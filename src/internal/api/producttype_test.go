package api

import "testing"

func TestProductType(t *testing.T) {
	cases := map[string]string{
		"cloud-gateways-compact":        "Gateways",
		"switching-professional-max-xg": "Switches",
		"wifi-flagship":                 "WiFi",
		"physical-security-ptz":         "Cameras & Security",
		"door-access-readers":           "Door Access",
		"internet-solutions":            "Internet",
		"network-storage":               "Storage",
		"integrations-power-tech":       "Integrations",
		"accessories-storage":           "Accessories",
		"":                              "",
		"something-new":                 "",
	}
	for in, want := range cases {
		if got := productType(in); got != want {
			t.Errorf("productType(%q) = %q, want %q", in, got, want)
		}
	}
}
