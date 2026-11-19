package specs

import (
	"testing"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

func metricOf(label, value string) (Result, *Metric) {
	b := &builder{}
	b.text("Overview", label, value)
	r := b.derive()
	return r, metric(r, map[string]string{
		"Switching Capacity": "switching_capacity_gbps", "Total Non-Blocking Throughput": "nonblocking_throughput_gbps",
		"IDS/IPS Throughput": "ids_ips_throughput_mbps", "Forwarding Rate": "forwarding_rate_mpps",
	}[label])
}

func TestRateMetrics(t *testing.T) {
	for _, tc := range []struct {
		label, value string
		want         float64
		atLeast      bool
	}{
		{"Switching Capacity", "112 Gbps", 112, false},
		{"Switching Capacity", "1.28 Tbps", 1280, false},
		{"Switching Capacity", "500 Mbps", 0.5, false},
		{"Total Non-Blocking Throughput", "56 Gbps", 56, false},
		{"IDS/IPS Throughput", "5 Gbps", 5000, false},
		{"IDS/IPS Throughput", "2.3 Gbps", 2300, false},
		{"IDS/IPS Throughput", "1 Gbps", 1000, false},
		{"IDS/IPS Throughput", "750 Mbps", 750, false},
		{"IDS/IPS Throughput", "8+ Gbps", 8000, true},
		{"IDS/IPS Throughput", "1,500 Mbps", 1500, false},
		{"Forwarding Rate", "83 Mpps", 83, false},
		{"Forwarding Rate", "14.88 Mpps", 14.88, false},
		{"Forwarding Rate", "1.2 Gpps", 1200, false},
		{"Forwarding Rate", "500 Kpps", 0.5, false},
		{"Forwarding Rate", "2.4 Bpps", 2400, false},
	} {
		_, m := metricOf(tc.label, tc.value)
		if m == nil || m.Value != tc.want || m.AtLeast != tc.atLeast || m.Raw != tc.value {
			t.Errorf("%s = %q: got %+v, want %v (at least %v)", tc.label, tc.value, m, tc.want, tc.atLeast)
		}
	}
}

func TestRateMetricUnits(t *testing.T) {
	for label, unit := range map[string]string{
		"Switching Capacity": "Gbps", "Total Non-Blocking Throughput": "Gbps", "IDS/IPS Throughput": "Mbps", "Forwarding Rate": "Mpps",
	} {
		value := "1 Gbps"
		if label == "Forwarding Rate" {
			value = "1 Mpps"
		}
		if _, m := metricOf(label, value); m == nil || m.Unit != unit {
			t.Errorf("%s unit = %+v", label, m)
		}
	}
}

func TestRateMetricsReportAnUnreadableValue(t *testing.T) {
	for _, label := range []string{"Switching Capacity", "IDS/IPS Throughput", "Forwarding Rate", "Total Non-Blocking Throughput"} {
		r, m := metricOf(label, "very fast")
		if m != nil || len(r.Issues) != 1 || r.Issues[0].Area != "metrics" {
			t.Errorf("%s: metric %+v issues %+v", label, m, r.Issues)
		}
	}
}

func TestPowerDraw(t *testing.T) {
	for _, tc := range []struct {
		name, value string
		max         float64
		excl        float64 // 0: none
	}{
		{"plain", "29W", 29, 0},
		{"excluding PoE output", "50W (Excluding PoE Output)", 50, 50},
		{"with and without PoE output", "50W (Excluding PoE Output)\n450W (Including PoE Output)", 450, 50},
		{"per power source", "9W (Excluding PoE Output) with PoE input\n8W (Excluding PoE Output) with adapter input\n210W (Including PoE Output)", 210, 9},
		{"thousands", "150W (Excluding PoE Output)\n2,400W (Including PoE Output)", 2400, 150},
		{"fractional", "29.4W", 29.4, 0},
		{"milliwatts", "27.7mW", 0.0277, 0},
		{"milliwatts with a current", "50mW/20mA", 0.05, 0},
		{"milliwatts and watts", "500mW (idle)\n3W (active)", 3, 0},
		{"AC input line", "21W (AC input)\n15W (Excluding PoE output)", 21, 15},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := &builder{}
			b.text("Hardware", "Max. Power Consumption", tc.value)
			r := b.derive()
			m := metric(r, "power_draw_max_w")
			if m == nil || m.Value != tc.max || m.Unit != "W" {
				t.Errorf("max = %+v, want %v", m, tc.max)
			}
			x := metric(r, "power_draw_excl_poe_w")
			if (x == nil) != (tc.excl == 0) || x != nil && x.Value != tc.excl {
				t.Errorf("excluding PoE = %+v, want %v", x, tc.excl)
			}
		})
	}
}

func TestPowerDrawAlternativeLabelAndNoWatts(t *testing.T) {
	b := &builder{}
	b.text("Hardware", "Power Consumption", "12W")
	if m := metric(b.derive(), "power_draw_max_w"); m == nil || m.Value != 12 {
		t.Errorf("metric = %+v", m)
	}
	b = &builder{}
	b.text("Hardware", "Max. Power Consumption", "varies")
	if r := b.derive(); metric(r, "power_draw_max_w") != nil || len(r.Issues) != 1 {
		t.Errorf("result = %+v", r)
	}
}

func TestMetricsAbsentWhenNotPublished(t *testing.T) {
	b := &builder{}
	b.text("Overview", "Weight", "1 kg")
	if r := b.derive(); len(r.Metrics) != 0 {
		t.Errorf("metrics = %+v", r.Metrics)
	}
}

func TestMetricsOnlyFromStandardSections(t *testing.T) {
	b := &builder{}
	b.grid("IDS/IPS", "5 Gbps IPS")
	if r := b.derive(); len(r.Metrics) != 0 {
		t.Errorf("the grid summary is not the specification: %+v", r.Metrics)
	}
}

func TestRackForms(t *testing.T) {
	for _, tc := range []struct {
		in    string
		known bool
		mount bool
		units int
		full  bool
	}{
		{"Rack mount (1U)", true, true, 1, false},
		{"Rack Mount (1U, Full-Depth)", true, true, 1, true},
		{"Rack mount (1U, Full-Depth)", true, true, 1, true},
		{"Rack mount (2U)", true, true, 2, false},
		{"Rack Mount (3U)", true, true, 3, false},
		{"Rack mount (1U), desktop, wall", true, true, 1, false},
		{"Rack Mount | Compact Desktop", true, true, 0, false},
		{"Rack-mount (1U)", true, true, 1, false},
		{"Compact desktop", true, false, 0, false},
		{"Compact DIN rail and wall-mountable", true, false, 0, false},
		{"3.5-inch HDD", true, false, 0, false},
		{"SFP+", true, false, 0, false},
	} {
		b := &builder{}
		b.text("Overview", "Form Factor", tc.in)
		r := b.derive()
		if r.Known.Rack != tc.known || r.Rack.Mountable != tc.mount || r.Rack.Units != tc.units || r.Rack.FullDepth != tc.full {
			t.Errorf("%q: known %v rack %+v", tc.in, r.Known.Rack, r.Rack)
		}
	}
	b := &builder{}
	b.text("Overview", "Weight", "1 kg")
	if r := b.derive(); r.Known.Rack || r.Rack.Mountable {
		t.Errorf("no form factor means rack status is unknown: %+v", r.Rack)
	}
}

func dimsOf(formFactor, dims string) Result {
	b := &builder{}
	if formFactor != "" {
		b.text("Overview", "Form Factor", formFactor)
	}
	b.text("Overview", "Dimensions", dims)
	return b.derive()
}

func TestDimsSortedWhateverTheOrder(t *testing.T) {
	for _, in := range []string{
		"442 x 325 x 44 mm\n(17.4 x 12.8 x 1.7\")",
		"44 x 442 x 325 mm",
		"325×44×442 mm",
		"442 x 325 x 44 mm (17.4 x 12.8 x 1.7\")",
		"  442 x 325 x 44 mm  \n  (17.4 x 12.8 x 1.7\")",
	} {
		r := dimsOf("", in)
		if !r.Known.Dims || r.Dims.MinMM != 44 || r.Dims.MidMM != 325 || r.Dims.MaxMM != 442 || r.Dims.Round {
			t.Errorf("%q: dims = %+v known %v", in, r.Dims, r.Known.Dims)
		}
		if r.Dims.WidthMM != nil {
			t.Errorf("%q: axes can't be told apart for a device that isn't rack mount", in)
		}
	}
}

func TestDimsRoundDevices(t *testing.T) {
	for _, in := range []string{"⌀206 x 46 mm\n(⌀8.1 x 1.8\")", "⌀206 × 46 mm (⌀8.1 x 1.8\")", "Ø206 x 46 mm"} {
		r := dimsOf("", in)
		if !r.Dims.Round || r.Dims.MinMM != 46 || r.Dims.MidMM != 206 || r.Dims.MaxMM != 206 {
			t.Errorf("%q: dims = %+v", in, r.Dims)
		}
	}
}

func TestDimsDecimals(t *testing.T) {
	r := dimsOf("", "43.7 x 442.4 x 285.6 mm")
	if r.Dims.MinMM != 43.7 || r.Dims.MidMM != 285.6 || r.Dims.MaxMM != 442.4 {
		t.Errorf("dims = %+v", r.Dims)
	}
}

func TestDimsLabelledLines(t *testing.T) {
	// The device line is taken; the table stand is an accessory.
	r := dimsOf("", "Device: 120 x 80 x 30 mm\n(4.7 x 3.1 x 1.2\")\nTable stand: 200 x 150 x 40 mm\n(7.9 x 5.9 x 1.6\")")
	if !r.Known.Dims || r.Dims.MinMM != 30 || r.Dims.MaxMM != 120 {
		t.Errorf("dims = %+v", r.Dims)
	}
	// A single labelled line is the device's.
	r = dimsOf("", "Unit: 120 x 80 x 30 mm")
	if !r.Known.Dims || r.Dims.MaxMM != 120 {
		t.Errorf("dims = %+v", r.Dims)
	}
	// An unlabelled line beats labelled accessories.
	r = dimsOf("", "120 x 80 x 30 mm\nWith stand: 200 x 150 x 40 mm")
	if !r.Known.Dims || r.Dims.MaxMM != 120 {
		t.Errorf("dims = %+v", r.Dims)
	}
}

func TestDimsPicksTheBareDeviceAmongLabelledConfigurations(t *testing.T) {
	for _, tc := range []struct {
		name, in string
		max      float64
	}{
		{"packaging is never the device", "Packaging: 500 x 400 x 100 mm\nRack: 442 x 325 x 44 mm", 442},
		{"without mount", "With mount: 170 x 208 x 121.8 mm\nWithout mount: 170 x 208 x 66.5 mm", 208},
		{"without, among three", "With antennas: 160 x 80 x 40 mm\nWith antennas and outdoor cover: 160 x 80 x 60 mm\nWithout antennas and outdoor cover: 150 x 70 x 30 mm", 150},
		{"packaging, then without", "Packaging: 600 x 500 x 200 mm\nRack with caster: 519 x 460 x 485 mm\nRack without caster: 519 x 460 x 351 mm", 519},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := dimsOf("", tc.in)
			if !r.Known.Dims || r.Dims.MaxMM != tc.max {
				t.Errorf("dims = %+v known %v issues %+v", r.Dims, r.Known.Dims, r.Issues)
			}
		})
	}
}

func TestDimsLabelsOnTheirOwnLine(t *testing.T) {
	// How the Toolless Mini Rack's sizes are published: each label alone, the
	// size on the next line. The bare rack is the lower one, 351 mm.
	r := dimsOf("", "With handle and caster:\n519 x 460 x 485 mm\n(20.43 x 18.11 x 19.09\")\nWithout handle and caster:\n519 x 460 x 351 mm\n(20.43 x 18.11 x 13.82\")")
	if !r.Known.Dims || r.Dims.MinMM != 351 || r.Dims.MidMM != 460 || r.Dims.MaxMM != 519 {
		t.Errorf("dims = %+v issues %+v", r.Dims, r.Issues)
	}
	// A label on its own line also names a "Device" size.
	r = dimsOf("", "Device:\n120 x 80 x 30 mm\nTable stand:\n200 x 150 x 40 mm")
	if !r.Known.Dims || r.Dims.MaxMM != 120 {
		t.Errorf("dims = %+v", r.Dims)
	}
	// A label with nothing after it names nothing.
	r = dimsOf("", "120 x 80 x 30 mm\nWith stand:")
	if !r.Known.Dims || r.Dims.MaxMM != 120 {
		t.Errorf("dims = %+v", r.Dims)
	}
}

func TestDimsRefusesToGuess(t *testing.T) {
	for _, in := range []string{
		"Packaging: 500 x 400 x 100 mm\nCase: 442 x 325 x 44 mm\nBase: 400 x 300 x 20 mm",
		"With mount: 170 x 208 x 121.8 mm\nWith cover: 170 x 208 x 130 mm",
		"Without mount: 170 x 208 x 66.5 mm\nWithout cover: 170 x 208 x 60 mm",
		"With antenna: 159 x 82 x 26 mm\nWith wall mount: 159 x 82 x 30 mm\nWith DIN rail mount: 159 x 82 x 38 mm",
		"120 x 80 x 30 mm\n200 x 150 x 40 mm",
		"120 x 80 mm",
		"approximately a shoebox",
	} {
		r := dimsOf("", in)
		if r.Known.Dims || r.Dims.MaxMM != 0 || len(r.Issues) != 1 || r.Issues[0].Area != "dims" {
			t.Errorf("%q: dims %+v known %v issues %+v", in, r.Dims, r.Known.Dims, r.Issues)
		}
	}
}

func TestDimsRackMountAxesWidthDepthHeight(t *testing.T) {
	r := dimsOf("Rack mount (1U)", "442 x 325 x 44 mm\n(17.4 x 12.8 x 1.7\")")
	d := r.Dims
	if d.WidthMM == nil || *d.WidthMM != 442 || *d.DepthMM != 325 || *d.HeightMM != 44 {
		t.Errorf("dims = %+v", d)
	}
}

func TestDimsRackMountAxesWidthHeightDepth(t *testing.T) {
	r := dimsOf("Rack Mount (1U, Full-Depth)", "442.4 x 43.7 x 496 mm")
	d := r.Dims
	if d.WidthMM == nil || *d.WidthMM != 442.4 || *d.DepthMM != 496 || *d.HeightMM != 43.7 {
		t.Errorf("dims = %+v", d)
	}
}

func TestDimsRackMountMultipleUnits(t *testing.T) {
	r := dimsOf("Rack mount (2U)", "442.4 x 87.4 x 630 mm")
	d := r.Dims
	if d.WidthMM == nil || *d.HeightMM != 87.4 || *d.DepthMM != 630 || *d.WidthMM != 442.4 {
		t.Errorf("dims = %+v", d)
	}
}

func TestDimsRackMountDeepDeviceNearWidth(t *testing.T) {
	// A depth (480) near a rack width must not be taken for the width.
	r := dimsOf("Rack Mount (1U, Full-Depth)", "442.4 x 43.7 x 480 mm")
	if d := r.Dims; d.WidthMM == nil || *d.WidthMM != 442.4 || *d.DepthMM != 480 {
		t.Errorf("dims = %+v", d)
	}
}

func TestDimsRackMountDepthBeyondTheWidth(t *testing.T) {
	r := dimsOf("Rack mount (1U)", "787 x 43.7 x 481.4 mm")
	if d := r.Dims; d.WidthMM == nil || *d.WidthMM != 481.4 || *d.DepthMM != 787 || *d.HeightMM != 43.7 {
		t.Errorf("dims = %+v", d)
	}
}

func TestDimsRackMountWith19InchEars(t *testing.T) {
	r := dimsOf("Rack mount (1U)", "482.6 x 44.45 x 250 mm")
	if d := r.Dims; d.WidthMM == nil || *d.WidthMM != 482.6 || *d.DepthMM != 250 {
		t.Errorf("dims = %+v", d)
	}
}

func TestDimsRackMountThatIsNotNineteenInchesIsLeftAlone(t *testing.T) {
	// 325 x 160 x 43.7: the height is clear, the width isn't a 19-inch one.
	r := dimsOf("Rack mount (1U), desktop, wall", "325.1 x 160 x 43.7 mm")
	d := r.Dims
	if !r.Known.Dims || d.MinMM != 43.7 || d.MidMM != 160 || d.MaxMM != 325.1 {
		t.Errorf("dims = %+v", d)
	}
	if d.WidthMM != nil || d.DepthMM != nil || d.HeightMM != nil {
		t.Errorf("axes should not be guessed: %+v", d)
	}
}

func TestDimsRackMountWithoutUnitsOrWithAnAmbiguousHeight(t *testing.T) {
	// No U count: nothing to tell the height by.
	if d := dimsOf("Rack Mount | Compact Desktop", "442.4 x 43.7 x 285.6 mm").Dims; d.HeightMM != nil {
		t.Errorf("dims = %+v", d)
	}
	// 1U is 44.45: two dimensions that both fit it can't be told apart.
	if d := dimsOf("Rack mount (1U)", "44 x 44 x 442 mm").Dims; d.HeightMM != nil {
		t.Errorf("dims = %+v", d)
	}
	// Nothing near the stated height.
	if d := dimsOf("Rack mount (3U)", "442 x 325 x 44 mm").Dims; d.HeightMM != nil {
		t.Errorf("dims = %+v", d)
	}
}

func TestDimsRoundIsNotResolved(t *testing.T) {
	if d := dimsOf("Rack mount (1U)", "⌀206 x 46 mm").Dims; d.WidthMM != nil {
		t.Errorf("dims = %+v", d)
	}
}

func TestDimsUnknownWithoutAnEntry(t *testing.T) {
	b := &builder{}
	b.text("Overview", "Weight", "1 kg")
	if r := b.derive(); r.Known.Dims || len(r.Issues) != 0 {
		t.Errorf("result = %+v", r)
	}
}

func coverageOf(value string) Result {
	b := &builder{}
	b.text("Overview", "Coverage Area", value)
	return b.derive()
}

func TestCoverageArea(t *testing.T) {
	for _, tc := range []struct {
		value    string
		m2, sqft float64
	}{
		{"140 m² (1,500 ft²)", 140, 1500},
		{"115 m² (1,250 ft²)", 115, 1250},
		{"465 m² (5,000 ft²)", 465, 5000},
		{"465 m² (5,000 ft²)", 465, 5000}, // a non-breaking space, as the store sometimes writes
		{"1,500 ft² (139 m²)", 139, 1500}, // in the other order
		{"140 m²", 140, 1507},             // one unit only: the other is worked out
		{"1,500 ft²", 139, 1500},
	} {
		r := coverageOf(tc.value)
		m2, sqft := metric(r, "coverage_m2"), metric(r, "coverage_sqft")
		if m2 == nil || sqft == nil || m2.Value != tc.m2 || sqft.Value != tc.sqft || m2.Unit != "m²" || sqft.Unit != "ft²" {
			t.Errorf("%q: got %+v and %+v, want %v m² and %v ft²", tc.value, m2, sqft, tc.m2, tc.sqft)
		}
		if metric(r, "range_m") != nil {
			t.Errorf("%q: an area was also read as a range", tc.value)
		}
	}
}

func TestCoverageRangeOfABridge(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  float64
	}{
		{"500 m (1,640 ft)", 500},
		{"5 km (3.1 mi)", 5000},
		{"1.5 km (0.9 mi)", 1500},
	} {
		r := coverageOf(tc.value)
		m := metric(r, "range_m")
		if m == nil || m.Value != tc.want || m.Unit != "m" || m.Raw != tc.value {
			t.Errorf("%q: got %+v, want %v m", tc.value, m, tc.want)
		}
		if metric(r, "coverage_m2") != nil || metric(r, "coverage_sqft") != nil {
			t.Errorf("%q: a range was also read as an area", tc.value)
		}
	}
}

func TestCoverageThatCannotBeReadIsReportedNotGuessed(t *testing.T) {
	for _, value := range []string{"", "wide", "0 m²", "0 m (0 ft)", "Up to the horizon"} {
		r := coverageOf(value)
		for _, name := range []string{"coverage_m2", "coverage_sqft", "range_m"} {
			if metric(r, name) != nil {
				t.Errorf("%q gave a %s", value, name)
			}
		}
		if value != "" && len(r.Issues) == 0 {
			t.Errorf("%q gave no issue", value)
		}
	}
}

func TestRealCoverage(t *testing.T) {
	for _, tc := range []struct {
		slug     string
		m2, sqft float64
		reach    float64
	}{
		{"u7-pro", 140, 1500, 0},
		{"u7-pro-max", 160, 1750, 0},
		{"u7-outdoor", 465, 5000, 0},
		{"e7", 185, 2000, 0},
		{"udr7", 160, 1750, 0},
		{"ucg-industrial", 115, 1250, 0},
		{"ubb-xg", 0, 0, 500},
	} {
		r := derived(t, tc.slug)
		if tc.reach > 0 {
			if m := metric(r, "range_m"); m == nil || m.Value != tc.reach {
				t.Errorf("%s: range = %+v, want %v", tc.slug, m, tc.reach)
			}
			continue
		}
		m2, sqft := metric(r, "coverage_m2"), metric(r, "coverage_sqft")
		if m2 == nil || sqft == nil || m2.Value != tc.m2 || sqft.Value != tc.sqft {
			t.Errorf("%s: coverage = %+v / %+v, want %v m² / %v ft²", tc.slug, m2, sqft, tc.m2, tc.sqft)
		}
	}
	// Devices with no coverage figure have none.
	if r := derived(t, "usw-ultra"); metric(r, "coverage_m2") != nil || metric(r, "range_m") != nil {
		t.Error("a switch has coverage")
	}
}

func TestNVRCameraCapacity(t *testing.T) {
	for _, tc := range []struct {
		name, value string
		hd, k2, k4  float64
	}{
		{"a count per class", "(60) HD\n(30) 2K\n(18) 4K", 60, 30, 18},
		{"only the first configuration of two", "With built-in HDMI Viewport disabled:\n(60) HD \n(50) 2K \n(30) 4K\n\nWith built-in HDMI Viewport in use:\n(40) HD\n(30) 2K\n(20) 4K", 60, 50, 30},
		{"a class left out is left out", "(15) HD\n(6) 4K", 15, 0, 6},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := &builder{}
			b.text("Overview", "Managed Cameras", tc.value)
			r := b.derive()
			for name, want := range map[string]float64{"nvr_cameras_hd": tc.hd, "nvr_cameras_2k": tc.k2, "nvr_cameras_4k": tc.k4} {
				m := metric(r, name)
				if want == 0 {
					if m != nil {
						t.Errorf("%s = %+v, want none", name, m)
					}
				} else if m == nil || m.Value != want {
					t.Errorf("%s = %+v, want %v", name, m, want)
				}
			}
			if len(r.Issues) != 0 {
				t.Errorf("issues %+v", r.Issues)
			}
		})
	}
}

func TestCameraResolution(t *testing.T) {
	for _, tc := range []struct {
		name string
		res  []string // the Resolution entries, in the order of the sections
		want float64
	}{
		{"pixel dimensions are preferred", []string{"4K", "8MP 3840 x 2160 (16:9)"}, 8},
		{"a 4 MP 2K camera", []string{"2K", "4MP 2688 x 1512 (16:9)"}, 4},
		{"a multi-sensor camera is read per sensor", []string{"16 MP", "(2) 8MP 3840 x 2160 (16:9)"}, 8},
		{"the larger of main and package cameras", []string{"FHD", "Main camera: 2MP 1600 x 1200 (4:3)\nPackage camera: 2MP 1600 x 1200 (4:3)"}, 2},
		{"the headline when there are no dimensions", []string{"4K"}, 8.3},
		{"megapixels as the headline", []string{"5MP"}, 5},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := &builder{}
			for i, v := range tc.res {
				if i == 0 {
					b.text("Overview", "Resolution", v)
				} else {
					b.group("Performance", "Video", "Resolution", v)
				}
			}
			m := metric(b.derive(), "camera_megapixels")
			if m == nil || m.Value != tc.want {
				t.Errorf("camera_megapixels = %+v, want %v", m, tc.want)
			}
		})
	}
	if m := metric((&builder{}).derive(), "camera_megapixels"); m != nil {
		t.Errorf("a product with no resolution has %+v", m)
	}
}

func appsOf(r Result) (apps []string) {
	for _, name := range []string{"network", "protect", "access", "talk"} {
		if m := metric(r, "app_"+name); m != nil && m.Value == 1 {
			apps = append(apps, name)
		}
	}
	return apps
}

func TestApplicationsAGatewayOrConsoleRuns(t *testing.T) {
	b := &builder{}
	g := b.add("Overview", "", "UniFi Application Suite", unistore.SpecGroup, "", "")
	for _, a := range []string{"Network", "Protect", "Talk", "Connect"} {
		b.add("Overview", g, a, unistore.SpecFlag, "true", "")
	}
	b.add("Overview", g, "Access", unistore.SpecFlag, "false", "")
	if got := appsOf(b.derive()); !jsonEqual(got, []string{"network", "protect", "talk"}) {
		t.Errorf("apps = %v", got)
	}
}

func TestApplicationsAnNVRNamesInText(t *testing.T) {
	b := &builder{}
	b.text("Overview", "Managed Cameras", "(60) HD / (30) 2K / (18) 4K")
	b.text("Overview", "Management Application", "UniFi Protect /  UniFi Access /  UniFi Connect")
	if got := appsOf(b.derive()); !jsonEqual(got, []string{"protect", "access"}) {
		t.Errorf("apps = %v", got)
	}
}

func TestApplicationsAManagedDeviceRunsNone(t *testing.T) {
	// A door hub, a camera and a phone name the application that manages them; they don't run it.
	b := &builder{}
	b.text("Software", "Management Application", "Access")
	if got := appsOf(b.derive()); len(got) != 0 {
		t.Errorf("a hub's apps = %v", got)
	}
	c := &builder{}
	c.text("Overview", "UniFi Application Suite", "Protect / Access")
	if got := appsOf(c.derive()); len(got) != 0 {
		t.Errorf("a camera's apps = %v", got)
	}
}

func TestRealApplications(t *testing.T) {
	for slug, want := range map[string][]string{
		"ucg-fiber":            {"network", "protect", "talk"},
		"udr7":                 {"network", "protect", "talk"},
		"cloud-key-enterprise": {"network"},
		"unvr-g2":              {"protect", "access"},
		"uvc-g6-entry":         nil,
		"usw-flex":             nil,
	} {
		if got := appsOf(derived(t, slug)); !jsonEqual(got, want) && !(len(got) == 0 && len(want) == 0) {
			t.Errorf("%s apps = %v, want %v", slug, got, want)
		}
	}
}

func TestManagedCounts(t *testing.T) {
	for _, tc := range []struct {
		label, value string
		want         float64
		atLeast      bool
	}{
		{"Managed UniFi Devices", "1,000", 1000, false},
		{"Managed UniFi Devices", "100+", 100, true},
		{"Managed UniFi Devices", "2,250+", 2250, true},
		{"Managed Access Hubs", "150", 150, false},
	} {
		b := &builder{}
		b.text("Overview", tc.label, tc.value)
		name := map[string]string{"Managed UniFi Devices": "managed_devices", "Managed Access Hubs": "managed_access_hubs"}[tc.label]
		m := metric(b.derive(), name)
		if m == nil || m.Value != tc.want || m.AtLeast != tc.atLeast {
			t.Errorf("%s %q = %+v, want %v atLeast=%v", tc.label, tc.value, m, tc.want, tc.atLeast)
		}
	}
	b := &builder{}
	b.text("Overview", "Managed UniFi Devices", "lots")
	r := b.derive()
	if metric(r, "managed_devices") != nil || len(r.Issues) != 1 {
		t.Errorf("unreadable count: metric %+v issues %+v", metric(r, "managed_devices"), r.Issues)
	}
}

func TestRealManagedCounts(t *testing.T) {
	if m := metric(derived(t, "cloud-key-enterprise"), "managed_devices"); m == nil || m.Value != 1000 || m.AtLeast {
		t.Errorf("cloud key managed devices = %+v", m)
	}
	r := derived(t, "ucg-fiber")
	if m := metric(r, "managed_devices"); m == nil || m.Value != 50 || !m.AtLeast {
		t.Errorf("ucg-fiber managed devices = %+v", m)
	}
	if m := metric(r, "managed_access_hubs"); m == nil || m.Value != 50 {
		t.Errorf("ucg-fiber access hubs = %+v", m)
	}
}
