package store

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"strings"
	"time"
)

// regionSuffix is the region some product slugs end with ("ups-tower-eu"): the store sells a few products
// as a separate product in each region, with the region in the slug.
var regionSuffix = regexp.MustCompile(`-(us|ca|eu|uk|gb|jp|br|tw|sg)$`)

// BaseSlug is a slug without its region suffix, in lower case: "ups-tower-eu" is "ups-tower". It is how a
// product is recognised as the same one in another region.
func BaseSlug(slug string) string {
	return regionSuffix.ReplaceAllString(strings.ToLower(strings.TrimSpace(slug)), "")
}

// SpecsGap is a tracked product that has no tech specs to check a plan with: none are stored, or what the store
// publishes gives nothing to derive (a table laid out per variant, say, which the derivation doesn't read).
type SpecsGap struct {
	Region   string `json:"region"`
	ID       string `json:"id"`
	Slug     string `json:"slug"`
	Title    string `json:"title"`
	Category string `json:"category"`
	// FetchedAt is when the product endpoint last supplied the product; nil when it hasn't been fetched
	// yet, in which case the specs may simply not have been collected.
	FetchedAt *time.Time `json:"fetched_at"`
	// Published says the store published some specs for it, but nothing could be derived from them. When false,
	// the store published none.
	Published bool `json:"published"`
	// NotExpected says the product is on the list of those that have no tech specs and shouldn't.
	NotExpected bool `json:"not_expected"`
}

// SpecsNotExpected is one entry of that list.
type SpecsNotExpected struct {
	// Slug is the product's slug without its region suffix.
	Slug      string    `json:"slug"`
	Reason    string    `json:"reason"`
	CreatedAt time.Time `json:"created_at"`
	CreatedBy string    `json:"created_by,omitempty"`
}

// SpecsGaps lists the tracked products with no usable tech specs, by title (those with none stored, and those whose
// stored specs gave nothing derived: no ports, PoE, radios, rack, size, numbers or power), and the list of products
// no specs are expected for.
func (s *Store) SpecsGaps(ctx context.Context) ([]SpecsGap, []SpecsNotExpected, error) {
	expected, err := s.SpecsNotExpectedList(ctx)
	if err != nil {
		return nil, nil, err
	}
	listed := make(map[string]bool, len(expected))
	for _, e := range expected {
		listed[e.Slug] = true
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT p.region, p.id, p.slug, p.title, p.category, p.specs_fetched_at,
		       EXISTS (SELECT 1 FROM product_specs ps WHERE ps.region = p.region AND ps.product_id = p.id) AS published
		FROM products p
		LEFT JOIN product_derived d ON d.region = p.region AND d.product_id = p.id
		WHERE NOT EXISTS (SELECT 1 FROM product_specs ps WHERE ps.region = p.region AND ps.product_id = p.id)
		   OR (d.product_id IS NOT NULL
		       AND d.known_ports = 0 AND d.known_poe = 0 AND d.known_radios = 0 AND d.known_rack = 0 AND d.known_dims = 0
		       AND NOT EXISTS (SELECT 1 FROM product_metrics m WHERE m.region = p.region AND m.product_id = p.id)
		       AND NOT EXISTS (SELECT 1 FROM product_power w WHERE w.region = p.region AND w.product_id = p.id))
		ORDER BY p.title, p.region`)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []SpecsGap
	for rows.Next() {
		var g SpecsGap
		var fetched sql.NullString
		if err := rows.Scan(&g.Region, &g.ID, &g.Slug, &g.Title, &g.Category, &fetched, &g.Published); err != nil {
			return nil, nil, err
		}
		g.FetchedAt = parseTS(fetched)
		g.NotExpected = listed[BaseSlug(g.Slug)]
		out = append(out, g)
	}
	return out, expected, rows.Err()
}

// SpecsNotExpectedList is the products marked as having no tech specs to expect, by slug.
func (s *Store) SpecsNotExpectedList(ctx context.Context) ([]SpecsNotExpected, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT slug, reason, created_at, created_by FROM specs_not_expected ORDER BY slug`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []SpecsNotExpected
	for rows.Next() {
		var e SpecsNotExpected
		var created string
		if err := rows.Scan(&e.Slug, &e.Reason, &created, &e.CreatedBy); err != nil {
			return nil, err
		}
		e.CreatedAt, _ = time.Parse(time.RFC3339, created)
		out = append(out, e)
	}
	return out, rows.Err()
}

// MarkSpecsNotExpected puts a product on the list, by its slug in any region (the region suffix is dropped,
// so the product is covered in every region). It must be a product we track.
func (s *Store) MarkSpecsNotExpected(ctx context.Context, slug, reason, actor string, now time.Time) (SpecsNotExpected, error) {
	base := BaseSlug(slug)
	if base == "" {
		return SpecsNotExpected{}, invalid("a slug is required")
	}
	reason = strings.TrimSpace(reason)
	// The LIKE narrows the products to those whose slug starts with the base; the exact test is in Go.
	rows, err := s.db.QueryContext(ctx, `SELECT slug FROM products WHERE lower(slug) = ? OR lower(slug) LIKE ?`, base, base+"-%")
	if err != nil {
		return SpecsNotExpected{}, err
	}
	found := false
	for rows.Next() {
		var sl string
		if err := rows.Scan(&sl); err != nil {
			_ = rows.Close()
			return SpecsNotExpected{}, err
		}
		if BaseSlug(sl) == base {
			found = true
		}
	}
	if err := rows.Close(); err != nil {
		return SpecsNotExpected{}, err
	}
	if !found {
		return SpecsNotExpected{}, ErrUnknownProduct
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO specs_not_expected (slug, reason, created_at, created_by) VALUES (?, ?, ?, ?)
		ON CONFLICT (slug) DO UPDATE SET reason = excluded.reason`, base, reason, ts(now), strings.TrimSpace(actor))
	if err != nil {
		return SpecsNotExpected{}, err
	}
	list, err := s.SpecsNotExpectedList(ctx)
	if err != nil {
		return SpecsNotExpected{}, err
	}
	for _, e := range list {
		if e.Slug == base {
			return e, nil
		}
	}
	return SpecsNotExpected{}, errors.New("reading back the entry")
}

// UnmarkSpecsNotExpected takes a product off the list, reporting whether it was on it.
func (s *Store) UnmarkSpecsNotExpected(ctx context.Context, slug string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM specs_not_expected WHERE slug = ?`, BaseSlug(slug))
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
