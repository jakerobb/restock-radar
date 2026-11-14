// Package techspecs builds product URLs on the UniFi tech specs site
// (techspecs.ui.com) and checks whether they lead to a real page.
//
// The site looks a product up by slug and only checks that the category segment
// is one of its own: /unifi/switching/ucg-fiber serves the same page as
// /unifi/cloud-gateways/ucg-fiber. A slug it doesn't know, or a category it
// doesn't have, redirects away. So the category exists to give a canonical URL,
// and the redirect is how we learn that a product has no page.
package techspecs

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const base = "https://techspecs.ui.com/unifi"

// rules map the prefix of a store category id to the tech specs site's
// category: its seven top-level ones, which are the parents of the store's
// subcategories (store "cloud-gateways-compact" is "cloud-gateways" there).
// "all-" categories are handled by URL.
var rules = []struct{ prefix, category string }{
	{"cloud-gateways", "cloud-gateways"},
	{"switching", "switching"},
	{"wifi", "wifi"},
	{"physical-security", "physical-security"},
	{"door-access", "door-access"},
	{"accessories", "accessories"},
	{"integrations", "integrations"},
	// The tech specs site files these store categories under Integrations.
	{"internet-solutions", "integrations"},
	{"network-storage", "integrations"},
	{"managed-voip", "integrations"},
	{"premium-iot", "integrations"},
}

// URL is where the product would be on the tech specs site, given its store
// category id and slug, or "" when the category is unknown or isn't one the
// site has. It says nothing about whether the page exists; see Client.Exists.
func URL(category, slug string) string {
	if slug == "" {
		return ""
	}
	category = strings.TrimPrefix(category, "all-")
	for _, r := range rules {
		if strings.HasPrefix(category, r.prefix) {
			// The site redirects a mixed-case slug to its lowercase form.
			return base + "/" + r.category + "/" + url.PathEscape(strings.ToLower(slug))
		}
	}
	return ""
}

// HTTPError is a response that says nothing about whether a page exists. 403,
// 429 and 503 mean we are being blocked or rate limited and should back off.
type HTTPError struct {
	Status int
	URL    string
}

func (e *HTTPError) Error() string { return fmt.Sprintf("HTTP %d from %s", e.Status, e.URL) }

// Blocked reports whether the response suggests rate limiting or bot defense.
func (e *HTTPError) Blocked() bool {
	return e.Status == http.StatusForbidden || e.Status == http.StatusTooManyRequests || e.Status == http.StatusServiceUnavailable
}

type Client struct {
	http      *http.Client
	userAgent string
}

func New(userAgent string) *Client {
	return &Client{
		userAgent: userAgent,
		http: &http.Client{
			Timeout: 30 * time.Second,
			// A redirect is the site's way of saying there is no such page.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

// Exists reports whether u, a URL from URL, leads to a product page. A page that
// is missing is (false, nil); an error means we couldn't tell.
func (c *Client) Exists(ctx context.Context, u string) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, u, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("User-Agent", c.userAgent)
	resp, err := c.http.Do(req)
	if err != nil {
		return false, err
	}
	_ = resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusOK:
		return true, nil
	case resp.StatusCode >= 300 && resp.StatusCode < 400, resp.StatusCode == http.StatusNotFound:
		return false, nil
	default:
		return false, &HTTPError{Status: resp.StatusCode, URL: u}
	}
}
