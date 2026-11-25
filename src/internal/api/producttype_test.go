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
		"managed-voip":                  "VoIP",
		"premium-iot":                   "Premium IoT",
		"integrations-power-tech":       "Integrations",
		"accessories-storage":           "Accessories",
		"":                              "",
		"something-new":                 "",
	}
	for in, want := range cases {
		if got := productType(in, "some-product"); got != want {
			t.Errorf("productType(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestProductTypeSlugOverridesTheCategory(t *testing.T) {
	const category = "switching-utility"
	if got := productType(category, "usw-ultra"); got != "Switches" {
		t.Errorf("an ordinary switch in %s is %q, want Switches", category, got)
	}
	for _, slug := range []string{"usw-flexutility", "uacc-flex-utility-pro"} {
		if got := productType(category, slug); got != "Accessories" {
			t.Errorf("productType(%q, %q) = %q, want Accessories", category, slug, got)
		}
	}
	// Even before a poll has recorded a category.
	if got := productType("", "usw-flexutility"); got != "Accessories" {
		t.Errorf("with no category: %q, want Accessories", got)
	}
}
