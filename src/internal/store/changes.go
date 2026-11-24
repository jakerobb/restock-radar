package store

import (
	"slices"
	"strings"
)

// DescribeChange says in a few words what a variant's latest change was, from the events recorded when it
// happened (a poll can produce a status event and a price event at once; the status is the more notable).
// It is empty when there is nothing to go on.
func DescribeChange(events []Event) string {
	for _, e := range events {
		if e.Kind == KindStatus {
			return describeStatusChange(e)
		}
	}
	for _, e := range events {
		if e.Kind == KindPrice {
			return describePriceChange(e)
		}
	}
	return ""
}

func describeStatusChange(e Event) string {
	switch e.NewStatus {
	case "Available":
		if e.OldStatus == "SoldOut" {
			return "Back in stock"
		}
		return "In stock"
	case "SoldOut":
		return "Out of stock"
	case "ComingSoon":
		return "Coming soon"
	}
	return "Status changed"
}

func describePriceChange(e Event) string {
	added, removed := typesNotIn(e.OldSurchargeTypes, e.NewSurchargeTypes), typesNotIn(e.NewSurchargeTypes, e.OldSurchargeTypes)
	switch {
	case len(added) > 0 && len(removed) == 0:
		return surchargeList(added) + " added"
	case len(removed) > 0 && len(added) == 0:
		return surchargeList(removed) + " removed"
	case len(added)+len(removed) > 0:
		return "Surcharges changed"
	}
	oldCents, newCents := e.OldPriceCents, e.NewPriceCents
	if e.OldTotalCents != nil && e.NewTotalCents != nil {
		oldCents, newCents = e.OldTotalCents, e.NewTotalCents
	}
	switch {
	case oldCents == nil || newCents == nil || *oldCents == *newCents:
		return "Price changed"
	case *newCents > *oldCents:
		return "Price increased"
	default:
		return "Price decreased"
	}
}

// typesNotIn returns the surcharge types in b but not in a.
func typesNotIn(a, b []string) []string {
	var out []string
	for _, t := range b {
		if !slices.Contains(a, t) {
			out = append(out, t)
		}
	}
	return out
}

// surchargeList names surcharge types as the start of a sentence: "Memory surcharge", "Memory and Tariff surcharges".
func surchargeList(types []string) string {
	if len(types) == 1 {
		return types[0] + " surcharge"
	}
	return strings.Join(types[:len(types)-1], ", ") + " and " + types[len(types)-1] + " surcharges"
}
