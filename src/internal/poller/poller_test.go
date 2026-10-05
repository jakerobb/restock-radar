package poller

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jakerobb/restock-radar/internal/config"
	"github.com/jakerobb/restock-radar/internal/metrics"
	"github.com/jakerobb/restock-radar/internal/notify"
	"github.com/jakerobb/restock-radar/internal/store"
	"github.com/jakerobb/restock-radar/internal/unistore"
)

type fakeFetcher struct {
	status string
	err    error
}

func (f *fakeFetcher) FetchProduct(context.Context, config.Region, string) (*unistore.Product, error) {
	if f.err != nil {
		return nil, f.err
	}
	return &unistore.Product{ID: "p1", Slug: "widget", Name: "W", Title: "Widget", Variants: []unistore.Variant{{
		ID: "v1", SKU: "W-1", Title: "US", Status: f.status,
		Price: &unistore.Money{Amount: 10900, Currency: "USD"},
	}}}, nil
}

type fakeNotifier struct {
	sent []notify.Message
	fail bool
}

func (n *fakeNotifier) Send(_ context.Context, m notify.Message) error {
	if n.fail {
		return errors.New("ntfy down")
	}
	n.sent = append(n.sent, m)
	return nil
}

func setup(t *testing.T) (*Poller, *fakeFetcher, *fakeNotifier) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	cfg := &config.Config{
		FailureAlertAfter: 2,
		Regions:           []config.Region{{ID: "us", BaseURL: "https://store.example", Path: "us/en"}},
	}
	if _, _, err := st.SyncConfigItems(context.Background(), []store.ItemKey{{Region: "us", Slug: "widget"}}, time.Now()); err != nil {
		t.Fatal(err)
	}
	f, n := &fakeFetcher{status: "SoldOut"}, &fakeNotifier{}
	return New(cfg, f, st, n), f, n
}

func TestNotifiesOnRestockNotOnBaseline(t *testing.T) {
	p, f, n := setup(t)
	ctx := context.Background()

	p.cycle(ctx)
	if len(n.sent) != 0 {
		t.Fatalf("baseline must not notify, got %v", n.sent)
	}
	f.status = "Available"
	p.cycle(ctx)
	if len(n.sent) != 1 || n.sent[0].Click != "https://store.example/us/en/products/widget" {
		t.Fatalf("want one in-stock notification, got %+v", n.sent)
	}
	p.cycle(ctx)
	if len(n.sent) != 1 {
		t.Fatalf("no duplicate notification expected, got %d", len(n.sent))
	}
}

func TestRetriesFailedDelivery(t *testing.T) {
	p, f, n := setup(t)
	ctx := context.Background()
	p.cycle(ctx)
	f.status = "Available"
	n.fail = true
	p.cycle(ctx)
	if len(n.sent) != 0 {
		t.Fatal("send should have failed")
	}
	n.fail = false
	p.cycle(ctx)
	if len(n.sent) != 1 {
		t.Fatalf("undelivered event should be retried, got %d sent", len(n.sent))
	}
}

func TestFailureAlertOnceThenRecovery(t *testing.T) {
	p, f, n := setup(t)
	ctx := context.Background()
	f.err = unistore.ErrSchema
	p.cycle(ctx)
	if len(n.sent) != 0 {
		t.Fatal("one failure shouldn't alert")
	}
	p.cycle(ctx)
	p.cycle(ctx)
	if len(n.sent) != 1 {
		t.Fatalf("want exactly one failure alert, got %d", len(n.sent))
	}
	f.err = nil
	p.cycle(ctx)
	if len(n.sent) != 2 {
		t.Fatalf("want a recovery notice, got %d", len(n.sent))
	}
}

func TestBlockedAbandonsCycle(t *testing.T) {
	p, f, _ := setup(t)
	f.err = &unistore.HTTPError{Status: 429}
	if !p.cycle(context.Background()) {
		t.Fatal("429 should report blocked")
	}
}

func TestJitterBounds(t *testing.T) {
	for range 1000 {
		if j := jitter(time.Minute); j < -time.Minute || j >= time.Minute {
			t.Fatalf("jitter out of range: %v", j)
		}
	}
	if jitter(0) != 0 {
		t.Fatal("zero jitter must be zero")
	}
}

func TestAdd(t *testing.T) {
	ctx := context.Background()
	p, f, n := setup(t)
	f.status = "SoldOut"

	if _, err := p.Add(ctx, "bad slug", ""); err == nil {
		t.Fatal("invalid input should fail")
	} else if ue := new(UserError); !errors.As(err, &ue) {
		t.Fatalf("want a UserError, got %T", err)
	}

	f.err = unistore.ErrNotFound
	if _, err := p.Add(ctx, "nope", ""); err == nil || !errors.As(err, new(*UserError)) {
		t.Fatalf("missing product should be a UserError, got %v", err)
	}

	f.err = nil
	if _, err := p.Add(ctx, "https://other.example/us/en/products/widget", ""); err == nil {
		t.Fatal("a URL from an unknown store should fail")
	}
	res, err := p.Add(ctx, "Widget", "")
	if err != nil || res.AlreadyTracked || res.Slug != "widget" || res.Variants != 1 {
		t.Fatalf("unexpected result %+v err=%v", res, err)
	}
	items, _ := p.store.Items(ctx)
	var found bool
	for _, it := range items {
		found = found || (it.Slug == "widget" && it.ProductID == "p1")
	}
	if !found {
		t.Fatalf("item not recorded: %+v", items)
	}

	res, err = p.Add(ctx, "widget", "")
	if err != nil || !res.AlreadyTracked {
		t.Fatalf("second add should report already tracked: %+v err=%v", res, err)
	}

	// The baseline is silent, and a later restock alerts normally.
	f.status = "Available"
	p.cycle(ctx)
	if len(n.sent) != 1 {
		t.Fatalf("want one restock notification, got %d", len(n.sent))
	}
}

func TestMetricsFollowThePoll(t *testing.T) {
	p, f, n := setup(t)
	ctx := context.Background()
	render := func() string {
		var buf strings.Builder
		p.Metrics().Render(&buf, metrics.Gauges{})
		return buf.String()
	}

	p.cycle(ctx)
	f.status = "Available"
	p.cycle(ctx)
	out := render()
	for _, want := range []string{`fetches_total{result="ok"} 2`, `events_total{kind="status"} 1`, `notifications_total{result="sent"} 1`, "items_failing 0"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}

	f.err = &unistore.HTTPError{Status: 429}
	p.cycle(ctx)
	f.err = unistore.ErrSchema
	p.cycle(ctx)
	n.fail = true
	out = render()
	for _, want := range []string{`fetches_total{result="blocked"} 1`, `fetches_total{result="schema"} 1`, "items_failing 1"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}

	f.err = nil
	f.status = "SoldOut"
	p.cycle(ctx) // restock reverses; delivery fails
	if out = render(); !strings.Contains(out, `notifications_total{result="failed"} 1`) || !strings.Contains(out, "items_failing 0") {
		t.Errorf("failure metrics wrong:\n%s", out)
	}
}
