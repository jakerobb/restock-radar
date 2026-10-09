package store

import (
	"context"
	"time"
)

// HistoryPoint is a variant's state from Time until the next point (or until
// the history's Until).
type HistoryPoint struct {
	Time       time.Time `json:"time"`
	Status     string    `json:"status"`
	PriceCents *int64    `json:"price_cents"`
}

// VariantHistory is the timeline of one variant over a window. Nothing is
// known before From (when the variant was first seen) or after Until (when it
// was last checked successfully).
type VariantHistory struct {
	Region    string    `json:"region"`
	VariantID string    `json:"variant_id"`
	From      time.Time `json:"from"`
	Until     time.Time `json:"until"`
	// Points are in time order. The first is the state in effect at the start
	// of the window (timestamped at its true start, which may precede the
	// window); the rest are changes inside it.
	Points []HistoryPoint `json:"points"`
}

type variantKey struct{ region, id string }

// History returns every variant's timeline over the window starting at since.
// Nothing records a variant's initial state, so it's recovered by undoing its
// events from its current state.
func (s *Store) History(ctx context.Context, since time.Time) ([]VariantHistory, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT region, id, status, price_cents, first_seen, last_checked FROM variants ORDER BY region, id`)
	if err != nil {
		return nil, err
	}
	type tracked struct {
		VariantHistory
		status string
		price  *int64
	}
	var order []variantKey
	byKey := map[variantKey]*tracked{}
	for rows.Next() {
		var t tracked
		var first, checked string
		if err := rows.Scan(&t.Region, &t.VariantID, &t.status, &t.price, &first, &checked); err != nil {
			_ = rows.Close()
			return nil, err
		}
		t.From, _ = time.Parse(time.RFC3339, first)
		t.Until, _ = time.Parse(time.RFC3339, checked)
		k := variantKey{t.Region, t.VariantID}
		order = append(order, k)
		byKey[k] = &t
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	_ = rows.Close()

	type change struct {
		when      time.Time
		kind      string
		oldStatus string
		newStatus string
		oldPrice  *int64
		newPrice  *int64
		key       variantKey
	}
	erows, err := s.db.QueryContext(ctx, `
		SELECT ts, region, variant_id, kind, old_status, new_status, old_price_cents, new_price_cents
		FROM events ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = erows.Close() }()
	changes := map[variantKey][]change{}
	for erows.Next() {
		var c change
		var when string
		if err := erows.Scan(&when, &c.key.region, &c.key.id, &c.kind, &c.oldStatus, &c.newStatus, &c.oldPrice, &c.newPrice); err != nil {
			return nil, err
		}
		c.when, _ = time.Parse(time.RFC3339, when)
		changes[c.key] = append(changes[c.key], c)
	}
	if err := erows.Err(); err != nil {
		return nil, err
	}

	out := make([]VariantHistory, 0, len(order))
	for _, k := range order {
		t := byKey[k]
		evs := changes[k]

		// Undo the events, newest first, to recover the state at first_seen.
		status, price := t.status, t.price
		for i := len(evs) - 1; i >= 0; i-- {
			switch evs[i].kind {
			case KindStatus:
				status = evs[i].oldStatus
			case KindPrice:
				price = evs[i].oldPrice
			}
		}

		// Replay forward, then drop everything superseded before the window.
		current := HistoryPoint{Time: t.From, Status: status, PriceCents: price}
		points := []HistoryPoint{current}
		for _, e := range evs {
			switch e.kind {
			case KindStatus:
				current.Status = e.newStatus
			case KindPrice:
				current.PriceCents = e.newPrice
			}
			current.Time = e.when
			points = append(points, current)
		}
		start := 0
		for i, p := range points {
			if p.Time.Before(since) {
				start = i
			}
		}
		points = points[start:]
		t.Points = points
		out = append(out, t.VariantHistory)
	}
	return out, nil
}
