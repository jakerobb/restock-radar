package category

import "testing"

func TestType(t *testing.T) {
	cases := map[string]string{
		"cloud-gateways-compact":        Gateways,
		"switching-professional-max-xg": Switches,
		"wifi-flagship":                 WiFi,
		"physical-security-ptz":         Cameras,
		"door-access-readers":           DoorAccess,
		"door-access-nvrs":              DoorAccess,
		"internet-solutions":            Internet,
		"network-storage":               Storage,
		"managed-voip":                  VoIP,
		"premium-iot":                   PremiumIoT,
		"integrations-power-tech":       Integrations,
		"accessories-storage":           Accessories,
		"":                              "",
		"something-new":                 "",
	}
	for in, want := range cases {
		if got := Type(in); got != want {
			t.Errorf("Type(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestPriorityCoversEveryType guards against a new type that no rule can
// outrank: every label a rule yields must have a place in priority.
func TestPriorityCoversEveryType(t *testing.T) {
	for _, r := range rules {
		if rank(r.prefix) == len(priority) {
			t.Errorf("type %q (rule %q) is missing from priority", r.label, r.prefix)
		}
	}
}

// TestBeats pins down the store's real overlaps (checked against the live US
// store): the category that should win for each, whichever order the pages are read in.
func TestBeats(t *testing.T) {
	cases := []struct{ winner, loser string }{
		{"physical-security-nvr", "door-access-nvrs"},              // every NVR
		{"cloud-gateways-wifi-integrated", "wifi-whole-home-wifi"}, // UniFi Express 7
		{"switching-professional", "integrations-power-tech"},      // UPS PoE Switch Mission Critical
		{"switching-professional", "accessories-poe-power"},        // same
		{"cloud-gateways-compact", "physical-security-nvr"},        // Gateways over Cameras & Security
		{"physical-security-accessories", "accessories-camera"},    // camera mounts
		{"door-access-accessories", "accessories-door-access"},     // lock hardware
		{"integrations-power-tech", "accessories-poe-power"},       // UPSs and PDUs
		{"physical-security-nvr", "accessories-advanced-hosting"},  // CloudKey+ SSD
		{"managed-voip", "integrations-power-tech"},                // specific over Integrations
		{"physical-security-dome-turret", "door-access-readers"},   // Cameras & Security over Door Access
		{"door-access-readers", "something-new"},                   // a known category over an unknown one
	}
	for _, c := range cases {
		if !Beats(c.winner, c.loser) {
			t.Errorf("%q should beat %q", c.winner, c.loser)
		}
		if Beats(c.loser, c.winner) {
			t.Errorf("%q should not beat %q", c.loser, c.winner)
		}
	}
}

func TestBeatsSameTypeKeepsTheLatest(t *testing.T) {
	// Access Ultra is under both door-access-hub and door-access-readers: not a
	// conflict, so whichever page was read last stands, as it did before.
	if !Beats("door-access-readers", "door-access-hub") || !Beats("door-access-hub", "door-access-readers") {
		t.Error("categories of one type should replace each other")
	}
}

func TestBeatsWithNoCategory(t *testing.T) {
	if !Beats("wifi-outdoor", "") {
		t.Error("any category should beat none")
	}
	if Beats("", "wifi-outdoor") {
		t.Error("an empty observation must not replace a stored category")
	}
}
