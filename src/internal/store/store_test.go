package store

import (
	"context"
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
