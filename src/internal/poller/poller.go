// Package poller periodically fetches each watched product, records changes,
// and sends notifications for them.
package poller

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"sync/atomic"
	"time"

	"github.com/jakerobb/restock-radar/internal/config"
	"github.com/jakerobb/restock-radar/internal/metrics"
	"github.com/jakerobb/restock-radar/internal/notify"
	"github.com/jakerobb/restock-radar/internal/store"
	"github.com/jakerobb/restock-radar/internal/unistore"
)

const maxBackoffFactor = 8

// Fetcher is the part of unistore.Client the poller needs.
type Fetcher interface {
	FetchProduct(ctx context.Context, region config.Region, slug string) (*unistore.Product, error)
}

type Poller struct {
	cfg      *config.Config
	fetcher  Fetcher
	store    *store.Store
	notifier notify.Notifier
	metrics  *metrics.Metrics

	// failures counts consecutive failed fetches per item; alerted records
	// which items have already raised a "failing" alert.
	failures map[string]int
	alerted  map[string]bool

	lastCycle atomic.Int64 // unix seconds of the last completed cycle
}

func New(cfg *config.Config, f Fetcher, s *store.Store, n notify.Notifier) *Poller {
	return &Poller{
		cfg: cfg, fetcher: f, store: s, notifier: n,
		metrics:  metrics.New(time.Now()),
		failures: make(map[string]int),
		alerted:  make(map[string]bool),
	}
}

// Metrics returns the counters this poller maintains.
func (p *Poller) Metrics() *metrics.Metrics { return p.metrics }

// LastCycle returns when the last poll cycle finished, or the zero time.
func (p *Poller) LastCycle() time.Time {
	secs := p.lastCycle.Load()
	if secs == 0 {
		return time.Time{}
	}
	return time.Unix(secs, 0)
}

// Run polls until ctx is cancelled. After the first cycle, each wait is the
// poll interval plus or minus jitter, doubled (up to 8x) while the store is
// blocking or rate limiting us.
func (p *Poller) Run(ctx context.Context) {
	backoff := 1
	for {
		if p.cycle(ctx) {
			backoff = min(backoff*2, maxBackoffFactor)
			slog.Warn("store is blocking or rate limiting; backing off", "factor", backoff)
		} else {
			backoff = 1
		}
		p.lastCycle.Store(time.Now().Unix())
		p.metrics.CycleDone(time.Now())

		wait := p.cfg.PollInterval*time.Duration(backoff) + jitter(p.cfg.PollJitter)
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

func jitter(max time.Duration) time.Duration {
	if max <= 0 {
		return 0
	}
	return time.Duration(rand.Int64N(int64(2*max))) - max
}

func itemKey(it store.Item) string { return it.Region + "/" + it.Slug }

// cycle polls every item once and reports whether the store blocked us.
func (p *Poller) cycle(ctx context.Context) (blocked bool) {
	p.flush(ctx) // retry anything a previous cycle failed to deliver

	items, err := p.store.Items(ctx)
	if err != nil {
		slog.Error("failed to load watch list", "err", err)
		return false
	}
	for i, it := range items {
		if i > 0 && p.cfg.RequestDelay > 0 {
			select {
			case <-ctx.Done():
				return false
			case <-time.After(p.cfg.RequestDelay/2 + time.Duration(rand.Int64N(int64(p.cfg.RequestDelay)))):
			}
		}
		if ctx.Err() != nil {
			return false
		}

		region, ok := p.cfg.RegionByID(it.Region)
		if !ok {
			slog.Warn("skipping item from a region no longer in config", "item", itemKey(it))
			continue
		}
		err := p.pollItem(ctx, region, it)
		var he *unistore.HTTPError
		if errors.As(err, &he) && he.Blocked() {
			// Hammering a store that's pushing back only makes it worse.
			slog.Warn("blocked by store; abandoning cycle", "item", itemKey(it), "status", he.Status)
			return true
		}
	}
	return false
}

func (p *Poller) pollItem(ctx context.Context, region config.Region, it store.Item) error {
	key := itemKey(it)
	prod, err := p.fetcher.FetchProduct(ctx, region, it.Slug)
	if ctx.Err() == nil {
		p.metrics.Fetch(fetchResult(err), time.Now())
	}
	if err != nil {
		if ctx.Err() == nil {
			slog.Error("fetch failed", "item", key, "err", err)
			p.recordFailure(ctx, region, it, err)
		}
		return err
	}
	p.recordSuccess(ctx, region, it)

	events, err := p.store.Apply(ctx, it.Region, prod, time.Now())
	if err != nil {
		slog.Error("failed to record observation", "item", key, "err", err)
		return err
	}
	if err := p.store.LinkItem(ctx, it.Region, it.Slug, prod.ID); err != nil {
		slog.Warn("failed to link item to product", "item", key, "err", err)
	}
	for _, e := range events {
		p.metrics.Event(e.Kind)
		slog.Info("change detected", "item", key, "kind", e.Kind, "variant", e.VariantSKU,
			"old_status", e.OldStatus, "new_status", e.NewStatus)
	}
	p.flush(ctx)
	return nil
}

// recordFailure alerts once when an item has failed several times in a row,
// which usually means the store's JSON changed shape or the slug went away.
func (p *Poller) recordFailure(ctx context.Context, region config.Region, it store.Item, err error) {
	key := itemKey(it)
	p.failures[key]++
	p.metrics.SetItemsFailing(len(p.failures))
	if p.failures[key] < p.cfg.FailureAlertAfter || p.alerted[key] {
		return
	}
	p.alerted[key] = true
	p.sendAlert(ctx, notify.Message{
		Title:    "Restock Radar: can't check " + it.Slug,
		Body:     fmt.Sprintf("%d consecutive failures. Last error: %v", p.failures[key], err),
		Priority: 3,
		Tags:     []string{"warning"},
	})
}

func (p *Poller) recordSuccess(ctx context.Context, region config.Region, it store.Item) {
	key := itemKey(it)
	if p.alerted[key] {
		p.sendAlert(ctx, notify.Message{
			Title: "Restock Radar: " + it.Slug + " is being checked again",
			Tags:  []string{"white_check_mark"},
		})
	}
	delete(p.failures, key)
	delete(p.alerted, key)
	p.metrics.SetItemsFailing(len(p.failures))
}

// fetchResult classifies a fetch outcome for the fetches_total metric.
func fetchResult(err error) string {
	var he *unistore.HTTPError
	switch {
	case err == nil:
		return metrics.FetchOK
	case errors.Is(err, unistore.ErrNotFound):
		return metrics.FetchNotFound
	case errors.Is(err, unistore.ErrSchema):
		return metrics.FetchSchema
	case errors.As(err, &he) && he.Blocked():
		return metrics.FetchBlocked
	default:
		return metrics.FetchError
	}
}

func (p *Poller) sendAlert(ctx context.Context, m notify.Message) {
	if err := p.notifier.Send(ctx, m); err != nil {
		slog.Error("failed to send alert", "title", m.Title, "err", err)
	}
}

// flush delivers pending events in order. An event is marked notified only
// after a successful send, so failures are retried on the next flush.
func (p *Poller) flush(ctx context.Context) {
	events, err := p.store.PendingEvents(ctx)
	if err != nil {
		slog.Error("failed to load pending events", "err", err)
		return
	}
	for _, e := range events {
		region, ok := p.cfg.RegionByID(e.Region)
		if !ok {
			// The region was removed from config; nothing to link to or send.
			_ = p.store.MarkNotified(ctx, e.ID, time.Now())
			continue
		}
		link := fmt.Sprintf("%s/%s/products/%s", region.BaseURL, region.Path, e.ProductSlug)
		err := p.notifier.Send(ctx, notify.FromEvent(e, link))
		var rejected *notify.PermanentError
		if errors.As(err, &rejected) {
			// Retrying can't help, and leaving it at the head of the queue
			// would hold up every notification behind it.
			p.metrics.Notification(metrics.NotifyDropped)
			slog.Error("notification permanently rejected; giving up on it", "event", e.ID, "err", err)
			if err := p.store.MarkFailed(ctx, e.ID, time.Now()); err != nil {
				slog.Error("failed to mark event failed", "event", e.ID, "err", err)
				return
			}
			continue
		}
		if err != nil {
			p.metrics.Notification(metrics.NotifyFailed)
			slog.Error("failed to send notification; will retry", "event", e.ID, "err", err)
			return
		}
		p.metrics.Notification(metrics.NotifySent)
		if err := p.store.MarkNotified(ctx, e.ID, time.Now()); err != nil {
			slog.Error("failed to mark event notified", "event", e.ID, "err", err)
			return
		}
	}
}

// AddResult describes the outcome of Add.
type AddResult struct {
	Region string
	Slug   string
	// Title is the product's display name.
	Title string
	// Variants is how many variants the product has.
	Variants int
	// AlreadyTracked is true when the product was already on the watch list.
	AlreadyTracked bool
}

// Add validates input (a slug or a store URL) against the live store and, if
// it names a real product, adds it to the watch list and records its current
// state as the baseline. Errors from parsing and from a missing product are
// safe to show to users; others are not.
func (p *Poller) Add(ctx context.Context, input, regionID string) (*AddResult, error) {
	region, slug, err := p.cfg.ParseItem(input, regionID)
	if err != nil {
		return nil, &UserError{err.Error()}
	}
	if p.cfg.MaxItems > 0 {
		items, err := p.store.Items(ctx)
		if err != nil {
			return nil, err
		}
		if len(items) >= p.cfg.MaxItems {
			return nil, &UserError{fmt.Sprintf("the watch list is full (%d products); remove one from the config first", p.cfg.MaxItems)}
		}
	}

	prod, err := p.fetcher.FetchProduct(ctx, region, slug)
	if errors.Is(err, unistore.ErrNotFound) {
		return nil, &UserError{fmt.Sprintf("the %s store has no product with slug %q", region.ID, slug)}
	}
	if err != nil {
		return nil, fmt.Errorf("checking the store: %w", err)
	}

	res := &AddResult{Region: region.ID, Slug: prod.Slug, Title: prod.Title, Variants: len(prod.Variants)}
	if known, err := p.store.HasProduct(ctx, region.ID, prod.ID); err != nil {
		return nil, err
	} else if known {
		res.AlreadyTracked = true
		return res, nil
	}

	// Store the canonical slug rather than an alias that needs a redirect.
	now := time.Now()
	if _, err := p.store.AddItem(ctx, region.ID, prod.Slug, store.SourceUI, prod.ID, now); err != nil {
		return nil, err
	}
	if err := p.store.LinkItem(ctx, region.ID, prod.Slug, prod.ID); err != nil {
		return nil, err
	}
	// The baseline is silent, so a brand-new product never alerts on its first sighting.
	if _, err := p.store.Apply(ctx, region.ID, prod, now); err != nil {
		return nil, err
	}
	slog.Info("item added", "item", region.ID+"/"+prod.Slug, "variants", len(prod.Variants))
	return res, nil
}

// UserError is an error whose message is meant to be shown to the user.
type UserError struct{ Msg string }

func (e *UserError) Error() string { return e.Msg }
