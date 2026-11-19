package store

import (
	"context"
	"database/sql"
	"time"
)

// CategoryCount is how many tracked products the store files in one category.
type CategoryCount struct {
	Region   string
	ID       string
	Products int
}

// Status is what the status page shows: counts over the whole database.
type Status struct {
	Products int
	Variants int
	// ProductsByRegion counts products per region id.
	ProductsByRegion map[string]int
	// Categories are the ingested categories (the ones whose product lists are
	// read each cycle), with the products currently filed under each.
	Categories []CategoryCount
	// Uncategorized are products whose category hasn't been learned yet, or is
	// not one of the ingested ones.
	Uncategorized int

	// WithSpecs have a stored technical specification. WithoutSpecs split into
	// those the product endpoint was read for (and gave none) and those not read yet.
	WithSpecs       int
	SpecsEmpty      int // read from the product endpoint, which gave no specification
	SpecsNotFetched int // the product endpoint hasn't been read for them yet

	// WithTechSpecsURL have a techspecs.ui.com page. NoTechSpecsURL were checked
	// and have none; TechSpecsNotChecked haven't been looked at yet.
	WithTechSpecsURL    int
	NoTechSpecsURL      int
	TechSpecsNotChecked int

	// NeverDetailed are products the product endpoint hasn't supplied yet.
	NeverDetailed     int
	WatchedFromConfig int
	WatchedFromUI     int
	PendingItems      int // watched items not matched to a product yet

	VariantsByStatus map[string]int
	LastChecked      *time.Time // the newest variant check
	OldestChecked    *time.Time // the variant checked longest ago

	Events24h     int
	Events7d      int
	PendingEvents int
	FailedEvents  int
	LatestEvent   *time.Time
}

// Status gathers the counts behind the status page. Each is a small aggregate
// over indexed or small tables, so it is cheap enough to run per request.
func (s *Store) Status(ctx context.Context, now time.Time) (Status, error) {
	st := Status{ProductsByRegion: map[string]int{}, VariantsByStatus: map[string]int{}}

	one := func(query string, args []any, dest ...any) error {
		return s.db.QueryRowContext(ctx, query, args...).Scan(dest...)
	}

	err := one(`
		SELECT COUNT(*),
		       COALESCE(SUM(has_specs), 0),
		       COALESCE(SUM(NOT has_specs AND specs_fetched_at IS NOT NULL), 0),
		       COALESCE(SUM(NOT has_specs AND specs_fetched_at IS NULL), 0),
		       COALESCE(SUM(techspecs_url != ''), 0),
		       COALESCE(SUM(techspecs_url = '' AND techspecs_checked_at IS NOT NULL), 0),
		       COALESCE(SUM(techspecs_url = '' AND techspecs_checked_at IS NULL), 0),
		       COALESCE(SUM(detailed_at IS NULL), 0)
		FROM (SELECT *, EXISTS (SELECT 1 FROM product_specs ps WHERE ps.region = p.region AND ps.product_id = p.id) AS has_specs
		      FROM products p)`, nil,
		&st.Products, &st.WithSpecs, &st.SpecsEmpty, &st.SpecsNotFetched,
		&st.WithTechSpecsURL, &st.NoTechSpecsURL, &st.TechSpecsNotChecked, &st.NeverDetailed)
	if err != nil {
		return st, err
	}

	var last, oldest, latestEvent sql.NullString
	if err := one(`SELECT COUNT(*), MAX(last_checked), MIN(last_checked) FROM variants WHERE delisted_at = ''`, nil, &st.Variants, &last, &oldest); err != nil {
		return st, err
	}
	st.LastChecked, st.OldestChecked = parseTS(last), parseTS(oldest)

	if err := one(`
		SELECT COALESCE(SUM(source = 'config'), 0), COALESCE(SUM(source = 'ui'), 0), COALESCE(SUM(product_id IS NULL), 0)
		FROM items`, nil, &st.WatchedFromConfig, &st.WatchedFromUI, &st.PendingItems); err != nil {
		return st, err
	}

	if err := one(`
		SELECT COALESCE(SUM(ts >= ?), 0), COUNT(*) FROM events WHERE ts >= ?`,
		[]any{ts(now.Add(-24 * time.Hour)), ts(now.AddDate(0, 0, -7))},
		&st.Events24h, &st.Events7d); err != nil {
		return st, err
	}
	if err := one(`
		SELECT COALESCE(SUM(notified_at IS NULL AND failed_at IS NULL), 0), COALESCE(SUM(failed_at IS NOT NULL), 0), MAX(ts)
		FROM events`, nil, &st.PendingEvents, &st.FailedEvents, &latestEvent); err != nil {
		return st, err
	}
	st.LatestEvent = parseTS(latestEvent)

	if err := s.groupCounts(ctx, `SELECT region, COUNT(*) FROM products GROUP BY region`, st.ProductsByRegion); err != nil {
		return st, err
	}
	if err := s.groupCounts(ctx, `SELECT status, COUNT(*) FROM variants WHERE delisted_at = '' GROUP BY status`, st.VariantsByStatus); err != nil {
		return st, err
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT c.region, c.id, COUNT(p.id)
		FROM categories c
		LEFT JOIN products p ON p.region = c.region AND p.category = c.id
		GROUP BY c.region, c.id
		ORDER BY c.region, c.id`)
	if err != nil {
		return st, err
	}
	defer func() { _ = rows.Close() }()
	inCategory := 0
	for rows.Next() {
		var c CategoryCount
		if err := rows.Scan(&c.Region, &c.ID, &c.Products); err != nil {
			return st, err
		}
		inCategory += c.Products
		st.Categories = append(st.Categories, c)
	}
	if err := rows.Err(); err != nil {
		return st, err
	}
	st.Uncategorized = st.Products - inCategory
	return st, nil
}

func (s *Store) groupCounts(ctx context.Context, query string, into map[string]int) error {
	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var key string
		var n int
		if err := rows.Scan(&key, &n); err != nil {
			return err
		}
		into[key] = n
	}
	return rows.Err()
}

func parseTS(s sql.NullString) *time.Time {
	if !s.Valid {
		return nil
	}
	t, err := time.Parse(time.RFC3339, s.String)
	if err != nil {
		return nil
	}
	return &t
}
