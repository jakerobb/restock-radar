package unistore

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"testing"

	"github.com/jakerobb/restock-radar/internal/config"
)

// entry builds one raw specification entry as the store sends it.
func entry(typename, id, label, parent string, fields map[string]any) map[string]any {
	f := map[string]any{"__typename": "SpecificationEntitySectionFeature" + typename, "feature": map[string]any{"id": id, "label": label, "parentId": nilIfEmpty(parent)}}
	for k, v := range fields {
		f[k] = v
	}
	return f
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func text(id, label, parent, value string) map[string]any {
	return entry("EntryText", id, label, parent, map[string]any{"value": value, "note": nil})
}

func flag(id, label, parent, value string) map[string]any {
	return entry("EntryFlag", id, label, parent, map[string]any{"flag": value, "note": nil})
}

func group(id, label string) map[string]any { return entry("Group", id, label, "", nil) }

// section builds a raw section.
func section(id, label, typ string, features ...map[string]any) map[string]any {
	return map[string]any{"section": map[string]any{"id": id, "label": label, "type": typ}, "features": features}
}

// specsOf runs the specification through the same JSON decoding the client does.
func specsOf(t *testing.T, sections ...map[string]any) ([]Spec, int) {
	t.Helper()
	b, err := json.Marshal(map[string]any{"sections": sections})
	if err != nil {
		t.Fatal(err)
	}
	var raw rawSpecs
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	return convertSpecs(&raw)
}

func TestConvertSpecsEntryKinds(t *testing.T) {
	got, skipped := specsOf(t, section("s1", "Hardware", "Standard",
		text("f1", "Weight", "", "680 g (1.5 lb)"),
		flag("f2", "NDAA Compliant", "", "True"),
		flag("f3", "Layer 3", "", "False"),
		group("g1", "Antenna Gain"),
		text("f4", "6 GHz", "g1", "5.8 dBi"),
	))
	want := []Spec{
		{SectionID: "s1", Section: "Hardware", SectionType: "Standard", FeatureID: "f1", Label: "Weight", Kind: SpecText, Value: "680 g (1.5 lb)"},
		{SectionID: "s1", Section: "Hardware", SectionType: "Standard", FeatureID: "f2", Label: "NDAA Compliant", Kind: SpecFlag, Value: "true"},
		{SectionID: "s1", Section: "Hardware", SectionType: "Standard", FeatureID: "f3", Label: "Layer 3", Kind: SpecFlag, Value: "false"},
		{SectionID: "s1", Section: "Hardware", SectionType: "Standard", FeatureID: "g1", Label: "Antenna Gain", Kind: SpecGroup},
		{SectionID: "s1", Section: "Hardware", SectionType: "Standard", FeatureID: "f4", ParentID: "g1", Label: "6 GHz", Kind: SpecText, Value: "5.8 dBi"},
	}
	if !slices.Equal(got, want) || skipped != 0 {
		t.Errorf("got %+v (skipped %d)\nwant %+v", got, skipped, want)
	}
}

func TestConvertSpecsKeepsTheStoresOrderAcrossSections(t *testing.T) {
	got, _ := specsOf(t,
		section("s2", "Performance", "Standard", text("b", "B", "", "2")),
		section("s1", "Overview", "Standard", text("a", "A", "", "1"), text("c", "C", "", "3")),
	)
	var order []string
	for _, s := range got {
		order = append(order, s.Section+"/"+s.Label)
	}
	if want := []string{"Performance/B", "Overview/A", "Overview/C"}; !slices.Equal(order, want) {
		t.Errorf("order = %v, want %v", order, want)
	}
}

func TestConvertSpecsNilAndEmpty(t *testing.T) {
	if got, n := convertSpecs(nil); got != nil || n != 0 {
		t.Errorf("no specification: got %#v, %d; want nil", got, n)
	}
	got, n := specsOf(t)
	if got == nil || len(got) != 0 || n != 0 {
		t.Errorf("empty specification: got %#v, %d; want an empty, non-nil slice", got, n)
	}
	got, _ = specsOf(t, section("s1", "Hardware", "Standard"))
	if got == nil || len(got) != 0 {
		t.Errorf("section without entries: got %#v, want empty non-nil", got)
	}
}

func TestConvertSpecsDropsEntriesWithoutValues(t *testing.T) {
	got, skipped := specsOf(t, section("s1", "Hardware", "Standard",
		flag("f1", "Thread", "", "Empty"),
		flag("f2", "Wind Loading", "", "empty"), // case doesn't matter
		text("f3", "Blank", "", ""),
		text("f4", "Spaces", "", " \n\t "),
		entry("EntryText", "f5", "Missing value", "", map[string]any{"value": nil}),
		entry("EntryFlag", "f6", "Missing flag", "", map[string]any{"flag": nil}),
		text("f7", "Kept", "", "yes"),
	))
	if len(got) != 1 || got[0].FeatureID != "f7" {
		t.Errorf("got %+v, want only f7", got)
	}
	if skipped != 0 {
		t.Errorf("empty entries are not malformed; skipped = %d", skipped)
	}
}

func TestConvertSpecsTrimsAndKeepsNotes(t *testing.T) {
	got, _ := specsOf(t, section("s1", "Overview", "Standard",
		entry("EntryText", "f1", "Redundancy", "", map[string]any{"value": "\nDC Power Backup\n", "note": " With UniFi RPS "}),
		entry("EntryText", "f2", "Dimensions", "", map[string]any{"value": "442 x 325 x 44 mm\n(17.4 x 12.8 x 1.7\")", "note": ""}),
	))
	if got[0].Value != "DC Power Backup" || got[0].Note != "With UniFi RPS" {
		t.Errorf("not trimmed: %+v", got[0])
	}
	// Line breaks inside a value are the store's layout and are kept.
	if got[1].Value != "442 x 325 x 44 mm\n(17.4 x 12.8 x 1.7\")" || got[1].Note != "" {
		t.Errorf("inner newline lost: %+v", got[1])
	}
}

func TestConvertSpecsCountsMalformedEntries(t *testing.T) {
	got, skipped := specsOf(t, section("s1", "Hardware", "Standard",
		text("", "No id", "", "x"),
		entry("EntryVideo", "f2", "Unknown kind", "", map[string]any{"value": "x"}),
		flag("f3", "Odd flag", "", "Maybe"),
		text("f4", "Fine", "", "ok"),
	))
	if len(got) != 1 || got[0].FeatureID != "f4" {
		t.Errorf("got %+v, want only f4", got)
	}
	if skipped != 3 {
		t.Errorf("skipped = %d, want 3", skipped)
	}
}

func TestConvertSpecsPrunesEmptyGroups(t *testing.T) {
	got, _ := specsOf(t, section("s1", "Hardware", "Standard",
		group("g1", "Antennas"), // every child empty
		flag("c1", "2.4 GHz", "g1", "Empty"),
		group("g2", "Antenna Gain"), // one child kept
		text("c2", "6 GHz", "g2", "5.8 dBi"),
		flag("c3", "5 GHz", "g2", "Empty"),
		group("g3", "Nothing at all"), // never had children
	))
	var ids []string
	for _, s := range got {
		ids = append(ids, s.FeatureID)
	}
	if want := []string{"g2", "c2"}; !slices.Equal(ids, want) {
		t.Errorf("kept %v, want %v", ids, want)
	}
}

func TestConvertSpecsPrunesNestedGroupsFromTheInside(t *testing.T) {
	inner := entry("Group", "g2", "Inner", "g1", nil)
	got, _ := specsOf(t, section("s1", "Hardware", "Standard",
		group("g1", "Outer"),
		inner,
		flag("c1", "Child", "g2", "Empty"),
	))
	if len(got) != 0 {
		t.Errorf("an outer group whose only child is an emptied group must go too: %+v", got)
	}

	got, _ = specsOf(t, section("s1", "Hardware", "Standard",
		group("g1", "Outer"),
		inner,
		text("c1", "Child", "g2", "x"),
	))
	if len(got) != 3 {
		t.Errorf("a populated nest is kept whole: %+v", got)
	}
}

func TestConvertSpecsFeatureRepeatedAcrossSections(t *testing.T) {
	// The grid overview echoes features from the other sections, so the same
	// feature id turns up in more than one; groups are matched within a section.
	got, _ := specsOf(t,
		section("s0", "Grid overview", "Overview", group("g1", "Antenna Gain"), text("c1", "6 GHz", "g1", "5.8 dBi")),
		section("s1", "Performance", "Standard", group("g1", "Antenna Gain"), flag("c1", "6 GHz", "g1", "Empty")),
	)
	// A group emptied in one section isn't kept alive by the same id in another.
	if len(got) != 2 || got[0].Section != "Grid overview" || got[1].Section != "Grid overview" {
		t.Errorf("got %+v, want only the grid overview's two entries", got)
	}
}

// --- through the client, against a real page ---

func serve(t *testing.T, product string) config.Region {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/us/en", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`"buildId":"b1"`)) })
	mux.HandleFunc("/_next/data/b1/us/en/products/{slug}", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(product)) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return config.Region{ID: "us", BaseURL: srv.URL, Path: "us/en"}
}

// child finds the entry labelled label under the group labelled parent in a section.
func child(specs []Spec, section, parent, label string) *Spec {
	for _, g := range specs {
		if g.Section != section || g.Kind != SpecGroup || g.Label != parent {
			continue
		}
		for i := range specs {
			if s := &specs[i]; s.Section == section && s.ParentID == g.FeatureID && s.Label == label {
				return s
			}
		}
	}
	return nil
}

func find(specs []Spec, section, label string) *Spec {
	for i := range specs {
		if specs[i].Section == section && specs[i].Label == label {
			return &specs[i]
		}
	}
	return nil
}

func TestFetchProductReadsASpecificationFromARealPage(t *testing.T) {
	// A U7 Pro product page as the store served it (media and unrelated fields removed).
	page, err := os.ReadFile("testdata/product-u7-pro.json")
	if err != nil {
		t.Fatal(err)
	}
	p, err := New("test").FetchProduct(context.Background(), serve(t, string(page)), "u7-pro")
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Specs) == 0 || p.SpecsSkipped != 0 {
		t.Fatalf("got %d specs, %d skipped", len(p.Specs), p.SpecsSkipped)
	}
	for _, s := range p.Specs {
		if s.FeatureID == "" || s.Label == "" || s.Section == "" || s.SectionID == "" {
			t.Fatalf("incomplete entry: %+v", s)
		}
		switch s.Kind {
		case SpecText:
			if s.Value == "" {
				t.Fatalf("text entry without a value: %+v", s)
			}
		case SpecFlag:
			if s.Value != "true" && s.Value != "false" {
				t.Fatalf("flag with value %q: %+v", s.Value, s)
			}
		case SpecGroup:
			if s.Value != "" {
				t.Fatalf("group with a value: %+v", s)
			}
		default:
			t.Fatalf("kind %q: %+v", s.Kind, s)
		}
	}

	// The same label ("6 GHz") means different things under different groups.
	for group, want := range map[string]string{"Antenna Gain": "5.8 dBi", "Max. TX Power": "23 dBm"} {
		if s := child(p.Specs, "Performance", group, "6 GHz"); s == nil || s.Kind != SpecText || s.Value != want {
			t.Errorf("%s / 6 GHz = %+v, want %q", group, s, want)
		}
	}
	if s := child(p.Specs, "Performance", "Max. TX Power", "5 GHz"); s == nil || s.Value != "26 dBm" {
		t.Errorf("Max. TX Power / 5 GHz = %+v", s)
	}

	if s := find(p.Specs, "Overview", "Uplink"); s == nil || s.Value != "2.5 GbE" || s.Kind != SpecText {
		t.Errorf("Uplink = %+v", s)
	}
	if s := find(p.Specs, "Features", "Band Steering"); s == nil || s.Kind != SpecFlag || s.Value != "true" {
		t.Errorf("Band Steering = %+v", s)
	}
	if s := find(p.Specs, "Overview", "WiFi Standard"); s == nil || s.Value != "WiFi 7" || s.Note != "With 6 GHz support" {
		t.Errorf("WiFi Standard = %+v", s)
	}

	// The grid overview is kept, marked as such.
	grid := 0
	for _, s := range p.Specs {
		if s.Section == "Grid overview" {
			grid++
			if s.SectionType != "Overview" {
				t.Errorf("grid entry has section type %q", s.SectionType)
			}
		} else if s.SectionType != "Standard" {
			t.Errorf("%s has section type %q", s.Section, s.SectionType)
		}
	}
	if grid == 0 {
		t.Error("grid overview entries were dropped")
	}

	// The page lists features the U7 Pro has no value for ("Thread", "Antennas", ...).
	for _, s := range p.Specs {
		if s.Label == "Thread" || s.Label == "Antennas" || s.Label == "Includes PoE Adapter" {
			t.Errorf("an empty feature survived: %+v", s)
		}
	}
}

func TestFetchProductWithoutASpecification(t *testing.T) {
	for name, field := range map[string]string{
		"absent": ``,
		"null":   `"technicalSpecification":null,`,
	} {
		t.Run(name, func(t *testing.T) {
			page := `{"pageProps":{"currentProductId":"p1","collection":{"products":[{"id":"p1","slug":"w","name":"W","title":"W",` + field +
				`"variants":[{"id":"v1","sku":"S","title":"US","status":"Available"}]}]}}}`
			p, err := New("test").FetchProduct(context.Background(), serve(t, page), "w")
			if err != nil {
				t.Fatal(err)
			}
			if p.Specs != nil {
				t.Errorf("Specs = %#v, want nil (the response said nothing)", p.Specs)
			}
		})
	}
}

func TestFetchProductWithAnEmptySpecification(t *testing.T) {
	page := `{"pageProps":{"currentProductId":"p1","collection":{"products":[{"id":"p1","slug":"w","name":"W","title":"W",
		"technicalSpecification":{"sections":[]},"variants":[{"id":"v1","sku":"S","title":"US","status":"Available"}]}]}}}`
	p, err := New("test").FetchProduct(context.Background(), serve(t, page), "w")
	if err != nil {
		t.Fatal(err)
	}
	if p.Specs == nil || len(p.Specs) != 0 {
		t.Errorf("Specs = %#v, want empty but non-nil: the store says there are none", p.Specs)
	}
}

func TestMalformedSpecificationDoesNotFailTheProduct(t *testing.T) {
	// Stock and price are what we track; a broken specification mustn't hide them.
	page := `{"pageProps":{"currentProductId":"p1","collection":{"products":[{"id":"p1","slug":"w","name":"W","title":"W",
		"technicalSpecification":{"sections":[{"section":{"id":"s","label":"S","type":"Standard"},"features":[
			{"__typename":"SpecificationEntitySectionFeatureEntryText","value":"x","feature":{"id":""}},
			{"__typename":"SpecificationEntitySectionFeatureEntryText","value":"ok","feature":{"id":"f","label":"Fine"}}]}]},
		"variants":[{"id":"v1","sku":"S","title":"US","status":"Available"}]}]}}}`
	p, err := New("test").FetchProduct(context.Background(), serve(t, page), "w")
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Specs) != 1 || p.SpecsSkipped != 1 || len(p.Variants) != 1 {
		t.Errorf("specs %+v, skipped %d, variants %d", p.Specs, p.SpecsSkipped, len(p.Variants))
	}
}

func TestFetchProductFollowsARedirectToTheSpecification(t *testing.T) {
	page, _ := os.ReadFile("testdata/product-u7-pro.json")
	mux := http.NewServeMux()
	mux.HandleFunc("/us/en", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`"buildId":"b1"`)) })
	mux.HandleFunc("/_next/data/b1/us/en/products/{slug}", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("slug") == "old-u7-pro.json" {
			_, _ = w.Write([]byte(`{"pageProps":{"__N_REDIRECT":"/us/en/products/u7-pro"}}`))
			return
		}
		_, _ = w.Write(page)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	p, err := New("test").FetchProduct(context.Background(), config.Region{ID: "us", BaseURL: srv.URL, Path: "us/en"}, "old-u7-pro")
	if err != nil || len(p.Specs) == 0 {
		t.Fatalf("specs after a redirect: %d (%v)", len(p.Specs), err)
	}
}

func TestCategoryPagesNeverProvideSpecs(t *testing.T) {
	// Category pages carry only the grid summary. Taking it for the specification
	// would replace a product's full one with six entries.
	page := `{"pageProps":{"subCategories":[{"id":"c1","products":[{"id":"p1","slug":"w","name":"W","title":"W",
		"technicalSpecification":{"sections":[{"section":{"id":"s","label":"Grid overview","type":"Overview"},"features":[
			{"__typename":"SpecificationEntitySectionFeatureEntryText","value":"WiFi 7","feature":{"id":"f","label":"WiFi7"}}]}]},
		"variants":[{"id":"v1","sku":"S","status":"Available"}]}]}]}}`
	mux := http.NewServeMux()
	mux.HandleFunc("/us/en", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`"buildId":"b1"`)) })
	mux.HandleFunc("/_next/data/b1/us/en/category/{id}", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(page)) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	cat, err := New("test").FetchCategory(context.Background(), config.Region{ID: "us", BaseURL: srv.URL, Path: "us/en"}, "c1")
	if err != nil || len(cat.Products) != 1 {
		t.Fatalf("category: %+v (%v)", cat, err)
	}
	if p := cat.Products[0]; p.Specs != nil || p.SpecsSkipped != 0 || p.Detailed {
		t.Errorf("category product has specs %+v / detailed %v", p.Specs, p.Detailed)
	}
}
