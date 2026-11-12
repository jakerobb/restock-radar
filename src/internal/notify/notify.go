// Package notify turns events into push notifications. Notifier is the seam
// where APNs/FCM delivery will plug in alongside ntfy.
package notify

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/jakerobb/restock-radar/internal/store"
)

// Message is a delivery-agnostic notification.
type Message struct {
	Title string
	Body  string
	// Click is a URL opened when the notification is tapped. Always a product
	// page, never a cart action.
	Click string
	// Priority is 1 (min) to 5 (max); 0 means the default.
	Priority int
	// Tags are ntfy emoji shortcodes (e.g. "white_check_mark").
	Tags []string
}

// PermanentError means retrying the same message can't succeed because the
// server rejected it (a 4xx other than 408 and 429). Callers should give up on
// that message instead of retrying it forever.
type PermanentError struct{ Err error }

func (e *PermanentError) Error() string { return e.Err.Error() }
func (e *PermanentError) Unwrap() error { return e.Err }

type Notifier interface {
	Send(ctx context.Context, m Message) error
}

func money(cents *int64, currency string) string {
	if cents == nil {
		return "n/a"
	}
	sym := map[string]string{"USD": "$", "CAD": "CA$", "GBP": "£", "EUR": "€", "AUD": "A$"}[currency]
	if sym == "" {
		return fmt.Sprintf("%.2f %s", float64(*cents)/100, currency)
	}
	return fmt.Sprintf("%s%.2f", sym, float64(*cents)/100)
}

func name(e store.Event) string {
	n := e.ProductTitle
	if e.VariantTitle != "" && !strings.EqualFold(e.VariantTitle, "default") {
		n += " (" + e.VariantTitle + ")"
	}
	return n
}

// humanStatus turns a store status like "SoldOut" into "sold out".
func humanStatus(s string) string {
	var b strings.Builder
	for i, r := range s {
		if i > 0 && unicode.IsUpper(r) {
			b.WriteByte(' ')
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return b.String()
}

func plural(n int, unit string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", unit)
	}
	return fmt.Sprintf("%d %ss", n, unit)
}

// humanDuration renders d coarsely: minutes under an hour, hours under two
// days, days beyond that.
func humanDuration(d time.Duration) string {
	switch {
	case d < time.Minute:
		return "less than a minute"
	case d < time.Hour:
		return plural(int(d/time.Minute), "minute")
	case d < 48*time.Hour:
		return plural(int(d/time.Hour), "hour")
	default:
		return plural(int(d/(24*time.Hour)), "day")
	}
}

// previousState says what the variant was before the event, e.g. "Was sold out
// for 22 hours." It is "at least" when we only know since we started watching.
func previousState(e store.Event) string {
	state := humanStatus(e.OldStatus)
	if e.PreviousStateSince.IsZero() || e.Timestamp.Before(e.PreviousStateSince) {
		return fmt.Sprintf("Was %s.", state)
	}
	atLeast := ""
	if e.PreviousStateSinceFirstSeen {
		atLeast = "at least "
	}
	return fmt.Sprintf("Was %s for %s%s.", state, atLeast, humanDuration(e.Timestamp.Sub(e.PreviousStateSince)))
}

// priceChange describes the new price, including surcharges, relative to the
// old one. It returns "" when there is no new price, or when the price is
// unchanged and always is false.
func priceChange(e store.Event, always bool) string {
	oldP, newP := e.TotalOld(), e.TotalNew()
	if newP == nil {
		return ""
	}
	now := money(newP, e.Currency)
	switch {
	case oldP == nil:
		return fmt.Sprintf("Now %s.", now)
	case *newP > *oldP:
		return fmt.Sprintf("Price increased to %s.", now)
	case *newP < *oldP:
		return fmt.Sprintf("Price decreased to %s.", now)
	case always:
		return fmt.Sprintf("Still %s.", now)
	}
	return ""
}

func statusBody(e store.Event, alwaysPrice bool) string {
	return strings.TrimSpace(previousState(e) + " " + priceChange(e, alwaysPrice))
}

// newProductBody says whether the new product can be bought and what it costs,
// e.g. "In stock, $199.00." Events carry only one variant, so a product with
// several gets a count instead of a price that might not represent it.
func newProductBody(e store.Event) string {
	if e.VariantCount > 1 {
		return plural(e.VariantCount, "variant") + "."
	}
	status := humanStatus(e.NewStatus)
	if e.NewStatus == "Available" {
		status = "in stock"
	}
	body := strings.ToUpper(status[:1]) + status[1:]
	if p := e.TotalNew(); p != nil {
		body += ", " + money(p, e.Currency)
	}
	return body + "."
}

// FromEvent renders an event. storeURL is the product page for the event's region.
func FromEvent(e store.Event, storeURL string) Message {
	m := Message{Click: storeURL}
	switch e.Kind {
	case store.KindStatus:
		m.Title = name(e)
		switch e.NewStatus {
		case "Available":
			m.Title += " is in stock"
			m.Body = statusBody(e, true)
			m.Priority = 4
			m.Tags = []string{"white_check_mark"}
		case "SoldOut":
			m.Title += " is sold out"
			m.Body = statusBody(e, false)
			m.Tags = []string{"x"}
		default:
			m.Title += " status: " + e.NewStatus
			m.Body = statusBody(e, false)
			m.Tags = []string{"eyes"}
		}
	case store.KindNew:
		m.Title = "New product! " + e.ProductTitle
		m.Body = newProductBody(e)
		m.Tags = []string{"new"}
	case store.KindPrice:
		m.Title, m.Body = priceEvent(e)
		m.Tags = []string{"moneybag"}
		if oldP, newP := e.TotalOld(), e.TotalNew(); oldP != nil && newP != nil && *newP < *oldP {
			m.Tags = []string{"chart_with_downwards_trend"}
		}
	}
	return m
}

// surchargeName renders a surcharge type the way the store names it, e.g.
// "Memory" -> "memory surcharge".
func surchargeName(t string) string { return strings.ToLower(t) + " surcharge" }

// diffTypes returns the surcharge types in b but not in a.
func diffTypes(a, b []string) []string {
	var out []string
	for _, t := range b {
		if !slices.Contains(a, t) {
			out = append(out, t)
		}
	}
	return out
}

// surchargeAmount is the total less the base price: what the surcharges come to.
func surchargeAmount(base, total *int64) *int64 {
	if base == nil || total == nil {
		return nil
	}
	d := *total - *base
	return &d
}

// priceEvent renders a price event: a title saying whether the price, the
// surcharges, or both changed, and a body with the total before and after
// and what moved.
func priceEvent(e store.Event) (title, body string) {
	baseChanged := !equalPtr(e.OldPriceCents, e.NewPriceCents) || !equalPtr(e.OldRegularPriceCents, e.NewRegularPriceCents)
	added, removed := diffTypes(e.OldSurchargeTypes, e.NewSurchargeTypes), diffTypes(e.NewSurchargeTypes, e.OldSurchargeTypes)
	oldSur, newSur := surchargeAmount(e.OldPriceCents, e.OldTotalCents), surchargeAmount(e.NewPriceCents, e.NewTotalCents)
	amountChanged := oldSur != nil && newSur != nil && *oldSur != *newSur
	surchargeChanged := len(added)+len(removed) > 0 || amountChanged

	title = name(e)
	switch {
	case baseChanged && surchargeChanged:
		title += " price and surcharges changed"
	case surchargeChanged && len(added) > 0 && len(removed) == 0:
		title += " surcharge added"
	case surchargeChanged && len(removed) > 0 && len(added) == 0:
		title += " surcharge removed"
	case surchargeChanged:
		title += " surcharge changed"
	default:
		title += " price changed"
	}

	lines := []string{fmt.Sprintf("%s → %s", money(e.TotalOld(), e.Currency), money(e.TotalNew(), e.Currency))}
	if baseChanged {
		lines = append(lines, fmt.Sprintf("Base price: %s → %s", money(e.OldPriceCents, e.Currency), money(e.NewPriceCents, e.Currency)))
	}
	for _, t := range added {
		lines = append(lines, "Added: "+surchargeName(t))
	}
	for _, t := range removed {
		lines = append(lines, "Removed: "+surchargeName(t))
	}
	if amountChanged {
		lines = append(lines, fmt.Sprintf("Surcharges: %s → %s", money(oldSur, e.Currency), money(newSur, e.Currency)))
	}
	return title, strings.Join(lines, "\n")
}

func equalPtr(a, b *int64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
