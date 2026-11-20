package specs

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

// injectorCategory is the store category that holds the PoE injectors ("PoE
// adapters"), with surge protectors, power modules and the like.
const injectorCategory = "accessories-poe-power"

// injectorWatts is what one port of each PoE class supplies, by the standards.
var injectorWatts = map[string]float64{"PoE": 15.4, "PoE+": 30, "PoE++": 60, "PoE+++": 90}

var (
	// "48V DC @ 0.32A", "54V DC at 1.12A", "PoE+: 48V@ 0.65A".
	outputRe = regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)\s*V(?:\s*DC)?\s*(?:@|at)\s*(\d+(?:\.\d+)?)\s*A\b`)
	// "UniFi 10G PoE+++ Adapter (90W)": the store's own name for the speed, which its specification doesn't give.
	titleSpeedRe = regexp.MustCompile(`(?i)\b(\d+(?:\.\d+)?)\s*G\b`)
)

// injectorClass is the PoE class an injector's output gives, by its power:
// 48 V at 0.32 A is 15 W (PoE), at 0.65 A 31 W (PoE+), 1.25 A 60 W (PoE++),
// and 54 V at 1.67 A 90 W (PoE+++).
func injectorClass(watts float64) string {
	switch {
	case watts >= 80:
		return "PoE+++"
	case watts >= 50:
		return "PoE++"
	case watts >= 25:
		return "PoE+"
	case watts >= 12:
		return "PoE"
	}
	return ""
}

// deriveInjector reads a PoE injector: a mains-powered box that takes data in on
// one port and gives data and PoE out on the other. The store gives it neither
// ports nor a PoE class, nor (for the faster ones) a speed: its "Gigabit LAN
// Port" flag is true even for the 10G models. So the class comes from the power
// the output is rated for, and the speed from the product's name, falling back
// to the flag.
//
// It is described the way a one-port PoE switch would be (a PoE port out, a
// budget of its own), plus the data port that has to be plugged into a switch.
func deriveInjector(ix *index, in Input, r *Result) {
	if in.Category != injectorCategory || len(r.Ports) > 0 {
		return
	}
	if _, ok := ix.scalar("Data In / PoE"); !ok {
		return
	}
	out, ok := ix.scalar("Output Voltage")
	if !ok {
		return
	}
	// The USB-C model lists its Type-C output too; only the PoE one counts here.
	var watts float64
	lines := Lines(out.Value)
	for _, pass := range []bool{true, false} {
		for _, line := range lines {
			if pass && !strings.Contains(strings.ToLower(line), "poe") {
				continue
			}
			m := outputRe.FindStringSubmatch(line)
			if m == nil {
				continue
			}
			v, _ := strconv.ParseFloat(m[1], 64)
			a, _ := strconv.ParseFloat(m[2], 64)
			watts = max(watts, v*a)
		}
		if watts > 0 {
			break
		}
	}
	class := injectorClass(watts)
	if class == "" {
		ix.issue("poe_injector", out, "no usable PoE output rating")
		return
	}

	speed := 0
	if m := titleSpeedRe.FindStringSubmatch(in.Title); m != nil {
		g, _ := strconv.ParseFloat(m[1], 64)
		speed = int(g * 1000)
	} else if e, ok := ix.flag("Gigabit LAN Port"); ok && e {
		speed = 1000
	}
	if speed == 0 {
		ix.issue("poe_injector", out, "no port speed")
	}
	label := "RJ45"
	if speed > 0 {
		label = formatSpeedLabel(speed) + " RJ45"
	}
	poeWatts := injectorWatts[class]
	r.Ports = append(r.Ports,
		Port{Label: label + " (data in)", Media: "rj45", Role: "data", Count: 1, MaxSpeedMbps: speed, SpeedsMbps: speedList(speed), Source: "injector"},
		Port{Label: label + " (PoE out)", Media: "rj45", Role: "data", Count: 1, MaxSpeedMbps: speed, SpeedsMbps: speedList(speed), PoEClass: class, PoEDirection: "out", PoEWatts: &poeWatts, Source: "injector"},
	)
	r.Known.Ports = true
	r.PoEMaxClass = class
	r.PoEBudget = append(r.PoEBudget, PoEScenario{Watts: poeWatts, Selected: true})
	r.Metrics = append(r.Metrics, Metric{Name: "poe_budget_w", Value: poeWatts, Unit: "W", Raw: oneLine(out.Value)})
	if rated, ok := ix.scalar("Rated Voltage"); ok && !hasPower(r, PowerAC) {
		r.Power = append(r.Power, PowerSource{Kind: PowerAC, Detail: oneLine(rated.Value)})
	}
}

func hasPower(r *Result, kind string) bool {
	for _, s := range r.Power {
		if s.Kind == kind {
			return true
		}
	}
	return false
}

func speedList(mbps int) []int {
	if mbps <= 0 {
		return []int{}
	}
	return []int{mbps}
}

// formatSpeedLabel writes a speed as the store does in port names: "2.5 GbE", "100 MbE".
func formatSpeedLabel(mbps int) string {
	if mbps >= 1000 {
		return strconv.FormatFloat(float64(mbps)/1000, 'f', -1, 64) + " GbE"
	}
	return strconv.Itoa(mbps) + " MbE"
}

// flag reports a yes/no entry's value; ok is false when the product has no such entry.
func (ix *index) flag(label string) (value, ok bool) {
	for _, e := range ix.std {
		if e.ParentID == "" && e.Kind == unistore.SpecFlag && key(e.Label) == key(label) {
			return e.Value == "true", true
		}
	}
	return false, false
}
