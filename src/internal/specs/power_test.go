package specs

import (
	"reflect"
	"testing"
)

func powerOf(value string) []PowerSource {
	b := &builder{}
	b.text("Hardware", "Power Method", value)
	return b.derive().Power
}

func kinds(ps []PowerSource) []string {
	out := []string{}
	for _, p := range ps {
		k := p.Kind
		if p.PoEClass != "" {
			k += ":" + p.PoEClass
		}
		out = append(out, k)
	}
	return out
}

// The values are the ones the store publishes (a sample of every shape seen in production).
func TestPowerMethodKinds(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  []string
	}{
		{"PoE", []string{"poe:PoE"}},
		{"PoE+", []string{"poe:PoE+"}},
		{"PoE++", []string{"poe:PoE++"}},
		{"PoE+++", []string{"poe:PoE+++"}},
		{"PoE\nUL 294 Power-limited Class 2 PSU\nUL 60950-1/62368-1 LPS/PS2 PSU", []string{"poe:PoE"}},
		{"PoE++\nPassive PoE", []string{"poe:PoE++", "passive_poe"}},
		{"PoE \nPassive PoE, 24V", []string{"poe:PoE", "passive_poe"}},
		{"PoE/PoE+ 2-pairs (Pins 1, 2+; 3, 6-)", []string{"poe:PoE"}},
		{"PoE++/PoE+++\n12V SLA battery", []string{"poe:PoE++", "battery"}},
		{"PoE, 48V DC, 0.27A Max.", []string{"poe:PoE"}},
		{"PoE\nPoE+ (Required for PoE output)", []string{"poe:PoE", "poe:PoE+"}},
		{"PoE+\nPoE++ (Required for PoE output)", []string{"poe:PoE+", "poe:PoE++"}},
		{"PoE\nPoE+ input required for PoE output (12.95W)\nPoE++ input required for PoE+ output (25.5W)", []string{"poe:PoE", "poe:PoE+", "poe:PoE++"}},
		{"Universal input, 100–240V AC, 50/60 Hz", []string{"ac"}},
		{"Universal AC input, 100–240V AC, 1.5A Max, 50/60 Hz", []string{"ac"}},
		{"(1) Universal input, 100–240V AC, 50/60 Hz\n(1) USP RPS DC input", []string{"ac", "rps"}},
		{"(1) Universal AC input, 100–240V AC, 3A Max., 50/60 Hz\n(1) USP-RPS DC input, 11.5V DC, 13.91A", []string{"ac", "rps"}},
		{"(2) AC input, 100–240V, 7A Max., 50/60Hz (Redundant, hot-swappable)", []string{"ac"}},
		{"(1) TN system, 120V AC, 12A Max., 50/60 Hz", []string{"ac"}},
		{"16–24V AC, 1.25A Max., 50/60 Hz\nUSB-C power cable, 5V DC, 2A", []string{"ac", "usb"}},
		{"100–125V AC, 30A Max. (Derated to 24A), 50/60 Hz (NEMA L5-30P)", []string{"ac"}},
		{"AC", []string{"ac"}},
		{"AC Adapter", []string{"ac"}},
		{"AC/DC Adapter (included)", []string{"ac"}},
		{"(1) AC/DC adapter (Excluded)\n(1) PoE++", []string{"ac", "poe:PoE++"}},
		{"(1) AC/DC adapter, 12V DC (Included)\n(1) PoE", []string{"ac", "poe:PoE"}},
		{"DC jack (54V DC/1.1A)", []string{"dc"}},
		{"12V DC", []string{"dc"}},
		{"DC 12V", []string{"dc"}},
		{"12/24V DC", []string{"dc"}},
		{"5V/12V input", []string{"dc"}},
		{"(2) 2-pin DC inputs with terminal block", []string{"dc"}},
		{"(1) DC Input (350W PSU)\n(1) ATX power (48V)", []string{"dc"}},
		{"USB type C (5V DC/3A)", []string{"usb"}},
		{"USB-C", []string{"usb"}},
		{"Magnetic Type-C", []string{"usb"}},
		{"(1) USB Type-C, 5V DC, 1A\n(1) PoE", []string{"usb", "poe:PoE"}},
		{"USB-C 5V DC, 1A\nPoE 48V DC, 0.35A", []string{"usb", "poe:PoE"}},
		{"5V, 2A USB power adapter (Included)\nInstant PoE to USB adapter (Optional)", []string{"usb"}},
		{"5V, 2A USB power adapter (Included)\nPoE to USB-C adapter (Not included)", []string{"usb"}},
		{"Lithium battery CR123A", []string{"battery"}},
		{"(1) Lithium battery CR2450", []string{"battery"}},
		{"1000mAh Li-ion battery", []string{"battery"}},
		{"(4) CR123A batteries\n12–24V DC", []string{"battery", "dc"}},
		{"Universal input, 100–240V AC, Max. 4.4A, 50/60 Hz  \n32–48V DC Lead Acid Battery, Max. 7.5A @32V", []string{"ac", "battery"}},
		{"US: \n(1) Universal AC input, 125V AC, 2.7A Max., 60 Hz\n(1) RPS DC input, 11.5V DC, 2.87A\n\nWorldwide:\n(1) Universal AC input, 200-240V AC, 1.7A Max., 50/60 Hz\n(1) RPS DC input, 11.5V DC, 2.87A", []string{"ac", "rps"}},
		{"Theta proprietary", []string{"other"}},
		{"Via camera AI Pro", []string{"other"}},
		{"Accessory connector", []string{"other"}},
		{"Camera G6 Pro Bullet, AI Pro", []string{"other"}},
	} {
		if got := kinds(powerOf(tc.value)); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%q: got %v, want %v", tc.value, got, tc.want)
		}
	}
}

func TestPowerMethodKeepsTheLineItCameFrom(t *testing.T) {
	got := powerOf("PoE++\nPassive PoE")
	if len(got) != 2 || got[0].Detail != "PoE++" || got[1].Detail != "Passive PoE" {
		t.Errorf("%+v", got)
	}
}

func TestPowerMethodListsEachSourceOnce(t *testing.T) {
	if got := kinds(powerOf("PoE+\nPoE+\nUniversal AC input\nAC adapter")); !reflect.DeepEqual(got, []string{"poe:PoE+", "ac"}) {
		t.Errorf("%v", got)
	}
}

func TestPowerMethodIsEmptyNotNilWhenUnstated(t *testing.T) {
	b := &builder{}
	b.text("Hardware", "Weight", "1 kg")
	if p := b.derive().Power; p == nil || len(p) != 0 {
		t.Errorf("power = %#v", p)
	}
	if got := powerOf("UL 294 Power-limited Class 2 PSU"); len(got) != 0 {
		t.Errorf("a certification note alone is not a source: %+v", got)
	}
}

func TestPowerMethodIgnoresTheGridOverview(t *testing.T) {
	b := &builder{}
	b.grid("Power Method", "PoE++")
	if p := b.derive().Power; len(p) != 0 {
		t.Errorf("the grid repeats the standard sections and isn't read: %+v", p)
	}
}

func TestRealPowerMethods(t *testing.T) {
	for slug, want := range map[string][]string{
		"usw-pro-max-24-poe":  {"ac", "rps"},
		"usw-ultra":           {"ac", "poe:PoE++"},
		"usw-flex-mini":       {"usb", "poe:PoE"},
		"usw-flex-2-5g-8-poe": {"ac", "poe:PoE+++"},
		"ubb-xg":              {"poe:PoE++", "passive_poe"},
		"umr-us":              {"poe:PoE+", "usb", "dc"},
		"u7-pro":              {"poe:PoE+"},
		"ucg-fiber":           {"dc", "ac"}, // the DC jack is fed by an adapter, whose mains range is listed separately
		"utr":                 {"usb"},
		"toolless-mini-rack":  {}, // states no power method at all
	} {
		if _, ok := fixtures(t)[slug]; !ok {
			t.Errorf("no fixture for %s", slug)
			continue
		}
		if got := kinds(derived(t, slug).Power); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: got %v, want %v", slug, got, want)
		}
	}
}

// Every captured product's power sources are well formed, and the captured
// "Power Method" values never fall through to "other" except for the accessories
// that really are powered by something else.
func TestEveryRealPowerMethodIsRecognised(t *testing.T) {
	seen := 0
	for slug := range fixtures(t) {
		for _, p := range derived(t, slug).Power {
			seen++
			if p.Detail == "" || p.Kind == "" || (p.Kind == PowerPoE) != (p.PoEClass != "") {
				t.Errorf("%s: malformed %+v", slug, p)
			}
			if p.Kind == PowerOther {
				t.Logf("%s: unclassified %q", slug, p.Detail)
			}
		}
	}
	if seen == 0 {
		t.Fatal("no power sources found in any captured product")
	}
}
