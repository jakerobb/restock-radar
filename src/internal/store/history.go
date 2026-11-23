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
	// PriceWithSurchargesCents is the price including the store's surcharges,
	// or PriceCents where no surcharge was known.
	PriceWithSurchargesCents *int64 `json:"price_with_surcharges_cents"`
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
	// window); the rest are changes inside it. A point with no status and no
	// price starts a stretch in which the store didn't list the variant; the
	// next point is its return.
	Points []HistoryPoint `json:"points"`
}

type variantKey struct{ region, id string }

// History returns every variant's timeline over the window starting at since.
// Nothing records a variant's initial state, so it's recovered by undoing its
// events from its current state.
func (s *Store) History(ctx context.Context, since time.Time) ([]VariantHistory, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT region, id, status, price_cents, surcharge_price_cents, first_seen, last_checked FROM variants ORDER BY region, id`)
	if err != nil {
		return nil, err
	}
	type tracked struct {
		VariantHistory
		status string
		price  *int64
		total  *int64
	}
	var order []variantKey
	byKey := map[variantKey]*tracked{}
	for rows.Next() {
		var t tracked
		var first, checked string
		if err := rows.Scan(&t.Region, &t.VariantID, &t.status, &t.price, &t.total, &first, &checked); err != nil {
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
		oldTotal  *int64
		newTotal  *int64
		key       variantKey
	}
	erows, err := s.db.QueryContext(ctx, `
		SELECT ts, region, variant_id, kind, old_status, new_status, old_price_cents, new_price_cents, old_total_cents, new_total_cents
		FROM events ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = erows.Close() }()
	changes := map[variantKey][]change{}
	for erows.Next() {
		var c change
		var when string
		if err := erows.Scan(&when, &c.key.region, &c.key.id, &c.kind, &c.oldStatus, &c.newStatus, &c.oldPrice, &c.newPrice, &c.oldTotal, &c.newTotal); err != nil {
			return nil, err
		}
		c.when, _ = time.Parse(time.RFC3339, when)
		changes[c.key] = append(changes[c.key], c)
	}
	if err := erows.Err(); err != nil {
		return nil, err
	}

	type gap struct{ from, to time.Time }
	grows, err := s.db.QueryContext(ctx, `SELECT region, variant_id, from_ts, to_ts FROM variant_gaps ORDER BY from_ts`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = grows.Close() }()
	gaps := map[variantKey][]gap{}
	for grows.Next() {
		var k variantKey
		var from, to string
		if err := grows.Scan(&k.region, &k.id, &from, &to); err != nil {
			return nil, err
		}
		g := gap{}
		g.from, _ = time.Parse(time.RFC3339, from)
		g.to, _ = time.Parse(time.RFC3339, to)
		gaps[k] = append(gaps[k], g)
	}
	if err := grows.Err(); err != nil {
		return nil, err
	}

	out := make([]VariantHistory, 0, len(order))
	for _, k := range order {
		t := byKey[k]
		evs := changes[k]

		// Undo the events, newest first, to recover the state at first_seen.
		status, price, total := t.status, t.price, t.total
		for i := len(evs) - 1; i >= 0; i-- {
			switch evs[i].kind {
			case KindStatus:
				status = evs[i].oldStatus
			case KindPrice:
				price, total = evs[i].oldPrice, evs[i].oldTotal
			}
		}

		// Replay forward, then drop everything superseded before the window.
		current := HistoryPoint{Time: t.From, Status: status, PriceCents: price, PriceWithSurchargesCents: firstNonNil(total, price)}
		points := []HistoryPoint{current}
		for _, e := range evs {
			switch e.kind {
			case KindStatus:
				current.Status = e.newStatus
			case KindPrice:
				current.PriceCents, current.PriceWithSurchargesCents = e.newPrice, firstNonNil(e.newTotal, e.newPrice)
			}
			current.Time = e.when
			points = append(points, current)
		}
		// Blank out the stretches in which the variant wasn't listed. Whatever it was just before is
		// held until it comes back, when the state is whatever events at that moment left it.
		for _, g := range gaps[k] {
			var back HistoryPoint
			for _, p := range points {
				if !p.Time.After(g.to) {
					back = p
				}
			}
			back.Time = g.to
			spliced := make([]HistoryPoint, 0, len(points)+2)
			for _, p := range points {
				if p.Time.Before(g.from) {
					spliced = append(spliced, p)
				}
			}
			spliced = append(spliced, HistoryPoint{Time: g.from})
			if !hasPointAt(points, g.to) {
				spliced = append(spliced, back)
			}
			for _, p := range points {
				if !p.Time.Before(g.to) {
					spliced = append(spliced, p)
				}
			}
			points = spliced
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

func hasPointAt(points []HistoryPoint, at time.Time) bool {
	for _, p := range points {
		if p.Time.Equal(at) {
			return true
		}
	}
	return false
}
