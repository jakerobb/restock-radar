package store

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

// withSpecs is a product as the product endpoint returns it.
func withSpecs(specs ...unistore.Spec) *unistore.Product {
	p := product("Available", 10900)
	p.Detailed = true
	p.Specs = append([]unistore.Spec{}, specs...)
	return p
}

func spec(section, feature, parent, label, kind, value string) unistore.Spec {
	return unistore.Spec{SectionID: "sec-" + section, Section: section, SectionType: "Standard",
		FeatureID: feature, ParentID: parent, Label: label, Kind: kind, Value: value}
}

var wifiSpecs = []unistore.Spec{
	spec("Overview", "f-weight", "", "Weight", unistore.SpecText, "680 g (1.5 lb)"),
	spec("Performance", "g-gain", "", "Antenna Gain", unistore.SpecGroup, ""),
	spec("Performance", "f-6g", "g-gain", "6 GHz", unistore.SpecText, "5.8 dBi"),
	spec("Performance", "f-5g", "g-gain", "5 GHz", unistore.SpecText, "6 dBi"),
	spec("Features", "f-ndaa", "", "NDAA Compliant", unistore.SpecFlag, "true"),
}

func specsFetchedAt(t *testing.T, s *Store, region, id string) (at sql.NullString) {
	t.Helper()
	if err := s.db.QueryRow(`SELECT specs_fetched_at FROM products WHERE region = ? AND id = ?`, region, id).Scan(&at); err != nil {
		t.Fatal(err)
	}
	return at
}

func TestApplyStoresSpecsInOrder(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	if _, err := s.Apply(ctx, "us", withSpecs(wifiSpecs...), time.Now()); err != nil {
		t.Fatal(err)
	}
	got, err := s.ProductSpecs(ctx, "us", "p1")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got, wifiSpecs) {
		t.Errorf("got %+v\nwant %+v", got, wifiSpecs)
	}
}

func TestSpecsKeepEveryFieldAndMultilineValues(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	in := unistore.Spec{SectionID: "sid", Section: "Hardware", SectionType: "Overview", FeatureID: "fid", ParentID: "pid",
		Label: "Operating Frequency", Kind: unistore.SpecText, Value: "US/CA:\n2400 - 2472 MHz\nU-NII-1: 5150 - 5250 MHz", Note: "Depends on the regulatory region"}
	if _, err := s.Apply(ctx, "us", withSpecs(in), time.Now()); err != nil {
		t.Fatal(err)
	}
	got, _ := s.ProductSpecs(ctx, "us", "p1")
	if len(got) != 1 || got[0] != in {
		t.Errorf("got %+v, want %+v", got, in)
	}
}

func TestSpecsFeatureIDMayRepeatAcrossSections(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	grid := spec("Grid overview", "f-6g", "", "GHz", unistore.SpecText, "6 GHz")
	grid.SectionType = "Overview"
	specs := []unistore.Spec{grid, spec("Hardware", "f-6g", "", "GHz", unistore.SpecText, "6 GHz")}
	if _, err := s.Apply(ctx, "us", withSpecs(specs...), time.Now()); err != nil {
		t.Fatalf("a feature shown in two sections must be storable: %v", err)
	}
	if got, _ := s.ProductSpecs(ctx, "us", "p1"); !slices.Equal(got, specs) {
		t.Errorf("got %+v", got)
	}
}

func TestUnchangedSpecsAreNotRewritten(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	t0 := time.Now().Add(-time.Hour)
	if _, err := s.Apply(ctx, "us", withSpecs(wifiSpecs...), t0); err != nil {
		t.Fatal(err)
	}
	first := specsFetchedAt(t, s, "us", "p1")

	// Mark a stored row. A rewrite would take the mark with it.
	if _, err := s.db.Exec(`UPDATE product_specs SET note = 'mark' WHERE feature_id = 'f-weight'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Apply(ctx, "us", withSpecs(wifiSpecs...), time.Now()); err != nil {
		t.Fatal(err)
	}
	var note string
	if err := s.db.QueryRow(`SELECT note FROM product_specs WHERE feature_id = 'f-weight'`).Scan(&note); err != nil || note != "mark" {
		t.Errorf("unchanged specs were rewritten (note %q, %v)", note, err)
	}
	// It still counts as a fresh look.
	if second := specsFetchedAt(t, s, "us", "p1"); second == first {
		t.Errorf("specs_fetched_at stayed %v", second)
	}
}

func TestChangedSpecsReplaceTheOldOnes(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	if _, err := s.Apply(ctx, "us", withSpecs(wifiSpecs...), now); err != nil {
		t.Fatal(err)
	}

	// A value changes, an entry goes, a new one arrives, and the order differs.
	revised := []unistore.Spec{
		spec("Features", "f-new", "", "Wi-Fi Speed Test", unistore.SpecFlag, "true"),
		spec("Overview", "f-weight", "", "Weight", unistore.SpecText, "700 g"),
	}
	if _, err := s.Apply(ctx, "us", withSpecs(revised...), now); err != nil {
		t.Fatal(err)
	}
	got, _ := s.ProductSpecs(ctx, "us", "p1")
	if !slices.Equal(got, revised) {
		t.Errorf("got %+v, want only the revised specs", got)
	}
	var n int
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM product_specs`).Scan(&n)
	if n != len(revised) {
		t.Errorf("%d rows, want %d: old rows left behind", n, len(revised))
	}
}

func TestEmptySpecsClearTheStoredOnes(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	_, _ = s.Apply(ctx, "us", withSpecs(wifiSpecs...), now)
	if _, err := s.Apply(ctx, "us", withSpecs(), now); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.ProductSpecs(ctx, "us", "p1"); len(got) != 0 {
		t.Errorf("the store said there are none, but %+v remain", got)
	}
	// "None" is itself remembered, so an identical answer afterwards is a no-op.
	var hash string
	if err := s.db.QueryRow(`SELECT specs_hash FROM products WHERE id = 'p1'`).Scan(&hash); err != nil || hash == "" {
		t.Errorf("specs_hash = %q (%v)", hash, err)
	}
	if _, err := s.Apply(ctx, "us", withSpecs(), now); err != nil {
		t.Fatal(err)
	}
}

func TestNoSpecsInTheResponseKeepsTheStoredOnes(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	old := time.Now().Add(-24 * time.Hour)
	_, _ = s.Apply(ctx, "us", withSpecs(wifiSpecs...), old)
	before := specsFetchedAt(t, s, "us", "p1")

	// The product endpoint answered, but without a specification (the store may
	// have renamed the field). Nothing we know is thrown away.
	p := product("Available", 10900)
	p.Detailed = true
	if _, err := s.Apply(ctx, "us", p, time.Now()); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.ProductSpecs(ctx, "us", "p1"); !slices.Equal(got, wifiSpecs) {
		t.Errorf("stored specs lost: %+v", got)
	}
	if after := specsFetchedAt(t, s, "us", "p1"); after == before {
		t.Error("the fetch still counts: specs_fetched_at should have moved, or the product is refetched every cycle")
	}
}

func TestFirstDetailedResponseWithoutSpecsStillCounts(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	p := product("Available", 10900)
	p.Detailed = true
	_, _ = s.Apply(ctx, "us", p, time.Now())
	if !specsFetchedAt(t, s, "us", "p1").Valid {
		t.Error("a product that has never had specs would be refetched every cycle")
	}
	if got, _ := s.ProductSpecs(ctx, "us", "p1"); len(got) != 0 {
		t.Errorf("got %+v", got)
	}
}

func TestCategoryObservationsLeaveSpecsAlone(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	_, _ = s.Apply(ctx, "us", withSpecs(wifiSpecs...), time.Now().Add(-time.Hour))
	before := specsFetchedAt(t, s, "us", "p1")

	// Not from the product endpoint: no Detailed flag, and even if Specs were set
	// (it never is) they wouldn't be trusted.
	p := product("SoldOut", 10900)
	p.Specs = []unistore.Spec{spec("Grid overview", "x", "", "GHz", unistore.SpecText, "6 GHz")}
	if _, err := s.Apply(ctx, "us", p, time.Now()); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.ProductSpecs(ctx, "us", "p1"); !slices.Equal(got, wifiSpecs) {
		t.Errorf("category observation changed the specs: %+v", got)
	}
	if after := specsFetchedAt(t, s, "us", "p1"); after != before {
		t.Errorf("specs_fetched_at moved from %v to %v", before, after)
	}
}

func TestDiscoveredProductsHaveNoSpecsYet(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	if _, err := s.Discover(ctx, "us", product("Available", 10900), false, time.Now()); err != nil {
		t.Fatal(err)
	}
	if specsFetchedAt(t, s, "us", "p1").Valid {
		t.Error("a product known only from a category page has not had its specs fetched")
	}
}

func TestSpecsAreKeptPerRegionAndProduct(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	other := withSpecs(spec("Overview", "f1", "", "Weight", unistore.SpecText, "1 kg"))
	other.ID, other.Slug = "p2", "gadget"
	other.Variants = []unistore.Variant{{ID: "v2", SKU: "G", Status: "Available"}}

	_, _ = s.Apply(ctx, "us", withSpecs(wifiSpecs...), now)
	_, _ = s.Apply(ctx, "us", other, now)
	eu := withSpecs(spec("Overview", "f1", "", "Weight", unistore.SpecText, "2 kg"))
	if _, err := s.Apply(ctx, "eu", eu, now); err != nil {
		t.Fatal(err)
	}

	if got, _ := s.ProductSpecs(ctx, "us", "p1"); !slices.Equal(got, wifiSpecs) {
		t.Errorf("us/p1: %+v", got)
	}
	if got, _ := s.ProductSpecs(ctx, "us", "p2"); len(got) != 1 || got[0].Value != "1 kg" {
		t.Errorf("us/p2: %+v", got)
	}
	if got, _ := s.ProductSpecs(ctx, "eu", "p1"); len(got) != 1 || got[0].Value != "2 kg" {
		t.Errorf("eu/p1: %+v", got)
	}

	// Changing one doesn't disturb the others.
	_, _ = s.Apply(ctx, "us", withSpecs(), now)
	if got, _ := s.ProductSpecs(ctx, "eu", "p1"); len(got) != 1 {
		t.Errorf("eu/p1 disturbed: %+v", got)
	}
	if got, _ := s.ProductSpecs(ctx, "us", "p2"); len(got) != 1 {
		t.Errorf("us/p2 disturbed: %+v", got)
	}
}

func TestDetailsDueOrdering(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	cutoff := now.Add(-7 * 24 * time.Hour)

	add := func(id string, source string) {
		t.Helper()
		p := product("Available", 10900)
		p.ID, p.Slug = id, id
		if source == SourceDiscovered {
			if _, err := s.Discover(ctx, "us", p, false, now); err != nil {
				t.Fatal(err)
			}
			return
		}
		if _, err := s.AddItem(ctx, "us", id, source, "", now); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Apply(ctx, "us", p, now); err != nil {
			t.Fatal(err)
		}
		if err := s.LinkItem(ctx, "us", id, id); err != nil {
			t.Fatal(err)
		}
	}
	fetch := func(id string, at time.Time) {
		t.Helper()
		p := product("Available", 10900)
		p.ID, p.Slug, p.Detailed = id, id, true
		if _, err := s.Apply(ctx, "us", p, at); err != nil {
			t.Fatal(err)
		}
	}
	add("fresh", SourceConfig)        // fetched a day ago: not due
	add("stale-old", SourceConfig)    // fetched a month ago
	add("stale-newer", SourceConfig)  // fetched ten days ago
	add("never-listed", SourceConfig) // never fetched
	add("never-found", SourceDiscovered)
	fetch("fresh", now.Add(-24*time.Hour))
	fetch("stale-old", now.Add(-30*24*time.Hour))
	fetch("stale-newer", now.Add(-10*24*time.Hour))

	due, err := s.DetailsDue(ctx, cutoff)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, it := range due {
		got = append(got, it.Slug)
	}
	// Never-fetched first (listed before discovered), then the stalest.
	if want := []string{"never-listed", "never-found", "stale-old", "stale-newer"}; !slices.Equal(got, want) {
		t.Errorf("due = %v, want %v", got, want)
	}
}

func TestDetailsDueCarriesTheItemDetails(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	p := product("Available", 10900)
	p.Category = "wifi-flagship"
	if _, err := s.Discover(ctx, "us", p, false, time.Now()); err != nil {
		t.Fatal(err)
	}
	due, err := s.DetailsDue(ctx, time.Now().Add(-time.Hour))
	if err != nil || len(due) != 1 {
		t.Fatalf("due = %+v (%v)", due, err)
	}
	if it := due[0]; it.Region != "us" || it.Slug != "widget" || it.Source != SourceDiscovered || it.ProductID != "p1" || it.Category != "wifi-flagship" || it.AddedAt.IsZero() {
		t.Errorf("item = %+v", it)
	}
}

func TestDetailsDueIgnoresProductsNotOnTheWatchList(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	// Observed (so it has a products row) but with no items row.
	if _, err := s.Apply(ctx, "us", product("Available", 10900), time.Now()); err != nil {
		t.Fatal(err)
	}
	if due, _ := s.DetailsDue(ctx, time.Now().Add(-time.Hour)); len(due) != 0 {
		t.Errorf("due = %+v", due)
	}
}

func TestMigratesSpecsFromTheTechSpecsSchema(t *testing.T) {
	// A database as deployed before specs were stored: a product that was already
	// detailed, with no knowledge of its specification.
	path := filepath.Join(t.TempDir(), "old.db")
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
	for _, q := range []string{
		fmt.Sprintf(`PRAGMA user_version = %d`, prior),
		`INSERT INTO products (region, id, slug, name, title, detailed_at) VALUES ('us', 'p1', 'widget', 'W', 'Widget', '2026-10-01T00:00:00Z')`,
		`INSERT INTO items (region, slug, source, product_id, added_at) VALUES ('us', 'widget', 'config', 'p1', '2026-10-01T00:00:00Z')`,
	} {
		if _, err := raw.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	_ = raw.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}
	defer func() { _ = s.Close() }()
	var version int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil || version != len(migrations) {
		t.Fatalf("user_version = %d (%v), want %d", version, err, len(migrations))
	}
	// Already detailed, but its specs were never read, so it is due.
	due, err := s.DetailsDue(context.Background(), time.Now().Add(-time.Hour))
	if err != nil || len(due) != 1 || due[0].Slug != "widget" {
		t.Fatalf("a product detailed before specs existed must be due: %+v (%v)", due, err)
	}
	if got, err := s.ProductSpecs(context.Background(), "us", "p1"); err != nil || len(got) != 0 {
		t.Errorf("specs = %+v (%v)", got, err)
	}
}
