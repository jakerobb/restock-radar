package specs

import (
	"sort"
	"testing"
)

// These tests run the derivation over specifications captured from the live
// store, so the patterns are held to what the store actually publishes.

func portsMatching(r Result, f func(Port) bool) (n int) {
	for _, p := range r.Ports {
		if f(p) {
			n += p.Count
		}
	}
	return n
}

func TestRealSwitchWithMixedPoE(t *testing.T) {
	r := derived(t, "usw-pro-max-24-poe")
	if r.PoEMaxClass != "PoE++" || !r.Known.Ports || !r.Known.PoE {
		t.Fatalf("maxclass %q known %+v", r.PoEMaxClass, r.Known)
	}
	if n := portsMatching(r, func(p Port) bool { return p.PoEClass == "PoE+" && p.PoEDirection == "out" }); n != 8 {
		t.Errorf("PoE+ ports = %d, want 8", n)
	}
	if n := portsMatching(r, func(p Port) bool { return p.PoEClass == "PoE++" && p.PoEDirection == "out" }); n != 16 {
		t.Errorf("PoE++ ports = %d, want 16 (8 of the 1GbE and all 8 2.5GbE)", n)
	}
	if n := portsMatching(r, func(p Port) bool { return p.Media == "sfp+" }); n != 2 {
		t.Errorf("SFP+ = %d", n)
	}
	if m := metric(r, "poe_budget_w"); m.Value != 400 {
		t.Errorf("budget = %v", m.Value)
	}
	if !r.Rack.Mountable || r.Rack.Units != 1 || r.Dims.WidthMM == nil || *r.Dims.WidthMM != 442 || *r.Dims.HeightMM != 44 || *r.Dims.DepthMM != 325 {
		t.Errorf("rack %+v dims %+v", r.Rack, r.Dims)
	}
	if len(r.Issues) != 0 {
		t.Errorf("issues = %+v", r.Issues)
	}
}

func TestRealModularChassis(t *testing.T) {
	r := derived(t, "eav-xg-24-poe")
	if len(r.PoEBudget) != 4 {
		t.Fatalf("scenarios = %+v", r.PoEBudget)
	}
	s := selected(r)
	if len(s) != 1 || s[0].Watts != 2150 || s[0].Name != "200-240V AC Shared Mode" {
		t.Errorf("selected = %+v", s)
	}
	// "10GbE PoE+++ port": 24 of them, supplying 90W each.
	var found bool
	for _, p := range r.Ports {
		if p.Media == "rj45" && p.MaxSpeedMbps == 10000 && p.PoEClass == "PoE+++" && p.PoEDirection == "out" && p.Count == 24 && p.PoEWatts != nil && *p.PoEWatts == 90 {
			found = true
		}
	}
	if !found {
		t.Errorf("no 10GbE PoE+++ output ports in %+v", r.Ports)
	}
	if n := portsMatching(r, func(p Port) bool { return p.Media == "qsfp28" && p.MaxSpeedMbps == 100000 }); n != 4 {
		t.Errorf("100G ports = %d", n)
	}
	if !r.Rack.FullDepth || r.Rack.Units != 1 {
		t.Errorf("rack = %+v", r.Rack)
	}
	if m := metric(r, "power_draw_max_w"); m.Value != 2400 {
		t.Errorf("max draw = %v", m.Value)
	}
	if m := metric(r, "power_draw_excl_poe_w"); m.Value != 150 {
		t.Errorf("device draw = %v", m.Value)
	}
	if m := metric(r, "switching_capacity_gbps"); m.Value != 1280 {
		t.Errorf("capacity = %v", m.Value)
	}
}

func TestRealUSWUltraVariants(t *testing.T) {
	for slug, want := range map[string]float64{"usw-ultra-60w": 52, "usw-ultra-210w": 202, "usw-ultra": 202} {
		r := derived(t, slug)
		if m := metric(r, "poe_budget_w"); m == nil || m.Value != want {
			t.Errorf("%s: budget = %+v, want %v", slug, m, want)
		}
		if len(r.PoEBudget) != 5 {
			t.Errorf("%s: scenarios = %d", slug, len(r.PoEBudget))
		}
		// The eighth port is the PoE++ input, not an output.
		if n := portsMatching(r, func(p Port) bool { return p.PoEDirection == "in" && p.PoEClass == "PoE++" }); n != 1 {
			t.Errorf("%s: PoE++ inputs = %d", slug, n)
		}
		if n := portsMatching(r, func(p Port) bool { return p.PoEDirection == "out" }); n != 7 {
			t.Errorf("%s: PoE outputs = %d", slug, n)
		}
	}
}

func TestRealPoEInputsThatAreNotLabelledAsInputs(t *testing.T) {
	r := derived(t, "usw-flex")
	if n := portsMatching(r, func(p Port) bool { return p.PoEClass == "PoE++" && p.PoEDirection == "in" && p.PoEInferred }); n != 1 {
		t.Errorf("usw-flex: inferred PoE++ input = %d in %+v", n, r.Ports)
	}
	if n := portsMatching(r, func(p Port) bool { return p.PoEClass == "PoE++" && p.PoEDirection == "out" }); n != 0 {
		t.Errorf("usw-flex has no PoE++ output")
	}

	r = derived(t, "usw-flex-2-5g-8-poe")
	// The switch must not turn up as having a 10GbE PoE+++ port that supplies power.
	if n := portsMatching(r, func(p Port) bool { return p.PoEClass == "PoE+++" && p.PoEDirection == "out" }); n != 0 {
		t.Errorf("usw-flex-2-5g-8-poe: PoE+++ outputs = %d", n)
	}
	if n := portsMatching(r, func(p Port) bool {
		return p.PoEClass == "PoE+++" && p.PoEDirection == "in" && p.MaxSpeedMbps == 10000 && p.Combo
	}); n != 1 {
		t.Errorf("usw-flex-2-5g-8-poe: the 10GbE PoE+++ input = %d in %+v", n, r.Ports)
	}
	if m := metric(r, "poe_budget_w"); m.Value != 196 {
		t.Errorf("budget = %v (the 210W adapter gives 196W)", m.Value)
	}
}

func TestRealGatewaysWithPoEAndWiFi(t *testing.T) {
	r := derived(t, "ucg-industrial")
	if len(r.PoEBudget) != 2 || selected(r)[0].Watts != 270 || selected(r)[0].Name != "DC input" {
		t.Errorf("budget = %+v", r.PoEBudget)
	}
	if n := portsMatching(r, func(p Port) bool { return p.PoEClass == "PoE+++" && p.PoEDirection == "out" }); n != 3 {
		t.Errorf("PoE+++ outputs = %d", n)
	}
	if n := portsMatching(r, func(p Port) bool { return p.PoEClass == "PoE+" && p.PoEDirection == "out" }); n != 2 {
		t.Errorf("PoE+ outputs = %d", n)
	}
	if radio(r, "2.4 GHz") == nil || radio(r, "5 GHz") == nil || radio(r, "6 GHz") != nil {
		t.Errorf("radios = %+v", r.Radios)
	}
	if m := metric(r, "ids_ips_throughput_mbps"); m == nil || m.Value != 5000 {
		t.Errorf("IDS/IPS = %+v", m)
	}

	r = derived(t, "udr7")
	if radio(r, "6 GHz") == nil || *radio(r, "6 GHz").TxPowerDBm != 24 || *radio(r, "6 GHz").AntennaGainDBi != 6 {
		t.Errorf("6 GHz = %+v", radio(r, "6 GHz"))
	}
	if m := metric(r, "ids_ips_throughput_mbps"); m.Value != 2300 {
		t.Errorf("IDS/IPS = %+v", m)
	}
}

func TestRealAccessPoints(t *testing.T) {
	r := derived(t, "u7-pro")
	if !r.Known.Radios || len(r.Radios) != 3 {
		t.Fatalf("radios = %+v", r.Radios)
	}
	six := radio(r, "6 GHz")
	if *six.AntennaGainDBi != 5.8 || *six.TxPowerDBm != 23 || *six.Streams != 2 || *six.MaxRateMbps != 5800 {
		t.Errorf("6 GHz = %+v", six)
	}
	if len(r.Ports) != 1 || r.Ports[0].MaxSpeedMbps != 2500 || r.Ports[0].Source != "networking_interface" {
		t.Errorf("ports = %+v", r.Ports)
	}
	if m := metric(r, "wifi_generation"); m.Value != 7 {
		t.Errorf("generation = %+v", m)
	}
	if !r.Dims.Round || r.Dims.MaxMM != 206 || r.Dims.MinMM != 46 {
		t.Errorf("dims = %+v", r.Dims)
	}

	// A WiFi 7 AP with no 6 GHz radio: generation is no stand-in for the band.
	r = derived(t, "u7-outdoor")
	if m := metric(r, "wifi_generation"); m.Value != 7 || radio(r, "6 GHz") != nil || !r.Known.Radios {
		t.Errorf("u7-outdoor: generation %+v radios %+v", m, r.Radios)
	}
	if !radio(r, "5 GHz").Multi {
		t.Error("the outdoor AP lists several antennas")
	}
}

func TestRealBridgeWith60GHz(t *testing.T) {
	r := derived(t, "ubb-xg")
	sixty := radio(r, "60 GHz")
	if sixty == nil || sixty.Tech != "wigig" || *sixty.AntennaGainDBi != 21 || *sixty.TxPowerDBm != 16 {
		t.Errorf("60 GHz = %+v", sixty)
	}
	if radio(r, "5 GHz") == nil || radio(r, "6 GHz") != nil {
		t.Errorf("radios = %+v", r.Radios)
	}
}

func TestRealSuperLinkAndBluetooth(t *testing.T) {
	r := derived(t, "usl-gateway")
	if radio(r, "SuperLink") == nil || radio(r, "Bluetooth") == nil || radio(r, "5 GHz") != nil {
		t.Errorf("radios = %+v", r.Radios)
	}
	if radio(r, "Bluetooth").Tech != "bluetooth" {
		t.Errorf("tech = %q", radio(r, "Bluetooth").Tech)
	}
}

func TestRealDeviceWithNoPorts(t *testing.T) {
	r := derived(t, "utr")
	if r.Known.Ports || len(r.Ports) != 0 {
		t.Errorf("a travel router with no port list: %+v", r.Ports)
	}
	if m := metric(r, "wifi_generation"); m == nil || m.Value != 5 {
		t.Errorf("generation = %+v", m)
	}
}

func TestRealDimensionsTakeTheSmallestVolume(t *testing.T) {
	// The Toolless Mini Rack gives the rack with and without its handle and
	// caster: the bare one is taken.
	if d := derived(t, "toolless-mini-rack").Dims; d.MinMM != 351 || d.MaxMM != 519 {
		t.Errorf("toolless-mini-rack: dims = %+v", d)
	}
	// The USL gateway gives its size three ways (with antenna, DIN rail or wall
	// mount), none of them labelled as the bare device: the smallest is taken,
	// and says which it is.
	r := derived(t, "usl-gateway")
	if !r.Known.Dims || r.Dims.Label != "With antenna" || r.Dims.MaxMM != 159.3 {
		t.Errorf("usl-gateway: dims %+v known %v", r.Dims, r.Known.Dims)
	}
	for _, is := range r.Issues {
		if is.Area == "dims" {
			t.Errorf("usl-gateway: unexpected dims issue %+v", is)
		}
	}
}

func TestRealRackMountAxesResolve(t *testing.T) {
	// Both orders of the three numbers: width x depth x height, and width x height x depth.
	for slug, want := range map[string][3]float64{
		"usw-pro-max-24-poe":   {442, 325, 44},
		"ecs-24-poe":           {442.4, 496, 43.7},
		"eav-xg-24-poe":        {442.4, 480, 43.7},
		"cloud-key-enterprise": {481.4, 787, 43.7},
		"unvr-g2":              {442.4, 325, 43.7},
		"usw-pro-48-poe":       {442, 400, 44},
	} {
		d := derived(t, slug).Dims
		if d.WidthMM == nil || *d.WidthMM != want[0] || *d.DepthMM != want[1] || *d.HeightMM != want[2] {
			t.Errorf("%s: dims = %+v, want %v", slug, d, want)
		}
	}
	// 19-inch width but not 19-inch gear: left unresolved.
	if d := derived(t, "usw-pro-max-16-poe").Dims; d.WidthMM != nil || d.MaxMM != 325.1 {
		t.Errorf("usw-pro-max-16-poe: dims = %+v", d)
	}
}

// TestEveryRealProductHolds checks properties that must be true of anything the
// store publishes, over every captured product.
func TestEveryRealProductHolds(t *testing.T) {
	all := fixtures(t)
	var slugs []string
	for s := range all {
		slugs = append(slugs, s)
	}
	sort.Strings(slugs)
	for _, slug := range slugs {
		r := derived(t, slug)

		// A device never supplies more PoE than its maximum.
		for _, p := range r.Ports {
			if p.PoEDirection == "out" && r.PoEMaxClass != "" && poeRank(p.PoEClass) > poeRank(r.PoEMaxClass) {
				t.Errorf("%s: %s port supplies %s, above the maximum %s", slug, p.Label, p.PoEClass, r.PoEMaxClass)
			}
			if p.Count <= 0 {
				t.Errorf("%s: port %s has count %d", slug, p.Label, p.Count)
			}
			if p.PoEClass == "" && p.PoEDirection != "" || p.PoEClass != "" && p.PoEDirection == "" {
				t.Errorf("%s: port %+v has a class or direction without the other", slug, p)
			}
			if p.PoEWatts != nil && p.PoEDirection != "out" {
				t.Errorf("%s: wattage on a port that isn't an output: %+v", slug, p)
			}
			for i := 1; i < len(p.SpeedsMbps); i++ {
				if p.SpeedsMbps[i] > p.SpeedsMbps[i-1] {
					t.Errorf("%s: speeds not descending: %v", slug, p.SpeedsMbps)
				}
			}
			if len(p.SpeedsMbps) > 0 && p.MaxSpeedMbps < p.SpeedsMbps[0] {
				t.Errorf("%s: max speed %d below the fastest listed %d", slug, p.MaxSpeedMbps, p.SpeedsMbps[0])
			}
		}

		// Exactly one budget scenario is selected, and it has a metric.
		if len(r.PoEBudget) > 0 {
			if n := len(selected(r)); n != 1 {
				t.Errorf("%s: %d scenarios selected", slug, n)
			}
			if metric(r, "poe_budget_w") == nil {
				t.Errorf("%s: budget without metric", slug)
			}
		}
		if metric(r, "poe_budget_w") != nil && len(r.PoEBudget) == 0 {
			t.Errorf("%s: metric without budget", slug)
		}

		// Any device that supplies PoE has a budget to sort by.
		if portsMatching(r, func(p Port) bool { return p.PoEDirection == "out" }) > 0 && len(r.PoEBudget) == 0 {
			t.Errorf("%s: supplies PoE but has no budget", slug)
		}

		for _, m := range r.Metrics {
			if m.Value <= 0 && m.Name != "wifi_generation" || m.Raw == "" || m.Name == "" {
				t.Errorf("%s: metric %+v", slug, m)
			}
		}
		seen := map[string]bool{}
		for _, m := range r.Metrics {
			if seen[m.Name] {
				t.Errorf("%s: metric %s twice", slug, m.Name)
			}
			seen[m.Name] = true
		}
		seen = map[string]bool{}
		for _, rd := range r.Radios {
			if seen[rd.Band] {
				t.Errorf("%s: radio %s twice", slug, rd.Band)
			}
			seen[rd.Band] = true
		}

		d := r.Dims
		if r.Known.Dims && !(d.MinMM > 0 && d.MinMM <= d.MidMM && d.MidMM <= d.MaxMM) {
			t.Errorf("%s: dims %+v", slug, d)
		}
		if d.WidthMM != nil && (d.DepthMM == nil || d.HeightMM == nil || !r.Rack.Mountable) {
			t.Errorf("%s: resolved axes %+v on a device that isn't rack mount", slug, d)
		}

		if r.Known.Radios != (len(r.Radios) > 0) || r.Known.Ports != (len(r.Ports) > 0) {
			t.Errorf("%s: known %+v vs %d radios %d ports", slug, r.Known, len(r.Radios), len(r.Ports))
		}
	}
}

func TestEveryRealProductDerivesTheSameTwice(t *testing.T) {
	// Deriving is a pure function of the specification.
	for slug := range fixtures(t) {
		a, b := derived(t, slug), derived(t, slug)
		if !jsonEqual(a, b) {
			t.Errorf("%s: two derivations differ", slug)
		}
	}
}

// A Cloud Gateway Fiber's port rows don't mention PoE; "PoE Support: (1) PoE+" does.
func TestPoESupportFieldGivesPoEPort(t *testing.T) {
	r := derived(t, "ucg-fiber")
	var out int
	for _, p := range r.Ports {
		if p.PoEDirection == "out" && p.PoEClass == "PoE+" {
			out += p.Count
		}
	}
	if out != 1 {
		t.Fatalf("PoE+ out ports = %d, ports %+v", out, r.Ports)
	}
}
