// Package store persists current variant state and the history of changes in
// SQLite. The pure-Go driver keeps the binary CGO-free.
package store

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"time"

	_ "modernc.org/sqlite"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

const (
	KindStatus = "status"
	KindPrice  = "price"
)

// migrations are applied in order; PRAGMA user_version records how many ran.
var migrations = []string{
	`CREATE TABLE products (
		region TEXT NOT NULL,
		id     TEXT NOT NULL,
		slug   TEXT NOT NULL,
		name   TEXT NOT NULL,
		title  TEXT NOT NULL,
		PRIMARY KEY (region, id)
	);
	CREATE TABLE variants (
		region              TEXT NOT NULL,
		id                  TEXT NOT NULL,
		product_id          TEXT NOT NULL,
		sku                 TEXT NOT NULL,
		title               TEXT NOT NULL,
		status              TEXT NOT NULL,
		price_cents         INTEGER,
		regular_price_cents INTEGER,
		currency            TEXT NOT NULL DEFAULT '',
		restock_eta         TEXT NOT NULL DEFAULT '',
		first_seen          TEXT NOT NULL,
		last_checked        TEXT NOT NULL,
		last_changed        TEXT NOT NULL,
		PRIMARY KEY (region, id)
	);
	CREATE TABLE events (
		id                      INTEGER PRIMARY KEY AUTOINCREMENT,
		ts                      TEXT NOT NULL,
		region                  TEXT NOT NULL,
		product_id              TEXT NOT NULL,
		variant_id              TEXT NOT NULL,
		kind                    TEXT NOT NULL,
		old_status              TEXT NOT NULL DEFAULT '',
		new_status              TEXT NOT NULL DEFAULT '',
		old_price_cents         INTEGER,
		new_price_cents         INTEGER,
		old_regular_price_cents INTEGER,
		new_regular_price_cents INTEGER,
		currency                TEXT NOT NULL DEFAULT '',
		notified_at             TEXT
	);
	CREATE INDEX events_region_id ON events (region, id);
	CREATE INDEX events_pending ON events (id) WHERE notified_at IS NULL;`,
	// The watch list. source is "config" (owned by the config file, kept in
	// sync with it at startup) or "ui" (added through the web UI).
	`CREATE TABLE items (
		region     TEXT NOT NULL,
		slug       TEXT NOT NULL,
		source     TEXT NOT NULL,
		product_id TEXT,
		added_at   TEXT NOT NULL,
		PRIMARY KEY (region, slug)
	);`,
	// failed_at marks an event the notifier permanently rejected, so it stops
	// being retried (and stops blocking the events behind it).
	`ALTER TABLE events ADD COLUMN failed_at TEXT;
	DROP INDEX events_pending;
	CREATE INDEX events_pending ON events (id) WHERE notified_at IS NULL AND failed_at IS NULL;`,
}

type Store struct {
	db *sql.DB
}

// Open opens (creating if needed) the database at path and migrates it.
func Open(path string) (*Store, error) {
	// WAL lets the API read while the poller writes; busy_timeout covers the
	// brief moments writers collide. _txlock=immediate avoids upgrade deadlocks.
	dsn := fmt.Sprintf("file:%s?_txlock=immediate&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)&_pragma=synchronous(NORMAL)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("opening database %s: %w", path, err)
	}
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	var version int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return fmt.Errorf("reading schema version: %w", err)
	}
	for i := version; i < len(migrations); i++ {
		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(migrations[i]); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, i+1)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// Event is one detected change, joined with enough product detail to render.
type Event struct {
	ID                   int64      `json:"id"`
	Timestamp            time.Time  `json:"timestamp"`
	Region               string     `json:"region"`
	ProductID            string     `json:"product_id"`
	ProductSlug          string     `json:"product_slug"`
	ProductTitle         string     `json:"product_title"`
	VariantID            string     `json:"variant_id"`
	VariantSKU           string     `json:"variant_sku"`
	VariantTitle         string     `json:"variant_title"`
	Kind                 string     `json:"kind"`
	OldStatus            string     `json:"old_status,omitempty"`
	NewStatus            string     `json:"new_status,omitempty"`
	OldPriceCents        *int64     `json:"old_price_cents,omitempty"`
	NewPriceCents        *int64     `json:"new_price_cents,omitempty"`
	OldRegularPriceCents *int64     `json:"old_regular_price_cents,omitempty"`
	NewRegularPriceCents *int64     `json:"new_regular_price_cents,omitempty"`
	Currency             string     `json:"currency,omitempty"`
	NotifiedAt           *time.Time `json:"notified_at,omitempty"`
	FailedAt             *time.Time `json:"failed_at,omitempty"`
	// PreviousStateSince is when the variant entered OldStatus: the preceding
	// status change, or when we first saw the variant if there was none. It is
	// zero if unknown. PreviousStateSinceFirstSeen marks the latter case, where
	// the true duration may be longer than we can tell.
	PreviousStateSince          time.Time `json:"previous_state_since,omitzero"`
	PreviousStateSinceFirstSeen bool      `json:"previous_state_since_first_seen,omitempty"`
}

// VariantState is the latest observed state of a variant.
type VariantState struct {
	Region            string    `json:"region"`
	ProductID         string    `json:"product_id"`
	ProductSlug       string    `json:"product_slug"`
	ProductTitle      string    `json:"product_title"`
	VariantID         string    `json:"variant_id"`
	SKU               string    `json:"sku"`
	VariantTitle      string    `json:"variant_title"`
	Status            string    `json:"status"`
	PriceCents        *int64    `json:"price_cents"`
	RegularPriceCents *int64    `json:"regular_price_cents"`
	Currency          string    `json:"currency"`
	RestockETA        string    `json:"restock_eta,omitempty"`
	LastChecked       time.Time `json:"last_checked"`
	LastChanged       time.Time `json:"last_changed"`
}

func cents(m *unistore.Money) *int64 {
	if m == nil {
		return nil
	}
	return &m.Amount
}

func currency(v unistore.Variant) string {
	if v.Price != nil {
		return v.Price.Currency
	}
	if v.RegularPrice != nil {
		return v.RegularPrice.Currency
	}
	return ""
}

func equalCents(a, b *int64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func ts(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// Apply records an observation of a product in one transaction and returns
// the events it produced. A variant seen for the first time establishes a
// baseline and produces no events.
func (s *Store) Apply(ctx context.Context, region string, p *unistore.Product, now time.Time) ([]Event, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	_, err = tx.ExecContext(ctx, `
		INSERT INTO products (region, id, slug, name, title) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (region, id) DO UPDATE SET slug = excluded.slug, name = excluded.name, title = excluded.title`,
		region, p.ID, p.Slug, p.Name, p.Title)
	if err != nil {
		return nil, fmt.Errorf("upserting product: %w", err)
	}

	var events []Event
	for _, v := range p.Variants {
		newPrice, newRegular, cur := cents(v.Price), cents(v.RegularPrice), currency(v)

		var oldStatus string
		var oldPrice, oldRegular *int64
		err := tx.QueryRowContext(ctx,
			`SELECT status, price_cents, regular_price_cents FROM variants WHERE region = ? AND id = ?`,
			region, v.ID).Scan(&oldStatus, &oldPrice, &oldRegular)

		if err == sql.ErrNoRows {
			_, err = tx.ExecContext(ctx, `
				INSERT INTO variants (region, id, product_id, sku, title, status, price_cents, regular_price_cents,
					currency, restock_eta, first_seen, last_checked, last_changed)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				region, v.ID, p.ID, v.SKU, v.Title, v.Status, newPrice, newRegular, cur, v.RestockETA,
				ts(now), ts(now), ts(now))
			if err != nil {
				return nil, fmt.Errorf("inserting variant: %w", err)
			}
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("reading variant: %w", err)
		}

		changed := false
		if oldStatus != v.Status {
			changed = true
			e, err := insertEvent(ctx, tx, Event{
				Timestamp: now, Region: region, ProductID: p.ID, VariantID: v.ID, Kind: KindStatus,
				OldStatus: oldStatus, NewStatus: v.Status, Currency: cur,
				OldPriceCents: oldPrice, NewPriceCents: newPrice, NewRegularPriceCents: newRegular,
			})
			if err != nil {
				return nil, err
			}
			events = append(events, e)
		}
		if !equalCents(oldPrice, newPrice) || !equalCents(oldRegular, newRegular) {
			changed = true
			e, err := insertEvent(ctx, tx, Event{
				Timestamp: now, Region: region, ProductID: p.ID, VariantID: v.ID, Kind: KindPrice,
				NewStatus: v.Status, Currency: cur,
				OldPriceCents: oldPrice, NewPriceCents: newPrice,
				OldRegularPriceCents: oldRegular, NewRegularPriceCents: newRegular,
			})
			if err != nil {
				return nil, err
			}
			events = append(events, e)
		}

		lastChanged := "last_changed"
		if changed {
			lastChanged = "?"
		}
		args := []any{v.SKU, v.Title, v.Status, newPrice, newRegular, cur, v.RestockETA, ts(now)}
		if changed {
			args = append(args, ts(now))
		}
		args = append(args, region, v.ID)
		_, err = tx.ExecContext(ctx, `UPDATE variants SET sku = ?, title = ?, status = ?, price_cents = ?,
			regular_price_cents = ?, currency = ?, restock_eta = ?, last_checked = ?, last_changed = `+lastChanged+`
			WHERE region = ? AND id = ?`, args...)
		if err != nil {
			return nil, fmt.Errorf("updating variant: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.hydrate(ctx, events)
}

func insertEvent(ctx context.Context, tx *sql.Tx, e Event) (Event, error) {
	res, err := tx.ExecContext(ctx, `
		INSERT INTO events (ts, region, product_id, variant_id, kind, old_status, new_status,
			old_price_cents, new_price_cents, old_regular_price_cents, new_regular_price_cents, currency)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		ts(e.Timestamp), e.Region, e.ProductID, e.VariantID, e.Kind, e.OldStatus, e.NewStatus,
		e.OldPriceCents, e.NewPriceCents, e.OldRegularPriceCents, e.NewRegularPriceCents, e.Currency)
	if err != nil {
		return e, fmt.Errorf("inserting event: %w", err)
	}
	e.ID, err = res.LastInsertId()
	return e, err
}

const eventSelect = `
	SELECT e.id, e.ts, e.region, e.product_id, p.slug, p.title, e.variant_id, v.sku, v.title, e.kind,
		e.old_status, e.new_status, e.old_price_cents, e.new_price_cents,
		e.old_regular_price_cents, e.new_regular_price_cents, e.currency, e.notified_at, e.failed_at,
		(SELECT MAX(x.ts) FROM events x WHERE x.region = e.region AND x.variant_id = e.variant_id
			AND x.kind = 'status' AND x.id < e.id),
		v.first_seen
	FROM events e
	JOIN products p ON p.region = e.region AND p.id = e.product_id
	JOIN variants v ON v.region = e.region AND v.id = e.variant_id`

func scanEvents(rows *sql.Rows) ([]Event, error) {
	defer func() { _ = rows.Close() }()
	var out []Event
	for rows.Next() {
		var e Event
		var when string
		var notified, failed, prevStatusTS sql.NullString
		var firstSeen string
		if err := rows.Scan(&e.ID, &when, &e.Region, &e.ProductID, &e.ProductSlug, &e.ProductTitle,
			&e.VariantID, &e.VariantSKU, &e.VariantTitle, &e.Kind, &e.OldStatus, &e.NewStatus,
			&e.OldPriceCents, &e.NewPriceCents, &e.OldRegularPriceCents, &e.NewRegularPriceCents,
			&e.Currency, &notified, &failed, &prevStatusTS, &firstSeen); err != nil {
			return nil, err
		}
		e.Timestamp, _ = time.Parse(time.RFC3339, when)
		if prevStatusTS.Valid {
			e.PreviousStateSince, _ = time.Parse(time.RFC3339, prevStatusTS.String)
		} else {
			e.PreviousStateSince, _ = time.Parse(time.RFC3339, firstSeen)
			e.PreviousStateSinceFirstSeen = true
		}
		if notified.Valid {
			t, _ := time.Parse(time.RFC3339, notified.String)
			e.NotifiedAt = &t
		}
		if failed.Valid {
			t, _ := time.Parse(time.RFC3339, failed.String)
			e.FailedAt = &t
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// hydrate re-reads events with their joined product and variant details.
func (s *Store) hydrate(ctx context.Context, events []Event) ([]Event, error) {
	out := make([]Event, 0, len(events))
	for _, e := range events {
		rows, err := s.db.QueryContext(ctx, eventSelect+` WHERE e.id = ?`, e.ID)
		if err != nil {
			return nil, err
		}
		got, err := scanEvents(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, got...)
	}
	return out, nil
}

// PendingEvents returns events still waiting to be delivered, oldest first.
func (s *Store) PendingEvents(ctx context.Context) ([]Event, error) {
	rows, err := s.db.QueryContext(ctx, eventSelect+` WHERE e.notified_at IS NULL AND e.failed_at IS NULL ORDER BY e.id`)
	if err != nil {
		return nil, err
	}
	return scanEvents(rows)
}

// MarkFailed gives up on delivering an event.
func (s *Store) MarkFailed(ctx context.Context, id int64, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE events SET failed_at = ? WHERE id = ?`, ts(now), id)
	return err
}

func (s *Store) MarkNotified(ctx context.Context, id int64, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE events SET notified_at = ? WHERE id = ?`, ts(now), id)
	return err
}

// Events lists events with id > sinceID, oldest first. An empty region means all.
func (s *Store) Events(ctx context.Context, region string, sinceID int64, limit int) ([]Event, error) {
	rows, err := s.db.QueryContext(ctx,
		eventSelect+` WHERE e.id > ? AND (? = '' OR e.region = ?) ORDER BY e.id LIMIT ?`,
		sinceID, region, region, limit)
	if err != nil {
		return nil, err
	}
	return scanEvents(rows)
}

// Variants lists the latest state of every variant. An empty region means all.
func (s *Store) Variants(ctx context.Context, region string) ([]VariantState, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT v.region, v.product_id, p.slug, p.title, v.id, v.sku, v.title, v.status, v.price_cents,
			v.regular_price_cents, v.currency, v.restock_eta, v.last_checked, v.last_changed
		FROM variants v
		JOIN products p ON p.region = v.region AND p.id = v.product_id
		WHERE ? = '' OR v.region = ?
		ORDER BY v.region, p.slug, v.sku`, region, region)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var out []VariantState
	for rows.Next() {
		var v VariantState
		var checked, changed string
		if err := rows.Scan(&v.Region, &v.ProductID, &v.ProductSlug, &v.ProductTitle, &v.VariantID, &v.SKU,
			&v.VariantTitle, &v.Status, &v.PriceCents, &v.RegularPriceCents, &v.Currency, &v.RestockETA,
			&checked, &changed); err != nil {
			return nil, err
		}
		v.LastChecked, _ = time.Parse(time.RFC3339, checked)
		v.LastChanged, _ = time.Parse(time.RFC3339, changed)
		out = append(out, v)
	}
	return out, rows.Err()
}

const (
	SourceConfig = "config"
	SourceUI     = "ui"
)

// Item is one entry in the watch list.
type Item struct {
	Region  string
	Slug    string
	Source  string
	AddedAt time.Time
	// ProductID is set once a poll has resolved the slug to a product.
	ProductID string
}

// ItemKey identifies a watch list entry.
type ItemKey struct{ Region, Slug string }

// SyncConfigItems makes the config's items the complete set of config-sourced
// entries: new ones are added, and config-sourced ones no longer listed are
// removed. Items added through the UI are never removed. It returns how many
// were added and removed.
func (s *Store) SyncConfigItems(ctx context.Context, keys []ItemKey, now time.Time) (added, removed int, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback() }()

	want := make(map[ItemKey]bool, len(keys))
	for _, k := range keys {
		want[k] = true
		res, err := tx.ExecContext(ctx,
			`INSERT INTO items (region, slug, source, added_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT (region, slug) DO UPDATE SET source = excluded.source WHERE source != excluded.source`,
			k.Region, k.Slug, SourceConfig, ts(now))
		if err != nil {
			return 0, 0, fmt.Errorf("syncing item %s/%s: %w", k.Region, k.Slug, err)
		}
		if n, _ := res.RowsAffected(); n > 0 {
			added++
		}
	}

	rows, err := tx.QueryContext(ctx, `SELECT region, slug FROM items WHERE source = ?`, SourceConfig)
	if err != nil {
		return 0, 0, err
	}
	var stale []ItemKey
	for rows.Next() {
		var k ItemKey
		if err := rows.Scan(&k.Region, &k.Slug); err != nil {
			_ = rows.Close()
			return 0, 0, err
		}
		if !want[k] {
			stale = append(stale, k)
		}
	}
	if err := rows.Close(); err != nil {
		return 0, 0, err
	}
	for _, k := range stale {
		if _, err := tx.ExecContext(ctx, `DELETE FROM items WHERE region = ? AND slug = ?`, k.Region, k.Slug); err != nil {
			return 0, 0, err
		}
		removed++
	}
	return added, removed, tx.Commit()
}

// AddItem adds an entry if it isn't already on the list, reporting whether it was new.
func (s *Store) AddItem(ctx context.Context, region, slug, source, productID string, now time.Time) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO items (region, slug, source, product_id, added_at) VALUES (?, ?, ?, NULLIF(?, ''), ?)
		 ON CONFLICT (region, slug) DO NOTHING`, region, slug, source, productID, ts(now))
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// LinkItem records which product a slug resolved to.
func (s *Store) LinkItem(ctx context.Context, region, slug, productID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE items SET product_id = ? WHERE region = ? AND slug = ? AND product_id IS NOT ?`,
		productID, region, slug, productID)
	return err
}

// Items lists the watch list.
func (s *Store) Items(ctx context.Context) ([]Item, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT region, slug, source, COALESCE(product_id, ''), added_at FROM items ORDER BY region, slug`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Item
	for rows.Next() {
		var it Item
		var added string
		if err := rows.Scan(&it.Region, &it.Slug, &it.Source, &it.ProductID, &added); err != nil {
			return nil, err
		}
		it.AddedAt, _ = time.Parse(time.RFC3339, added)
		out = append(out, it)
	}
	return out, rows.Err()
}

// HasProduct reports whether a product has ever been observed.
func (s *Store) HasProduct(ctx context.Context, region, id string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM products WHERE region = ? AND id = ?`, region, id).Scan(&n)
	return n > 0, err
}

// Stats are counts for the metrics endpoint.
type Stats struct {
	Items            int
	PendingEvents    int
	VariantsByStatus map[string]int
}

// Stats counts watched items, undelivered events, and variants by status.
func (s *Store) Stats(ctx context.Context) (Stats, error) {
	st := Stats{VariantsByStatus: map[string]int{}}
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM items`).Scan(&st.Items); err != nil {
		return st, err
	}
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM events WHERE notified_at IS NULL AND failed_at IS NULL`).Scan(&st.PendingEvents); err != nil {
		return st, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT status, COUNT(*) FROM variants GROUP BY status`)
	if err != nil {
		return st, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var status string
		var n int
		if err := rows.Scan(&status, &n); err != nil {
			return st, err
		}
		st.VariantsByStatus[status] = n
	}
	return st, rows.Err()
}

// Backup writes a consistent copy of the whole database to dest while the
// service keeps running (VACUUM INTO reads a snapshot, so it neither blocks
// the poller's writes nor copies a half-written file). The copy is built under
// a temporary name and renamed into place, so dest is either absent or complete.
func (s *Store) Backup(ctx context.Context, dest string) error {
	tmp := dest + ".tmp"
	if err := os.Remove(tmp); err != nil && !os.IsNotExist(err) {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `VACUUM INTO ?`, tmp); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("backing up database: %w", err)
	}
	return os.Rename(tmp, dest)
}
