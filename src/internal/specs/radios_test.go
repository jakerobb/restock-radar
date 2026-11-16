package specs

import (
	"testing"
)

func radiosOf(groups map[string][]string) Result {
	b := &builder{}
	for _, g := range []string{"Antenna Gain", "Max. TX Power", "MIMO", "Max. Data Rate"} {
		if kv, ok := groups[g]; ok {
			b.group("Performance", g, kv...)
		}
	}
	return b.derive()
}

func radio(r Result, band string) *Radio {
	for i := range r.Radios {
		if r.Radios[i].Band == band {
			return &r.Radios[i]
		}
	}
	return nil
}

func TestRadiosFromTheFourGroups(t *testing.T) {
	r := radiosOf(map[string][]string{
		"Antenna Gain":   {"6 GHz", "5.8 dBi", "5 GHz", "6 dBi", "2.4 GHz", "4 dBi"},
		"Max. TX Power":  {"6 GHz", "23 dBm", "5 GHz", "26 dBm", "2.4 GHz", "23 dBm"},
		"MIMO":           {"6 GHz", "2 x 2 (DL/UL MU-MIMO)", "5 GHz", "2 x 2 (DL/UL MU-MIMO)", "2.4 GHz", "2 x 2 (DL/UL MU-MIMO)"},
		"Max. Data Rate": {"6 GHz", "5.8 Gbps (BW320)", "5 GHz", "4.3 Gbps (BW240)", "2.4 GHz", "688 Mbps (BW40)"},
	})
	if !r.Known.Radios || len(r.Radios) != 3 {
		t.Fatalf("radios = %+v", r.Radios)
	}
	// Ordered by band, whatever order the groups list them in.
	if r.Radios[0].Band != "2.4 GHz" || r.Radios[1].Band != "5 GHz" || r.Radios[2].Band != "6 GHz" {
		t.Errorf("order = %v %v %v", r.Radios[0].Band, r.Radios[1].Band, r.Radios[2].Band)
	}
	six := radio(r, "6 GHz")
	if six.Tech != "wifi" || *six.AntennaGainDBi != 5.8 || *six.TxPowerDBm != 23 || *six.Streams != 2 || *six.MaxRateMbps != 5800 {
		t.Errorf("6 GHz = %+v", six)
	}
	if six.Multi || six.TxPowerExtendedDBm != nil {
		t.Errorf("6 GHz = %+v", six)
	}
	if two := radio(r, "2.4 GHz"); *two.MaxRateMbps != 688 || two.AntennaGainRaw != "4 dBi" || two.MaxRateRaw != "688 Mbps (BW40)" {
		t.Errorf("2.4 GHz = %+v", two)
	}
}

func TestRadiosAreTheUnionOfTheBandsAcrossGroups(t *testing.T) {
	// Gain for two bands, power for one, nothing else: each radio has what the
	// specification gives it and nothing it doesn't.
	r := radiosOf(map[string][]string{
		"Antenna Gain":  {"5 GHz", "14 dBi", "2.4 GHz", "2 dBi (BLE)"},
		"Max. TX Power": {"5 GHz", "23 dBm"},
	})
	if len(r.Radios) != 2 {
		t.Fatalf("radios = %+v", r.Radios)
	}
	five, two := radio(r, "5 GHz"), radio(r, "2.4 GHz")
	if *five.AntennaGainDBi != 14 || *five.TxPowerDBm != 23 || five.Streams != nil || five.MaxRateMbps != nil {
		t.Errorf("5 GHz = %+v", five)
	}
	if *two.AntennaGainDBi != 2 || two.TxPowerDBm != nil {
		t.Errorf("2.4 GHz = %+v", two)
	}
}

func TestRadioTechnologies(t *testing.T) {
	r := radiosOf(map[string][]string{
		"Antenna Gain": {"60 GHz", "21 dBi", "Bluetooth", "3 dBi", "SuperLink", "2 dBi", "5 GHz", "14 dBi"},
	})
	want := map[string]string{"5 GHz": "wifi", "60 GHz": "wigig", "Bluetooth": "bluetooth", "SuperLink": "superlink"}
	if len(r.Radios) != 4 {
		t.Fatalf("radios = %+v", r.Radios)
	}
	for _, rd := range r.Radios {
		if rd.Tech != want[rd.Band] {
			t.Errorf("%s tech = %q", rd.Band, rd.Tech)
		}
	}
	// Ordered: WiFi bands, then 60 GHz, then the others.
	if r.Radios[0].Band != "5 GHz" || r.Radios[1].Band != "60 GHz" || r.Radios[2].Band != "Bluetooth" || r.Radios[3].Band != "SuperLink" {
		t.Errorf("order = %+v", r.Radios)
	}
}

func TestRadioBandLabelsAreNormalized(t *testing.T) {
	r := radiosOf(map[string][]string{"Antenna Gain": {"2.4GHz", "4 dBi", "5 ghz", "6 dBi", " 6 GHz ", "5 dBi", "BLE", "3 dBi"}})
	got := map[string]bool{}
	for _, rd := range r.Radios {
		got[rd.Band] = true
	}
	for _, b := range []string{"2.4 GHz", "5 GHz", "6 GHz", "Bluetooth"} {
		if !got[b] {
			t.Errorf("missing %s in %+v", b, r.Radios)
		}
	}
}

func TestRadioMultipleAntennasKeepTheLargestFigure(t *testing.T) {
	r := radiosOf(map[string][]string{
		"Antenna Gain": {"5 GHz", "Directional internal: 12 dBi, 60° x 60°\nExternal omni: 8 dBi, 360° x 40°", "2.4 GHz", "Internal: 4dBi\nExternal omni: 3dBi"},
	})
	five, two := radio(r, "5 GHz"), radio(r, "2.4 GHz")
	if *five.AntennaGainDBi != 12 || !five.Multi {
		t.Errorf("5 GHz = %+v", five)
	}
	if *two.AntennaGainDBi != 4 || !two.Multi {
		t.Errorf("2.4 GHz (no space before dBi) = %+v", two)
	}
}

func TestRadioDegreesAreNotGain(t *testing.T) {
	r := radiosOf(map[string][]string{"Antenna Gain": {"5 GHz", "Directional internal: 9 dBi, 90° x 90°"}})
	if g := *radio(r, "5 GHz").AntennaGainDBi; g != 9 {
		t.Errorf("gain = %v", g)
	}
}

func TestRadioTxPowerIgnoresEIRPAndReadsEachBand(t *testing.T) {
	r := radiosOf(map[string][]string{
		"Max. TX Power": {
			"6 GHz", "Low Band: 24 dBm\n(30 dBm EIRP)\n\nHigh Band: 27 dBm\n(36 dBm EIRP)",
			"5 GHz", "23 dBm\n(30 dBm EIRP)",
			"2.4 GHz", "20 dBm / 17 dBm",
		},
	})
	if v := *radio(r, "6 GHz").TxPowerDBm; v != 27 {
		t.Errorf("6 GHz tx = %v, want 27 (the EIRP figures are not conducted power)", v)
	}
	if !radio(r, "6 GHz").Multi {
		t.Error("6 GHz has Low/High Band")
	}
	if v := *radio(r, "5 GHz").TxPowerDBm; v != 23 {
		t.Errorf("5 GHz tx = %v", v)
	}
	if v := *radio(r, "2.4 GHz").TxPowerDBm; v != 20 {
		t.Errorf("2.4 GHz tx = %v", v)
	}
}

func TestRadioTxPowerFootnote(t *testing.T) {
	b := &builder{}
	b.groupNoted("Performance", "Max. TX Power", []string{"6 GHz", "23 dBm", "5 GHz", "26 dBm"}, 0,
		"30 dBm with 6 GHz Extended Range mode. Available in FCC/IC region only")
	r := b.derive()
	six, five := radio(r, "6 GHz"), radio(r, "5 GHz")
	if *six.TxPowerDBm != 23 || six.TxPowerExtendedDBm == nil || *six.TxPowerExtendedDBm != 30 {
		t.Errorf("6 GHz = %+v", six)
	}
	if six.TxPowerNote == "" {
		t.Error("the footnote should be kept")
	}
	if five.TxPowerExtendedDBm != nil || five.TxPowerNote != "" {
		t.Errorf("5 GHz = %+v", five)
	}
}

func TestRadioTxPowerFootnoteWithoutANumber(t *testing.T) {
	b := &builder{}
	b.groupNoted("Performance", "Max. TX Power", []string{"6 GHz", "30 dBm"}, 0, "With 6 GHz Extended Range mode. Available in FCC/IC region only.")
	six := radio(b.derive(), "6 GHz")
	if *six.TxPowerDBm != 30 || six.TxPowerExtendedDBm != nil || six.TxPowerNote == "" {
		t.Errorf("6 GHz = %+v", six)
	}
}

func TestRadioStreams(t *testing.T) {
	r := radiosOf(map[string][]string{"MIMO": {
		"5 GHz", "4 x 4 (DL/UL MU-MIMO)", "2.4 GHz", "2 x 2", "6 GHz", "Low Band: 2 x 2 (DL MU-MIMO)\nHigh Band: 4 x 4 (DL MU-MIMO)", "60 GHz", "1x1",
	}})
	for band, want := range map[string]int{"5 GHz": 4, "2.4 GHz": 2, "6 GHz": 4, "60 GHz": 1} {
		if s := radio(r, band).Streams; s == nil || *s != want {
			t.Errorf("%s streams = %v, want %d", band, s, want)
		}
	}
}

func TestRadioMaxRateUnits(t *testing.T) {
	r := radiosOf(map[string][]string{"Max. Data Rate": {
		"5 GHz", "8.6 Gbps (BW160)", "2.4 GHz", "574 Mbps (BW40)", "6 GHz", "Low Band: 2.4 Gbps (BW160)\nHigh Band: 5.7 Gbps (BW320)", "60 GHz", "6 Gbps",
	}})
	for band, want := range map[string]float64{"5 GHz": 8600, "2.4 GHz": 574, "6 GHz": 5700, "60 GHz": 6000} {
		if s := radio(r, band).MaxRateMbps; s == nil || *s != want {
			t.Errorf("%s rate = %v, want %v", band, s, want)
		}
	}
}

func TestRadiosReportWhatTheyCannotRead(t *testing.T) {
	r := radiosOf(map[string][]string{
		"Antenna Gain":   {"5 GHz", "very high", "3 GHz", "4 dBi"},
		"Max. TX Power":  {"5 GHz", "lots"},
		"MIMO":           {"5 GHz", "many"},
		"Max. Data Rate": {"5 GHz", "fast"},
	})
	if len(r.Issues) != 5 {
		t.Errorf("issues = %+v", r.Issues)
	}
	// The band is still there, so we know the device has it.
	if rd := radio(r, "5 GHz"); rd == nil || rd.AntennaGainDBi != nil || rd.TxPowerDBm != nil {
		t.Errorf("5 GHz = %+v", rd)
	}
	if radio(r, "3 GHz") != nil {
		t.Error("an unknown band is not a radio")
	}
}

func TestRadiosOnlyFromStandardSections(t *testing.T) {
	b := &builder{}
	b.grid("GHz", "6 GHz").grid("Radio/Antenna", "5 GHz Backup")
	if r := b.derive(); len(r.Radios) != 0 || r.Known.Radios {
		t.Errorf("radios = %+v", r.Radios)
	}
}

func TestRadiosNoneKnown(t *testing.T) {
	b := &builder{}
	b.text("Overview", "Weight", "1 kg")
	if r := b.derive(); r.Known.Radios || len(r.Radios) != 0 {
		t.Errorf("radios = %+v", r.Radios)
	}
}

func TestWiFiGeneration(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want int
		ok   bool
	}{
		{"WiFi 7", 7, true}, {"WiFi 6", 6, true}, {"WiFi 6E", 6, true}, {"WiFi 5", 5, true}, {"WiFi 4", 4, true},
		{"WIFi 7", 7, true}, {"Wi-Fi 6", 6, true},
		{"802.11a/b/g/n/ac/ax/be (WiFi 6/6E, WiFi 7)", 7, true},
		{"802.11a/b/g/n/ac/ax/be (WiFi 6, WiFi 7)", 7, true},
		{"802.11 a/b/g/n/ac/ax", 6, true},
		{"802.11 a/b/g/n/ac", 5, true},
		{"802.11 a/b/g/n", 4, true},
		{"802.11a/b/g", 0, false},
		{"WiFi 2", 0, false},
		{"Bluetooth", 0, false},
		{"", 0, false},
	} {
		got, ok := wifiGeneration(tc.in)
		if got != tc.want || ok != tc.ok {
			t.Errorf("wifiGeneration(%q) = %d, %v; want %d, %v", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestWiFiGenerationMetric(t *testing.T) {
	for _, label := range []string{"WiFi Standard", "WiFi Standards"} {
		b := &builder{}
		b.text("Overview", label, "WiFi 7")
		if m := metric(b.derive(), "wifi_generation"); m == nil || m.Value != 7 || m.Raw != "WiFi 7" {
			t.Errorf("%s: metric = %+v", label, m)
		}
	}
	b := &builder{}
	b.text("Overview", "WiFi Standard", "something else")
	if r := b.derive(); metric(r, "wifi_generation") != nil || len(r.Issues) != 1 {
		t.Errorf("result = %+v", r)
	}
}
