package specs

import (
	"testing"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

func TestCompareIdenticalResults(t *testing.T) {
	r := derived(t, "usw-pro-max-24-poe")
	o := Compare(r, r)
	if o.Any() || o.Metrics == nil {
		t.Errorf("overridden = %+v", o)
	}
}

func TestCompareAnOverriddenMetric(t *testing.T) {
	f := fixtures(t)["ucg-fiber"]
	// The user's correction: 8 Gbps, not the published 5.
	eff, _ := Apply(f.Specs, []Override{{ID: 1, Action: ActionSet, Section: "Overview", Label: "IDS/IPS Throughput", Value: "8+ Gbps"}})
	re := Derive(Input{Slug: "ucg-fiber", Specs: eff})
	rp := Derive(Input{Slug: "ucg-fiber", Specs: Plain(f.Specs)})

	if m := metric(re, "ids_ips_throughput_mbps"); m.Value != 8000 || !m.AtLeast {
		t.Fatalf("effective metric = %+v", m)
	}
	o := Compare(re, rp)
	if len(o.Metrics) != 1 || o.Metrics[0].Name != "ids_ips_throughput_mbps" {
		t.Fatalf("overridden = %+v", o)
	}
	if p := o.Metrics[0].Published; p == nil || p.Value != 5000 || p.Raw != "5 Gbps" {
		t.Errorf("published = %+v", p)
	}
	if o.Ports || o.PoEBudget || o.Radios || o.Rack || o.Dims {
		t.Errorf("only the one metric changed: %+v", o)
	}
	if !o.Any() {
		t.Error("Any")
	}
}

func TestCompareAMetricTheStoreDoesNotGive(t *testing.T) {
	f := fixtures(t)["usw-flex-mini"]
	eff, _ := Apply(f.Specs, []Override{{ID: 1, Action: ActionSet, Section: "Overview", Label: "IDS/IPS Throughput", Value: "1 Gbps"}})
	o := Compare(Derive(Input{Specs: eff}), Derive(Input{Specs: Plain(f.Specs)}))
	if len(o.Metrics) != 1 || o.Metrics[0].Published != nil {
		t.Errorf("overridden = %+v", o)
	}
}

func TestCompareChangesToTheDerivedLists(t *testing.T) {
	f := fixtures(t)["usw-pro-max-24-poe"]
	pub := Derive(Input{Specs: Plain(f.Specs)})
	for _, tc := range []struct {
		name string
		ov   Override
		got  func(Overridden) bool
	}{
		{"a port count", Override{Action: ActionSet, Section: "Overview", Group: "Port Layout", Label: "10G SFP+", Value: "4\n(10G/1G)"}, func(o Overridden) bool { return o.Ports }},
		{"the budget", Override{Action: ActionSet, Section: "Overview", Label: "Total PoE Availability", Value: "500W"}, func(o Overridden) bool { return o.PoEBudget }},
		{"the form factor", Override{Action: ActionSet, Section: "Overview", Label: "Form Factor", Value: "Rack mount (2U)"}, func(o Overridden) bool { return o.Rack }},
		{"the dimensions", Override{Action: ActionSet, Section: "Overview", Label: "Dimensions", Value: "442 x 325 x 88 mm"}, func(o Overridden) bool { return o.Dims }},
		{"the maximum PoE class", Override{Action: ActionSet, Section: "Overview", Label: "Max. PoE Output", Value: "Up to PoE+++"}, func(o Overridden) bool { return o.Ports }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.ov.ID = 1
			eff, applied := Apply(f.Specs, []Override{tc.ov})
			if applied[0].Status != StatusOverrides {
				t.Fatalf("the override didn't match anything: %+v", applied)
			}
			o := Compare(Derive(Input{Specs: eff}), pub)
			if !tc.got(o) {
				t.Errorf("overridden = %+v", o)
			}
		})
	}
}

func TestCompareRadios(t *testing.T) {
	f := fixtures(t)["u7-pro"]
	eff, applied := Apply(f.Specs, []Override{{ID: 1, Action: ActionSet, Section: "Performance", Group: "Max. TX Power", Label: "6 GHz", Value: "30 dBm"}})
	if applied[0].Status != StatusOverrides {
		t.Fatalf("applied = %+v", applied)
	}
	re, rp := Derive(Input{Specs: eff}), Derive(Input{Specs: Plain(f.Specs)})
	if o := Compare(re, rp); !o.Radios || o.Ports || len(o.Metrics) != 0 {
		t.Errorf("overridden = %+v", o)
	}
	if *radio(re, "6 GHz").TxPowerDBm != 30 || *radio(rp, "6 GHz").TxPowerDBm != 23 {
		t.Error("the override should change the effective radio and not the published one")
	}
}

func TestCompareAnOverrideThatRestatesThePublishedValue(t *testing.T) {
	f := fixtures(t)["u7-pro"]
	eff, _ := Apply(f.Specs, []Override{{ID: 1, Action: ActionSet, Section: "Performance", Group: "Max. TX Power", Label: "6 GHz", Value: "23 dBm"}})
	// An override that restates the published value changes nothing derived.
	if o := Compare(Derive(Input{Specs: eff}), Derive(Input{Specs: Plain(f.Specs)})); o.Any() {
		t.Errorf("overridden = %+v", o)
	}
}

func TestCompareHidingEverythingAboutPorts(t *testing.T) {
	f := fixtures(t)["usw-pro-max-24-poe"]
	var ovs []Override
	id := int64(0)
	for _, s := range f.Specs {
		if s.Kind == unistore.SpecText && s.ParentID != "" {
			for _, g := range f.Specs {
				if g.FeatureID == s.ParentID && g.SectionID == s.SectionID && g.Label == "Port Layout" {
					id++
					ovs = append(ovs, Override{ID: id, Action: ActionHide, Section: s.Section, Group: "Port Layout", Label: s.Label})
				}
			}
		}
	}
	eff, _ := Apply(f.Specs, ovs)
	re := Derive(Input{Specs: eff})
	if re.Known.Ports || len(re.Ports) != 0 {
		t.Errorf("ports remain: %+v", re.Ports)
	}
	if o := Compare(re, Derive(Input{Specs: Plain(f.Specs)})); !o.Ports {
		t.Errorf("overridden = %+v", o)
	}
}
