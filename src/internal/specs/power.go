package specs

import (
	"regexp"
	"strings"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

// Kinds of power source.
const (
	PowerPoE        = "poe"
	PowerPassivePoE = "passive_poe"
	PowerAC         = "ac"
	PowerDC         = "dc"
	PowerUSB        = "usb"
	PowerBattery    = "battery"
	// PowerRPS is a redundant power supply input (UniFi's USP-RPS).
	PowerRPS = "rps"
	// PowerOther covers what isn't a supply in the ordinary sense: powered by an
	// accessory or another device ("Via camera AI Pro"), proprietary connectors.
	PowerOther = "other"
)

// PowerSource is one way a product can be powered, as its "Power Method" gives it.
type PowerSource struct {
	Kind string `json:"kind"`
	// PoEClass is the lowest PoE class that powers it ("PoE", "PoE+", ...), for Kind "poe".
	PoEClass string `json:"poe_class"`
	// Detail is the line of the specification it was read from.
	Detail string `json:"detail"`
}

var (
	// Certification notes listed among the power methods.
	powerNoiseRe = regexp.MustCompile(`^(?i:ul\s|ce\s|fcc\s)|^[A-Za-z ]{1,20}:$`)
	passiveRe    = regexp.MustCompile(`(?i)passive\s+poe`)
	poeToUSBRe   = regexp.MustCompile(`(?i)poe[\s-]*(?:to|-)[\s-]*usb`)
	batteryRe    = regexp.MustCompile(`(?i)batter|\bCR\d{3,4}\b|li-?ion|lithium|\bSLA\b`)
	rpsRe        = regexp.MustCompile(`\bRPS\b|USP-RPS`)
	usbRe        = regexp.MustCompile(`(?i)\busb\b|\bTYPE[\s-]*C\b`)
	acRe         = regexp.MustCompile(`\bAC\b`)
	dcRe         = regexp.MustCompile(`\bDC\b|\bVDC\b|\d\s*V\b`)
	// "PoE+ (Required for PoE output)": what follows names a different job for PoE.
	requiredForRe = regexp.MustCompile(`(?i)\(?\s*required for`)
)

// classifyPower says what kind of source a line of "Power Method" describes.
// ok is false for lines that aren't one (certifications, "US:" headings).
func classifyPower(line string) (kind, poeClass string, ok bool) {
	if powerNoiseRe.MatchString(line) {
		return "", "", false
	}
	switch {
	case passiveRe.MatchString(line):
		return PowerPassivePoE, "", true
	case poeToUSBRe.MatchString(line):
		return PowerUSB, "", true
	case batteryRe.MatchString(line):
		return PowerBattery, "", true
	case rpsRe.MatchString(line):
		return PowerRPS, "", true
	}
	if m := classRe.FindAllString(requiredForRe.Split(line, 2)[0], -1); len(m) > 0 {
		// "PoE/PoE+" takes either, so the lowest is what powers it.
		lowest := m[0]
		for _, c := range m[1:] {
			if poeRank(c) < poeRank(lowest) {
				lowest = c
			}
		}
		return PowerPoE, lowest, true
	}
	switch {
	case usbRe.MatchString(line):
		return PowerUSB, "", true
	case acRe.MatchString(line):
		return PowerAC, "", true
	case dcRe.MatchString(line):
		return PowerDC, "", true
	}
	return PowerOther, "", true
}

// derivePower reads "Power Method": one source per distinct kind (and PoE
// class), in the order the store lists them. An empty result means the
// specification doesn't say.
func derivePower(ix *index, r *Result) {
	for _, e := range ix.std {
		if e.Kind != unistore.SpecText || key(e.Label) != "power method" {
			continue
		}
		for _, line := range Lines(e.Value) {
			kind, class, ok := classifyPower(line)
			if !ok || len(r.Power) >= 8 {
				continue
			}
			dup := false
			for _, s := range r.Power {
				dup = dup || (s.Kind == kind && s.PoEClass == class)
			}
			if !dup {
				r.Power = append(r.Power, PowerSource{Kind: kind, PoEClass: class, Detail: strings.TrimSpace(line)})
			}
		}
	}
}
