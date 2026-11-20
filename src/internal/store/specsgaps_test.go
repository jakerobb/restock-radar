package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

func plainProduct(region, id, slug string, specs []unistore.Spec) *unistore.Product {
	return &unistore.Product{
		ID: id, Slug: slug, Name: slug, Title: slug, Category: "accessories", Detailed: true, Specs: specs,
		Variants: []unistore.Variant{{ID: "v-" + id, SKU: slug, Title: region, Status: "Available", Price: &unistore.Money{Amount: 1000, Currency: "USD"}}},
	}
}

func TestBaseSlugDropsTheRegion(t *testing.T) {
	for in, want := range map[string]string{"ups-tower-eu": "ups-tower", "UPS-Tower-US": "ups-tower", "unvr": "unvr", "usw-flex-mini": "usw-flex-mini", "cable-uk": "cable"} {
		if got := BaseSlug(in); got != want {
			t.Errorf("BaseSlug(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSpecsGapsListsProductsWithNoSpecsAndWhichAreNotExpected(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	withSpecs := []unistore.Spec{{SectionID: "s", Section: "Overview", SectionType: "Standard", FeatureID: "f", Label: "Dimensions", Kind: unistore.SpecText, Value: "442.4 x 63.5 x 43.7 mm"}}
	for _, p := range []struct {
		region string
		p      *unistore.Product
	}{
		{"us", plainProduct("us", "p1", "cable", nil)},        // fetched, the store has none
		{"eu", plainProduct("eu", "p2", "cable-eu", nil)},     // the same product in another region, with a regional slug
		{"us", plainProduct("us", "p3", "switch", withSpecs)}, // has specs
		{"us", plainProduct("us", "p4", "cable-ties", nil)},   // starts with "cable" but is another product
	} {
		if _, err := s.Apply(ctx, p.region, p.p, now); err != nil {
			t.Fatal(err)
		}
	}

	gaps, expected, err := s.SpecsGaps(ctx)
	if err != nil || len(expected) != 0 || len(gaps) != 3 {
		t.Fatalf("gaps = %+v, expected = %+v (%v)", gaps, expected, err)
	}
	for _, g := range gaps {
		if g.NotExpected || g.FetchedAt == nil {
			t.Errorf("%s/%s = %+v", g.Region, g.Slug, g)
		}
	}

	e, err := s.MarkSpecsNotExpected(ctx, "cable-eu", "just a cable", "jake", now) // marked through the regional slug
	if err != nil || e.Slug != "cable" || e.Reason != "just a cable" || e.CreatedBy != "jake" {
		t.Fatalf("entry = %+v (%v)", e, err)
	}
	gaps, expected, _ = s.SpecsGaps(ctx)
	if len(expected) != 1 {
		t.Fatalf("expected = %+v", expected)
	}
	got := map[string]bool{}
	for _, g := range gaps {
		got[g.Region+"/"+g.Slug] = g.NotExpected
	}
	if !got["us/cable"] || !got["eu/cable-eu"] || got["us/cable-ties"] {
		t.Errorf("not expected = %v: both regions of the cable, and not the cable ties", got)
	}

	if _, err := s.MarkSpecsNotExpected(ctx, "no-such-thing", "", "jake", now); !errors.Is(err, ErrUnknownProduct) {
		t.Errorf("unknown product: %v", err)
	}
	// A prefix of a tracked slug isn't a tracked product.
	if _, err := s.MarkSpecsNotExpected(ctx, "cab", "", "jake", now); !errors.Is(err, ErrUnknownProduct) {
		t.Errorf("a prefix: %v", err)
	}

	if ok, err := s.UnmarkSpecsNotExpected(ctx, "cable-us"); err != nil || !ok {
		t.Fatalf("unmark = %v, %v", ok, err)
	}
	if ok, _ := s.UnmarkSpecsNotExpected(ctx, "cable"); ok {
		t.Error("unmarked twice")
	}
}

func TestSpecsGapsTellsNotFetchedFromFetchedWithNone(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	// Seen on a category page only: no product endpoint fetch yet.
	if _, err := s.Discover(ctx, "eu", &unistore.Product{ID: "p9", Slug: "new-thing", Title: "New thing", Category: "accessories",
		Variants: []unistore.Variant{{ID: "v9", SKU: "NEW", Title: "EU", Status: "Available", Price: &unistore.Money{Amount: 100, Currency: "EUR"}}}}, false, now); err != nil {
		t.Fatal(err)
	}
	gaps, _, err := s.SpecsGaps(ctx)
	if err != nil || len(gaps) != 1 || gaps[0].FetchedAt != nil {
		t.Fatalf("gaps = %+v (%v)", gaps, err)
	}
}

func TestSpecsGapsIncludesProductsWhoseSpecsGiveNothingToDerive(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	text := func(label, value string) unistore.Spec {
		return unistore.Spec{SectionID: "s", Section: "Overview", SectionType: "Standard", FeatureID: "f-" + label, Label: label, Kind: unistore.SpecText, Value: value}
	}
	// Published, but nothing the derivation reads (a per-variant table puts its values under a group).
	if _, err := s.Apply(ctx, "us", plainProduct("us", "p1", "panels", []unistore.Spec{text("Materials", "Steel"), text("Treatment", "Painting")}), now); err != nil {
		t.Fatal(err)
	}
	// Published, and a size can be read from it.
	if _, err := s.Apply(ctx, "us", plainProduct("us", "p2", "bracket", []unistore.Spec{text("Dimensions", "442.4 x 63.5 x 43.7 mm")}), now); err != nil {
		t.Fatal(err)
	}
	gaps, _, err := s.SpecsGaps(ctx)
	if err != nil || len(gaps) != 1 || gaps[0].Slug != "panels" || !gaps[0].Published || gaps[0].FetchedAt == nil {
		t.Fatalf("gaps = %+v (%v)", gaps, err)
	}
}
