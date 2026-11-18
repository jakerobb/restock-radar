package specs

import (
	"slices"
	"testing"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

func TestParseSpeeds(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want []int
	}{
		{"10G/1G", []int{10000, 1000}},
		{"1G/100M/10M", []int{1000, 100, 10}},
		{"10G/5G/2.5G/1G/100M/10M", []int{10000, 5000, 2500, 1000, 100, 10}},
		{"100G/40G", []int{100000, 40000}},
		{"25G", []int{25000}},
		{"100M", []int{100}},
		// The store sometimes leaves a unit off. A bare number takes the one that
		// keeps the list descending: 2.5 here is 2.5G, not 2.5M.
		{"10G/5G/2.5/100M", []int{10000, 5000, 2500, 100}},
		{"10G/5G/2.5/1G", []int{10000, 5000, 2500, 1000}},
		// A first number with no unit: small is G, large is M.
		{"10/1G", []int{10000, 1000}},
		{"100/10M", []int{100, 10}},
		// Not in order: the result is.
		{"1G/10G", []int{10000, 1000}},
		{"", nil},
		{"10G//1G", nil},
		{"fast", nil},
	} {
		if got := parseSpeeds(tc.in); !slices.Equal(got, tc.want) {
			t.Errorf("parseSpeeds(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestParsePortLabel(t *testing.T) {
	for _, tc := range []struct {
		label       string
		media, role string
		speed       int
		ok          bool
	}{
		{"1 GbE RJ45", "rj45", "data", 1000, true},
		{"2.5 GbE RJ45", "rj45", "data", 2500, true},
		{"10 GbE RJ45", "rj45", "data", 10000, true},
		{"100 MbE RJ45", "rj45", "data", 100, true},
		{"10G SFP+", "sfp+", "data", 10000, true},
		{"25G SFP28", "sfp28", "data", 25000, true},
		{"1G SFP", "sfp", "data", 1000, true},
		{"100G QSFP28", "qsfp28", "data", 100000, true},
		{"  10G   SFP+ ", "sfp+", "data", 10000, true},
		{"Console", "console", "console", 0, true},
		{"SMA", "sma", "sma", 0, true},
		{"MGMT", "rj45", "mgmt", 0, true},
		{"USB-C", "", "", 0, false},
		{"", "", "", 0, false},
	} {
		got := parsePortLabel(tc.label)
		if got.ok != tc.ok || got.media != tc.media || got.role != tc.role || got.speed != tc.speed {
			t.Errorf("parsePortLabel(%q) = %+v", tc.label, got)
		}
	}
}

func TestParsePoE(t *testing.T) {
	for _, tc := range []struct {
		in   string
		n    int
		want []poeSeg
		ok   bool
	}{
		{"All PoE+++", 24, []poeSeg{{"PoE+++", 24, false}}, true},
		{"All PoE+", 8, []poeSeg{{"PoE+", 8, false}}, true},
		{"PoE+++", 1, []poeSeg{{"PoE+++", 1, false}}, true},
		{"PoE", 4, []poeSeg{{"PoE", 4, false}}, true},
		{"8 PoE+; 8 PoE++", 16, []poeSeg{{"PoE+", 8, false}, {"PoE++", 8, false}}, true},
		{"7 PoE+; 1 PoE++ input", 8, []poeSeg{{"PoE+", 7, false}, {"PoE++", 1, true}}, true},
		{"2 PoE+++, 2 PoE+", 4, []poeSeg{{"PoE+++", 2, false}, {"PoE+", 2, false}}, true},
		{"1 PoE", 4, []poeSeg{{"PoE", 1, false}}, true},
		{"  4 PoE+  ", 8, []poeSeg{{"PoE+", 4, false}}, true},
		{"some PoE", 4, nil, false},
		{"8 PoE+; lots", 16, nil, false},
		{"", 4, nil, false},
	} {
		got, ok := parsePoE(tc.in, tc.n)
		if ok != tc.ok || !slices.Equal(got, tc.want) {
			t.Errorf("parsePoE(%q, %d) = %v, %v; want %v, %v", tc.in, tc.n, got, ok, tc.want, tc.ok)
		}
	}
}

// portsOf derives the ports of a product whose only specification is one Port
// Layout entry.
func portsOf(maxOut string, watts []string, entries ...string) Result {
	b := &builder{}
	if maxOut != "" {
		b.text("Overview", "Max. PoE Output", maxOut)
	}
	b.group("Overview", "Port Layout", entries...)
	if watts != nil {
		b.group("Hardware", "Max. PoE Wattage per Port by PSE", watts...)
	}
	return b.derive()
}

func TestPortLayoutPlainPorts(t *testing.T) {
	r := portsOf("", nil, "1 GbE RJ45", "16\n(1G/100M/10M)", "10G SFP+", "2\n(10G/1G)")
	if len(r.Ports) != 2 || !r.Known.Ports {
		t.Fatalf("ports = %+v", r.Ports)
	}
	p := r.Ports[0]
	if p.Label != "1 GbE RJ45" || p.Media != "rj45" || p.Role != "data" || p.Count != 16 || p.MaxSpeedMbps != 1000 ||
		!slices.Equal(p.SpeedsMbps, []int{1000, 100, 10}) || p.PoEClass != "" || p.PoEDirection != "" || p.Source != "port_layout" {
		t.Errorf("port 0 = %+v", p)
	}
	if q := r.Ports[1]; q.Media != "sfp+" || q.Count != 2 || q.MaxSpeedMbps != 10000 {
		t.Errorf("port 1 = %+v", q)
	}
	if len(r.Issues) != 0 {
		t.Errorf("issues = %+v", r.Issues)
	}
}

func TestPortLayoutSplitsAMixedGroupByPoEClass(t *testing.T) {
	r := portsOf("Up to PoE++", []string{"PoE+", "32W", "PoE++", "60W"},
		"1 GbE RJ45", "16 (8 PoE+; 8 PoE++)\n(1G/100M/10M)")
	if len(r.Ports) != 2 {
		t.Fatalf("ports = %+v", r.Ports)
	}
	a, b := r.Ports[0], r.Ports[1]
	if a.Count != 8 || a.PoEClass != "PoE+" || a.PoEDirection != "out" || a.PoEWatts == nil || *a.PoEWatts != 32 {
		t.Errorf("first = %+v", a)
	}
	if b.Count != 8 || b.PoEClass != "PoE++" || b.PoEDirection != "out" || b.PoEWatts == nil || *b.PoEWatts != 60 {
		t.Errorf("second = %+v", b)
	}
}

func TestPortLayoutKeepsThePortsWithoutPoE(t *testing.T) {
	r := portsOf("Up to PoE+", nil, "1 GbE RJ45", "8 (4 PoE+)\n(1G)")
	if len(r.Ports) != 2 || r.Ports[0].PoEClass != "PoE+" || r.Ports[0].Count != 4 || r.Ports[1].PoEClass != "" || r.Ports[1].Count != 4 {
		t.Errorf("ports = %+v", r.Ports)
	}
}

func TestPortLayoutAllPoE(t *testing.T) {
	r := portsOf("Up to PoE+++", []string{"PoE+++", "90W"}, "10 GbE RJ45", "24 (All PoE+++)\n(10G/5G/2.5G/1G/100M/10M)")
	if len(r.Ports) != 1 || r.Ports[0].Count != 24 || r.Ports[0].PoEClass != "PoE+++" || r.Ports[0].PoEDirection != "out" || *r.Ports[0].PoEWatts != 90 {
		t.Errorf("ports = %+v", r.Ports)
	}
}

func TestPortLayoutExplicitPoEInput(t *testing.T) {
	r := portsOf("Up to PoE+", []string{"PoE+", "30W"}, "1 GbE RJ45", "8 (7 PoE+; 1 PoE++ input)\n(1G/100M/10M)")
	if len(r.Ports) != 2 {
		t.Fatalf("ports = %+v", r.Ports)
	}
	out, in := r.Ports[0], r.Ports[1]
	if out.Count != 7 || out.PoEDirection != "out" || out.PoEWatts == nil {
		t.Errorf("out = %+v", out)
	}
	if in.Count != 1 || in.PoEClass != "PoE++" || in.PoEDirection != "in" || in.PoEInferred || in.PoEWatts != nil {
		t.Errorf("in = %+v", in)
	}
}

func TestPortLayoutInfersInputWhenTheClassExceedsWhatTheDeviceSupplies(t *testing.T) {
	// "5 (4 PoE+; 1 PoE++)" on a switch whose maximum output is PoE+: the PoE++
	// port is the one that powers the switch. The text doesn't say so.
	r := portsOf("Up to PoE+", []string{"PoE+", "25W", "PoE++", "60W"}, "1 GbE RJ45", "5 (4 PoE+; 1 PoE++)\n(1G/100M/10M)")
	if len(r.Ports) != 2 {
		t.Fatalf("ports = %+v", r.Ports)
	}
	in := r.Ports[1]
	if in.PoEClass != "PoE++" || in.PoEDirection != "in" || !in.PoEInferred {
		t.Errorf("in = %+v", in)
	}
	if in.PoEWatts != nil {
		t.Errorf("an input has no output wattage: %v", *in.PoEWatts)
	}
	if out := r.Ports[0]; out.PoEDirection != "out" || out.PoEInferred {
		t.Errorf("out = %+v", out)
	}
}

func TestPortLayoutInfersBareClassAsInput(t *testing.T) {
	// A combo 10GbE port listed "(PoE+++)" on a PoE++ switch: an input, so the
	// switch must not turn up as having a PoE+++ port to power things with.
	r := portsOf("Up to PoE++", nil, "10 GbE RJ45", "1 (PoE+++)\n(10G/5G/2.5G/1G/100M)")
	if p := r.Ports[0]; p.PoEDirection != "in" || !p.PoEInferred || p.PoEClass != "PoE+++" {
		t.Errorf("port = %+v", p)
	}
}

func TestPortLayoutDoesNotInferWithoutAMaximum(t *testing.T) {
	// Gateways that give no "Max. PoE Output": what the ports say, they supply.
	r := portsOf("", nil, "2.5 GbE RJ45", "4 (2 PoE+++, 2 PoE+)\n(2.5G/1G/100M)")
	for _, p := range r.Ports {
		if p.PoEDirection != "out" || p.PoEInferred {
			t.Errorf("port = %+v", p)
		}
	}
}

func TestPortLayoutAtTheMaximumIsOutput(t *testing.T) {
	r := portsOf("Up to PoE++", nil, "1 GbE RJ45", "8 (All PoE++)")
	if r.Ports[0].PoEDirection != "out" || r.Ports[0].PoEInferred {
		t.Errorf("port = %+v", r.Ports[0])
	}
}

func TestPortLayoutRolesAndCombo(t *testing.T) {
	b := &builder{}
	g := b.add("Overview", "", "Port Layout", unistore.SpecGroup, "", "")
	b.add("Overview", g, "10G SFP+", unistore.SpecText, "2\n(10G/1G)", "Stacking port only, does not support uplink. Breakout cables are not supported")
	b.add("Overview", g, "1 GbE RJ45", unistore.SpecText, "1\n(1G)", "OOB Management port only")
	b.add("Overview", g, "10 GbE RJ45", unistore.SpecText, "1\n(10G)", "Combo port")
	b.add("Overview", g, "Console", unistore.SpecText, "1", "")
	r := b.derive()
	roles := []string{r.Ports[0].Role, r.Ports[1].Role, r.Ports[2].Role, r.Ports[3].Role}
	if want := []string{"stacking", "mgmt", "data", "console"}; !slices.Equal(roles, want) {
		t.Errorf("roles = %v, want %v", roles, want)
	}
	if !r.Ports[2].Combo || r.Ports[0].Combo {
		t.Errorf("combo flags wrong: %+v", r.Ports)
	}
	if r.Ports[1].Note != "OOB Management port only" {
		t.Errorf("note = %q", r.Ports[1].Note)
	}
}

func TestPortLayoutSpeedFromTheLabelWhenNoList(t *testing.T) {
	r := portsOf("", nil, "1 GbE RJ45", "8", "10G SFP+", "2")
	if r.Ports[0].MaxSpeedMbps != 1000 || len(r.Ports[0].SpeedsMbps) != 0 || r.Ports[1].MaxSpeedMbps != 10000 {
		t.Errorf("ports = %+v", r.Ports)
	}
}

func TestPortLayoutTheSpeedListCanRaiseTheMaximum(t *testing.T) {
	// A label of "1 GbE" on a port whose list tops out at 2.5G: trust the list.
	r := portsOf("", nil, "1 GbE RJ45", "4\n(2.5G/1G)")
	if r.Ports[0].MaxSpeedMbps != 2500 {
		t.Errorf("max = %d", r.Ports[0].MaxSpeedMbps)
	}
}

func TestPortLayoutReportsWhatItCannotRead(t *testing.T) {
	r := portsOf("", nil,
		"USB-C", "2",
		"1 GbE RJ45", "several",
		"2.5 GbE RJ45", "4 (some PoE)\n(2.5G)",
		"10G SFP+", "2 extra words",
		"25G SFP28", "4 (2 PoE+; 8 PoE++)")
	if len(r.Issues) < 4 {
		t.Fatalf("issues = %+v", r.Issues)
	}
	// The ports that can be read are still reported.
	var counts []int
	for _, p := range r.Ports {
		counts = append(counts, p.Count)
	}
	if !slices.Contains(counts, 2) || !slices.Contains(counts, 4) {
		t.Errorf("ports = %+v", r.Ports)
	}
	for _, is := range r.Issues {
		if is.Area != "ports" || is.Problem == "" || is.Label == "" {
			t.Errorf("issue = %+v", is)
		}
	}
}

func TestPortLayoutPoEPortsOutnumberingThePortsIsReported(t *testing.T) {
	r := portsOf("", nil, "1 GbE RJ45", "4 (3 PoE+; 3 PoE++)")
	found := false
	for _, is := range r.Issues {
		if is.Area == "ports" {
			found = true
		}
	}
	if !found {
		t.Error("an impossible count should be reported")
	}
}

func TestPortLayoutReadsNormalizedText(t *testing.T) {
	r := portsOf("", nil, "10 GbE RJ45", "  4 (All PoE++)\n\n(10G/5G/2.5G) ")
	if len(r.Ports) != 1 || r.Ports[0].Count != 4 || r.Ports[0].PoEClass != "PoE++" || r.Ports[0].MaxSpeedMbps != 10000 {
		t.Errorf("ports = %+v", r.Ports)
	}
}

func TestPortLayoutIgnoresTheGridOverview(t *testing.T) {
	b := &builder{}
	b.grid("Port Layout", "(1) 1 GbE, (8) 100 MbE & (1) 1G SFP").grid("Ports", "(1) 10 GbE & (2) SFP+")
	r := b.derive()
	if len(r.Ports) != 0 || r.Known.Ports {
		t.Errorf("the grid summary is not a port list: %+v", r.Ports)
	}
}

func TestNetworkingInterfacePorts(t *testing.T) {
	for _, tc := range []struct {
		name, value string
		want        []Port
	}{
		{"one port", "(1) 2.5 GbE RJ45 port", []Port{{Media: "rj45", Count: 1, MaxSpeedMbps: 2500, SpeedsMbps: []int{2500}}}},
		{"a speed range", "(1) 1/2.5 GbE RJ45 port", []Port{{Media: "rj45", Count: 1, MaxSpeedMbps: 2500, SpeedsMbps: []int{2500, 1000}}}},
		{"plural, plain GbE", "(2) GbE RJ45 ports", []Port{{Media: "rj45", Count: 2, MaxSpeedMbps: 1000, SpeedsMbps: []int{1000}}}},
		{"two kinds on two lines", "(1) GbE RJ45 port\n(1) 10G SFP+ port", []Port{
			{Media: "rj45", Count: 1, MaxSpeedMbps: 1000, SpeedsMbps: []int{1000}},
			{Media: "sfp+", Count: 1, MaxSpeedMbps: 10000, SpeedsMbps: []int{10000}}}},
		{"data in and out", "(1) Data in: 1/2.5 GbE RJ45 port\n(1) Data out: GbE RJ45 ports", []Port{
			{Media: "rj45", Count: 1, MaxSpeedMbps: 2500, SpeedsMbps: []int{2500, 1000}, Note: "Data in"},
			{Media: "rj45", Count: 1, MaxSpeedMbps: 1000, SpeedsMbps: []int{1000}, Note: "Data out"}}},
		{"ports among other interfaces", "(2) GbE RJ45 ports, LTE Cat 4 radio, WiFi 4", []Port{{Media: "rj45", Count: 2, MaxSpeedMbps: 1000, SpeedsMbps: []int{1000}}}},
		{"megabit speeds", "(1) 10/100M RJ45 port", []Port{{Media: "rj45", Count: 1, MaxSpeedMbps: 100, SpeedsMbps: []int{100, 10}}}},
		{"Fast Ethernet", "(2) FE RJ45 ports, LTE Cat 4 radio, WiFi 4", []Port{{Media: "rj45", Count: 2, MaxSpeedMbps: 100, SpeedsMbps: []int{100}}}},
		{"Mbps", "(1) 10/100 Mbps RJ45 port", []Port{{Media: "rj45", Count: 1, MaxSpeedMbps: 100, SpeedsMbps: []int{100, 10}}}},
		{"Gbps and an SFP", "(1) 1 Gbps SFP port", []Port{{Media: "sfp", Count: 1, MaxSpeedMbps: 1000, SpeedsMbps: []int{1000}}}},
		{"hyphenated direction", "(1) Data-in: GbE RJ45 port\n(4) Data-out: GbE RJ45 ports", []Port{
			{Media: "rj45", Count: 1, MaxSpeedMbps: 1000, SpeedsMbps: []int{1000}, Note: "Data-in"},
			{Media: "rj45", Count: 4, MaxSpeedMbps: 1000, SpeedsMbps: []int{1000}, Note: "Data-out"}}},
		{"a speed list after the port", "(1) GbE RJ45 port (1G/100M)", []Port{{Media: "rj45", Count: 1, MaxSpeedMbps: 1000, SpeedsMbps: []int{1000, 100}}}},
		{"two kinds with no separator", "(2) 25G SFP28 ports (25G/10G/1G) (1) GbE RJ45 port (1G/100M)", []Port{
			{Media: "sfp28", Count: 2, MaxSpeedMbps: 25000, SpeedsMbps: []int{25000, 10000, 1000}},
			{Media: "rj45", Count: 1, MaxSpeedMbps: 1000, SpeedsMbps: []int{1000, 100}}}},
		{"a DC injection port is not a data port", "(1) DC RJ45 port DC injection\n(1) GbE RJ45 port", []Port{{Media: "rj45", Count: 1, MaxSpeedMbps: 1000, SpeedsMbps: []int{1000}}}},
		{"no ports at all", "(1) USB-C", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := &builder{}
			b.text("Hardware", "Networking Interface", tc.value)
			r := b.derive()
			if len(r.Ports) != len(tc.want) {
				t.Fatalf("ports = %+v", r.Ports)
			}
			for i, w := range tc.want {
				g := r.Ports[i]
				if g.Media != w.Media || g.Count != w.Count || g.MaxSpeedMbps != w.MaxSpeedMbps || !slices.Equal(g.SpeedsMbps, w.SpeedsMbps) ||
					g.Note != w.Note || g.Role != "data" || g.Source != "networking_interface" || g.PoEClass != "" {
					t.Errorf("port %d = %+v, want %+v", i, g, w)
				}
			}
			if r.Known.Ports != (len(tc.want) > 0) {
				t.Errorf("known = %v", r.Known.Ports)
			}
		})
	}
}

func TestNetworkingInterfacePoEDownlinkPorts(t *testing.T) {
	b := &builder{}
	b.text("Overview", "Networking Interface", "(1) GbE RJ45 uplink port\n(6) GbE PoE RJ45 downlink ports\n(1) HDMI port (Viewport)")
	r := b.derive()
	if len(r.Ports) != 2 || len(r.Issues) != 0 {
		t.Fatalf("ports %+v issues %+v", r.Ports, r.Issues)
	}
	up, down := r.Ports[0], r.Ports[1]
	if up.Count != 1 || up.MaxSpeedMbps != 1000 || up.PoEClass != "" {
		t.Errorf("uplink %+v", up)
	}
	if down.Count != 6 || down.MaxSpeedMbps != 1000 || down.PoEClass != "PoE" || down.PoEDirection != "out" {
		t.Errorf("downlink %+v", down)
	}
	if !r.Known.PoE {
		t.Error("an NVR with PoE downlink ports gives PoE")
	}
}

func TestNetworkingInterfaceManagementPort(t *testing.T) {
	b := &builder{}
	b.text("Hardware", "Networking Interface", "(1) GbE MGMT RJ45 port (1G/100M)")
	r := b.derive()
	if len(r.Ports) != 1 || r.Ports[0].Role != "mgmt" || r.Ports[0].MaxSpeedMbps != 1000 || len(r.Issues) != 0 {
		t.Errorf("ports %+v issues %+v", r.Ports, r.Issues)
	}
}

func TestNetworkingInterfaceLabelsDropTheCountAndWord(t *testing.T) {
	b := &builder{}
	b.text("Hardware", "Networking Interface", "(2) GbE RJ45 ports")
	if l := b.derive().Ports[0].Label; l != "GbE RJ45" {
		t.Errorf("label = %q", l)
	}
}

func TestPortLayoutWinsOverNetworkingInterface(t *testing.T) {
	b := &builder{}
	b.group("Overview", "Port Layout", "1 GbE RJ45", "4")
	b.text("Hardware", "Networking Interface", "(8) GbE RJ45 ports")
	r := b.derive()
	if len(r.Ports) != 1 || r.Ports[0].Count != 4 || r.Ports[0].Source != "port_layout" {
		t.Errorf("ports = %+v", r.Ports)
	}
}

func TestNetworkingInterfaceReportsASpeedItCannotRead(t *testing.T) {
	b := &builder{}
	b.text("Hardware", "Networking Interface", "(1) lightning-fast RJ45 port")
	r := b.derive()
	if len(r.Ports) != 1 || r.Ports[0].MaxSpeedMbps != 0 || len(r.Issues) != 1 {
		t.Errorf("ports %+v, issues %+v", r.Ports, r.Issues)
	}
}

func TestPortCountsMustBePlausible(t *testing.T) {
	for _, count := range []string{"99999999999999999999", "1001", "5000"} {
		r := portsOf("", nil, "1 GbE RJ45", count+" (All PoE+)")
		if len(r.Ports) != 0 || len(r.Issues) != 1 {
			t.Errorf("%s: ports %+v issues %+v", count, r.Ports, r.Issues)
		}
	}
	// The largest believable count is kept.
	if r := portsOf("", nil, "1 GbE RJ45", "1000"); len(r.Ports) != 1 || r.Ports[0].Count != 1000 {
		t.Errorf("ports = %+v", r.Ports)
	}
	// Also in the PoE part, and in an interface list.
	if r := portsOf("", nil, "1 GbE RJ45", "8 (99999999999999999999 PoE+)"); len(r.Issues) != 1 {
		t.Errorf("issues = %+v", r.Issues)
	}
	b := &builder{}
	b.text("Hardware", "Networking Interface", "(99999999999999999999) GbE RJ45 ports")
	if r := b.derive(); len(r.Ports) != 0 || len(r.Issues) != 1 {
		t.Errorf("ports %+v issues %+v", r.Ports, r.Issues)
	}
}
