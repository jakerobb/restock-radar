package specs

import (
	"regexp"
	"strings"
)

// PoEScenario is one of the PoE budgets a device gives. Most give a single
// figure; some give one per way of powering them ("PoE++ input: 42W", "210W AC
// adapter input: 202W") or per power-supply arrangement.
type PoEScenario struct {
	// Name is what the figure applies to, empty for a lone figure.
	Name  string  `json:"name"`
	Watts float64 `json:"watts"`
	// Selected marks the figure used as the device's budget: the one for the
	// power supply it ships with, else the largest.
	Selected bool `json:"selected"`
}

var (
	budgetAfterColonRe = regexp.MustCompile(`:\s*` + numRe + `\s*W\b`)
	budgetLoneRe       = regexp.MustCompile(`^(?i:max\.?\s*)?` + numRe + `\s*W\b`)
	supplyRe           = regexp.MustCompile(`(?i)external.*?` + numRe + `\s*W\b`)
)

// derivePoEBudget reads the device's PoE budget. The figure to take is the one
// after the colon on each line: "210W AC adapter input: 196W" is a 196W budget
// from a 210W adapter, and "…Shared Mode: 2,150W with (2) 1,200W modules" is a
// 2,150W budget from two 1,200W modules.
func derivePoEBudget(ix *index, r *Result) {
	e, ok := ix.scalar("Total PoE Availability", "PoE Budget", "Total Available PoE")
	if !ok {
		return
	}
	for _, line := range Lines(e.Value) {
		var name string
		var watts float64
		if m := budgetAfterColonRe.FindStringSubmatchIndex(line); m != nil {
			name = strings.TrimSpace(line[:strings.Index(line, ":")])
			watts, _ = num(line[m[2]:m[3]])
		} else if m := budgetLoneRe.FindStringSubmatch(line); m != nil {
			watts, _ = num(m[1])
		} else {
			ix.issue("poe_budget", e, "no watts in: "+line)
			continue
		}
		r.PoEBudget = append(r.PoEBudget, PoEScenario{Name: name, Watts: watts})
	}
	if len(r.PoEBudget) == 0 {
		return
	}

	// A product that ships with an external power supply has the budget that
	// supply gives: USW-Ultra-60W the "60W AC adapter" one, USW-Ultra-210W the
	// "210W" one. Everything else gets the best case.
	chosen := -1
	if sup, ok := ix.scalar("Power Supply"); ok {
		if m := supplyRe.FindStringSubmatch(oneLine(sup.Value)); m != nil {
			chosen = scenarioForAdapter(r.PoEBudget, m[1])
		}
	}
	if chosen < 0 {
		for i, s := range r.PoEBudget {
			if chosen < 0 || s.Watts > r.PoEBudget[chosen].Watts {
				chosen = i
			}
		}
	}
	r.PoEBudget[chosen].Selected = true
	r.Metrics = append(r.Metrics, Metric{Name: "poe_budget_w", Value: r.PoEBudget[chosen].Watts, Unit: "W", Raw: oneLine(e.Value)})
}

// scenarioForAdapter finds the scenario for an adapter of the given wattage,
// preferring an AC adapter over a PoE one, or -1.
func scenarioForAdapter(ss []PoEScenario, watts string) int {
	w, ok := num(watts)
	if !ok {
		return -1
	}
	adapter := regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(formatFloat(w)) + `\s*W\b.*adapter`)
	found := -1
	for i, s := range ss {
		if !adapter.MatchString(s.Name) {
			continue
		}
		if strings.Contains(strings.ToLower(s.Name), "ac adapter") {
			return i
		}
		if found < 0 {
			found = i
		}
	}
	return found
}
