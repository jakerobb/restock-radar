package specs

import (
	"slices"
	"testing"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

// published is a small specification: a top-level entry, a group with two
// children, and a flag, in two sections.
func published() []unistore.Spec {
	return []unistore.Spec{
		{SectionID: "s1", Section: "Overview", SectionType: "Standard", FeatureID: "f-ids", Label: "IDS/IPS Throughput", Kind: unistore.SpecText, Value: "5 Gbps"},
		{SectionID: "s1", Section: "Overview", SectionType: "Standard", FeatureID: "f-uplink", Label: "Uplink", Kind: unistore.SpecText, Value: "10 GbE", Note: "published note"},
		{SectionID: "s2", Section: "Performance", SectionType: "Standard", FeatureID: "g-tx", Label: "Max. TX Power", Kind: unistore.SpecGroup},
		{SectionID: "s2", Section: "Performance", SectionType: "Standard", FeatureID: "f-tx6", ParentID: "g-tx", Label: "6 GHz", Kind: unistore.SpecText, Value: "23 dBm"},
		{SectionID: "s2", Section: "Performance", SectionType: "Standard", FeatureID: "f-tx5", ParentID: "g-tx", Label: "5 GHz", Kind: unistore.SpecText, Value: "26 dBm"},
		{SectionID: "s2", Section: "Performance", SectionType: "Standard", FeatureID: "f-mu", Label: "MU-MIMO", Kind: unistore.SpecFlag, Value: "true"},
	}
}

func byLabel(es []Effective, section, label string) *Effective {
	for i := range es {
		if es[i].Section == section && es[i].Label == label {
			return &es[i]
		}
	}
	return nil
}

func TestApplyWithoutOverridesIsThePublishedSpecification(t *testing.T) {
	es, applied := Apply(published(), nil)
	if len(es) != len(published()) || len(applied) != 0 {
		t.Fatalf("got %d entries, %d applied", len(es), len(applied))
	}
	for i, e := range es {
		if e.Spec != published()[i] || e.Origin != OriginPublished || e.Published != nil || e.OverrideID != 0 {
			t.Errorf("entry %d changed: %+v", i, e)
		}
	}
}

func TestApplyOverridesAValueAndKeepsThePublishedOne(t *testing.T) {
	es, applied := Apply(published(), []Override{
		{ID: 7, Action: ActionSet, Section: "Overview", Label: "IDS/IPS Throughput", Value: "8 Gbps", PublishedValue: ptr("5 Gbps")},
	})
	e := byLabel(es, "Overview", "IDS/IPS Throughput")
	if e == nil || e.Value != "8 Gbps" || e.Origin != OriginOverride || e.OverrideID != 7 {
		t.Fatalf("entry = %+v", e)
	}
	if e.Published == nil || *e.Published != "5 Gbps" {
		t.Errorf("the published value must stay visible: %v", e.Published)
	}
	if e.Stale {
		t.Error("the published value is still the one the override was written against")
	}
	// Everything about the entry other than its value is as published.
	if e.FeatureID != "f-ids" || e.SectionID != "s1" || e.Kind != unistore.SpecText {
		t.Errorf("identity changed: %+v", e.Spec)
	}
	if len(applied) != 1 || applied[0].Status != StatusOverrides || applied[0].Stale {
		t.Errorf("applied = %+v", applied)
	}
	// Other entries are untouched.
	if u := byLabel(es, "Overview", "Uplink"); u.Origin != OriginPublished || u.Value != "10 GbE" {
		t.Errorf("Uplink = %+v", u)
	}
}

func TestApplyMatchesIgnoringCaseAndSpacing(t *testing.T) {
	es, _ := Apply(published(), []Override{
		{ID: 1, Action: ActionSet, Section: " overview ", Label: "ids/ips  throughput", Value: "8 Gbps"},
	})
	if e := byLabel(es, "Overview", "IDS/IPS Throughput"); e.Value != "8 Gbps" || e.Origin != OriginOverride {
		t.Errorf("entry = %+v", e)
	}
}

func TestApplyFindsEntriesUnderGroupsByGroupAndLabel(t *testing.T) {
	es, applied := Apply(published(), []Override{
		{ID: 1, Action: ActionSet, Section: "Performance", Group: "Max. TX Power", Label: "6 GHz", Value: "30 dBm"},
	})
	if e := byLabel(es, "Performance", "6 GHz"); e.Value != "30 dBm" || e.ParentID != "g-tx" || e.Origin != OriginOverride {
		t.Errorf("6 GHz = %+v", e)
	}
	if e := byLabel(es, "Performance", "5 GHz"); e.Value != "26 dBm" {
		t.Errorf("the sibling changed: %+v", e)
	}
	if applied[0].Status != StatusOverrides {
		t.Errorf("status = %s", applied[0].Status)
	}
}

func TestApplyDoesNotMatchAGroupedEntryWithoutItsGroup(t *testing.T) {
	// "6 GHz" with no group is a different target from "6 GHz" under a group, so
	// this adds a new top-level entry and leaves the grouped one alone.
	es, applied := Apply(published(), []Override{
		{ID: 1, Action: ActionSet, Section: "Performance", Label: "6 GHz", Value: "30 dBm"},
	})
	if applied[0].Status != StatusAdds {
		t.Errorf("status = %s, want adds", applied[0].Status)
	}
	var grouped, top *Effective
	for i := range es {
		if es[i].Label == "6 GHz" {
			if es[i].ParentID == "" {
				top = &es[i]
			} else {
				grouped = &es[i]
			}
		}
	}
	if grouped == nil || grouped.Value != "23 dBm" || grouped.Origin != OriginPublished {
		t.Errorf("the grouped entry changed: %+v", grouped)
	}
	if top == nil || top.Value != "30 dBm" || top.Origin != OriginAdded {
		t.Errorf("the new entry = %+v", top)
	}
}

func TestApplyStaleWhenThePublishedValueMoved(t *testing.T) {
	es, applied := Apply(published(), []Override{
		{ID: 3, Action: ActionSet, Section: "Overview", Label: "IDS/IPS Throughput", Value: "8 Gbps", PublishedValue: ptr("3.5 Gbps")},
	})
	e := byLabel(es, "Overview", "IDS/IPS Throughput")
	if !e.Stale || e.Value != "8 Gbps" {
		t.Errorf("a stale override still applies, and says so: %+v", e)
	}
	if !applied[0].Stale {
		t.Errorf("applied = %+v", applied[0])
	}
}

func TestApplyOverrideWithNoRecordedPublishedValueIsNeverStale(t *testing.T) {
	es, _ := Apply(published(), []Override{{ID: 3, Action: ActionSet, Section: "Overview", Label: "IDS/IPS Throughput", Value: "8 Gbps"}})
	if byLabel(es, "Overview", "IDS/IPS Throughput").Stale {
		t.Error("nothing to compare against")
	}
}

func TestApplyKindAndNote(t *testing.T) {
	es, _ := Apply(published(), []Override{
		{ID: 1, Action: ActionSet, Section: "Performance", Label: "MU-MIMO", Kind: unistore.SpecFlag, Value: "false"},
		{ID: 2, Action: ActionSet, Section: "Overview", Label: "Uplink", Value: "25 GbE", Note: "per teardown"},
		{ID: 3, Action: ActionSet, Section: "Overview", Label: "IDS/IPS Throughput", Value: "8 Gbps"},
	})
	if e := byLabel(es, "Performance", "MU-MIMO"); e.Kind != unistore.SpecFlag || e.Value != "false" {
		t.Errorf("flag = %+v", e)
	}
	if e := byLabel(es, "Overview", "Uplink"); e.Note != "per teardown" {
		t.Errorf("note not replaced: %+v", e)
	}
	// Without a note of its own, the override keeps the published one.
	es2, _ := Apply(published(), []Override{{ID: 1, Action: ActionSet, Section: "Overview", Label: "Uplink", Value: "25 GbE"}})
	if e := byLabel(es2, "Overview", "Uplink"); e.Note != "published note" {
		t.Errorf("note = %q", e.Note)
	}
}

func TestApplyHide(t *testing.T) {
	es, applied := Apply(published(), []Override{{ID: 1, Action: ActionHide, Section: "Overview", Label: "Uplink"}})
	if byLabel(es, "Overview", "Uplink") != nil || len(es) != len(published())-1 {
		t.Errorf("entry still there: %d entries", len(es))
	}
	if applied[0].Status != StatusHides {
		t.Errorf("status = %s", applied[0].Status)
	}
}

func TestApplyHideOfEveryChildDropsTheGroup(t *testing.T) {
	es, _ := Apply(published(), []Override{
		{ID: 1, Action: ActionHide, Section: "Performance", Group: "Max. TX Power", Label: "6 GHz"},
		{ID: 2, Action: ActionHide, Section: "Performance", Group: "Max. TX Power", Label: "5 GHz"},
	})
	if byLabel(es, "Performance", "Max. TX Power") != nil {
		t.Error("a group with nothing under it should go")
	}
	// One child left keeps it.
	es, _ = Apply(published(), []Override{{ID: 1, Action: ActionHide, Section: "Performance", Group: "Max. TX Power", Label: "6 GHz"}})
	if byLabel(es, "Performance", "Max. TX Power") == nil || byLabel(es, "Performance", "5 GHz") == nil {
		t.Error("group or its remaining child lost")
	}
}

func TestApplyHideOfNothingIsAnOrphan(t *testing.T) {
	es, applied := Apply(published(), []Override{{ID: 1, Action: ActionHide, Section: "Overview", Label: "No Such Thing"}})
	if len(es) != len(published()) {
		t.Errorf("a hide that matches nothing must change nothing")
	}
	if applied[0].Status != StatusOrphan {
		t.Errorf("status = %s", applied[0].Status)
	}
}

func TestApplyGroupsCannotBeTargeted(t *testing.T) {
	es, applied := Apply(published(), []Override{{ID: 1, Action: ActionHide, Section: "Performance", Label: "Max. TX Power"}})
	if byLabel(es, "Performance", "Max. TX Power") == nil || byLabel(es, "Performance", "6 GHz") == nil {
		t.Error("hiding a group's label must not remove the group or its children")
	}
	if applied[0].Status != StatusOrphan {
		t.Errorf("status = %s", applied[0].Status)
	}
}

func TestApplyAddsAnEntryToAnExistingSection(t *testing.T) {
	es, applied := Apply(published(), []Override{
		{ID: 5, Action: ActionSet, Section: "Overview", Label: "SoC", Value: "Marvell AC5X", SourceURL: "https://example.com/teardown"},
	})
	e := byLabel(es, "Overview", "SoC")
	if e == nil || e.Origin != OriginAdded || e.Value != "Marvell AC5X" || e.Kind != unistore.SpecText || e.OverrideID != 5 {
		t.Fatalf("entry = %+v", e)
	}
	if e.SectionID != "s1" || e.SectionType != "Standard" || e.Published != nil || e.ParentID != "" {
		t.Errorf("should sit in the existing section: %+v", e)
	}
	if e.FeatureID == "" || e.FeatureID == "f-ids" {
		t.Errorf("feature id = %q", e.FeatureID)
	}
	// It goes after the section's last entry, before the next section.
	idx := slices.IndexFunc(es, func(x Effective) bool { return x.Label == "SoC" })
	if idx != 2 || es[3].Section != "Performance" {
		t.Errorf("placed at %d", idx)
	}
	if applied[0].Status != StatusAdds {
		t.Errorf("status = %s", applied[0].Status)
	}
}

func TestApplyAddsToAnExistingGroup(t *testing.T) {
	es, _ := Apply(published(), []Override{
		{ID: 1, Action: ActionSet, Section: "Performance", Group: "Max. TX Power", Label: "2.4 GHz", Value: "20 dBm"},
	})
	e := byLabel(es, "Performance", "2.4 GHz")
	if e == nil || e.ParentID != "g-tx" || e.Origin != OriginAdded {
		t.Fatalf("entry = %+v", e)
	}
	groups := 0
	for _, x := range es {
		if x.Kind == unistore.SpecGroup {
			groups++
		}
	}
	if groups != 1 {
		t.Errorf("a second group was made: %d", groups)
	}
}

func TestApplyAddsAGroupAndASection(t *testing.T) {
	es, _ := Apply(published(), []Override{
		{ID: 1, Action: ActionSet, Section: "Teardown", Group: "Chips", Label: "Switch ASIC", Value: "Marvell AC5X"},
		{ID: 2, Action: ActionSet, Section: "Teardown", Group: "Chips", Label: "CPU", Value: "Arm A55"},
	})
	asic, cpu := byLabel(es, "Teardown", "Switch ASIC"), byLabel(es, "Teardown", "CPU")
	grp := byLabel(es, "Teardown", "Chips")
	if asic == nil || cpu == nil || grp == nil || grp.Kind != unistore.SpecGroup {
		t.Fatalf("got %+v %+v %+v", asic, cpu, grp)
	}
	if asic.ParentID != grp.FeatureID || cpu.ParentID != grp.FeatureID {
		t.Error("both entries belong under the one new group")
	}
	if asic.SectionID != cpu.SectionID || asic.SectionType != "Standard" {
		t.Errorf("section = %+v / %+v", asic.Spec, cpu.Spec)
	}
	n := 0
	for _, e := range es {
		if e.Kind == unistore.SpecGroup && e.Label == "Chips" {
			n++
		}
	}
	if n != 1 {
		t.Errorf("the group was made %d times", n)
	}
}

func TestApplyAddedEntriesFollowOverrideOrderNotArgumentOrder(t *testing.T) {
	es, _ := Apply(published(), []Override{
		{ID: 9, Action: ActionSet, Section: "Overview", Label: "Second", Value: "2"},
		{ID: 4, Action: ActionSet, Section: "Overview", Label: "First", Value: "1"},
	})
	if byLabel(es, "Overview", "First") == nil {
		t.Fatal("missing")
	}
	i1 := slices.IndexFunc(es, func(e Effective) bool { return e.Label == "First" })
	i2 := slices.IndexFunc(es, func(e Effective) bool { return e.Label == "Second" })
	if i1 > i2 {
		t.Errorf("First at %d after Second at %d", i1, i2)
	}
}

func TestApplyAddedFlag(t *testing.T) {
	es, _ := Apply(published(), []Override{{ID: 1, Action: ActionSet, Section: "Features", Label: "Hardware Offload", Kind: unistore.SpecFlag, Value: "true"}})
	if e := byLabel(es, "Features", "Hardware Offload"); e == nil || e.Kind != unistore.SpecFlag || e.Value != "true" {
		t.Errorf("entry = %+v", e)
	}
}

func TestApplyDoesNotModifyItsInput(t *testing.T) {
	in := published()
	before := slices.Clone(in)
	ov := []Override{
		{ID: 1, Action: ActionSet, Section: "Overview", Label: "Uplink", Value: "x"},
		{ID: 2, Action: ActionHide, Section: "Overview", Label: "IDS/IPS Throughput"},
		{ID: 3, Action: ActionSet, Section: "New", Label: "New", Value: "n"},
	}
	Apply(in, ov)
	if !slices.Equal(in, before) {
		t.Error("the published specification was modified")
	}
}

func TestApplyReportsEveryOverrideInIDOrder(t *testing.T) {
	_, applied := Apply(published(), []Override{
		{ID: 30, Action: ActionHide, Section: "Overview", Label: "Nope"},
		{ID: 10, Action: ActionSet, Section: "Overview", Label: "Uplink", Value: "x"},
		{ID: 20, Action: ActionSet, Section: "Overview", Label: "Brand New", Value: "y"},
	})
	var got []string
	for _, a := range applied {
		got = append(got, a.Status)
	}
	if want := []string{StatusOverrides, StatusAdds, StatusOrphan}; !slices.Equal(got, want) || applied[0].OverrideID != 10 {
		t.Errorf("statuses = %v", got)
	}
}

func TestPlain(t *testing.T) {
	es := Plain(published())
	if len(es) != len(published()) || es[0].Origin != OriginPublished {
		t.Errorf("Plain = %+v", es[0])
	}
}

func TestNormalizeTarget(t *testing.T) {
	s, g, l := NormalizeTarget("  Over\u00a0view ", "\tMax.  TX Power", " 6   GHz\n")
	if s != "Over view" || g != "Max. TX Power" || l != "6 GHz" {
		t.Errorf("got %q %q %q", s, g, l)
	}
}

func TestFindPublished(t *testing.T) {
	e, ok := FindPublished(published(), "overview", "", "IDS/IPS throughput")
	if !ok || e.FeatureID != "f-ids" {
		t.Errorf("top-level: %+v %v", e, ok)
	}
	e, ok = FindPublished(published(), "Performance", "max. tx power", "6 GHz")
	if !ok || e.FeatureID != "f-tx6" {
		t.Errorf("grouped: %+v %v", e, ok)
	}
	if _, ok := FindPublished(published(), "Performance", "", "6 GHz"); ok {
		t.Error("a grouped entry isn't found without its group")
	}
	if _, ok := FindPublished(published(), "Performance", "", "Max. TX Power"); ok {
		t.Error("a group heading is not an entry")
	}
	if _, ok := FindPublished(published(), "Overview", "", "Nope"); ok {
		t.Error("found a thing that isn't there")
	}
}

func TestIsGroup(t *testing.T) {
	if !IsGroup(published(), "Performance", "", "Max. TX Power") {
		t.Error("a group heading")
	}
	if IsGroup(published(), "Performance", "Max. TX Power", "6 GHz") || IsGroup(published(), "Overview", "", "Uplink") {
		t.Error("entries are not groups")
	}
	if IsGroup(published(), "Performance", "", "No Such Group") {
		t.Error("nothing there")
	}
}
