package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jakerobb/restock-radar/internal/specs"
	"github.com/jakerobb/restock-radar/internal/unistore"
)

func idsOverride(value string) specs.Override {
	return specs.Override{Region: "us", Slug: "ucg-fiber", Action: specs.ActionSet, Section: "Overview", Label: "IDS/IPS Throughput",
		Value: value, SourceURL: "https://example.com/teardown", Reason: "measured above the rating in a teardown"}
}

func metricOf(d *DerivedProduct, name string) *specs.Metric {
	for i := range d.Metrics {
		if d.Metrics[i].Name == name {
			return &d.Metrics[i]
		}
	}
	return nil
}

func TestOverrideChangesWhatIsDerivedAndKeepsThePublishedValue(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	applyReal(t, s, "ucg-fiber", now)

	st, err := s.UpsertOverride(ctx, idsOverride("8+ Gbps"), now)
	if err != nil {
		t.Fatal(err)
	}
	if st.ID == 0 || st.Status != specs.StatusOverrides || st.Stale || st.Value != "8+ Gbps" || st.SourceURL == "" || st.Reason == "" {
		t.Errorf("status = %+v", st)
	}
	if st.PublishedValue == nil || *st.PublishedValue != "5 Gbps" || st.PublishedNow == nil || *st.PublishedNow != "5 Gbps" {
		t.Errorf("published = %v / now %v", st.PublishedValue, st.PublishedNow)
	}
	if st.CreatedAt.IsZero() || st.UpdatedAt.IsZero() {
		t.Errorf("times = %v %v", st.CreatedAt, st.UpdatedAt)
	}

	d, _ := s.Derived(ctx, "us", "id-ucg-fiber")
	m := metricOf(d, "ids_ips_throughput_mbps")
	if m == nil || m.Value != 8000 || !m.AtLeast || m.Raw != "8+ Gbps" {
		t.Fatalf("effective metric = %+v", m)
	}
	// The published value stays visible beside it.
	if len(d.Overridden.Metrics) != 1 || d.Overridden.Metrics[0].Name != "ids_ips_throughput_mbps" {
		t.Fatalf("overridden = %+v", d.Overridden)
	}
	if p := d.Overridden.Metrics[0].Published; p == nil || p.Value != 5000 || p.Raw != "5 Gbps" {
		t.Errorf("published metric = %+v", p)
	}

	// The effective specification shows it too.
	eff, applied, err := s.EffectiveSpecs(ctx, "us", "id-ucg-fiber")
	if err != nil || len(applied) != 1 || applied[0].Status != specs.StatusOverrides {
		t.Fatalf("applied = %+v (%v)", applied, err)
	}
	var e *specs.Effective
	for i := range eff {
		if eff[i].Label == "IDS/IPS Throughput" && eff[i].SectionType == "Standard" {
			e = &eff[i]
		}
	}
	if e == nil || e.Value != "8+ Gbps" || e.Origin != specs.OriginOverride || e.Published == nil || *e.Published != "5 Gbps" {
		t.Errorf("effective entry = %+v", e)
	}

	// The raw rows are untouched.
	raw, _ := s.ProductSpecs(ctx, "us", "id-ucg-fiber")
	for _, sp := range raw {
		if sp.Label == "IDS/IPS Throughput" && sp.SectionType == "Standard" && sp.Value != "5 Gbps" {
			t.Errorf("the published specification was modified: %+v", sp)
		}
	}
}

func TestOverrideSameTargetReplacesItAndRefreshesWhatItWasMadeAgainst(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	t0 := time.Now().Add(-time.Hour)
	p := applyReal(t, s, "ucg-fiber", t0)
	first, err := s.UpsertOverride(ctx, idsOverride("8 Gbps"), t0)
	if err != nil {
		t.Fatal(err)
	}

	// Edited later, with different capitalisation and spacing in the target.
	o := idsOverride("9 Gbps")
	o.Section, o.Label = " overview ", "ids/ips  throughput"
	t1 := time.Now()
	second, err := s.UpsertOverride(ctx, o, t1)
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != first.ID {
		t.Errorf("a second override was made: %d and %d", first.ID, second.ID)
	}
	if second.Value != "9 Gbps" || !second.CreatedAt.Equal(first.CreatedAt) || !second.UpdatedAt.After(first.UpdatedAt) {
		t.Errorf("second = %+v (first %+v)", second, first)
	}
	if all, _ := s.Overrides(ctx, "", ""); len(all) != 1 {
		t.Errorf("%d overrides", len(all))
	}
	_ = p
}

func TestOverrideBecomesStaleWhenTheStoreChangesTheValue(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	p := applyReal(t, s, "ucg-fiber", now)
	if _, err := s.UpsertOverride(ctx, idsOverride("8 Gbps"), now); err != nil {
		t.Fatal(err)
	}

	// The store now says 6 Gbps.
	revised := append([]unistore.Spec{}, p.Specs...)
	for i, sp := range revised {
		if sp.Label == "IDS/IPS Throughput" {
			revised[i].Value = "6 Gbps"
		}
	}
	p2 := *p
	p2.Specs = revised
	if _, err := s.Apply(ctx, "us", &p2, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}

	got, err := s.Overrides(ctx, "us", "ucg-fiber")
	if err != nil || len(got) != 1 {
		t.Fatalf("overrides = %+v (%v)", got, err)
	}
	if !got[0].Stale || got[0].Status != specs.StatusOverrides || *got[0].PublishedNow != "6 Gbps" || *got[0].PublishedValue != "5 Gbps" {
		t.Errorf("override = %+v", got[0])
	}
	// It still wins, and the published value shown is the new one.
	d, _ := s.Derived(ctx, "us", "id-ucg-fiber")
	if m := metricOf(d, "ids_ips_throughput_mbps"); m.Value != 8000 {
		t.Errorf("metric = %+v", m)
	}
	if p := d.Overridden.Metrics[0].Published; p == nil || p.Value != 6000 {
		t.Errorf("published = %+v", p)
	}

	// Saving it again says "I've looked": it is no longer stale.
	if _, err := s.UpsertOverride(ctx, idsOverride("8 Gbps"), now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Overrides(ctx, "us", "ucg-fiber"); got[0].Stale {
		t.Errorf("still stale: %+v", got[0])
	}
}

func TestOverrideSurvivesTheStoreRepublishingTheProduct(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	p := applyReal(t, s, "ucg-fiber", now)
	if _, err := s.UpsertOverride(ctx, idsOverride("8 Gbps"), now); err != nil {
		t.Fatal(err)
	}
	// An unrelated change: the weight is revised, so every row is rewritten (ids and positions could all differ).
	revised := append([]unistore.Spec{}, p.Specs...)
	for i, sp := range revised {
		if sp.Label == "Weight" {
			revised[i].Value = "999 g"
		}
	}
	// Reverse the order and replace the ids: the override finds its entry by target.
	for i, j := 0, len(revised)-1; i < j; i, j = i+1, j-1 {
		revised[i], revised[j] = revised[j], revised[i]
	}
	p2 := *p
	p2.Specs = revised
	if _, err := s.Apply(ctx, "us", &p2, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	d, _ := s.Derived(ctx, "us", "id-ucg-fiber")
	if m := metricOf(d, "ids_ips_throughput_mbps"); m == nil || m.Value != 8000 {
		t.Errorf("metric = %+v", m)
	}
}

func TestOverrideHide(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	applyReal(t, s, "ucg-fiber", now)
	st, err := s.UpsertOverride(ctx, specs.Override{Region: "us", Slug: "ucg-fiber", Action: specs.ActionHide, Section: "Overview", Label: "IDS/IPS Throughput", Value: "ignored", Kind: "flag"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if st.Status != specs.StatusHides || st.Value != "" || st.Kind != "" {
		t.Errorf("a hide carries no value: %+v", st)
	}
	d, _ := s.Derived(ctx, "us", "id-ucg-fiber")
	if metricOf(d, "ids_ips_throughput_mbps") != nil {
		t.Error("the hidden entry still derives a metric")
	}
	if len(d.Overridden.Metrics) != 0 {
		t.Errorf("a removed metric isn't listed as overridden: %+v", d.Overridden.Metrics)
	}
}

func TestOverrideAddsAFactTheStoreDoesNotPublish(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	applyReal(t, s, "usw-flex-mini", now)
	// This switch publishes no IDS/IPS figure.
	st, err := s.UpsertOverride(ctx, specs.Override{Region: "us", Slug: "usw-flex-mini", Action: specs.ActionSet, Section: "Overview", Label: "IDS/IPS Throughput", Value: "1 Gbps"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if st.Status != specs.StatusAdds || st.PublishedValue != nil || st.PublishedNow != nil {
		t.Errorf("status = %+v", st)
	}
	d, _ := s.Derived(ctx, "us", "id-usw-flex-mini")
	if m := metricOf(d, "ids_ips_throughput_mbps"); m == nil || m.Value != 1000 {
		t.Fatalf("metric = %+v", m)
	}
	if len(d.Overridden.Metrics) != 1 || d.Overridden.Metrics[0].Published != nil {
		t.Errorf("overridden = %+v", d.Overridden)
	}
	eff, _, _ := s.EffectiveSpecs(ctx, "us", "id-usw-flex-mini")
	found := false
	for _, e := range eff {
		if e.Label == "IDS/IPS Throughput" && e.Origin == specs.OriginAdded {
			found = true
		}
	}
	if !found {
		t.Error("the added entry is missing from the effective specification")
	}
}

// applyWithFlag stores a small product whose specification has a yes/no entry.
func applyWithFlag(t *testing.T, s *Store, now time.Time) {
	t.Helper()
	p := product("Available", 100)
	p.Detailed = true
	p.Specs = []unistore.Spec{
		{SectionID: "s1", Section: "Security", SectionType: "Standard", FeatureID: "f1", Label: "Intrusion Prevention (IPS/IDS)", Kind: unistore.SpecFlag, Value: "true"},
		{SectionID: "s1", Section: "Security", SectionType: "Standard", FeatureID: "f2", Label: "IDS/IPS Signatures", Kind: unistore.SpecText, Value: "55,000+"},
	}
	if _, err := s.Apply(context.Background(), "us", p, now); err != nil {
		t.Fatal(err)
	}
}

func TestOverrideOnAProductWithNoPublishedSpecification(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	// An accessory the store gives no specification for.
	p := product("Available", 100)
	p.Detailed = true
	if _, err := s.Apply(ctx, "us", p, now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertOverride(ctx, specs.Override{Region: "us", Slug: "widget", Action: specs.ActionSet, Section: "Hardware", Label: "Max. Power Consumption", Value: "12W"}, now); err != nil {
		t.Fatal(err)
	}
	d, _ := s.Derived(ctx, "us", "p1")
	if d == nil || metricOf(d, "power_draw_max_w") == nil || metricOf(d, "power_draw_max_w").Value != 12 {
		t.Errorf("derived = %+v", d)
	}
}

func TestOverridePortsAndRadios(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	applyReal(t, s, "u7-pro", now)
	if _, err := s.UpsertOverride(ctx, specs.Override{Region: "us", Slug: "u7-pro", Action: specs.ActionSet, Section: "Performance", Group: "Max. TX Power", Label: "6 GHz", Value: "30 dBm"}, now); err != nil {
		t.Fatal(err)
	}
	d, _ := s.Derived(ctx, "us", "id-u7-pro")
	var six *specs.Radio
	for i := range d.Radios {
		if d.Radios[i].Band == "6 GHz" {
			six = &d.Radios[i]
		}
	}
	if six == nil || *six.TxPowerDBm != 30 || !d.Overridden.Radios || d.Overridden.Ports {
		t.Errorf("6 GHz = %+v overridden = %+v", six, d.Overridden)
	}
}

func TestDeletingAnOverrideRestoresThePublishedValue(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	applyReal(t, s, "ucg-fiber", now)
	st, _ := s.UpsertOverride(ctx, idsOverride("8 Gbps"), now)

	ok, err := s.DeleteOverride(ctx, st.ID, "tester", now)
	if err != nil || !ok {
		t.Fatalf("delete = %v (%v)", ok, err)
	}
	d, _ := s.Derived(ctx, "us", "id-ucg-fiber")
	if m := metricOf(d, "ids_ips_throughput_mbps"); m.Value != 5000 || m.AtLeast {
		t.Errorf("metric = %+v", m)
	}
	if d.Overridden.Any() {
		t.Errorf("overridden = %+v", d.Overridden)
	}
	if got, _ := s.OverrideByID(ctx, st.ID); got != nil {
		t.Errorf("still there: %+v", got)
	}
	if ok, err := s.DeleteOverride(ctx, st.ID, "tester", now); err != nil || ok {
		t.Errorf("deleting again = %v (%v)", ok, err)
	}
	if ok, err := s.DeleteOverride(ctx, 9999, "tester", now); err != nil || ok {
		t.Errorf("deleting nothing = %v (%v)", ok, err)
	}
}

func TestOverrideValidation(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	applyReal(t, s, "ucg-fiber", now)
	applyWithFlag(t, s, now)

	for _, tc := range []struct {
		name string
		o    specs.Override
		want error
		msg  string
	}{
		{"unknown product", specs.Override{Region: "us", Slug: "nope", Action: "set", Section: "Overview", Label: "X", Value: "1"}, ErrUnknownProduct, ""},
		{"unknown region", specs.Override{Region: "eu", Slug: "ucg-fiber", Action: "set", Section: "Overview", Label: "X", Value: "1"}, ErrUnknownProduct, ""},
		{"bad action", specs.Override{Region: "us", Slug: "ucg-fiber", Action: "delete", Section: "Overview", Label: "X", Value: "1"}, ErrInvalidOverride, "action"},
		{"no section", specs.Override{Region: "us", Slug: "ucg-fiber", Action: "set", Label: "X", Value: "1"}, ErrInvalidOverride, "section and label"},
		{"no label", specs.Override{Region: "us", Slug: "ucg-fiber", Action: "set", Section: "Overview", Value: "1"}, ErrInvalidOverride, "section and label"},
		{"no value", specs.Override{Region: "us", Slug: "ucg-fiber", Action: "set", Section: "Overview", Label: "X", Value: "  "}, ErrInvalidOverride, "value is required"},
		{"bad kind", specs.Override{Region: "us", Slug: "ucg-fiber", Action: "set", Section: "Overview", Label: "X", Value: "1", Kind: "group"}, ErrInvalidOverride, "kind"},
		{"flag value", specs.Override{Region: "us", Slug: "ucg-fiber", Action: "set", Section: "Overview", Label: "X", Value: "yes", Kind: "flag"}, ErrInvalidOverride, "true or false"},
		{"a published yes/no entry given text", specs.Override{Region: "us", Slug: "widget", Action: "set", Section: "Security", Label: "Intrusion Prevention (IPS/IDS)", Value: "lots"}, ErrInvalidOverride, "yes/no"},
		{"a group heading", specs.Override{Region: "us", Slug: "ucg-fiber", Action: "set", Section: "Overview", Label: "Port Layout", Value: "1"}, ErrInvalidOverride, "group heading"},
		{"hiding nothing", specs.Override{Region: "us", Slug: "ucg-fiber", Action: "hide", Section: "Overview", Label: "No Such Thing"}, ErrInvalidOverride, "nothing to hide"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := s.UpsertOverride(ctx, tc.o, now)
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
			if tc.msg != "" && !contains(err.Error(), tc.msg) {
				t.Errorf("message %q lacks %q", err.Error(), tc.msg)
			}
		})
	}
	if all, _ := s.Overrides(ctx, "", ""); len(all) != 0 {
		t.Errorf("a refused override was stored: %+v", all)
	}
}

func contains(s, sub string) bool { return strings.Contains(s, sub) }

func TestOverrideFlagsAndKinds(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	applyReal(t, s, "ucg-fiber", now)
	// Adding a yes/no entry.
	st, err := s.UpsertOverride(ctx, specs.Override{Region: "us", Slug: "ucg-fiber", Action: "set", Section: "Features", Label: "Hardware Offload", Kind: "flag", Value: "true"}, now)
	if err != nil || st.Kind != "flag" || st.Value != "true" || st.Status != specs.StatusAdds {
		t.Fatalf("status = %+v (%v)", st, err)
	}
	// Changing a published yes/no entry: it stays a flag.
	applyWithFlag(t, s, now)
	st, err = s.UpsertOverride(ctx, specs.Override{Region: "us", Slug: "widget", Action: "set", Section: "Security", Label: "Intrusion Prevention (IPS/IDS)", Value: "false"}, now)
	if err != nil || st.Status != specs.StatusOverrides || *st.PublishedValue != "true" {
		t.Fatalf("status = %+v (%v)", st, err)
	}
	eff, _, _ := s.EffectiveSpecs(ctx, "us", "p1")
	for _, e := range eff {
		if e.Label == "Intrusion Prevention (IPS/IDS)" && (e.Kind != unistore.SpecFlag || e.Value != "false") {
			t.Errorf("entry = %+v", e)
		}
	}
}

func TestOverridesListAndFilter(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	applyReal(t, s, "ucg-fiber", now)
	applyReal(t, s, "usw-ultra", now)
	if _, err := s.UpsertOverride(ctx, idsOverride("8 Gbps"), now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertOverride(ctx, specs.Override{Region: "us", Slug: "usw-ultra", Action: "set", Section: "Overview", Label: "Total PoE Availability", Value: "220W"}, now); err != nil {
		t.Fatal(err)
	}
	all, err := s.Overrides(ctx, "", "")
	if err != nil || len(all) != 2 || all[0].Slug != "ucg-fiber" || all[1].Slug != "usw-ultra" {
		t.Fatalf("all = %+v (%v)", all, err)
	}
	if one, _ := s.Overrides(ctx, "us", "usw-ultra"); len(one) != 1 || one[0].Label != "Total PoE Availability" {
		t.Errorf("filtered = %+v", one)
	}
	if none, _ := s.Overrides(ctx, "eu", ""); len(none) != 0 {
		t.Errorf("another region = %+v", none)
	}
	// Overrides on one product don't leak into another's derived facts.
	d, _ := s.Derived(ctx, "us", "id-usw-ultra")
	if metricOf(d, "ids_ips_throughput_mbps") != nil {
		t.Error("the gateway's override reached the switch")
	}
	if d.PoEBudget == nil || selectedWatts(d) != 220 {
		t.Errorf("budget = %+v", d.PoEBudget)
	}
}

func selectedWatts(d *DerivedProduct) float64 {
	for _, b := range d.PoEBudget {
		if b.Selected {
			return b.Watts
		}
	}
	return 0
}

func TestOverrideOrphanedWhenTheStoreDropsTheEntry(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	p := applyReal(t, s, "ucg-fiber", now)
	if _, err := s.UpsertOverride(ctx, specs.Override{Region: "us", Slug: "ucg-fiber", Action: "hide", Section: "Hardware", Label: "Weight"}, now); err != nil {
		t.Fatal(err)
	}
	// The store stops publishing a weight.
	var revised []unistore.Spec
	for _, sp := range p.Specs {
		if sp.Label != "Weight" {
			revised = append(revised, sp)
		}
	}
	p2 := *p
	p2.Specs = revised
	if _, err := s.Apply(ctx, "us", &p2, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Overrides(ctx, "us", "ucg-fiber")
	if len(got) != 1 || got[0].Status != specs.StatusOrphan || got[0].PublishedNow != nil {
		t.Errorf("override = %+v", got)
	}
}

func TestOverridesApplyWhenAProductIsDerivedAgainForANewVersion(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	applyReal(t, s, "ucg-fiber", now)
	if _, err := s.UpsertOverride(ctx, idsOverride("8 Gbps"), now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`UPDATE product_derived SET version = 0`); err != nil {
		t.Fatal(err)
	}
	if n, err := s.RederiveStale(ctx, now); err != nil || n != 1 {
		t.Fatalf("derived %d (%v)", n, err)
	}
	d, _ := s.Derived(ctx, "us", "id-ucg-fiber")
	if m := metricOf(d, "ids_ips_throughput_mbps"); m.Value != 8000 || len(d.Overridden.Metrics) != 1 {
		t.Errorf("metric %+v overridden %+v", m, d.Overridden)
	}
}

func TestProductBySlug(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	applyReal(t, s, "ucg-fiber", time.Now())
	p, err := s.ProductBySlug(ctx, "us", "ucg-fiber")
	if err != nil || p == nil || p.ID != "id-ucg-fiber" || p.Title == "" || p.Category != "cloud-gateways-compact" {
		t.Errorf("product = %+v (%v)", p, err)
	}
	if p, err := s.ProductBySlug(ctx, "us", "nope"); err != nil || p != nil {
		t.Errorf("product = %+v (%v)", p, err)
	}
}

func by(o specs.Override, actor string) specs.Override {
	o.UpdatedBy = actor
	return o
}

func TestOverridesRecordWhoMadeAndChangedThem(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	t0 := time.Now()
	applyReal(t, s, "ucg-fiber", t0)

	first, err := s.UpsertOverride(ctx, by(idsOverride("8 Gbps"), "kim"), t0)
	if err != nil {
		t.Fatal(err)
	}
	if first.CreatedBy != "kim" || first.UpdatedBy != "kim" {
		t.Errorf("after creating: %q / %q", first.CreatedBy, first.UpdatedBy)
	}
	second, err := s.UpsertOverride(ctx, by(idsOverride("9 Gbps"), "lee"), t0.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != first.ID || second.CreatedBy != "kim" || second.UpdatedBy != "lee" {
		t.Errorf("after lee changed it: id %d, %q / %q", second.ID, second.CreatedBy, second.UpdatedBy)
	}
	// A client can't claim to have created it by saying so.
	forged := idsOverride("9 Gbps")
	forged.CreatedBy, forged.UpdatedBy = "mallory", "lee"
	third, err := s.UpsertOverride(ctx, forged, t0.Add(2*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if third.CreatedBy != "kim" {
		t.Errorf("created_by = %q", third.CreatedBy)
	}
}

func TestOverrideHistoryKeepsEveryChangeAndOutlivesTheOverride(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	t0 := time.Now().Truncate(time.Second)
	applyReal(t, s, "ucg-fiber", t0)

	created, _ := s.UpsertOverride(ctx, by(idsOverride("8 Gbps"), "kim"), t0)
	if _, err := s.UpsertOverride(ctx, by(idsOverride("9 Gbps"), "lee"), t0.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if ok, err := s.DeleteOverride(ctx, created.ID, "kim", t0.Add(2*time.Minute)); err != nil || !ok {
		t.Fatalf("delete: %v %v", ok, err)
	}

	h, err := s.OverrideHistory(ctx, "us", "ucg-fiber", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(h) != 3 {
		t.Fatalf("history has %d entries, want 3: %+v", len(h), h)
	}
	// Newest first.
	for i, want := range []struct{ change, actor string }{{"delete", "kim"}, {"update", "lee"}, {"create", "kim"}} {
		if h[i].Change != want.change || h[i].Actor != want.actor || h[i].OverrideID != created.ID || h[i].Slug != "ucg-fiber" {
			t.Errorf("entry %d = %+v, want %+v", i, h[i], want)
		}
	}
	if string(h[2].Before) != "null" || !strings.Contains(string(h[2].After), `"value":"8 Gbps"`) {
		t.Errorf("creation: before %s after %s", h[2].Before, h[2].After)
	}
	if !strings.Contains(string(h[1].Before), `"value":"8 Gbps"`) || !strings.Contains(string(h[1].After), `"value":"9 Gbps"`) {
		t.Errorf("update: before %s after %s", h[1].Before, h[1].After)
	}
	if !strings.Contains(string(h[0].Before), `"value":"9 Gbps"`) || string(h[0].After) != "null" {
		t.Errorf("deletion: before %s after %s", h[0].Before, h[0].After)
	}
	// With the override gone, what it said is still on record.
	if o, _ := s.OverrideByID(ctx, created.ID); o != nil {
		t.Fatal("the override is still there")
	}

	if h, _ := s.OverrideHistory(ctx, "us", "ucg-fiber", 2); len(h) != 2 || h[0].Change != "delete" {
		t.Errorf("limit 2 gave %+v", h)
	}
	if h, _ := s.OverrideHistory(ctx, "us", "other-product", 0); len(h) != 0 {
		t.Errorf("another product's history = %+v", h)
	}
	if h, _ := s.OverrideHistory(ctx, "", "", 0); len(h) != 3 {
		t.Errorf("unfiltered history = %d entries", len(h))
	}
}

func TestSavingAnOverrideAgainChangesNothingOnRecord(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	applyReal(t, s, "ucg-fiber", now)
	if _, err := s.UpsertOverride(ctx, by(idsOverride("8 Gbps"), "kim"), now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertOverride(ctx, by(idsOverride("8 Gbps"), "lee"), now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if h, _ := s.OverrideHistory(ctx, "", "", 0); len(h) != 1 {
		t.Errorf("a save with nothing new made %d history entries", len(h))
	}
}

func TestARefusedOverrideLeavesNoHistory(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	now := time.Now()
	applyReal(t, s, "ucg-fiber", now)
	bad := idsOverride("")
	if _, err := s.UpsertOverride(ctx, by(bad, "kim"), now); err == nil {
		t.Fatal("accepted")
	}
	if h, _ := s.OverrideHistory(ctx, "", "", 0); len(h) != 0 {
		t.Errorf("history = %+v", h)
	}
}
