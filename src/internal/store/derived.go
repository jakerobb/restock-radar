package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jakerobb/restock-radar/internal/specs"
	"github.com/jakerobb/restock-radar/internal/unistore"
)

// DerivedProduct is what is derived from one product's effective specification:
// ports, PoE budgets, radios, numbers and so on, with which derivation made it.
type DerivedProduct struct {
	Region    string    `json:"region"`
	ProductID string    `json:"product_id"`
	Slug      string    `json:"slug"`
	Title     string    `json:"title"`
	Category  string    `json:"category"`
	Version   int       `json:"version"`
	DerivedAt time.Time `json:"derived_at"`
	specs.Result
	// Overridden says what the user's overrides changed, with the published
	// values beside them.
	Overridden specs.Overridden `json:"overridden"`
}

// rawSpecsTx reads a product's published specification.
func rawSpecsTx(ctx context.Context, q interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, region, productID string) ([]unistore.Spec, error) {
	rows, err := q.QueryContext(ctx, `
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

// overridesTx reads the overrides for a product slug, oldest first.
func overridesTx(ctx context.Context, q interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, region, slug string) ([]specs.Override, error) {
	return queryOverrides(ctx, q, `WHERE region = ? AND slug = ? ORDER BY id`, region, slug)
}

func queryOverrides(ctx context.Context, q interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, where string, args ...any) ([]specs.Override, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT id, region, slug, action, section, group_label, label, kind, value, note, source_url, reason, published_value, created_at, updated_at, created_by, updated_by
		FROM spec_overrides `+where, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []specs.Override
	for rows.Next() {
		var o specs.Override
		var pub sql.NullString
		var created, updated string
		if err := rows.Scan(&o.ID, &o.Region, &o.Slug, &o.Action, &o.Section, &o.Group, &o.Label, &o.Kind, &o.Value, &o.Note, &o.SourceURL, &o.Reason, &pub, &created, &updated, &o.CreatedBy, &o.UpdatedBy); err != nil {
			return nil, err
		}
		if pub.Valid {
			v := pub.String
			o.PublishedValue = &v
		}
		o.CreatedAt, _ = time.Parse(time.RFC3339, created)
		o.UpdatedAt, _ = time.Parse(time.RFC3339, updated)
		out = append(out, o)
	}
	return out, rows.Err()
}

// rederiveTx derives a product's facts from its stored specification with its
// overrides applied, and stores them in place of any earlier ones.
func rederiveTx(ctx context.Context, tx *sql.Tx, region, productID string, now time.Time) error {
	var slug, title, category string
	if err := tx.QueryRowContext(ctx, `SELECT slug, title, category FROM products WHERE region = ? AND id = ?`, region, productID).Scan(&slug, &title, &category); err != nil {
		return fmt.Errorf("reading product to derive: %w", err)
	}
	raw, err := rawSpecsTx(ctx, tx, region, productID)
	if err != nil {
		return fmt.Errorf("reading specs to derive: %w", err)
	}
	ovs, err := overridesTx(ctx, tx, region, slug)
	if err != nil {
		return fmt.Errorf("reading overrides: %w", err)
	}
	eff, _ := specs.Apply(raw, ovs)
	res := specs.Derive(specs.Input{Slug: slug, Title: title, Category: category, Specs: eff})
	over := specs.Overridden{Metrics: []specs.OverriddenMetric{}}
	if len(ovs) > 0 {
		over = specs.Compare(res, specs.Derive(specs.Input{Slug: slug, Title: title, Category: category, Specs: specs.Plain(raw)}))
	}
	return storeDerived(ctx, tx, region, productID, res, over, now)
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func nullF(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

func nullI(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

func joinInts(v []int) string {
	parts := make([]string, len(v))
	for i, n := range v {
		parts[i] = strconv.Itoa(n)
	}
	return strings.Join(parts, ",")
}

func splitInts(s string) []int {
	out := []int{}
	if s == "" {
		return out
	}
	for _, p := range strings.Split(s, ",") {
		if n, err := strconv.Atoi(p); err == nil {
			out = append(out, n)
		}
	}
	return out
}

func storeDerived(ctx context.Context, tx *sql.Tx, region, productID string, r specs.Result, over specs.Overridden, now time.Time) error {
	for _, t := range []string{"product_ports", "product_poe_budget", "product_radios", "product_metrics", "product_derived"} {
		if _, err := tx.ExecContext(ctx, `DELETE FROM `+t+` WHERE region = ? AND product_id = ?`, region, productID); err != nil {
			return fmt.Errorf("clearing %s: %w", t, err)
		}
	}
	issues, err := json.Marshal(r.Issues)
	if err != nil {
		return err
	}
	overridden, err := json.Marshal(over)
	if err != nil {
		return err
	}
	d := r.Dims
	var minMM, midMM, maxMM any
	if r.Known.Dims {
		minMM, midMM, maxMM = d.MinMM, d.MidMM, d.MaxMM
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO product_derived (region, product_id, version, derived_at, known_ports, known_poe, known_radios, known_rack, known_dims,
			poe_max_class, rackmount, rack_units, full_depth, dim_min_mm, dim_mid_mm, dim_max_mm, dim_round, width_mm, depth_mm, height_mm, overridden, issues)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		region, productID, specs.Version, ts(now), b2i(r.Known.Ports), b2i(r.Known.PoE), b2i(r.Known.Radios), b2i(r.Known.Rack), b2i(r.Known.Dims),
		r.PoEMaxClass, b2i(r.Rack.Mountable), r.Rack.Units, b2i(r.Rack.FullDepth), minMM, midMM, maxMM, b2i(d.Round),
		nullF(d.WidthMM), nullF(d.DepthMM), nullF(d.HeightMM), string(overridden), string(issues)); err != nil {
		return fmt.Errorf("storing derived product: %w", err)
	}
	for i, p := range r.Ports {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO product_ports (region, product_id, position, label, media, role, count, max_speed_mbps, speeds_mbps, poe_class, poe_direction, poe_inferred, poe_watts, combo, note, source)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			region, productID, i, p.Label, p.Media, p.Role, p.Count, p.MaxSpeedMbps, joinInts(p.SpeedsMbps), p.PoEClass, p.PoEDirection,
			b2i(p.PoEInferred), nullF(p.PoEWatts), b2i(p.Combo), p.Note, p.Source); err != nil {
			return fmt.Errorf("storing port: %w", err)
		}
	}
	for i, b := range r.PoEBudget {
		if _, err := tx.ExecContext(ctx, `INSERT INTO product_poe_budget (region, product_id, position, name, watts, selected) VALUES (?, ?, ?, ?, ?, ?)`,
			region, productID, i, b.Name, b.Watts, b2i(b.Selected)); err != nil {
			return fmt.Errorf("storing PoE budget: %w", err)
		}
	}
	for _, rd := range r.Radios {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO product_radios (region, product_id, band, tech, antenna_gain_dbi, tx_power_dbm, tx_power_extended_dbm, streams, max_rate_mbps, multi,
				antenna_gain_raw, tx_power_raw, tx_power_note, mimo_raw, max_rate_raw)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			region, productID, rd.Band, rd.Tech, nullF(rd.AntennaGainDBi), nullF(rd.TxPowerDBm), nullF(rd.TxPowerExtendedDBm), nullI(rd.Streams),
			nullF(rd.MaxRateMbps), b2i(rd.Multi), rd.AntennaGainRaw, rd.TxPowerRaw, rd.TxPowerNote, rd.MIMORaw, rd.MaxRateRaw); err != nil {
			return fmt.Errorf("storing radio: %w", err)
		}
	}
	for _, m := range r.Metrics {
		if _, err := tx.ExecContext(ctx, `INSERT INTO product_metrics (region, product_id, name, value, unit, at_least, raw) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			region, productID, m.Name, m.Value, m.Unit, b2i(m.AtLeast), m.Raw); err != nil {
			return fmt.Errorf("storing metric: %w", err)
		}
	}
	return nil
}

// Rederive derives a product's facts again from what is stored, for when its
// overrides change.
func (s *Store) Rederive(ctx context.Context, region, productID string, now time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := rederiveTx(ctx, tx, region, productID, now); err != nil {
		return err
	}
	return tx.Commit()
}

// RederiveStale derives every product that has a specification (or overrides)
// and was never derived or was derived by an older version of the derivation.
// It returns how many it did. Nothing is fetched: this works from what is stored.
func (s *Store) RederiveStale(ctx context.Context, now time.Time) (int, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT p.region, p.id FROM products p
		LEFT JOIN product_derived d ON d.region = p.region AND d.product_id = p.id
		WHERE (d.version IS NULL OR d.version < ?)
			AND (p.specs_hash != '' OR EXISTS (SELECT 1 FROM spec_overrides o WHERE o.region = p.region AND o.slug = p.slug))
		ORDER BY p.region, p.id`, specs.Version)
	if err != nil {
		return 0, err
	}
	var todo [][2]string
	for rows.Next() {
		var k [2]string
		if err := rows.Scan(&k[0], &k[1]); err != nil {
			_ = rows.Close()
			return 0, err
		}
		todo = append(todo, k)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, k := range todo {
		if err := s.Rederive(ctx, k[0], k[1], now); err != nil {
			return 0, fmt.Errorf("deriving %s/%s: %w", k[0], k[1], err)
		}
	}
	return len(todo), nil
}

// EffectiveSpecs returns a product's specification with its overrides applied,
// and what each override did. The first result is empty for a product that has
// no specification and no overrides that add to one.
func (s *Store) EffectiveSpecs(ctx context.Context, region, productID string) ([]specs.Effective, []specs.Applied, error) {
	var slug string
	if err := s.db.QueryRowContext(ctx, `SELECT slug FROM products WHERE region = ? AND id = ?`, region, productID).Scan(&slug); err != nil {
		return nil, nil, err
	}
	raw, err := rawSpecsTx(ctx, s.db, region, productID)
	if err != nil {
		return nil, nil, err
	}
	ovs, err := overridesTx(ctx, s.db, region, slug)
	if err != nil {
		return nil, nil, err
	}
	eff, applied := specs.Apply(raw, ovs)
	return eff, applied, nil
}

// Derived returns what is derived for a product, or nil if nothing has been.
func (s *Store) Derived(ctx context.Context, region, productID string) (*DerivedProduct, error) {
	all, err := s.derived(ctx, `WHERE d.region = ? AND d.product_id = ?`, region, productID)
	if err != nil || len(all) == 0 {
		return nil, err
	}
	return &all[0], nil
}

// AllDerived returns what is derived for every product in a region (every
// region if empty), ordered by slug.
func (s *Store) AllDerived(ctx context.Context, region string) ([]DerivedProduct, error) {
	if region == "" {
		return s.derived(ctx, `WHERE ? = ''`, region)
	}
	return s.derived(ctx, `WHERE d.region = ?`, region)
}

func (s *Store) derived(ctx context.Context, where string, args ...any) ([]DerivedProduct, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT d.region, d.product_id, p.slug, p.title, p.category, d.version, d.derived_at,
			d.known_ports, d.known_poe, d.known_radios, d.known_rack, d.known_dims, d.poe_max_class,
			d.rackmount, d.rack_units, d.full_depth, d.dim_min_mm, d.dim_mid_mm, d.dim_max_mm, d.dim_round,
			d.width_mm, d.depth_mm, d.height_mm, d.overridden, d.issues
		FROM product_derived d JOIN products p ON p.region = d.region AND p.id = d.product_id
		`+where+` ORDER BY p.slug, d.region`, args...)
	if err != nil {
		return nil, err
	}
	var out []DerivedProduct
	index := map[[2]string]int{}
	for rows.Next() {
		var d DerivedProduct
		var at, overridden, issues string
		var kp, kpoe, kr, krack, kd, mount, full, round int
		var mn, md, mx, w, dep, h sql.NullFloat64
		if err := rows.Scan(&d.Region, &d.ProductID, &d.Slug, &d.Title, &d.Category, &d.Version, &at,
			&kp, &kpoe, &kr, &krack, &kd, &d.PoEMaxClass, &mount, &d.Rack.Units, &full, &mn, &md, &mx, &round, &w, &dep, &h, &overridden, &issues); err != nil {
			_ = rows.Close()
			return nil, err
		}
		d.DerivedAt, _ = time.Parse(time.RFC3339, at)
		d.Known = specs.Known{Ports: kp == 1, PoE: kpoe == 1, Radios: kr == 1, Rack: krack == 1, Dims: kd == 1}
		d.Rack.Mountable, d.Rack.FullDepth = mount == 1, full == 1
		d.Dims.Round = round == 1
		d.Dims.MinMM, d.Dims.MidMM, d.Dims.MaxMM = mn.Float64, md.Float64, mx.Float64
		d.Dims.WidthMM, d.Dims.DepthMM, d.Dims.HeightMM = optF(w), optF(dep), optF(h)
		d.Ports, d.PoEBudget, d.Radios, d.Metrics = []specs.Port{}, []specs.PoEScenario{}, []specs.Radio{}, []specs.Metric{}
		if err := json.Unmarshal([]byte(issues), &d.Issues); err != nil || d.Issues == nil {
			d.Issues = []specs.Issue{}
		}
		if err := json.Unmarshal([]byte(overridden), &d.Overridden); err != nil || d.Overridden.Metrics == nil {
			d.Overridden.Metrics = []specs.OverriddenMetric{}
		}
		index[[2]string{d.Region, d.ProductID}] = len(out)
		out = append(out, d)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return out, nil
	}
	return out, s.loadDerivedLists(ctx, out, index)
}

func optF(n sql.NullFloat64) *float64 {
	if !n.Valid {
		return nil
	}
	v := n.Float64
	return &v
}

func optI(n sql.NullInt64) *int {
	if !n.Valid {
		return nil
	}
	v := int(n.Int64)
	return &v
}

// loadDerivedLists fills in the ports, budgets, radios and metrics of the
// products already read, in one query each.
func (s *Store) loadDerivedLists(ctx context.Context, out []DerivedProduct, index map[[2]string]int) error {
	find := func(region, id string) *DerivedProduct {
		if i, ok := index[[2]string{region, id}]; ok {
			return &out[i]
		}
		return nil
	}

	rows, err := s.db.QueryContext(ctx, `SELECT region, product_id, label, media, role, count, max_speed_mbps, speeds_mbps, poe_class, poe_direction, poe_inferred, poe_watts, combo, note, source
		FROM product_ports ORDER BY region, product_id, position`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var region, id, speeds string
		var p specs.Port
		var inferred, combo int
		var watts sql.NullFloat64
		if err := rows.Scan(&region, &id, &p.Label, &p.Media, &p.Role, &p.Count, &p.MaxSpeedMbps, &speeds, &p.PoEClass, &p.PoEDirection, &inferred, &watts, &combo, &p.Note, &p.Source); err != nil {
			_ = rows.Close()
			return err
		}
		p.SpeedsMbps, p.PoEInferred, p.Combo, p.PoEWatts = splitInts(speeds), inferred == 1, combo == 1, optF(watts)
		if d := find(region, id); d != nil {
			d.Ports = append(d.Ports, p)
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}

	rows, err = s.db.QueryContext(ctx, `SELECT region, product_id, name, watts, selected FROM product_poe_budget ORDER BY region, product_id, position`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var region, id string
		var b specs.PoEScenario
		var sel int
		if err := rows.Scan(&region, &id, &b.Name, &b.Watts, &sel); err != nil {
			_ = rows.Close()
			return err
		}
		b.Selected = sel == 1
		if d := find(region, id); d != nil {
			d.PoEBudget = append(d.PoEBudget, b)
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}

	rows, err = s.db.QueryContext(ctx, `SELECT region, product_id, band, tech, antenna_gain_dbi, tx_power_dbm, tx_power_extended_dbm, streams, max_rate_mbps, multi,
		antenna_gain_raw, tx_power_raw, tx_power_note, mimo_raw, max_rate_raw FROM product_radios ORDER BY region, product_id,
		CASE band WHEN '2.4 GHz' THEN 1 WHEN '5 GHz' THEN 2 WHEN '6 GHz' THEN 3 WHEN '60 GHz' THEN 4 WHEN 'Bluetooth' THEN 5 ELSE 6 END`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var region, id string
		var rd specs.Radio
		var gain, tx, ext, rate sql.NullFloat64
		var streams sql.NullInt64
		var multi int
		if err := rows.Scan(&region, &id, &rd.Band, &rd.Tech, &gain, &tx, &ext, &streams, &rate, &multi,
			&rd.AntennaGainRaw, &rd.TxPowerRaw, &rd.TxPowerNote, &rd.MIMORaw, &rd.MaxRateRaw); err != nil {
			_ = rows.Close()
			return err
		}
		rd.AntennaGainDBi, rd.TxPowerDBm, rd.TxPowerExtendedDBm, rd.MaxRateMbps, rd.Streams, rd.Multi = optF(gain), optF(tx), optF(ext), optF(rate), optI(streams), multi == 1
		if d := find(region, id); d != nil {
			d.Radios = append(d.Radios, rd)
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}

	rows, err = s.db.QueryContext(ctx, `SELECT region, product_id, name, value, unit, at_least, raw FROM product_metrics ORDER BY region, product_id, name`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var region, id string
		var m specs.Metric
		var atLeast int
		if err := rows.Scan(&region, &id, &m.Name, &m.Value, &m.Unit, &atLeast, &m.Raw); err != nil {
			_ = rows.Close()
			return err
		}
		m.AtLeast = atLeast == 1
		if d := find(region, id); d != nil {
			d.Metrics = append(d.Metrics, m)
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	return rows.Err()
}

// ProductRef identifies a tracked product.
type ProductRef struct {
	Region   string `json:"region"`
	ID       string `json:"id"`
	Slug     string `json:"slug"`
	Title    string `json:"title"`
	Category string `json:"category"`
}

// ProductBySlug finds a tracked product by its slug, or returns nil.
func (s *Store) ProductBySlug(ctx context.Context, region, slug string) (*ProductRef, error) {
	var p ProductRef
	err := s.db.QueryRowContext(ctx, `SELECT region, id, slug, title, category FROM products WHERE region = ? AND slug = ?`, region, slug).
		Scan(&p.Region, &p.ID, &p.Slug, &p.Title, &p.Category)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// SpecsHash identifies the stored specification of a product: it changes when
// the store publishes a different one, and is empty for a product that has never
// had one stored.
func (s *Store) SpecsHash(ctx context.Context, region, productID string) (string, error) {
	var h string
	err := s.db.QueryRowContext(ctx, `SELECT specs_hash FROM products WHERE region = ? AND id = ?`, region, productID).Scan(&h)
	return h, err
}
