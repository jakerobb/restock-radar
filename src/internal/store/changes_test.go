package store

import (
	"context"
	"testing"
	"time"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

func cp(n int64) *int64 { return &n }

func TestDescribeChange(t *testing.T) {
	status := func(old, new string) Event { return Event{Kind: KindStatus, OldStatus: old, NewStatus: new} }
	price := func(e Event) Event { e.Kind = KindPrice; return e }
	for name, tc := range map[string]struct {
		events []Event
		want   string
	}{
		"nothing":            {nil, ""},
		"sold out":           {[]Event{status("Available", "SoldOut")}, "Out of stock"},
		"restocked":          {[]Event{status("SoldOut", "Available")}, "Back in stock"},
		"launched":           {[]Event{status("ComingSoon", "Available")}, "In stock"},
		"announced":          {[]Event{status("Available", "ComingSoon")}, "Coming soon"},
		"price up":           {[]Event{price(Event{OldPriceCents: cp(100), NewPriceCents: cp(200)})}, "Price increased"},
		"price down":         {[]Event{price(Event{OldPriceCents: cp(200), NewPriceCents: cp(100)})}, "Price decreased"},
		"total decides":      {[]Event{price(Event{OldPriceCents: cp(100), NewPriceCents: cp(100), OldTotalCents: cp(150), NewTotalCents: cp(130)})}, "Price decreased"},
		"unknown direction":  {[]Event{price(Event{})}, "Price changed"},
		"surcharge added":    {[]Event{price(Event{OldSurchargeTypes: []string{}, NewSurchargeTypes: []string{"Memory"}})}, "Memory surcharge added"},
		"surcharge removed":  {[]Event{price(Event{OldSurchargeTypes: []string{"Tariff"}, NewSurchargeTypes: []string{}})}, "Tariff surcharge removed"},
		"two added":          {[]Event{price(Event{OldSurchargeTypes: []string{}, NewSurchargeTypes: []string{"Memory", "Tariff"}})}, "Memory and Tariff surcharges added"},
		"swapped":            {[]Event{price(Event{OldSurchargeTypes: []string{"Memory"}, NewSurchargeTypes: []string{"Tariff"}})}, "Surcharges changed"},
		"status beats price": {[]Event{price(Event{OldPriceCents: cp(1), NewPriceCents: cp(2)}), status("SoldOut", "Available")}, "Back in stock"},
	} {
		t.Run(name, func(t *testing.T) {
			if got := DescribeChange(tc.events); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestVariantsSayWhatLastChanged(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	p := &unistore.Product{ID: "p", Slug: "p", Name: "p", Title: "P", Variants: []unistore.Variant{
		{ID: "v", SKU: "S", Title: "US", Status: "Available", Price: &unistore.Money{Amount: 10000, Currency: "USD"}},
	}}
	last := func() string {
		t.Helper()
		vs, err := s.Variants(ctx, "us")
		if err != nil || len(vs) != 1 {
			t.Fatalf("variants: %v, %v", vs, err)
		}
		return vs[0].LastChange
	}
	apply := func(at time.Time) {
		t.Helper()
		if _, err := s.Apply(ctx, "us", p, at); err != nil {
			t.Fatal(err)
		}
	}

	now := time.Now()
	apply(now)
	if got := last(); got != "First tracked" {
		t.Errorf("after the first poll: %q", got)
	}
	apply(now.Add(time.Minute))
	if got := last(); got != "First tracked" {
		t.Errorf("after an unchanged poll: %q", got)
	}
	p.Variants[0].Status = "SoldOut"
	apply(now.Add(2 * time.Minute))
	if got := last(); got != "Out of stock" {
		t.Errorf("after selling out: %q", got)
	}
	p.Variants[0].Status = "Available"
	p.Variants[0].Price = &unistore.Money{Amount: 12000, Currency: "USD"}
	apply(now.Add(3 * time.Minute))
	if got := last(); got != "Back in stock" {
		t.Errorf("after restocking at a new price: %q", got)
	}
	p.Variants[0].Price = &unistore.Money{Amount: 9000, Currency: "USD"}
	apply(now.Add(4 * time.Minute))
	if got := last(); got != "Price decreased" {
		t.Errorf("after a price drop: %q", got)
	}
}
