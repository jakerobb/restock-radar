package notify

import (
	"testing"
	"time"

	"github.com/jakerobb/restock-radar/internal/store"
)

func TestFromEventStatusBody(t *testing.T) {
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	p := func(c int64) *int64 { return &c }
	base := store.Event{Kind: store.KindStatus, Timestamp: now, Currency: "USD", ProductTitle: "Gateway"}

	tests := []struct {
		name   string
		mutate func(*store.Event)
		want   string
	}{
		{"sold out then restocked, price up", func(e *store.Event) {
			e.OldStatus, e.NewStatus = "SoldOut", "Available"
			e.PreviousStateSince = now.Add(-22 * time.Hour)
			e.OldPriceCents, e.NewPriceCents = p(10900), p(12900)
		}, "Was sold out for 22 hours. Price increased to $129.00."},
		{"available for days, same price", func(e *store.Event) {
			e.OldStatus, e.NewStatus = "Available", "SoldOut"
			e.PreviousStateSince = now.Add(-72 * time.Hour)
			e.OldPriceCents, e.NewPriceCents = p(12900), p(12900)
		}, "Was available for 3 days."},
		{"restock, same price", func(e *store.Event) {
			e.OldStatus, e.NewStatus = "SoldOut", "Available"
			e.PreviousStateSince = now.Add(-time.Hour)
			e.OldPriceCents, e.NewPriceCents = p(12900), p(12900)
		}, "Was sold out for 1 hour. Still $129.00."},
		{"price dropped, first seen baseline", func(e *store.Event) {
			e.OldStatus, e.NewStatus = "SoldOut", "Available"
			e.PreviousStateSince, e.PreviousStateSinceFirstSeen = now.Add(-5*time.Minute), true
			e.OldPriceCents, e.NewPriceCents = p(12900), p(9900)
		}, "Was sold out for at least 5 minutes. Price decreased to $99.00."},
		{"old price unknown (pre-upgrade event)", func(e *store.Event) {
			e.OldStatus, e.NewStatus = "ComingSoon", "Available"
			e.NewPriceCents = p(9900)
		}, "Was coming soon. Now $99.00."},
	}
	for _, tt := range tests {
		e := base
		tt.mutate(&e)
		if got := FromEvent(e, "").Body; got != tt.want {
			t.Errorf("%s: got %q, want %q", tt.name, got, tt.want)
		}
	}
}
