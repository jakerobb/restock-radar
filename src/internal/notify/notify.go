// Package notify turns events into push notifications. Notifier is the seam
// where APNs/FCM delivery will plug in alongside ntfy.
package notify

import (
	"context"
	"fmt"
	"strings"

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

// FromEvent renders an event. storeURL is the product page for the event's region.
func FromEvent(e store.Event, storeURL string) Message {
	m := Message{Click: storeURL}
	switch e.Kind {
	case store.KindStatus:
		m.Title = name(e)
		switch e.NewStatus {
		case "Available":
			m.Title += " is in stock"
			m.Body = fmt.Sprintf("Was %s. Now %s.", e.OldStatus, money(e.NewPriceCents, e.Currency))
			m.Priority = 4
			m.Tags = []string{"white_check_mark"}
		case "SoldOut":
			m.Title += " is sold out"
			m.Body = fmt.Sprintf("Was %s.", e.OldStatus)
			m.Tags = []string{"x"}
		default:
			m.Title += " status: " + e.NewStatus
			m.Body = fmt.Sprintf("Was %s.", e.OldStatus)
			m.Tags = []string{"eyes"}
		}
	case store.KindPrice:
		m.Title = name(e) + " price changed"
		m.Body = fmt.Sprintf("%s → %s", money(e.OldPriceCents, e.Currency), money(e.NewPriceCents, e.Currency))
		m.Tags = []string{"moneybag"}
		if e.OldPriceCents != nil && e.NewPriceCents != nil && *e.NewPriceCents < *e.OldPriceCents {
			m.Tags = []string{"chart_with_downwards_trend"}
		}
	}
	return m
}
