// Package unistore reads product stock and price from the UniFi store's
// Next.js data endpoints (/_next/data/{buildId}/...), the same JSON the
// store's own pages render from.
package unistore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jakerobb/restock-radar/internal/config"
)

const (
	maxBody      = 8 << 20
	maxRedirects = 3
	// buildIDTTL bounds how long a cached buildId is trusted. A stale one is
	// also caught reactively (404), so this is only a backstop.
	buildIDTTL = time.Hour
)

var (
	// ErrNotFound means the store has no product with that slug.
	ErrNotFound = errors.New("product not found")
	// ErrSchema means the response parsed but no longer looks like what we expect.
	ErrSchema = errors.New("unexpected response shape")

	buildIDRe = regexp.MustCompile(`"buildId":"([^"]+)"`)
)

// HTTPError is a non-success response worth acting on. 403 and 429 mean we
// are being blocked or rate limited and should back off.
type HTTPError struct {
	Status     int
	URL        string
	RetryAfter time.Duration
}

func (e *HTTPError) Error() string { return fmt.Sprintf("HTTP %d from %s", e.Status, e.URL) }

// Blocked reports whether the response suggests rate limiting or bot defense.
func (e *HTTPError) Blocked() bool {
	return e.Status == http.StatusForbidden || e.Status == http.StatusTooManyRequests || e.Status == http.StatusServiceUnavailable
}

type Money struct {
	Amount   int64  `json:"amount"` // minor units (cents)
	Currency string `json:"currency"`
}

type Variant struct {
	ID           string
	SKU          string
	Title        string
	Status       string // Available, SoldOut, ComingSoon, ...
	Price        *Money
	RegularPrice *Money // set when Price is a discount
	RestockETA   string
}

type Product struct {
	ID       string
	Slug     string
	Name     string
	Title    string
	Variants []Variant
}

type build struct {
	id      string
	fetched time.Time
}

type Client struct {
	http      *http.Client
	userAgent string

	mu     sync.Mutex
	builds map[string]build // keyed by region base URL + path
}

func New(userAgent string) *Client {
	return &Client{
		http:      &http.Client{Timeout: 30 * time.Second},
		userAgent: userAgent,
		builds:    make(map[string]build),
	}
}

// FetchProduct returns the current state of the product with the given slug.
func (c *Client) FetchProduct(ctx context.Context, region config.Region, slug string) (*Product, error) {
	refreshed := false
	for attempt := 0; ; attempt++ {
		id, err := c.buildID(ctx, region, refreshed)
		if err != nil {
			return nil, err
		}
		p, stale, err := c.fetchProduct(ctx, region, id, "/"+region.Path+"/products/"+url.PathEscape(slug), slug)
		if stale && !refreshed {
			// The store deployed since we cached the buildId.
			refreshed = true
			continue
		}
		return p, err
	}
}

// fetchProduct follows the store's in-body redirects (old slugs answer 200
// with __N_REDIRECT). stale is true when the buildId looks outdated.
func (c *Client) fetchProduct(ctx context.Context, region config.Region, buildID, path, slug string) (p *Product, stale bool, err error) {
	for hop := 0; hop <= maxRedirects; hop++ {
		u := fmt.Sprintf("%s/_next/data/%s%s.json", region.BaseURL, buildID, path)
		body, status, err := c.get(ctx, u, "application/json")
		if err != nil {
			return nil, false, err
		}
		if status == http.StatusNotFound {
			var nf struct {
				NotFound bool `json:"notFound"`
			}
			if json.Unmarshal(body, &nf) == nil && nf.NotFound {
				return nil, false, ErrNotFound
			}
			return nil, true, &HTTPError{Status: status, URL: u}
		}
		if status != http.StatusOK {
			return nil, false, &HTTPError{Status: status, URL: u}
		}

		var page struct {
			PageProps struct {
				Redirect         string `json:"__N_REDIRECT"`
				CurrentProductID string `json:"currentProductId"`
				Collection       struct {
					Products []rawProduct `json:"products"`
				} `json:"collection"`
			} `json:"pageProps"`
		}
		if err := json.Unmarshal(body, &page); err != nil {
			return nil, false, fmt.Errorf("%w: %v", ErrSchema, err)
		}
		if r := page.PageProps.Redirect; r != "" {
			if !strings.Contains(r, "/products/") {
				return nil, false, fmt.Errorf("%w: slug %q redirects to non-product %s", ErrSchema, slug, r)
			}
			path = strings.SplitN(r, "?", 2)[0]
			continue
		}
		return parseProduct(page.PageProps.CurrentProductID, page.PageProps.Collection.Products, slug)
	}
	return nil, false, fmt.Errorf("%w: too many redirects for slug %q", ErrSchema, slug)
}

type rawMoney struct {
	Amount   *int64 `json:"amount"`
	Currency string `json:"currency"`
}

type rawProduct struct {
	ID       string `json:"id"`
	Slug     string `json:"slug"`
	Name     string `json:"name"`
	Title    string `json:"title"`
	Variants []struct {
		ID           string    `json:"id"`
		SKU          string    `json:"sku"`
		Title        string    `json:"title"`
		Status       string    `json:"status"`
		Price        *rawMoney `json:"displayPrice"`
		RegularPrice *rawMoney `json:"displayRegularPrice"`
		RestockETA   *string   `json:"restockEtaAt"`
	} `json:"variants"`
}

func parseProduct(currentID string, products []rawProduct, slug string) (*Product, bool, error) {
	var raw *rawProduct
	for i := range products {
		if (currentID != "" && products[i].ID == currentID) || (currentID == "" && products[i].Slug == slug) {
			raw = &products[i]
			break
		}
	}
	if raw == nil {
		return nil, false, fmt.Errorf("%w: no product %q in response", ErrSchema, slug)
	}
	if len(raw.Variants) == 0 {
		return nil, false, fmt.Errorf("%w: product %q has no variants", ErrSchema, slug)
	}

	p := &Product{ID: raw.ID, Slug: raw.Slug, Name: raw.Name, Title: raw.Title}
	for _, v := range raw.Variants {
		if v.ID == "" || v.Status == "" {
			return nil, false, fmt.Errorf("%w: variant of %q missing id or status", ErrSchema, slug)
		}
		pv := Variant{ID: v.ID, SKU: v.SKU, Title: v.Title, Status: v.Status}
		pv.Price = money(v.Price)
		pv.RegularPrice = money(v.RegularPrice)
		if v.RestockETA != nil {
			pv.RestockETA = *v.RestockETA
		}
		p.Variants = append(p.Variants, pv)
	}
	return p, false, nil
}

func money(m *rawMoney) *Money {
	if m == nil || m.Amount == nil {
		return nil
	}
	return &Money{Amount: *m.Amount, Currency: m.Currency}
}

// buildID returns the region's current Next.js buildId, scraping it from the
// storefront's HTML when uncached, expired, or force-refreshed.
func (c *Client) buildID(ctx context.Context, region config.Region, force bool) (string, error) {
	key := region.BaseURL + "/" + region.Path
	c.mu.Lock()
	b, ok := c.builds[key]
	c.mu.Unlock()
	if ok && !force && time.Since(b.fetched) < buildIDTTL {
		return b.id, nil
	}

	u := key
	body, status, err := c.get(ctx, u, "text/html")
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return "", &HTTPError{Status: status, URL: u}
	}
	m := buildIDRe.FindSubmatch(body)
	if m == nil {
		return "", fmt.Errorf("%w: no buildId in %s", ErrSchema, u)
	}
	id := string(m[1])

	c.mu.Lock()
	c.builds[key] = build{id: id, fetched: time.Now()}
	c.mu.Unlock()
	return id, nil
}

// get returns the body and status for any HTTP response, erroring only on
// transport failures and on blocked/rate-limited statuses.
func (c *Client) get(ctx context.Context, u, accept string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("User-Agent", c.userAgent)
	req.Header.Set("Accept", accept)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = resp.Body.Close() }()

	he := &HTTPError{Status: resp.StatusCode, URL: u}
	if he.Blocked() {
		if secs, err := time.ParseDuration(resp.Header.Get("Retry-After") + "s"); err == nil {
			he.RetryAfter = secs
		}
		return nil, resp.StatusCode, he
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return body, resp.StatusCode, nil
}
