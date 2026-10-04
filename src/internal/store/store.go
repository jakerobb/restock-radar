// Package store persists current variant state and the history of changes in
// SQLite. The pure-Go driver keeps the binary CGO-free.
package store

import (
	"context"
	"database/sql"
	"fmt"
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
				NewPriceCents: newPrice, NewRegularPriceCents: newRegular,
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
		e.old_regular_price_cents, e.new_regular_price_cents, e.currency, e.notified_at
	FROM events e
	JOIN products p ON p.region = e.region AND p.id = e.product_id
	JOIN variants v ON v.region = e.region AND v.id = e.variant_id`

func scanEvents(rows *sql.Rows) ([]Event, error) {
	defer func() { _ = rows.Close() }()
	var out []Event
	for rows.Next() {
		var e Event
		var when string
		var notified sql.NullString
		if err := rows.Scan(&e.ID, &when, &e.Region, &e.ProductID, &e.ProductSlug, &e.ProductTitle,
			&e.VariantID, &e.VariantSKU, &e.VariantTitle, &e.Kind, &e.OldStatus, &e.NewStatus,
			&e.OldPriceCents, &e.NewPriceCents, &e.OldRegularPriceCents, &e.NewRegularPriceCents,
			&e.Currency, &notified); err != nil {
			return nil, err
		}
		e.Timestamp, _ = time.Parse(time.RFC3339, when)
		if notified.Valid {
			t, _ := time.Parse(time.RFC3339, notified.String)
			e.NotifiedAt = &t
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

// PendingEvents returns events not yet notified, oldest first.
func (s *Store) PendingEvents(ctx context.Context) ([]Event, error) {
	rows, err := s.db.QueryContext(ctx, eventSelect+` WHERE e.notified_at IS NULL ORDER BY e.id`)
	if err != nil {
		return nil, err
	}
	return scanEvents(rows)
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
