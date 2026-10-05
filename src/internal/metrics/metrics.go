// Package metrics keeps the poller's counters and renders them, with a few
// gauges read from the database at scrape time, in the Prometheus text format.
// It is hand-rolled (like nut-relay's) because the surface is tiny.
package metrics

import (
	"fmt"
	"io"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// Fetch results, as the `result` label of restock_radar_fetches_total.
const (
	FetchOK       = "ok"
	FetchBlocked  = "blocked"   // 403, 429 or 503: the store is pushing back
	FetchNotFound = "not_found" // the slug no longer exists
	FetchSchema   = "schema"    // the store's JSON changed shape
	FetchError    = "error"     // network errors and everything else
)

// Notification results, as the `result` label of restock_radar_notifications_total.
const (
	NotifySent   = "sent"
	NotifyFailed = "failed"
)

type counterVec struct {
	mu     sync.Mutex
	values map[string]uint64
}

func newCounterVec(labels ...string) *counterVec {
	c := &counterVec{values: make(map[string]uint64, len(labels))}
	for _, l := range labels {
		c.values[l] = 0 // series exist from the start, so rate() has a baseline
	}
	return c
}

func (c *counterVec) inc(label string) {
	c.mu.Lock()
	c.values[label]++
	c.mu.Unlock()
}

func (c *counterVec) snapshot() map[string]uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]uint64, len(c.values))
	for k, v := range c.values {
		out[k] = v
	}
	return out
}

// Metrics is the set of counters the poller updates. The zero value is not
// usable; call New.
type Metrics struct {
	fetches       *counterVec
	events        *counterVec
	notifications *counterVec
	lastSuccess   atomic.Int64 // unix seconds
	lastCycle     atomic.Int64 // unix seconds
	itemsFailing  atomic.Int64
}

// New returns Metrics whose "last success" starts at now, so an instance that
// never manages a fetch looks stale from the moment it starts.
func New(now time.Time) *Metrics {
	m := &Metrics{
		fetches:       newCounterVec(FetchOK, FetchBlocked, FetchNotFound, FetchSchema, FetchError),
		events:        newCounterVec("status", "price"),
		notifications: newCounterVec(NotifySent, NotifyFailed),
	}
	m.lastSuccess.Store(now.Unix())
	return m
}

// Fetch records one product fetch. A successful fetch also marks the poller as
// having recently made progress.
func (m *Metrics) Fetch(result string, now time.Time) {
	m.fetches.inc(result)
	if result == FetchOK {
		m.lastSuccess.Store(now.Unix())
	}
}

func (m *Metrics) Event(kind string)          { m.events.inc(kind) }
func (m *Metrics) Notification(result string) { m.notifications.inc(result) }
func (m *Metrics) CycleDone(now time.Time)    { m.lastCycle.Store(now.Unix()) }
func (m *Metrics) SetItemsFailing(n int)      { m.itemsFailing.Store(int64(n)) }

// Gauges are values read from the database at scrape time.
type Gauges struct {
	WatchedItems  int
	PendingEvents int
	// VariantsByStatus counts variants per store status (Available, SoldOut, ...).
	VariantsByStatus map[string]int
}

func writeFamily(w io.Writer, name, kind, help string) {
	_, _ = fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s %s\n", name, help, name, kind)
}

func writeLabeled[V uint64 | int](w io.Writer, name, label string, values map[string]V) {
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		_, _ = fmt.Fprintf(w, "%s{%s=%q} %d\n", name, label, k, values[k])
	}
}

// Render writes every metric in the Prometheus text exposition format.
func (m *Metrics) Render(w io.Writer, g Gauges) {
	writeFamily(w, "restock_radar_last_success_timestamp_seconds", "gauge",
		"Unix time of the last successful product fetch (process start time until the first one).")
	_, _ = fmt.Fprintf(w, "restock_radar_last_success_timestamp_seconds %d\n", m.lastSuccess.Load())

	writeFamily(w, "restock_radar_last_cycle_timestamp_seconds", "gauge",
		"Unix time the last poll cycle finished (0 before the first).")
	_, _ = fmt.Fprintf(w, "restock_radar_last_cycle_timestamp_seconds %d\n", m.lastCycle.Load())

	writeFamily(w, "restock_radar_fetches_total", "counter", "Product fetches, by result.")
	writeLabeled(w, "restock_radar_fetches_total", "result", m.fetches.snapshot())

	writeFamily(w, "restock_radar_events_total", "counter", "Changes detected, by kind.")
	writeLabeled(w, "restock_radar_events_total", "kind", m.events.snapshot())

	writeFamily(w, "restock_radar_notifications_total", "counter", "Notification delivery attempts, by result.")
	writeLabeled(w, "restock_radar_notifications_total", "result", m.notifications.snapshot())

	writeFamily(w, "restock_radar_items_failing", "gauge", "Watched items whose last fetch failed.")
	_, _ = fmt.Fprintf(w, "restock_radar_items_failing %d\n", m.itemsFailing.Load())

	writeFamily(w, "restock_radar_watched_items", "gauge", "Products on the watch list.")
	_, _ = fmt.Fprintf(w, "restock_radar_watched_items %d\n", g.WatchedItems)

	writeFamily(w, "restock_radar_pending_events", "gauge", "Detected changes not yet delivered as notifications.")
	_, _ = fmt.Fprintf(w, "restock_radar_pending_events %d\n", g.PendingEvents)

	writeFamily(w, "restock_radar_variants", "gauge", "Tracked variants, by store status.")
	writeLabeled(w, "restock_radar_variants", "status", g.VariantsByStatus)
}
