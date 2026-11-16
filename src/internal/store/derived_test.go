package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/jakerobb/restock-radar/internal/specs"
	"github.com/jakerobb/restock-radar/internal/unistore"
)

type fixtureProduct struct {
	Title, Category string
	Specs           []unistore.Spec
}

// realSpecs loads specifications captured from the store (see specs/testdata).
func realSpecs(t testing.TB) map[string]fixtureProduct {
	t.Helper()
	b, err := os.ReadFile("../specs/testdata/products.json")
	if err != nil {
		t.Fatal(err)
	}
	m := map[string]fixtureProduct{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// applyReal stores a captured product as the poller would after reading it from
// the product endpoint.
func applyReal(t testing.TB, s *Store, slug string, at time.Time) *unistore.Product {
	t.Helper()
	f, ok := realSpecs(t)[slug]
	if !ok {
		t.Fatalf("no captured product %q", slug)
	}
	p := &unistore.Product{
		ID: "id-" + slug, Slug: slug, Name: slug, Title: f.Title, Category: f.Category, Detailed: true, Specs: f.Specs,
		Variants: []unistore.Variant{{ID: "v-" + slug, SKU: slug, Title: "US", Status: "Available", Price: &unistore.Money{Amount: 10000, Currency: "USD"}}},
	}
	if _, err := s.Apply(context.Background(), "us", p, at); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestApplyDerivesTheSpecification(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	applyReal(t, s, "usw-pro-max-24-poe", time.Now())

	d, err := s.Derived(ctx, "us", "id-usw-pro-max-24-poe")
	if err != nil || d == nil {
		t.Fatalf("derived = %+v (%v)", d, err)
	}
	if d.Version != specs.Version || d.Slug != "usw-pro-max-24-poe" || d.DerivedAt.IsZero() {
		t.Errorf("derived = %+v", d)
	}
	if !d.Known.Ports || !d.Known.PoE || len(d.Ports) != 4 || d.PoEMaxClass != "PoE++" {
		t.Errorf("ports %+v known %+v class %q", d.Ports, d.Known, d.PoEMaxClass)
	}
	if !d.Rack.Mountable || d.Rack.Units != 1 || d.Dims.WidthMM == nil || *d.Dims.WidthMM != 442 {
		t.Errorf("rack %+v dims %+v", d.Rack, d.Dims)
	}
}

// TestDerivedRoundTrips checks that what comes back from the database is exactly
// what was derived, for every captured product: nothing lost to a column.
func TestDerivedRoundTrips(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	for slug, f := range realSpecs(t) {
		applyReal(t, s, slug, time.Now())
		want := specs.Derive(specs.Input{Slug: slug, Title: f.Title, Category: f.Category, Specs: specs.Plain(f.Specs)})
		// Only a published specification, so nothing is overridden.
		got, err := s.Derived(ctx, "us", "id-"+slug)
		if err != nil || got == nil {
			t.Fatalf("%s: derived = %v (%v)", slug, got, err)
		}
		if !reflect.DeepEqual(got.Result, want) {
			g, _ := json.MarshalIndent(got.Result, "", " ")
			w, _ := json.MarshalIndent(want, "", " ")
			t.Errorf("%s: stored result differs\ngot  %s\nwant %s", slug, g, w)
		}
		if got.Overridden.Any() {
			t.Errorf("%s: overridden = %+v", slug, got.Overridden)
		}
	}
}

func TestAllDerived(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	for _, slug := range []string{"u7-pro", "usw-ultra-60w", "eav-xg-24-poe"} {
		applyReal(t, s, slug, time.Now())
	}
	all, err := s.AllDerived(ctx, "us")
	if err != nil || len(all) != 3 {
		t.Fatalf("all = %d (%v)", len(all), err)
	}
	// Ordered by slug, each with its own lists.
	if all[0].Slug != "eav-xg-24-poe" || all[1].Slug != "u7-pro" || all[2].Slug != "usw-ultra-60w" {
		t.Errorf("order = %s %s %s", all[0].Slug, all[1].Slug, all[2].Slug)
	}
	if len(all[0].Ports) != 5 || len(all[1].Radios) != 3 || len(all[2].PoEBudget) != 5 {
		t.Errorf("lists = %d ports, %d radios, %d scenarios", len(all[0].Ports), len(all[1].Radios), len(all[2].PoEBudget))
	}
	if len(all[1].Ports) != 1 || all[1].Ports[0].Source != "networking_interface" {
		t.Errorf("u7-pro ports = %+v", all[1].Ports)
	}
	if other, err := s.AllDerived(ctx, "eu"); err != nil || len(other) != 0 {
		t.Errorf("another region: %d (%v)", len(other), err)
	}
	everything, err := s.AllDerived(ctx, "")
	if err != nil || len(everything) != 3 {
		t.Errorf("all regions: %d (%v)", len(everything), err)
	}
}

func TestDerivedForAProductWithNothing(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	if _, err := s.Apply(ctx, "us", product("Available", 10900), time.Now()); err != nil {
		t.Fatal(err)
	}
	if d, err := s.Derived(ctx, "us", "p1"); err != nil || d != nil {
		t.Errorf("a product that has never had a specification has nothing derived: %+v (%v)", d, err)
	}
	if d, err := s.Derived(ctx, "us", "no-such-product"); err != nil || d != nil {
		t.Errorf("derived = %+v (%v)", d, err)
	}
}

func TestChangedSpecsAreDerivedAgain(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	p := applyReal(t, s, "usw-pro-max-24-poe", time.Now())

	// The store revises the budget.
	revised := make([]unistore.Spec, len(p.Specs))
	copy(revised, p.Specs)
	for i, sp := range revised {
		if sp.Label == "Total PoE Availability" {
			revised[i].Value = "450W"
		}
	}
	p2 := *p
	p2.Specs = revised
	if _, err := s.Apply(ctx, "us", &p2, time.Now()); err != nil {
		t.Fatal(err)
	}
	d, _ := s.Derived(ctx, "us", "id-usw-pro-max-24-poe")
	if len(d.PoEBudget) != 1 || d.PoEBudget[0].Watts != 450 {
		t.Errorf("budget = %+v", d.PoEBudget)
	}
	// The derived rows are replaced, not added to.
	var n int
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM product_poe_budget`).Scan(&n)
	if n != 1 {
		t.Errorf("%d budget rows", n)
	}
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM product_ports`).Scan(&n)
	if want := len(d.Ports); n != want {
		t.Errorf("%d port rows, want %d", n, want)
	}
}

func TestUnchangedSpecsAreNotDerivedAgain(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	p := applyReal(t, s, "usw-pro-max-24-poe", time.Now().Add(-time.Hour))
	if _, err := s.db.Exec(`UPDATE product_derived SET derived_at = '2000-01-01T00:00:00Z'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Apply(ctx, "us", p, time.Now()); err != nil {
		t.Fatal(err)
	}
	var at string
	_ = s.db.QueryRow(`SELECT derived_at FROM product_derived`).Scan(&at)
	if at != "2000-01-01T00:00:00Z" {
		t.Errorf("derived_at = %s: the same specification was derived again", at)
	}
}

func TestCategoryObservationsDoNotDerive(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	p := applyReal(t, s, "usw-pro-max-24-poe", time.Now())
	if _, err := s.db.Exec(`UPDATE product_derived SET derived_at = '2000-01-01T00:00:00Z'`); err != nil {
		t.Fatal(err)
	}
	cat := *p
	cat.Detailed, cat.Specs = false, nil
	if _, err := s.Apply(ctx, "us", &cat, time.Now()); err != nil {
		t.Fatal(err)
	}
	d, _ := s.Derived(ctx, "us", "id-usw-pro-max-24-poe")
	if d.DerivedAt.Year() != 2000 || len(d.Ports) == 0 {
		t.Errorf("derived = %+v", d)
	}
}

func TestRederiveStaleCoversOldVersionsAndNeverDerived(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	applyReal(t, s, "u7-pro", time.Now())
	applyReal(t, s, "usw-ultra", time.Now())
	applyReal(t, s, "utr", time.Now())
	// A product with no specification isn't derived.
	if _, err := s.Discover(ctx, "us", product("Available", 100), false, time.Now()); err != nil {
		t.Fatal(err)
	}

	if n, err := s.RederiveStale(ctx, time.Now()); err != nil || n != 0 {
		t.Fatalf("everything is current: derived %d (%v)", n, err)
	}

	// One derived by an older version, one never derived (as before this existed).
	if _, err := s.db.Exec(`UPDATE product_derived SET version = ? WHERE product_id = 'id-u7-pro'`, specs.Version-1); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`DELETE FROM product_derived WHERE product_id = 'id-usw-ultra'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`DELETE FROM product_radios WHERE product_id = 'id-u7-pro'`); err != nil {
		t.Fatal(err)
	}
	n, err := s.RederiveStale(ctx, time.Now())
	if err != nil || n != 2 {
		t.Fatalf("derived %d (%v), want the two", n, err)
	}
	d, _ := s.Derived(ctx, "us", "id-u7-pro")
	if d == nil || d.Version != specs.Version || len(d.Radios) != 3 {
		t.Errorf("u7-pro = %+v", d)
	}
	if d, _ := s.Derived(ctx, "us", "id-usw-ultra"); d == nil || len(d.Ports) == 0 {
		t.Errorf("usw-ultra = %+v", d)
	}
	if n, _ := s.RederiveStale(ctx, time.Now()); n != 0 {
		t.Errorf("a second pass derived %d", n)
	}
}

func TestDerivedRowsGoWithTheProduct(t *testing.T) {
	// The foreign keys cascade, so nothing is left behind if a product is removed.
	ctx := context.Background()
	s := openTest(t)
	applyReal(t, s, "u7-pro", time.Now())
	if _, err := s.db.Exec(`DELETE FROM products WHERE id = 'id-u7-pro'`); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"product_derived", "product_ports", "product_radios", "product_metrics", "product_poe_budget", "product_specs"} {
		var n int
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table).Scan(&n); err != nil || n != 0 {
			t.Errorf("%s: %d rows left (%v)", table, n, err)
		}
	}
}

func TestMigratesDerivedTablesIntoAnExistingDatabase(t *testing.T) {
	// A database from before derived specifications: products with specifications
	// stored, nothing derived. Opening it adds the tables, and RederiveStale fills them.
	path := t.TempDir() + "/old.db"
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	prior := len(migrations) - 1
	for i := 0; i < prior; i++ {
		if _, err := raw.Exec(migrations[i]); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := raw.Exec(`PRAGMA user_version = ` + fmt.Sprint(prior)); err != nil {
		t.Fatal(err)
	}
	f := realSpecs(t)["usw-ultra"]
	if _, err := raw.Exec(`INSERT INTO products (region, id, slug, name, title, category, specs_hash, specs_fetched_at) VALUES ('us', 'p1', 'usw-ultra', 'U', 'Ultra', ?, 'h', '2026-11-01T00:00:00Z')`, f.Category); err != nil {
		t.Fatal(err)
	}
	for i, sp := range f.Specs {
		if _, err := raw.Exec(`INSERT INTO product_specs (region, product_id, position, section_id, section, section_type, feature_id, parent_feature_id, label, kind, value, note)
			VALUES ('us', 'p1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, i, sp.SectionID, sp.Section, sp.SectionType, sp.FeatureID, sp.ParentID, sp.Label, sp.Kind, sp.Value, sp.Note); err != nil {
			t.Fatal(err)
		}
	}
	_ = raw.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	defer func() { _ = s.Close() }()
	ctx := context.Background()
	if d, _ := s.Derived(ctx, "us", "p1"); d != nil {
		t.Fatalf("nothing is derived yet: %+v", d)
	}
	if n, err := s.RederiveStale(ctx, time.Now()); err != nil || n != 1 {
		t.Fatalf("derived %d (%v)", n, err)
	}
	if d, _ := s.Derived(ctx, "us", "p1"); d == nil || len(d.PoEBudget) != 5 || !d.Known.Ports {
		t.Errorf("derived = %+v", d)
	}
}
