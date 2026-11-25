// Package category knows what the store's category ids mean: which product type
// each belongs to, and which type wins when the store lists one product in
// categories of several types.
package category

import "strings"

// Type labels, as the UI filters by them.
const (
	Gateways     = "Gateways"
	Switches     = "Switches"
	WiFi         = "WiFi"
	Cameras      = "Cameras & Security"
	DoorAccess   = "Door Access"
	Internet     = "Internet"
	Storage      = "Storage"
	VoIP         = "VoIP"
	PremiumIoT   = "Premium IoT"
	Integrations = "Integrations"
	Accessories  = "Accessories"
)

// priority lists the types from the one that wins to the one that loses. The
// store lists some products in categories of more than one type (every NVR is
// under both Cameras & Security and Door Access; the UniFi Express 7 under both
// Gateways and WiFi; camera mounts under both Cameras & Security and
// Accessories), and a product has only one type, so the earliest type here wins.
// Specific types come before the catch-alls (Integrations, then Accessories).
var priority = []string{
	Gateways,
	Switches,
	WiFi,
	Cameras,
	DoorAccess,
	Internet,
	Storage,
	VoIP,
	PremiumIoT,
	Integrations,
	Accessories,
}

// rules map the prefix of a store category id (e.g. "switching-enterprise",
// "wifi-outdoor") to its product type. First match wins.
var rules = []struct{ prefix, label string }{
	{"cloud-gateways", Gateways},
	{"all-cloud-gateways", Gateways},
	{"switching", Switches},
	{"all-switching", Switches},
	{"wifi", WiFi},
	{"all-wifi", WiFi},
	{"physical-security", Cameras},
	{"all-physical-security", Cameras},
	{"door-access", DoorAccess},
	{"all-door-access", DoorAccess},
	{"internet-solutions", Internet},
	{"network-storage", Storage},
	{"managed-voip", VoIP},
	{"premium-iot", PremiumIoT},
	{"integrations", Integrations},
	{"all-integrations", Integrations},
	{"accessories", Accessories},
}

// Type names the product type of a store category id, or "" when it is unknown.
func Type(id string) string {
	for _, r := range rules {
		if strings.HasPrefix(id, r.prefix) {
			return r.label
		}
	}
	return ""
}

// rank is the position of a category's type in priority; lower wins. An unknown
// category ranks last.
func rank(id string) int {
	t := Type(id)
	for i, p := range priority {
		if p == t {
			return i
		}
	}
	return len(priority)
}

// Beats reports whether category a should replace category b as a product's
// category. A product listed in two categories of the same type is not a
// conflict, so equal rank counts as a win: the latest observation is kept.
func Beats(a, b string) bool {
	if b == "" {
		return true
	}
	if a == "" {
		return false
	}
	return rank(a) <= rank(b)
}
