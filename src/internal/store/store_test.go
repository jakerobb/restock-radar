package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

func product(status string, price int64) *unistore.Product {
	return &unistore.Product{
		ID: "p1", Slug: "widget", Name: "Widget", Title: "Widget",
		Variants: []unistore.Variant{{
			ID: "v1", SKU: "W-1", Title: "US", Status: status,
			Price: &unistore.Money{Amount: price, Currency: "USD"},
		}},
	}
}

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestApplyDetectsChanges(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()

	events, err := s.Apply(ctx, "us", product("SoldOut", 10900), now)
	if err != nil || len(events) != 0 {
		t.Fatalf("first observation is a baseline: events=%v err=%v", events, err)
	}
	events, _ = s.Apply(ctx, "us", product("SoldOut", 10900), now)
	if len(events) != 0 {
		t.Fatalf("no change, want no events, got %v", events)
	}

	events, err = s.Apply(ctx, "us", product("Available", 10900), now)
	if err != nil || len(events) != 1 || events[0].Kind != KindStatus ||
		events[0].OldStatus != "SoldOut" || events[0].NewStatus != "Available" || events[0].ProductSlug != "widget" {
		t.Fatalf("want one status event, got %+v err=%v", events, err)
	}

	events, _ = s.Apply(ctx, "us", product("Available", 9900), now)
	if len(events) != 1 || events[0].Kind != KindPrice || *events[0].OldPriceCents != 10900 || *events[0].NewPriceCents != 9900 {
		t.Fatalf("want one price event, got %+v", events)
	}

	events, _ = s.Apply(ctx, "us", product("SoldOut", 8900), now)
	if len(events) != 2 {
		t.Fatalf("status and price together should yield two events, got %+v", events)
	}
}

func TestPendingAndNotified(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	_, _ = s.Apply(ctx, "us", product("SoldOut", 10900), now)
	events, _ := s.Apply(ctx, "us", product("Available", 10900), now)

	pending, err := s.PendingEvents(ctx)
	if err != nil || len(pending) != 1 {
		t.Fatalf("want 1 pending, got %v err=%v", pending, err)
	}
	if err := s.MarkNotified(ctx, events[0].ID, now); err != nil {
		t.Fatal(err)
	}
	if pending, _ = s.PendingEvents(ctx); len(pending) != 0 {
		t.Fatalf("want none pending, got %v", pending)
	}

	all, _ := s.Events(ctx, "us", 0, 10)
	if len(all) != 1 || all[0].NotifiedAt == nil {
		t.Fatalf("want 1 notified event, got %+v", all)
	}
	if other, _ := s.Events(ctx, "gb", 0, 10); len(other) != 0 {
		t.Fatalf("region filter failed: %+v", other)
	}
}

func TestVariants(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	_, _ = s.Apply(ctx, "us", product("Available", 10900), time.Now())
	vs, err := s.Variants(ctx, "us")
	if err != nil || len(vs) != 1 || vs[0].Status != "Available" || *vs[0].PriceCents != 10900 {
		t.Fatalf("unexpected variants %+v err=%v", vs, err)
	}
}

func TestSyncConfigItems(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()

	added, removed, err := s.SyncConfigItems(ctx, []ItemKey{{"us", "a"}, {"us", "b"}}, now)
	if err != nil || added != 2 || removed != 0 {
		t.Fatalf("first sync: added=%d removed=%d err=%v", added, removed, err)
	}
	if isNew, _ := s.AddItem(ctx, "us", "ui-added", SourceUI, "", now); !isNew {
		t.Fatal("UI item should be new")
	}
	if isNew, _ := s.AddItem(ctx, "us", "ui-added", SourceUI, "", now); isNew {
		t.Fatal("duplicate add should be a no-op")
	}

	// b leaves the config, c joins; the UI item must survive.
	added, removed, err = s.SyncConfigItems(ctx, []ItemKey{{"us", "a"}, {"us", "c"}}, now)
	if err != nil || added != 1 || removed != 1 {
		t.Fatalf("second sync: added=%d removed=%d err=%v", added, removed, err)
	}
	items, _ := s.Items(ctx)
	var got []string
	for _, it := range items {
		got = append(got, it.Slug+":"+it.Source)
	}
	if len(got) != 3 || got[0] != "a:config" || got[1] != "c:config" || got[2] != "ui-added:ui" {
		t.Fatalf("unexpected items: %v", got)
	}

	// A config entry that matches a UI item takes it over.
	if added, _, _ := s.SyncConfigItems(ctx, []ItemKey{{"us", "a"}, {"us", "c"}, {"us", "ui-added"}}, now); added != 1 {
		t.Fatalf("config should claim the UI item, added=%d", added)
	}

	if err := s.LinkItem(ctx, "us", "a", "p1"); err != nil {
		t.Fatal(err)
	}
	items, _ = s.Items(ctx)
	if items[0].ProductID != "p1" {
		t.Fatalf("item not linked: %+v", items[0])
	}
}

func TestMarkFailedStopsRetrying(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	_, _ = s.Apply(ctx, "us", product("SoldOut", 10900), now)
	events, _ := s.Apply(ctx, "us", product("Available", 10900), now)

	if err := s.MarkFailed(ctx, events[0].ID, now); err != nil {
		t.Fatal(err)
	}
	if pending, _ := s.PendingEvents(ctx); len(pending) != 0 {
		t.Fatalf("a failed event must not be pending: %v", pending)
	}
	if st, _ := s.Stats(ctx); st.PendingEvents != 0 {
		t.Fatalf("stats should not count failed events as pending: %+v", st)
	}
	all, _ := s.Events(ctx, "us", 0, 10)
	if len(all) != 1 || all[0].FailedAt == nil || all[0].NotifiedAt != nil {
		t.Fatalf("history should record the failure: %+v", all)
	}
}

func TestMigratesFromSchemaVersion2(t *testing.T) {
	// A database as the first deployed release left it: migrations 1 and 2 applied.
	path := filepath.Join(t.TempDir(), "old.db")
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := raw.Exec(migrations[i]); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := raw.Exec(`PRAGMA user_version = 2`); err != nil {
		t.Fatal(err)
	}
	_, err = raw.Exec(`INSERT INTO events (ts, region, product_id, variant_id, kind) VALUES ('2026-10-05T00:00:00Z', 'us', 'p', 'v', 'status')`)
	if err != nil {
		t.Fatal(err)
	}
	_ = raw.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}
	defer func() { _ = s.Close() }()
	var version int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil || version != len(migrations) {
		t.Fatalf("user_version = %d (%v), want %d", version, err, len(migrations))
	}
	// The existing event is intact and still counts as pending.
	if st, err := s.Stats(context.Background()); err != nil || st.PendingEvents != 1 {
		t.Fatalf("existing event lost: %+v %v", st, err)
	}
}

func TestEventPreviousStateSince(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	t0 := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	_, _ = s.Apply(ctx, "us", product("SoldOut", 10900), t0)

	// The price change in between must not reset the clock on the status.
	_, _ = s.Apply(ctx, "us", product("SoldOut", 11900), t0.Add(time.Hour))
	events, _ := s.Apply(ctx, "us", product("Available", 11900), t0.Add(2*time.Hour))
	if len(events) != 1 || !events[0].PreviousStateSince.Equal(t0) || !events[0].PreviousStateSinceFirstSeen ||
		events[0].OldPriceCents == nil || *events[0].OldPriceCents != 11900 {
		t.Fatalf("first change should measure from first seen with the old price, got %+v", events)
	}

	t1 := t0.Add(5 * time.Hour)
	events, _ = s.Apply(ctx, "us", product("SoldOut", 11900), t1)
	if len(events) != 1 || !events[0].PreviousStateSince.Equal(t0.Add(2*time.Hour)) || events[0].PreviousStateSinceFirstSeen {
		t.Fatalf("later change should measure from the previous status event, got %+v", events)
	}
}

func TestHistoryReconstructsTimeline(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	t0 := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	_, _ = s.Apply(ctx, "us", product("SoldOut", 10900), t0)
	_, _ = s.Apply(ctx, "us", product("Available", 10900), t0.Add(24*time.Hour))
	_, _ = s.Apply(ctx, "us", product("Available", 9900), t0.Add(48*time.Hour))
	_, _ = s.Apply(ctx, "us", product("Available", 9900), t0.Add(72*time.Hour))

	h, err := s.History(ctx, t0.Add(-time.Hour))
	if err != nil || len(h) != 1 {
		t.Fatalf("history=%+v err=%v", h, err)
	}
	pts := h[0].Points
	if len(pts) != 3 || pts[0].Status != "SoldOut" || *pts[0].PriceCents != 10900 ||
		pts[1].Status != "Available" || *pts[1].PriceCents != 10900 ||
		pts[2].Status != "Available" || *pts[2].PriceCents != 9900 {
		t.Fatalf("unexpected points: %+v", pts)
	}
	if !h[0].From.Equal(t0) || !h[0].Until.Equal(t0.Add(72*time.Hour)) {
		t.Fatalf("from/until = %v / %v", h[0].From, h[0].Until)
	}

	// A window starting mid-way keeps only the state in effect at its start onward.
	h, _ = s.History(ctx, t0.Add(36*time.Hour))
	pts = h[0].Points
	if len(pts) != 2 || pts[0].Status != "Available" || *pts[0].PriceCents != 10900 || *pts[1].PriceCents != 9900 {
		t.Fatalf("unexpected windowed points: %+v", pts)
	}
}
