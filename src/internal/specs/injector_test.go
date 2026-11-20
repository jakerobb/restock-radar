package specs

import (
	"strings"
	"testing"
)

// The store gives a PoE injector no ports, no PoE class and, for the fast ones, no speed
// (every one says "Gigabit LAN Port: true"), so these are read from the output rating and the name.
func TestRealInjectors(t *testing.T) {
	cases := []struct {
		slug  string
		class string
		watts float64
		speed int
	}{
		{"u-poe-af", "PoE", 15, 1000},
		{"u-poe-plus", "PoE+", 30, 1000},
		{"u-poe-plus-plus", "PoE++", 60, 1000},
		{"uacc-poe-plus-2-5g", "PoE+", 30, 2500},
		{"uacc-poe-plus-plus-10g", "PoE++", 60, 10000},
		{"uacc-poe-10g", "PoE+++", 90, 10000},
		// Its name says PoE but no watts, so it isn't trusted, and its Type-C output (5 V at 5 A) isn't the PoE one.
		{"uacc-poe-plus-usbc", "PoE+", 30, 1000},
	}
	for _, c := range cases {
		t.Run(c.slug, func(t *testing.T) {
			r := derived(t, c.slug)
			if !r.Known.Ports || !r.Known.PoE || r.PoEMaxClass != c.class {
				t.Fatalf("known %+v, max class %q, want %q", r.Known, r.PoEMaxClass, c.class)
			}
			if n := portsMatching(r, func(p Port) bool {
				return p.PoEClass == c.class && p.PoEDirection == "out" && p.MaxSpeedMbps == c.speed
			}); n != 1 {
				t.Errorf("PoE out ports = %d, want one %s at %d Mbps: %+v", n, c.class, c.speed, r.Ports)
			}
			if n := portsMatching(r, func(p Port) bool {
				return p.PoEClass == "" && p.Role == "data" && p.Media == "rj45" && p.MaxSpeedMbps == c.speed
			}); n != 1 {
				t.Errorf("data in ports = %d, want one at %d Mbps", n, c.speed)
			}
			if m := metric(r, "poe_budget_w"); m == nil || m.Value != c.watts {
				t.Errorf("budget = %+v, want %v", m, c.watts)
			}
			if len(r.Power) != 1 || r.Power[0].Kind != PowerAC {
				t.Errorf("power = %+v, want mains", r.Power)
			}
			if len(r.Issues) != 0 {
				t.Errorf("issues = %+v", r.Issues)
			}
		})
	}
}

// Other products of the category (a surge protector, a power module) aren't injectors.
func TestInjectorOnlyInItsCategory(t *testing.T) {
	r := derived(t, "u-poe-af")
	f := fixtures(t)["u-poe-af"]
	if other := Derive(Input{Slug: "u-poe-af", Title: f.Title, Category: "accessories-other", Specs: Plain(f.Specs)}); other.Known.Ports {
		t.Errorf("a product outside the category got ports: %+v", other.Ports)
	}
	if !r.Known.Ports {
		t.Fatal("the injector got no ports")
	}
}

// The name is read first, then the "Max. PoE+ Wattage per Port by PSE" entry, then the output rating; where they
// disagree the first is used and the rest is raised as an issue.
func TestInjectorSourcesAgreeOrAreReported(t *testing.T) {
	f := fixtures(t)["u-poe-plus"]
	derive := func(title string) Result {
		return Derive(Input{Slug: "u-poe-plus", Title: title, Category: f.Category, Specs: Plain(f.Specs)})
	}
	// No watts in the name: the output rating says PoE+.
	if r := derive("UniFi PoE+ Adapter"); r.PoEMaxClass != "PoE+" || len(r.Issues) != 0 {
		t.Errorf("class %q, issues %+v", r.PoEMaxClass, r.Issues)
	}
	// A name that disagrees with the rating wins, and says so.
	r := derive("UniFi PoE++ Adapter (60W)")
	if r.PoEMaxClass != "PoE++" || metric(r, "poe_budget_w").Value != 60 {
		t.Errorf("class %q, budget %+v", r.PoEMaxClass, metric(r, "poe_budget_w"))
	}
	if len(r.Issues) != 1 || r.Issues[0].Area != "poe_injector" || !strings.Contains(r.Issues[0].Problem, "its name says PoE++ but its output rating says PoE+") {
		t.Errorf("issues = %+v", r.Issues)
	}
	// The wattage entry of the store is read where there is one, and checked against the rating.
	g := fixtures(t)["u-poe-plus-plus"]
	r = Derive(Input{Slug: "u-poe-plus-plus", Title: "UniFi PoE Adapter", Category: g.Category, Specs: Plain(g.Specs)})
	if r.PoEMaxClass != "PoE++" || metric(r, "poe_budget_w").Value != 60 || len(r.Issues) != 0 {
		t.Errorf("class %q, budget %+v, issues %+v", r.PoEMaxClass, metric(r, "poe_budget_w"), r.Issues)
	}
}
