package store

import (
	"context"
	"testing"
	"time"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

func TestStatusCountsEverything(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now().UTC().Truncate(time.Second)

	empty, err := s.Status(ctx, now)
	if err != nil || empty.Products != 0 || empty.LastChecked != nil || len(empty.Categories) != 0 {
		t.Fatalf("empty database: %+v, %v", empty, err)
	}

	mk := func(id, category string, detailed bool, specs []unistore.Spec) *unistore.Product {
		p := product("Available", 10900)
		p.ID, p.Slug, p.Category, p.Detailed, p.Specs = id, "slug-"+id, category, detailed, specs
		p.Variants[0].ID = "v-" + id
		return p
	}
	checked := now.Add(-time.Hour)
	for _, p := range []*unistore.Product{
		mk("a", "switching", true, wifiSpecs),         // has specs
		mk("b", "switching", true, []unistore.Spec{}), // read, but the store gave none
		mk("c", "cameras", false, nil),                // never read
		mk("d", "", false, nil),                       // category unknown
	} {
		if _, err := s.Apply(ctx, "us", p, checked); err != nil {
			t.Fatal(err)
		}
	}
	// A newer check of one variant moves last_checked forward.
	if _, err := s.Apply(ctx, "us", mk("a", "switching", true, wifiSpecs), now); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkCategoriesSeen(ctx, "us", []string{"switching", "cameras", "empty-cat"}, now); err != nil {
		t.Fatal(err)
	}
	if err := s.SetTechSpecsURL(ctx, "us", "a", "https://techspecs.ui.com/a", now); err != nil {
		t.Fatal(err)
	}
	if err := s.SetTechSpecsURL(ctx, "us", "b", "", now); err != nil {
		t.Fatal(err)
	}

	st, err := s.Status(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	if st.Products != 4 || st.Variants != 4 || st.ProductsByRegion["us"] != 4 {
		t.Errorf("totals: %+v", st)
	}
	want := map[string]int{"cameras": 1, "empty-cat": 0, "switching": 2}
	if len(st.Categories) != len(want) {
		t.Fatalf("categories: %+v", st.Categories)
	}
	for _, c := range st.Categories {
		if want[c.ID] != c.Products {
			t.Errorf("category %s: %d, want %d", c.ID, c.Products, want[c.ID])
		}
	}
	if st.Uncategorized != 1 {
		t.Errorf("uncategorized = %d, want 1", st.Uncategorized)
	}
	if st.WithSpecs != 1 || st.SpecsEmpty != 1 || st.SpecsNotFetched != 2 {
		t.Errorf("specs: with %d, empty %d, not fetched %d", st.WithSpecs, st.SpecsEmpty, st.SpecsNotFetched)
	}
	if st.WithTechSpecsURL != 1 || st.NoTechSpecsURL != 1 || st.TechSpecsNotChecked != 2 {
		t.Errorf("techspecs url: with %d, none %d, unchecked %d", st.WithTechSpecsURL, st.NoTechSpecsURL, st.TechSpecsNotChecked)
	}
	if st.NeverDetailed != 2 {
		t.Errorf("never detailed = %d, want 2", st.NeverDetailed)
	}
	if st.LastChecked == nil || !st.LastChecked.Equal(now) || st.OldestChecked == nil || !st.OldestChecked.Equal(checked) {
		t.Errorf("checked: newest %v oldest %v", st.LastChecked, st.OldestChecked)
	}
	if st.VariantsByStatus["Available"] != 4 {
		t.Errorf("variants by status: %v", st.VariantsByStatus)
	}
}
