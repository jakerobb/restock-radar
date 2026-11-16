package specs

import (
	"slices"
	"testing"
)

func budgetOf(text string, extra ...string) Result {
	b := &builder{}
	b.text("Overview", "Total PoE Availability", text)
	for i := 0; i+1 < len(extra); i += 2 {
		b.text("Hardware", extra[i], extra[i+1])
	}
	return b.derive()
}

func selected(r Result) []PoEScenario {
	var out []PoEScenario
	for _, s := range r.PoEBudget {
		if s.Selected {
			out = append(out, s)
		}
	}
	return out
}

func TestPoEBudgetSingleFigure(t *testing.T) {
	for _, text := range []string{"400W", " 400 W ", "Max. 400W", "max 400W"} {
		r := budgetOf(text)
		if len(r.PoEBudget) != 1 || r.PoEBudget[0].Watts != 400 || !r.PoEBudget[0].Selected || r.PoEBudget[0].Name != "" {
			t.Errorf("%q: budget = %+v", text, r.PoEBudget)
		}
		if m := metric(r, "poe_budget_w"); m == nil || m.Value != 400 || m.Unit != "W" {
			t.Errorf("%q: metric = %+v", text, m)
		}
		if !r.Known.PoE {
			t.Errorf("%q: PoE should be known", text)
		}
	}
}

func TestPoEBudgetFractionalAndThousands(t *testing.T) {
	if r := budgetOf("15.4W"); r.PoEBudget[0].Watts != 15.4 {
		t.Errorf("budget = %+v", r.PoEBudget)
	}
	if r := budgetOf("1,080W"); r.PoEBudget[0].Watts != 1080 {
		t.Errorf("budget = %+v", r.PoEBudget)
	}
}

func TestPoEBudgetTakesTheFigureAfterTheColon(t *testing.T) {
	// The 210W is the adapter; the budget it gives is 196W.
	r := budgetOf("PoE+++ input: 76W\nPoE++ input: 46W\nPoE+ input: 16W\n210W AC adapter input: 196W")
	var got []float64
	for _, s := range r.PoEBudget {
		got = append(got, s.Watts)
	}
	if want := []float64{76, 46, 16, 196}; !slices.Equal(got, want) {
		t.Errorf("watts = %v, want %v", got, want)
	}
	if r.PoEBudget[3].Name != "210W AC adapter input" || r.PoEBudget[0].Name != "PoE+++ input" {
		t.Errorf("names = %+v", r.PoEBudget)
	}
}

func TestPoEBudgetIgnoresModuleRatingsAfterTheFigure(t *testing.T) {
	r := budgetOf("200-240V AC Shared Mode: 2,150W with (2) 1,200W modules\n200-240V AC Redundant Mode: 1,050W with (2) 1,200W modules")
	if len(r.PoEBudget) != 2 || r.PoEBudget[0].Watts != 2150 || r.PoEBudget[1].Watts != 1050 {
		t.Errorf("budget = %+v", r.PoEBudget)
	}
	if r.PoEBudget[0].Name != "200-240V AC Shared Mode" {
		t.Errorf("name = %q", r.PoEBudget[0].Name)
	}
}

func TestPoEBudgetBestCaseIsSelectedWhenNothingShipsWithIt(t *testing.T) {
	r := budgetOf("100-240V AC Shared Mode: 1,050W\n100-240V AC Redundant Mode: 450W\n200-240V AC Shared Mode: 2,250W")
	s := selected(r)
	if len(s) != 1 || s[0].Watts != 2250 {
		t.Errorf("selected = %+v", s)
	}
	if m := metric(r, "poe_budget_w"); m.Value != 2250 {
		t.Errorf("metric = %+v", m)
	}
}

func TestPoEBudgetUsesTheShippedAdapter(t *testing.T) {
	const text = "PoE++ input: 42W\nPoE+ input: 16W\n60W PoE adapter input: 42W\n60W AC adapter input: 52W\n210W AC adapter input: 202W"
	for _, tc := range []struct {
		name   string
		supply string
		want   float64
	}{
		{"60W adapter", "AC/DC, external, 60W", 52},
		{"210W adapter", "AC/DC, external, 210W", 202},
		{"no supply field", "", 202},
		{"an adapter nothing matches", "AC/DC, external, 90W", 202},
		{"an internal supply is not an adapter", "AC/DC, internal, 60W", 202},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var r Result
			if tc.supply == "" {
				r = budgetOf(text)
			} else {
				r = budgetOf(text, "Power Supply", tc.supply)
			}
			s := selected(r)
			if len(s) != 1 || s[0].Watts != tc.want {
				t.Errorf("selected = %+v, want %vW", s, tc.want)
			}
			if m := metric(r, "poe_budget_w"); m == nil || m.Value != tc.want {
				t.Errorf("metric = %+v", m)
			}
			if len(r.PoEBudget) != 5 {
				t.Errorf("every scenario is kept: %d", len(r.PoEBudget))
			}
		})
	}
}

func TestPoEBudgetPrefersAnACAdapterOverAPoEOne(t *testing.T) {
	r := budgetOf("60W PoE adapter input: 42W\n60W AC adapter input: 52W", "Power Supply", "AC/DC, external, 60W")
	if s := selected(r); len(s) != 1 || s[0].Watts != 52 {
		t.Errorf("selected = %+v", s)
	}
	// With only a PoE adapter to match, that is used.
	r = budgetOf("60W PoE adapter input: 42W\n210W AC adapter input: 202W", "Power Supply", "AC/DC, external, 60W")
	if s := selected(r); len(s) != 1 || s[0].Watts != 42 {
		t.Errorf("selected = %+v", s)
	}
}

func TestPoEBudgetAdapterWattageMatchesWholeNumbers(t *testing.T) {
	// A 10W supply must not match the "210W" scenario.
	r := budgetOf("210W AC adapter input: 202W\n10W AC adapter input: 8W", "Power Supply", "AC/DC, external, 10W")
	if s := selected(r); len(s) != 1 || s[0].Watts != 8 {
		t.Errorf("selected = %+v", s)
	}
}

func TestPoEBudgetOtherLabels(t *testing.T) {
	for _, label := range []string{"PoE Budget", "Total Available PoE"} {
		b := &builder{}
		b.text("Hardware", label, "30W")
		if r := b.derive(); len(r.PoEBudget) != 1 || r.PoEBudget[0].Watts != 30 {
			t.Errorf("%s: budget = %+v", label, r.PoEBudget)
		}
	}
	b := &builder{}
	b.text("Hardware", "PoE Budget", "DC input: 270W\nATX power: 75W")
	if s := selected(b.derive()); len(s) != 1 || s[0].Watts != 270 {
		t.Errorf("selected = %+v", s)
	}
}

func TestPoEBudgetLinesWithNoWattsAreReported(t *testing.T) {
	r := budgetOf("Depends on the PSU\n400W")
	if len(r.PoEBudget) != 1 || r.PoEBudget[0].Watts != 400 {
		t.Errorf("budget = %+v", r.PoEBudget)
	}
	if len(r.Issues) != 1 || r.Issues[0].Area != "poe_budget" {
		t.Errorf("issues = %+v", r.Issues)
	}
	// Nothing readable: no budget, no metric, no claim.
	r = budgetOf("See manual")
	if len(r.PoEBudget) != 0 || metric(r, "poe_budget_w") != nil || len(r.Issues) != 1 {
		t.Errorf("budget %+v issues %+v", r.PoEBudget, r.Issues)
	}
}

func TestPoEMaxClass(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"Up to PoE+++", "PoE+++"}, {"Up to PoE++", "PoE++"}, {"Up to PoE+", "PoE+"}, {"Up to PoE", "PoE"},
		{"Passthrough up to PoE++", "PoE++"}, {"None", ""},
	} {
		b := &builder{}
		b.text("Overview", "Max. PoE Output", tc.in)
		r := b.derive()
		if r.PoEMaxClass != tc.want {
			t.Errorf("%q: class = %q, want %q", tc.in, r.PoEMaxClass, tc.want)
		}
		if r.Known.PoE != (tc.want != "") {
			t.Errorf("%q: known = %v", tc.in, r.Known.PoE)
		}
	}
}

func TestPoEIsUnknownWithNoPoEFacts(t *testing.T) {
	b := &builder{}
	b.text("Overview", "Weight", "1 kg")
	if r := b.derive(); r.Known.PoE || len(r.PoEBudget) != 0 || r.PoEMaxClass != "" {
		t.Errorf("result = %+v", r)
	}
}

func TestPoEKnownFromPortsAlone(t *testing.T) {
	r := portsOf("", nil, "2.5 GbE RJ45", "1 (1 PoE)")
	if !r.Known.PoE {
		t.Error("a port that supplies PoE makes PoE known")
	}
	r = portsOf("Up to PoE", nil, "2.5 GbE RJ45", "1 (PoE+++)")
	if !r.Known.PoE {
		t.Error("Max. PoE Output makes PoE known")
	}
}

func TestPoEKnownIsNotSetByAnInputPortAlone(t *testing.T) {
	r := portsOf("", nil, "1 GbE RJ45", "1 (1 PoE++ input)")
	if r.Known.PoE {
		t.Error("a PoE input says nothing about supplying PoE")
	}
}
