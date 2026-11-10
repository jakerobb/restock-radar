package api

import "strings"

// typeRules map the prefix of a store category id (e.g. "switching-enterprise",
// "wifi-outdoor") to the product type the UI filters by. First match wins.
var typeRules = []struct{ prefix, label string }{
	{"cloud-gateways", "Gateways"},
	{"all-cloud-gateways", "Gateways"},
	{"switching", "Switches"},
	{"all-switching", "Switches"},
	{"wifi", "WiFi"},
	{"all-wifi", "WiFi"},
	{"physical-security", "Cameras & Security"},
	{"all-physical-security", "Cameras & Security"},
	{"door-access", "Door Access"},
	{"all-door-access", "Door Access"},
	{"internet-solutions", "Internet"},
	{"network-storage", "Storage"},
	{"integrations", "Integrations"},
	{"all-integrations", "Integrations"},
	{"accessories", "Accessories"},
}

// productType names the type of a product given its store category id, or ""
// when the category is unknown (not yet polled since categories were recorded).
func productType(category string) string {
	for _, r := range typeRules {
		if strings.HasPrefix(category, r.prefix) {
			return r.label
		}
	}
	return ""
}
