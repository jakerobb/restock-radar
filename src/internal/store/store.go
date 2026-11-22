// Package store persists current variant state and the history of changes in
// SQLite. The pure-Go driver keeps the binary CGO-free.
package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

const (
	KindStatus = "status"
	KindPrice  = "price"
	// KindNew marks a product we hadn't seen before, found on a category page.
	KindNew = "new"
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
	// The store's category id, which the UI groups products by.
	`ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT '';`,
	// Categories whose product lists we have ingested. A product that turns up in
	// one of these is new to the store; in any other it is just new to us.
	`CREATE TABLE categories (
		region     TEXT NOT NULL,
		id         TEXT NOT NULL,
		first_seen TEXT NOT NULL,
		PRIMARY KEY (region, id)
	);`,
	// The store's tags for a product, as a JSON array; empty until first seen.
	`ALTER TABLE products ADD COLUMN tags TEXT NOT NULL DEFAULT '';`,
	// The store collection a product belongs to; the UI shows products sharing
	// one as a single product. Empty when standalone or not yet seen.
	`ALTER TABLE products ADD COLUMN collection TEXT NOT NULL DEFAULT '';`,
	// Surcharges (memory, tariffs, ...) the store adds to the base price. The
	// variant's price including them is its latest state only: a change in it
	// raises no event. surcharge_types is a JSON array of the product's
	// surcharge kinds, empty until first seen.
	`ALTER TABLE variants ADD COLUMN surcharge_price_cents INTEGER;
	ALTER TABLE products ADD COLUMN surcharge_types TEXT NOT NULL DEFAULT '';`,
	// Events carry the price including surcharges and the surcharge types before
	// and after, so a notification can say which of them changed. NULL / empty
	// means unknown (the response didn't say).
	`ALTER TABLE events ADD COLUMN old_total_cents INTEGER;
	ALTER TABLE events ADD COLUMN new_total_cents INTEGER;
	ALTER TABLE events ADD COLUMN old_surcharge_types TEXT NOT NULL DEFAULT '';
	ALTER TABLE events ADD COLUMN new_surcharge_types TEXT NOT NULL DEFAULT '';`,
	// short_title is the store's compact product name. group_title is the title the
	// store's breadcrumbs file the product under; products sharing one are shown
	// as a unit. detailed_at is when the product endpoint last supplied the
	// product, the only source of group_title; NULL until then.
	`ALTER TABLE products ADD COLUMN short_title TEXT NOT NULL DEFAULT '';
	ALTER TABLE products ADD COLUMN group_title TEXT NOT NULL DEFAULT '';
	ALTER TABLE products ADD COLUMN detailed_at TEXT;`,
	// techspecs_url is the product's page on techspecs.ui.com, empty when it has
	// none (or hasn't been checked). techspecs_checked_at is when we last looked,
	// so the oldest checks are the ones repeated; NULL until the first.
	`ALTER TABLE products ADD COLUMN techspecs_url TEXT NOT NULL DEFAULT '';
	ALTER TABLE products ADD COLUMN techspecs_checked_at TEXT;`,
	// The store's technical specification for a product, as the product endpoint
	// lists it, one row per entry in the store's order (position). It is kept as
	// the store gives it, text values and all; anything that wants numbers or
	// ports is derived from it. specs_hash identifies the stored rows, so an
	// unchanged specification isn't rewritten; specs_fetched_at is when the product
	// endpoint last supplied the product (NULL until then), which is what decides
	// when it is next fetched. feature_id repeats across sections, so it isn't a key.
	`ALTER TABLE products ADD COLUMN specs_hash TEXT NOT NULL DEFAULT '';
	ALTER TABLE products ADD COLUMN specs_fetched_at TEXT;
	CREATE TABLE product_specs (
		region            TEXT NOT NULL,
		product_id        TEXT NOT NULL,
		position          INTEGER NOT NULL,
		section_id        TEXT NOT NULL,
		section           TEXT NOT NULL,
		section_type      TEXT NOT NULL,
		feature_id        TEXT NOT NULL,
		parent_feature_id TEXT NOT NULL DEFAULT '',
		label             TEXT NOT NULL,
		kind              TEXT NOT NULL,
		value             TEXT NOT NULL DEFAULT '',
		note              TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (region, product_id, position),
		FOREIGN KEY (region, product_id) REFERENCES products (region, id) ON DELETE CASCADE
	);
	CREATE INDEX product_specs_feature ON product_specs (feature_id);`,
	// The user's corrections to a product's specification, and what is derived
	// from the specification once they are applied. An override is found by its
	// target (section, group, label) and the product's slug, not by the store's
	// ids or row positions, because the specification is rewritten whenever the
	// store changes it. published_value is what the store published when the
	// override was made, to notice when it moves. The derived tables are rebuilt
	// from product_specs and spec_overrides: version says which derivation made
	// them, so a newer one re-derives from the stored rows alone.
	`CREATE TABLE spec_overrides (
		id              INTEGER PRIMARY KEY AUTOINCREMENT,
		region          TEXT NOT NULL,
		slug            TEXT NOT NULL,
		action          TEXT NOT NULL,
		section         TEXT NOT NULL,
		group_label     TEXT NOT NULL DEFAULT '',
		label           TEXT NOT NULL,
		kind            TEXT NOT NULL DEFAULT '',
		value           TEXT NOT NULL DEFAULT '',
		note            TEXT NOT NULL DEFAULT '',
		source_url      TEXT NOT NULL DEFAULT '',
		reason          TEXT NOT NULL DEFAULT '',
		published_value TEXT,
		created_at      TEXT NOT NULL,
		updated_at      TEXT NOT NULL
	);
	CREATE UNIQUE INDEX spec_overrides_target ON spec_overrides (region, slug, lower(section), lower(group_label), lower(label));
	CREATE TABLE product_derived (
		region        TEXT NOT NULL,
		product_id    TEXT NOT NULL,
		version       INTEGER NOT NULL,
		derived_at    TEXT NOT NULL,
		known_ports   INTEGER NOT NULL,
		known_poe     INTEGER NOT NULL,
		known_radios  INTEGER NOT NULL,
		known_rack    INTEGER NOT NULL,
		known_dims    INTEGER NOT NULL,
		poe_max_class TEXT NOT NULL DEFAULT '',
		rackmount     INTEGER NOT NULL DEFAULT 0,
		rack_units    INTEGER NOT NULL DEFAULT 0,
		full_depth    INTEGER NOT NULL DEFAULT 0,
		dim_min_mm    REAL,
		dim_mid_mm    REAL,
		dim_max_mm    REAL,
		dim_round     INTEGER NOT NULL DEFAULT 0,
		width_mm      REAL,
		depth_mm      REAL,
		height_mm     REAL,
		overridden    TEXT NOT NULL DEFAULT '{}',
		issues        TEXT NOT NULL DEFAULT '[]',
		PRIMARY KEY (region, product_id),
		FOREIGN KEY (region, product_id) REFERENCES products (region, id) ON DELETE CASCADE
	);
	CREATE TABLE product_ports (
		region         TEXT NOT NULL,
		product_id     TEXT NOT NULL,
		position       INTEGER NOT NULL,
		label          TEXT NOT NULL,
		media          TEXT NOT NULL,
		role           TEXT NOT NULL,
		count          INTEGER NOT NULL,
		max_speed_mbps INTEGER NOT NULL,
		speeds_mbps    TEXT NOT NULL DEFAULT '',
		poe_class      TEXT NOT NULL DEFAULT '',
		poe_direction  TEXT NOT NULL DEFAULT '',
		poe_inferred   INTEGER NOT NULL DEFAULT 0,
		poe_watts      REAL,
		combo          INTEGER NOT NULL DEFAULT 0,
		note           TEXT NOT NULL DEFAULT '',
		source         TEXT NOT NULL,
		PRIMARY KEY (region, product_id, position),
		FOREIGN KEY (region, product_id) REFERENCES products (region, id) ON DELETE CASCADE
	);
	CREATE INDEX product_ports_search ON product_ports (media, max_speed_mbps, poe_class, poe_direction);
	CREATE TABLE product_poe_budget (
		region     TEXT NOT NULL,
		product_id TEXT NOT NULL,
		position   INTEGER NOT NULL,
		name       TEXT NOT NULL DEFAULT '',
		watts      REAL NOT NULL,
		selected   INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (region, product_id, position),
		FOREIGN KEY (region, product_id) REFERENCES products (region, id) ON DELETE CASCADE
	);
	CREATE TABLE product_radios (
		region                TEXT NOT NULL,
		product_id            TEXT NOT NULL,
		band                  TEXT NOT NULL,
		tech                  TEXT NOT NULL,
		antenna_gain_dbi      REAL,
		tx_power_dbm          REAL,
		tx_power_extended_dbm REAL,
		streams               INTEGER,
		max_rate_mbps         REAL,
		multi                 INTEGER NOT NULL DEFAULT 0,
		antenna_gain_raw      TEXT NOT NULL DEFAULT '',
		tx_power_raw          TEXT NOT NULL DEFAULT '',
		tx_power_note         TEXT NOT NULL DEFAULT '',
		mimo_raw              TEXT NOT NULL DEFAULT '',
		max_rate_raw          TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (region, product_id, band),
		FOREIGN KEY (region, product_id) REFERENCES products (region, id) ON DELETE CASCADE
	);
	CREATE INDEX product_radios_band ON product_radios (band);
	CREATE TABLE product_metrics (
		region     TEXT NOT NULL,
		product_id TEXT NOT NULL,
		name       TEXT NOT NULL,
		value      REAL NOT NULL,
		unit       TEXT NOT NULL DEFAULT '',
		at_least   INTEGER NOT NULL DEFAULT 0,
		raw        TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (region, product_id, name),
		FOREIGN KEY (region, product_id) REFERENCES products (region, id) ON DELETE CASCADE
	);
	CREATE INDEX product_metrics_name ON product_metrics (name, value);`,
	// Who changed an override, and an append-only record of every change, so
	// corrections can be reviewed and undone. A history row says what the override
	// looked like before and after (as JSON; null before a creation and after a
	// deletion) and is not tied to the override by a foreign key, since the
	// override may be gone.
	`ALTER TABLE spec_overrides ADD COLUMN created_by TEXT NOT NULL DEFAULT '';
	ALTER TABLE spec_overrides ADD COLUMN updated_by TEXT NOT NULL DEFAULT '';
	CREATE TABLE spec_override_history (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		at          TEXT NOT NULL,
		actor       TEXT NOT NULL,
		change      TEXT NOT NULL,
		override_id INTEGER NOT NULL,
		region      TEXT NOT NULL,
		slug        TEXT NOT NULL,
		before      TEXT,
		after       TEXT
	);
	CREATE INDEX spec_override_history_product ON spec_override_history (region, slug, id);`,

	// How each product is powered, derived from "Power Method".
	`CREATE TABLE product_power (
		region     TEXT NOT NULL,
		product_id TEXT NOT NULL,
		position   INTEGER NOT NULL,
		kind       TEXT NOT NULL,
		poe_class  TEXT NOT NULL DEFAULT '',
		detail     TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (region, product_id, position),
		FOREIGN KEY (region, product_id) REFERENCES products (region, id) ON DELETE CASCADE
	);`,
	// A small, stable number for every variant, for links that must be short (a shared build plan).
	// AUTOINCREMENT, so a number is never given to a second variant, whatever is deleted. Existing
	// variants are numbered oldest first.
	`CREATE TABLE variant_numbers (
		num        INTEGER PRIMARY KEY AUTOINCREMENT,
		region     TEXT NOT NULL,
		variant_id TEXT NOT NULL,
		UNIQUE (region, variant_id)
	);
	INSERT INTO variant_numbers (region, variant_id) SELECT region, id FROM variants ORDER BY first_seen, region, id;`,
	// A variant the store no longer lists for its product (renamed, replaced) is kept, for its history and so
	// that links to it still read, but marked so that it isn't offered or counted. Empty while it is listed.
	`ALTER TABLE variants ADD COLUMN delisted_at TEXT NOT NULL DEFAULT '';`,
	// Products the store sells with another on its page (a gateway's SSDs): which, in the store's order.
	`CREATE TABLE linked_products (
		region     TEXT NOT NULL,
		product_id TEXT NOT NULL,
		linked_id  TEXT NOT NULL,
		position   INTEGER NOT NULL,
		PRIMARY KEY (region, product_id, linked_id)
	);`,
	// What the store's page calls each choice: "1 TB" for a linked product, "No Storage" for having none of them.
	`ALTER TABLE linked_products ADD COLUMN label TEXT NOT NULL DEFAULT '';
	ALTER TABLE products ADD COLUMN linked_base_label TEXT NOT NULL DEFAULT '';`,
	// Products for which the store publishes no tech specs and none are expected (a cable, a mounting
	// bracket), so a plan holding one shouldn't be called unsure for lack of them. It is keyed by the
	// product's slug without its region suffix, so that one entry covers the product in every region.
	`CREATE TABLE specs_not_expected (
		slug       TEXT PRIMARY KEY,
		reason     TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL,
		created_by TEXT NOT NULL DEFAULT ''
	);`,
	// What the store called the size the dimensions were read from ("Device",
	// "Without mount"); empty when it gave one, unlabelled.
	`ALTER TABLE product_derived ADD COLUMN dim_label TEXT NOT NULL DEFAULT '';`,
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
	ID                   int64     `json:"id"`
	Timestamp            time.Time `json:"timestamp"`
	Region               string    `json:"region"`
	ProductID            string    `json:"product_id"`
	ProductSlug          string    `json:"product_slug"`
	ProductTitle         string    `json:"product_title"`
	VariantID            string    `json:"variant_id"`
	VariantSKU           string    `json:"variant_sku"`
	VariantTitle         string    `json:"variant_title"`
	Kind                 string    `json:"kind"`
	OldStatus            string    `json:"old_status,omitempty"`
	NewStatus            string    `json:"new_status,omitempty"`
	OldPriceCents        *int64    `json:"old_price_cents,omitempty"`
	NewPriceCents        *int64    `json:"new_price_cents,omitempty"`
	OldRegularPriceCents *int64    `json:"old_regular_price_cents,omitempty"`
	NewRegularPriceCents *int64    `json:"new_regular_price_cents,omitempty"`
	// Old/NewTotalCents are the prices including surcharges; nil when not known (see TotalOld, TotalNew).
	OldTotalCents *int64 `json:"old_total_cents,omitempty"`
	NewTotalCents *int64 `json:"new_total_cents,omitempty"`
	// Old/NewSurchargeTypes are the product's surcharge kinds around the event; nil when not known.
	OldSurchargeTypes []string `json:"old_surcharge_types,omitempty"`
	NewSurchargeTypes []string `json:"new_surcharge_types,omitempty"`
	Currency          string   `json:"currency,omitempty"`
	// VariantCount is how many variants the product has now.
	VariantCount int        `json:"variant_count"`
	NotifiedAt   *time.Time `json:"notified_at,omitempty"`
	FailedAt     *time.Time `json:"failed_at,omitempty"`
	// PreviousStateSince is when the variant entered OldStatus: the preceding
	// status change, or when we first saw the variant if there was none. It is
	// zero if unknown. PreviousStateSinceFirstSeen marks the latter case, where
	// the true duration may be longer than we can tell.
	PreviousStateSince          time.Time `json:"previous_state_since,omitzero"`
	PreviousStateSinceFirstSeen bool      `json:"previous_state_since_first_seen,omitempty"`
}

// TotalOld is the price including surcharges before the event, falling back to
// the base price when the surcharge-inclusive one wasn't recorded.
func (e Event) TotalOld() *int64 { return firstNonNil(e.OldTotalCents, e.OldPriceCents) }

// TotalNew is the price including surcharges after the event, with the same fallback.
func (e Event) TotalNew() *int64 { return firstNonNil(e.NewTotalCents, e.NewPriceCents) }

func firstNonNil(a, b *int64) *int64 {
	if a != nil {
		return a
	}
	return b
}

// VariantState is the latest observed state of a variant.
type VariantState struct {
	// Delisted is true when the store no longer lists the variant for its product.
	Delisted          bool     `json:"delisted,omitempty"`
	Region            string   `json:"region"`
	ProductID         string   `json:"product_id"`
	ProductSlug       string   `json:"product_slug"`
	ProductTitle      string   `json:"product_title"`
	ProductCategory   string   `json:"product_category"`
	ProductTags       []string `json:"product_tags"`
	ProductCollection string   `json:"product_collection"`
	// ProductShortTitle and ProductGroup are empty until a poll has seen them.
	ProductShortTitle string `json:"product_short_title"`
	ProductGroup      string `json:"product_group"`
	// ProductTechSpecsURL is the product's page on the tech specs site; empty when it has none or isn't checked yet.
	ProductTechSpecsURL string `json:"product_techspecs_url"`
	VariantID           string `json:"variant_id"`
	// Num is the variant's permanent number, small enough to put in a link.
	Num               int    `json:"num"`
	SKU               string `json:"sku"`
	VariantTitle      string `json:"variant_title"`
	Status            string `json:"status"`
	PriceCents        *int64 `json:"price_cents"`
	RegularPriceCents *int64 `json:"regular_price_cents"`
	// PriceWithSurchargesCents is PriceCents plus surcharges; null until a poll has seen it.
	PriceWithSurchargesCents *int64 `json:"price_with_surcharges_cents"`
	// SurchargeTypes are the kinds of surcharge on the product ("Memory", ...); empty when none.
	SurchargeTypes []string  `json:"surcharge_types"`
	Currency       string    `json:"currency"`
	RestockETA     string    `json:"restock_eta,omitempty"`
	LastChecked    time.Time `json:"last_checked"`
	LastChanged    time.Time `json:"last_changed"`
	FirstSeen      time.Time `json:"first_seen"`
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

// typesJSON encodes surcharge types for storage; nil (unknown) is "".
func typesJSON(types []string) string {
	if types == nil {
		return ""
	}
	b, _ := json.Marshal(types) // a string slice always encodes
	return string(b)
}

// parseTypes is the inverse of typesJSON; anything unreadable is unknown.
func parseTypes(s string) []string {
	if s == "" {
		return nil
	}
	var types []string
	if json.Unmarshal([]byte(s), &types) != nil {
		return nil
	}
	return types
}

// sameTypes reports whether two lists name the same set of surcharge types.
func sameTypes(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for _, t := range a {
		if !slices.Contains(b, t) {
			return false
		}
	}
	return true
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

	events, err := applyTx(ctx, tx, region, p, now)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.hydrate(ctx, events)
}

// Discover starts tracking a product we have never seen: it joins the watch
// list, its current state becomes the baseline, and, if announce is set, a
// "new" event is queued for notification. All of it happens in one transaction,
// so a product is never tracked without its announcement. It returns the event,
// or nil when announce is false.
func (s *Store) Discover(ctx context.Context, region string, p *unistore.Product, announce bool, now time.Time) (*Event, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO items (region, slug, source, product_id, added_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (region, slug) DO UPDATE SET product_id = excluded.product_id WHERE product_id IS NULL`,
		region, p.Slug, SourceDiscovered, p.ID, ts(now)); err != nil {
		return nil, fmt.Errorf("adding discovered item: %w", err)
	}
	if _, err := applyTx(ctx, tx, region, p, now); err != nil {
		return nil, err
	}
	if !announce {
		return nil, tx.Commit()
	}

	// Events hang off a variant, so the product's first one stands in.
	v := p.Variants[0]
	e, err := insertEvent(ctx, tx, Event{
		Timestamp: now, Region: region, ProductID: p.ID, VariantID: v.ID, Kind: KindNew,
		NewStatus: v.Status, Currency: currency(v), NewPriceCents: cents(v.Price), NewRegularPriceCents: cents(v.RegularPrice),
		NewTotalCents: cents(v.PriceWithSurcharges),
	})
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	got, err := s.hydrate(ctx, []Event{e})
	if err != nil || len(got) == 0 {
		return nil, err
	}
	return &got[0], nil
}

// applyTx upserts a product and its variants, returning the (unhydrated)
// events the observation produced.
func applyTx(ctx context.Context, tx *sql.Tx, region string, p *unistore.Product, now time.Time) ([]Event, error) {
	// An observation that doesn't mention tags leaves the stored ones alone.
	tags := ""
	if p.Tags != nil {
		b, err := json.Marshal(p.Tags)
		if err != nil {
			return nil, err
		}
		tags = string(b)
	}
	surcharges := typesJSON(p.SurchargeTypes)
	var detailedAt *string
	if p.Detailed {
		t := ts(now)
		detailedAt = &t
	}
	var storedTypes string
	if err := tx.QueryRowContext(ctx, `SELECT surcharge_types FROM products WHERE region = ? AND id = ?`, region, p.ID).Scan(&storedTypes); err != nil && err != sql.ErrNoRows {
		return nil, fmt.Errorf("reading product: %w", err)
	}
	// Unknown (nil) on either side means there's nothing to compare.
	oldTypes, newTypes := parseTypes(storedTypes), p.SurchargeTypes
	_, err := tx.ExecContext(ctx, `
		INSERT INTO products (region, id, slug, name, title, category, tags, collection, surcharge_types, short_title, group_title, detailed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (region, id) DO UPDATE SET slug = excluded.slug, name = excluded.name, title = excluded.title,
			short_title = CASE WHEN excluded.short_title = '' THEN products.short_title ELSE excluded.short_title END,
			group_title = CASE WHEN excluded.group_title = '' THEN products.group_title ELSE excluded.group_title END,
			detailed_at = COALESCE(excluded.detailed_at, products.detailed_at),
			category = CASE WHEN excluded.category = '' THEN products.category ELSE excluded.category END,
			tags = CASE WHEN excluded.tags = '' THEN products.tags ELSE excluded.tags END,
			collection = CASE WHEN excluded.collection = '' THEN products.collection ELSE excluded.collection END,
			surcharge_types = CASE WHEN excluded.surcharge_types = '' THEN products.surcharge_types ELSE excluded.surcharge_types END`,
		region, p.ID, p.Slug, p.Name, p.Title, p.Category, tags, p.Collection, surcharges, p.ShortTitle, p.Group, detailedAt)
	if err != nil {
		return nil, fmt.Errorf("upserting product: %w", err)
	}
	if p.Detailed {
		if err := applySpecs(ctx, tx, region, p, now); err != nil {
			return nil, err
		}
	}

	var events []Event
	for _, v := range p.Variants {
		newPrice, newRegular, cur := cents(v.Price), cents(v.RegularPrice), currency(v)
		newTotal := cents(v.PriceWithSurcharges)

		var oldStatus string
		var oldPrice, oldRegular, oldTotal *int64
		err := tx.QueryRowContext(ctx,
			`SELECT status, price_cents, regular_price_cents, surcharge_price_cents FROM variants WHERE region = ? AND id = ?`,
			region, v.ID).Scan(&oldStatus, &oldPrice, &oldRegular, &oldTotal)

		if err == sql.ErrNoRows {
			_, err = tx.ExecContext(ctx, `
				INSERT INTO variants (region, id, product_id, sku, title, status, price_cents, regular_price_cents,
					surcharge_price_cents, currency, restock_eta, first_seen, last_checked, last_changed)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				region, v.ID, p.ID, v.SKU, v.Title, v.Status, newPrice, newRegular, newTotal, cur, v.RestockETA,
				ts(now), ts(now), ts(now))
			if err != nil {
				return nil, fmt.Errorf("inserting variant: %w", err)
			}
			if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO variant_numbers (region, variant_id) VALUES (?, ?)`, region, v.ID); err != nil {
				return nil, fmt.Errorf("numbering variant: %w", err)
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
				OldTotalCents: oldTotal, NewTotalCents: newTotal,
			})
			if err != nil {
				return nil, err
			}
			events = append(events, e)
		}
		// A change in the surcharges counts as a price change: the amount, or a
		// type added or removed. Nothing is compared against an unknown.
		surchargeChanged := (oldTotal != nil && newTotal != nil && *oldTotal != *newTotal) ||
			(oldTypes != nil && newTypes != nil && !sameTypes(oldTypes, newTypes))
		if !equalCents(oldPrice, newPrice) || !equalCents(oldRegular, newRegular) || surchargeChanged {
			changed = true
			e, err := insertEvent(ctx, tx, Event{
				Timestamp: now, Region: region, ProductID: p.ID, VariantID: v.ID, Kind: KindPrice,
				NewStatus: v.Status, Currency: cur,
				OldPriceCents: oldPrice, NewPriceCents: newPrice,
				OldRegularPriceCents: oldRegular, NewRegularPriceCents: newRegular,
				OldTotalCents: oldTotal, NewTotalCents: newTotal,
				OldSurchargeTypes: oldTypes, NewSurchargeTypes: newTypes,
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
		args := []any{v.SKU, v.Title, v.Status, newPrice, newRegular, newTotal, cur, v.RestockETA, ts(now)}
		if changed {
			args = append(args, ts(now))
		}
		args = append(args, region, v.ID)
		_, err = tx.ExecContext(ctx, `UPDATE variants SET sku = ?, title = ?, status = ?, price_cents = ?,
			regular_price_cents = ?, surcharge_price_cents = ?, currency = ?, restock_eta = ?, last_checked = ?, delisted_at = '', last_changed = `+lastChanged+`
			WHERE region = ? AND id = ?`, args...)
		if err != nil {
			return nil, fmt.Errorf("updating variant: %w", err)
		}
	}

	// What the store lists is the whole product, so a variant of it that isn't there any more has been taken off.
	listed := make([]any, 0, len(p.Variants)+3)
	listed = append(listed, ts(now), region, p.ID)
	marks := make([]string, 0, len(p.Variants))
	for _, v := range p.Variants {
		listed = append(listed, v.ID)
		marks = append(marks, "?")
	}
	if _, err := tx.ExecContext(ctx, `UPDATE variants SET delisted_at = ? WHERE region = ? AND product_id = ? AND delisted_at = '' AND id NOT IN (`+strings.Join(marks, ",")+`)`, listed...); err != nil {
		return nil, fmt.Errorf("marking delisted variants: %w", err)
	}

	// Products sold alongside it are tracked as products of their own (without being watched: they have no
	// product page to read, so nothing more is learned of them than the category page says), unless
	// something already tracks them, whose own observation is the better one.
	if p.Linked != nil {
		// Category pages don't word the choices, so what a product page said earlier is kept.
		labels := map[string]string{}
		old, err := tx.QueryContext(ctx, `SELECT linked_id, label FROM linked_products WHERE region = ? AND product_id = ?`, region, p.ID)
		if err != nil {
			return nil, fmt.Errorf("reading linked products: %w", err)
		}
		for old.Next() {
			var id, label string
			if err := old.Scan(&id, &label); err != nil {
				_ = old.Close()
				return nil, err
			}
			labels[id] = label
		}
		if err := old.Close(); err != nil {
			return nil, err
		}
		for id, label := range p.LinkLabels {
			labels[id] = label
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM linked_products WHERE region = ? AND product_id = ?`, region, p.ID); err != nil {
			return nil, fmt.Errorf("clearing linked products: %w", err)
		}
		if p.LinkBaseLabel != "" {
			if _, err := tx.ExecContext(ctx, `UPDATE products SET linked_base_label = ? WHERE region = ? AND id = ?`, p.LinkBaseLabel, region, p.ID); err != nil {
				return nil, fmt.Errorf("saving the label of having none: %w", err)
			}
		}
		for i := range p.Linked {
			l := &p.Linked[i]
			if _, err := tx.ExecContext(ctx, `INSERT OR REPLACE INTO linked_products (region, product_id, linked_id, position, label) VALUES (?, ?, ?, ?, ?)`, region, p.ID, l.ID, i, labels[l.ID]); err != nil {
				return nil, fmt.Errorf("linking product: %w", err)
			}
			var watched int
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM items WHERE region = ? AND product_id = ?`, region, l.ID).Scan(&watched); err != nil {
				return nil, fmt.Errorf("reading items: %w", err)
			}
			if watched > 0 {
				continue
			}
			evs, err := applyTx(ctx, tx, region, l, now)
			if err != nil {
				return nil, err
			}
			events = append(events, evs...)
		}
	}

	return events, nil
}

func insertEvent(ctx context.Context, tx *sql.Tx, e Event) (Event, error) {
	res, err := tx.ExecContext(ctx, `
		INSERT INTO events (ts, region, product_id, variant_id, kind, old_status, new_status,
			old_price_cents, new_price_cents, old_regular_price_cents, new_regular_price_cents, currency,
			old_total_cents, new_total_cents, old_surcharge_types, new_surcharge_types)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		ts(e.Timestamp), e.Region, e.ProductID, e.VariantID, e.Kind, e.OldStatus, e.NewStatus,
		e.OldPriceCents, e.NewPriceCents, e.OldRegularPriceCents, e.NewRegularPriceCents, e.Currency,
		e.OldTotalCents, e.NewTotalCents, typesJSON(e.OldSurchargeTypes), typesJSON(e.NewSurchargeTypes))
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
		e.old_total_cents, e.new_total_cents, e.old_surcharge_types, e.new_surcharge_types,
		(SELECT COUNT(*) FROM variants c WHERE c.region = e.region AND c.product_id = e.product_id AND c.delisted_at = ''),
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
		var firstSeen, oldTypes, newTypes string
		if err := rows.Scan(&e.ID, &when, &e.Region, &e.ProductID, &e.ProductSlug, &e.ProductTitle,
			&e.VariantID, &e.VariantSKU, &e.VariantTitle, &e.Kind, &e.OldStatus, &e.NewStatus,
			&e.OldPriceCents, &e.NewPriceCents, &e.OldRegularPriceCents, &e.NewRegularPriceCents,
			&e.Currency, &notified, &failed, &e.OldTotalCents, &e.NewTotalCents, &oldTypes, &newTypes,
			&e.VariantCount, &prevStatusTS, &firstSeen); err != nil {
			return nil, err
		}
		e.OldSurchargeTypes, e.NewSurchargeTypes = parseTypes(oldTypes), parseTypes(newTypes)
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
		SELECT v.region, v.product_id, p.slug, p.title, p.short_title, p.group_title, p.techspecs_url, p.category, p.tags, p.collection, v.id, n.num, v.sku, v.title, v.status, v.price_cents,
			v.regular_price_cents, v.surcharge_price_cents, p.surcharge_types, v.currency, v.restock_eta, v.last_checked, v.last_changed, v.first_seen, v.delisted_at != ''
		FROM variants v
		JOIN products p ON p.region = v.region AND p.id = v.product_id
		JOIN variant_numbers n ON n.region = v.region AND n.variant_id = v.id
		WHERE ? = '' OR v.region = ?
		ORDER BY v.region, p.slug, v.sku`, region, region)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var out []VariantState
	for rows.Next() {
		var v VariantState
		var checked, changed, first, tags, surcharges string
		if err := rows.Scan(&v.Region, &v.ProductID, &v.ProductSlug, &v.ProductTitle, &v.ProductShortTitle, &v.ProductGroup, &v.ProductTechSpecsURL, &v.ProductCategory, &tags, &v.ProductCollection, &v.VariantID, &v.Num, &v.SKU,
			&v.VariantTitle, &v.Status, &v.PriceCents, &v.RegularPriceCents, &v.PriceWithSurchargesCents, &surcharges, &v.Currency, &v.RestockETA,
			&checked, &changed, &first, &v.Delisted); err != nil {
			return nil, err
		}
		v.ProductTags = []string{}
		if tags != "" {
			_ = json.Unmarshal([]byte(tags), &v.ProductTags) // a bad value just means no tags
		}
		v.SurchargeTypes = []string{}
		if surcharges != "" {
			_ = json.Unmarshal([]byte(surcharges), &v.SurchargeTypes) // likewise
		}
		v.LastChecked, _ = time.Parse(time.RFC3339, checked)
		v.LastChanged, _ = time.Parse(time.RFC3339, changed)
		v.FirstSeen, _ = time.Parse(time.RFC3339, first)
		out = append(out, v)
	}
	return out, rows.Err()
}

const (
	SourceConfig = "config"
	SourceUI     = "ui"
	// SourceDiscovered marks products found on a category page rather than listed by the user.
	SourceDiscovered = "discovered"
)

// Item is one entry in the watch list.
type Item struct {
	Region  string
	Slug    string
	Source  string
	AddedAt time.Time
	// ProductID is set once a poll has resolved the slug to a product.
	ProductID string
	// Category is the product's store category id; empty until a poll has seen it.
	Category string
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
	rows, err := s.db.QueryContext(ctx, `
		SELECT i.region, i.slug, i.source, COALESCE(i.product_id, ''), COALESCE(p.category, ''), i.added_at
		FROM items i
		LEFT JOIN products p ON p.region = i.region AND p.id = i.product_id
		ORDER BY i.region, i.slug`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Item
	for rows.Next() {
		var it Item
		var added string
		if err := rows.Scan(&it.Region, &it.Slug, &it.Source, &it.ProductID, &it.Category, &added); err != nil {
			return nil, err
		}
		it.AddedAt, _ = time.Parse(time.RFC3339, added)
		out = append(out, it)
	}
	return out, rows.Err()
}

// applySpecs records that the product endpoint supplied the product, and its
// specification if the response had one. A response without one (nil Specs)
// leaves the stored specification alone: the store may have dropped the field,
// and that is no reason to forget what we know. An unchanged specification is
// not rewritten.
func applySpecs(ctx context.Context, tx *sql.Tx, region string, p *unistore.Product, now time.Time) error {
	if _, err := tx.ExecContext(ctx, `UPDATE products SET specs_fetched_at = ? WHERE region = ? AND id = ?`, ts(now), region, p.ID); err != nil {
		return fmt.Errorf("recording specs fetch: %w", err)
	}
	if p.Specs == nil {
		return nil
	}
	b, err := json.Marshal(p.Specs)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(b)
	hash := hex.EncodeToString(sum[:])

	var stored string
	if err := tx.QueryRowContext(ctx, `SELECT specs_hash FROM products WHERE region = ? AND id = ?`, region, p.ID).Scan(&stored); err != nil {
		return fmt.Errorf("reading specs hash: %w", err)
	}
	if stored == hash {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM product_specs WHERE region = ? AND product_id = ?`, region, p.ID); err != nil {
		return fmt.Errorf("clearing specs: %w", err)
	}
	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO product_specs (region, product_id, position, section_id, section, section_type, feature_id, parent_feature_id, label, kind, value, note)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer func() { _ = stmt.Close() }()
	for i, sp := range p.Specs {
		if _, err := stmt.ExecContext(ctx, region, p.ID, i, sp.SectionID, sp.Section, sp.SectionType, sp.FeatureID, sp.ParentID, sp.Label, sp.Kind, sp.Value, sp.Note); err != nil {
			return fmt.Errorf("inserting spec %q: %w", sp.Label, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE products SET specs_hash = ? WHERE region = ? AND id = ?`, hash, region, p.ID); err != nil {
		return fmt.Errorf("recording specs hash: %w", err)
	}
	// What is derived from the specification is rebuilt in the same transaction,
	// so the two never disagree.
	return rederiveTx(ctx, tx, region, p.ID, now)
}

// ProductSpecs returns the stored specification of a product in the store's
// order. It is empty both for a product whose specification is empty and for one
// we haven't read yet; the latter has no specs_fetched_at.
func (s *Store) ProductSpecs(ctx context.Context, region, productID string) ([]unistore.Spec, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT section_id, section, section_type, feature_id, parent_feature_id, label, kind, value, note
		FROM product_specs WHERE region = ? AND product_id = ? ORDER BY position`, region, productID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []unistore.Spec
	for rows.Next() {
		var sp unistore.Spec
		if err := rows.Scan(&sp.SectionID, &sp.Section, &sp.SectionType, &sp.FeatureID, &sp.ParentID, &sp.Label, &sp.Kind, &sp.Value, &sp.Note); err != nil {
			return nil, err
		}
		out = append(out, sp)
	}
	return out, rows.Err()
}

// DetailsDue lists watched items whose product is due a fetch from the product
// endpoint, which alone supplies a product's group and specification: those
// never fetched from it (including products seen only on category pages), then
// those last fetched before olderThan, stalest first. Within each, listed
// products come before discovered ones.
func (s *Store) DetailsDue(ctx context.Context, olderThan time.Time) ([]Item, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT i.region, i.slug, i.source, i.product_id, COALESCE(p.category, ''), i.added_at
		FROM items i
		JOIN products p ON p.region = i.region AND p.id = i.product_id
		WHERE p.specs_fetched_at IS NULL OR p.specs_fetched_at < ?
		ORDER BY p.specs_fetched_at IS NOT NULL, i.source = ?, p.specs_fetched_at, i.added_at, i.slug`,
		ts(olderThan), SourceDiscovered)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Item
	for rows.Next() {
		var it Item
		var added string
		if err := rows.Scan(&it.Region, &it.Slug, &it.Source, &it.ProductID, &it.Category, &added); err != nil {
			return nil, err
		}
		it.AddedAt, _ = time.Parse(time.RFC3339, added)
		out = append(out, it)
	}
	return out, rows.Err()
}

// TechSpecsCandidate is a watched product whose tech specs page is due a check.
type TechSpecsCandidate struct {
	Region, ProductID, Slug, Category string
}

// TechSpecsDue lists watched products with a known category that have never been
// checked for a tech specs page, or were last checked before olderThan: never
// checked first, then the stalest.
func (s *Store) TechSpecsDue(ctx context.Context, olderThan time.Time) ([]TechSpecsCandidate, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT p.region, p.id, p.slug, p.category
		FROM products p
		WHERE p.category != ''
			AND (p.techspecs_checked_at IS NULL OR p.techspecs_checked_at < ?)
			AND EXISTS (SELECT 1 FROM items i WHERE i.region = p.region AND i.product_id = p.id)
		ORDER BY p.techspecs_checked_at IS NOT NULL, p.techspecs_checked_at, p.region, p.slug`,
		olderThan.UTC().Format(time.RFC3339))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []TechSpecsCandidate
	for rows.Next() {
		var c TechSpecsCandidate
		if err := rows.Scan(&c.Region, &c.ProductID, &c.Slug, &c.Category); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// SetTechSpecsURL records the outcome of checking a product for a tech specs
// page: its URL, or "" when it has none.
func (s *Store) SetTechSpecsURL(ctx context.Context, region, productID, url string, checkedAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE products SET techspecs_url = ?, techspecs_checked_at = ? WHERE region = ? AND id = ?`,
		url, checkedAt.UTC().Format(time.RFC3339), region, productID)
	return err
}

// HasProduct reports whether a product has ever been observed.
func (s *Store) HasProduct(ctx context.Context, region, id string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM products WHERE region = ? AND id = ?`, region, id).Scan(&n)
	return n > 0, err
}

// LinkedProduct is a product the store sells with another, and what its page calls that choice ("2 TB"; empty when unknown).
type LinkedProduct struct {
	Slug  string
	Label string
}

// Linked maps each product (region, id) to the products the store sells with it, in the store's order, and
// to what its page calls the choice of none of them ("No Storage"; empty when unknown).
func (s *Store) Linked(ctx context.Context) (links map[[2]string][]LinkedProduct, none map[[2]string]string, err error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT l.region, l.product_id, p.slug, l.label FROM linked_products l
		JOIN products p ON p.region = l.region AND p.id = l.linked_id
		ORDER BY l.region, l.product_id, l.position`)
	if err != nil {
		return nil, nil, err
	}
	links = map[[2]string][]LinkedProduct{}
	for rows.Next() {
		var region, id string
		var l LinkedProduct
		if err := rows.Scan(&region, &id, &l.Slug, &l.Label); err != nil {
			_ = rows.Close()
			return nil, nil, err
		}
		links[[2]string{region, id}] = append(links[[2]string{region, id}], l)
	}
	if err := rows.Close(); err != nil {
		return nil, nil, err
	}
	nrows, err := s.db.QueryContext(ctx, `SELECT region, id, linked_base_label FROM products WHERE linked_base_label != ''`)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = nrows.Close() }()
	none = map[[2]string]string{}
	for nrows.Next() {
		var region, id, label string
		if err := nrows.Scan(&region, &id, &label); err != nil {
			return nil, nil, err
		}
		none[[2]string{region, id}] = label
	}
	return links, none, nrows.Err()
}

// KnownProducts returns the ids of the products observed in a region, other than those seen only as another's linked product.
func (s *Store) KnownProducts(ctx context.Context, region string) (map[string]bool, error) {
	// A product known only as another's linked product (no item of its own) is still to be discovered.
	return s.idSet(ctx, `SELECT id FROM products p WHERE region = ? AND (EXISTS (SELECT 1 FROM items i WHERE i.region = p.region AND i.product_id = p.id) OR NOT EXISTS (SELECT 1 FROM linked_products l WHERE l.region = p.region AND l.linked_id = p.id))`, region)
}

// SeenCategories returns the ids of the categories whose product lists have
// been ingested in a region.
func (s *Store) SeenCategories(ctx context.Context, region string) (map[string]bool, error) {
	return s.idSet(ctx, `SELECT id FROM categories WHERE region = ?`, region)
}

// MarkCategoriesSeen records that these categories' product lists were ingested.
func (s *Store) MarkCategoriesSeen(ctx context.Context, region string, ids []string, now time.Time) error {
	for _, id := range ids {
		if _, err := s.db.ExecContext(ctx,
			`INSERT INTO categories (region, id, first_seen) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
			region, id, ts(now)); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) idSet(ctx context.Context, query string, args ...any) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
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
	rows, err := s.db.QueryContext(ctx, `SELECT status, COUNT(*) FROM variants WHERE delisted_at = '' GROUP BY status`)
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
