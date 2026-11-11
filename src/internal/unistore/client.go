// Package unistore reads product stock and price from the UniFi store's
// Next.js data endpoints (/_next/data/{buildId}/...), the same JSON the
// store's own pages render from.
package unistore

import (
	"bufio"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
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
	ID    string
	Slug  string
	Name  string
	Title string
	// Category is the store's category id (e.g. "switching-enterprise"); empty when unknown.
	Category string
	// Collection is the slug of the store collection the product belongs to;
	// products sharing one are presented by the store as a single product with a
	// choice between them. Empty when the product stands alone or it is unknown.
	Collection string
	// Tags are the store's labels for the product (e.g. "black-friday",
	// "feature:4k"), sorted and without duplicates. Nil means the response
	// didn't say, which is different from having no tags.
	Tags     []string
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
func (c *Client) FetchProduct(ctx context.Context, region config.Region, slug string) (p *Product, err error) {
	err = c.withBuildID(ctx, region, func(id string) (bool, error) {
		var stale bool
		p, stale, err = c.fetchProduct(ctx, region, id, "/"+region.Path+"/products/"+url.PathEscape(slug), slug)
		return stale, err
	})
	return p, err
}

// Category is every product the store lists in a category family: the page for
// any one category also carries its sibling categories.
type Category struct {
	// Subcategories are the ids of the categories on the page, in page order.
	Subcategories []string
	// Products are all the products on the page, each with Category set to the
	// subcategory that lists it.
	Products []Product
	// Skipped counts products left out because their data was incomplete (no
	// variants, or a variant missing its id or status).
	Skipped int
}

// FetchCategory returns every product on the page for the given category id,
// which must be a leaf category (the store redirects parent categories home).
// One request covers the whole family, so it replaces a request per product.
func (c *Client) FetchCategory(ctx context.Context, region config.Region, categoryID string) (cat *Category, err error) {
	err = c.withBuildID(ctx, region, func(id string) (bool, error) {
		var stale bool
		cat, stale, err = c.fetchCategory(ctx, region, id, categoryID)
		return stale, err
	})
	return cat, err
}

func (c *Client) fetchCategory(ctx context.Context, region config.Region, buildID, categoryID string) (*Category, bool, error) {
	u := fmt.Sprintf("%s/_next/data/%s/%s/category/%s.json", region.BaseURL, buildID, region.Path, url.PathEscape(categoryID))
	body, stale, err := c.fetchData(ctx, u)
	if err != nil {
		return nil, stale, err
	}

	var page struct {
		PageProps struct {
			Redirect      string `json:"__N_REDIRECT"`
			SubCategories []struct {
				ID       string       `json:"id"`
				Products []rawProduct `json:"products"`
			} `json:"subCategories"`
		} `json:"pageProps"`
	}
	if err := json.Unmarshal(body, &page); err != nil {
		return nil, false, fmt.Errorf("%w: %v", ErrSchema, err)
	}
	if r := page.PageProps.Redirect; r != "" {
		return nil, false, fmt.Errorf("%w: category %q redirects to %s", ErrNotFound, categoryID, r)
	}
	if len(page.PageProps.SubCategories) == 0 {
		return nil, false, fmt.Errorf("%w: category %q has no subcategories", ErrSchema, categoryID)
	}

	cat := &Category{}
	seen := make(map[string]bool)
	for _, sc := range page.PageProps.SubCategories {
		cat.Subcategories = append(cat.Subcategories, sc.ID)
		for i := range sc.Products {
			raw := &sc.Products[i]
			if seen[raw.ID] {
				continue
			}
			seen[raw.ID] = true
			p, err := convertProduct(raw)
			if err != nil {
				cat.Skipped++
				continue
			}
			p.Category = sc.ID
			cat.Products = append(cat.Products, *p)
		}
	}
	return cat, false, nil
}

// withBuildID runs fn with the region's buildId. If fn reports the buildId as
// stale (the store deployed since it was cached), it refreshes it and tries once more.
func (c *Client) withBuildID(ctx context.Context, region config.Region, fn func(buildID string) (stale bool, err error)) error {
	for refreshed := false; ; refreshed = true {
		id, err := c.buildID(ctx, region, refreshed)
		if err != nil {
			return err
		}
		stale, err := fn(id)
		if stale && !refreshed {
			continue
		}
		return err
	}
}

// fetchData GETs one Next.js data URL. stale is true when a 404 without the
// store's notFound marker suggests the buildId is outdated.
func (c *Client) fetchData(ctx context.Context, u string) (body []byte, stale bool, err error) {
	body, status, err := c.get(ctx, u, "application/json")
	if err != nil {
		return nil, false, err
	}
	switch status {
	case http.StatusOK:
		return body, false, nil
	case http.StatusNotFound:
		var nf struct {
			NotFound bool `json:"notFound"`
		}
		if json.Unmarshal(body, &nf) == nil && nf.NotFound {
			return nil, false, ErrNotFound
		}
		return nil, true, &HTTPError{Status: status, URL: u}
	default:
		return nil, false, &HTTPError{Status: status, URL: u}
	}
}

// fetchProduct follows the store's in-body redirects (old slugs answer 200
// with __N_REDIRECT). stale is true when the buildId looks outdated.
func (c *Client) fetchProduct(ctx context.Context, region config.Region, buildID, path, slug string) (p *Product, stale bool, err error) {
	for hop := 0; hop <= maxRedirects; hop++ {
		u := fmt.Sprintf("%s/_next/data/%s%s.json", region.BaseURL, buildID, path)
		body, stale, err := c.fetchData(ctx, u)
		if err != nil {
			return nil, stale, err
		}

		var page struct {
			PageProps struct {
				Redirect         string `json:"__N_REDIRECT"`
				CurrentProductID string `json:"currentProductId"`
				Category         struct {
					Current struct {
						ID string `json:"id"`
					} `json:"currentCategory"`
				} `json:"category"`
				Collection struct {
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
		prod, stale, err := parseProduct(page.PageProps.CurrentProductID, page.PageProps.Collection.Products, slug)
		if prod != nil {
			prod.Category = page.PageProps.Category.Current.ID
		}
		return prod, stale, err
	}
	return nil, false, fmt.Errorf("%w: too many redirects for slug %q", ErrSchema, slug)
}

type rawMoney struct {
	Amount   *int64 `json:"amount"`
	Currency string `json:"currency"`
}

type rawProduct struct {
	ID    string `json:"id"`
	Slug  string `json:"slug"`
	Name  string `json:"name"`
	Title string `json:"title"`
	// The store shows products sharing a collection slug as one page with a
	// choice between them. Either field may carry it.
	ProCollectionSlug            string `json:"proCollectionSlug"`
	OrganizationalCollectionSlug string `json:"organizationalCollectionSlug"`
	Tags                         []struct {
		Name string `json:"name"`
	} `json:"tags"`
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
	p, err := convertProduct(raw)
	return p, false, err
}

// convertProduct turns the store's JSON for one product into a Product,
// rejecting data too incomplete to track.
func convertProduct(raw *rawProduct) (*Product, error) {
	if len(raw.Variants) == 0 {
		return nil, fmt.Errorf("%w: product %q has no variants", ErrSchema, raw.Slug)
	}

	p := &Product{ID: raw.ID, Slug: raw.Slug, Name: raw.Name, Title: raw.Title, Collection: raw.ProCollectionSlug}
	if p.Collection == "" {
		p.Collection = raw.OrganizationalCollectionSlug
	}
	if raw.Tags != nil {
		p.Tags = []string{}
		for _, t := range raw.Tags {
			// Sort weights are per-product numbers the store orders its pages by,
			// not labels anyone would filter on.
			if t.Name == "" || strings.Contains(t.Name, "-sort-weight:") || slices.Contains(p.Tags, t.Name) {
				continue
			}
			p.Tags = append(p.Tags, t.Name)
		}
		slices.Sort(p.Tags)
	}
	for _, v := range raw.Variants {
		if v.ID == "" || v.Status == "" {
			return nil, fmt.Errorf("%w: variant of %q missing id or status", ErrSchema, raw.Slug)
		}
		pv := Variant{ID: v.ID, SKU: v.SKU, Title: v.Title, Status: v.Status}
		pv.Price = money(v.Price)
		pv.RegularPrice = money(v.RegularPrice)
		if v.RestockETA != nil {
			pv.RestockETA = *v.RestockETA
		}
		p.Variants = append(p.Variants, pv)
	}
	return p, nil
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
	// Setting this ourselves turns off net/http's transparent gzip, so decode
	// the response by hand. The store's JSON shrinks about 9x.
	req.Header.Set("Accept-Encoding", "gzip, deflate")

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

	r, err := decodedBody(resp)
	if err != nil {
		return nil, resp.StatusCode, err
	}
	// The limit applies after decompression, so a tiny compressed body can't balloon.
	body, err := io.ReadAll(io.LimitReader(r, maxBody))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return body, resp.StatusCode, nil
}

// decodedBody undoes the response's Content-Encoding. "deflate" is zlib-wrapped
// per the HTTP spec, but some servers send a bare deflate stream, so check.
func decodedBody(resp *http.Response) (io.Reader, error) {
	switch enc := strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Encoding"))); enc {
	case "", "identity":
		return resp.Body, nil
	case "gzip", "x-gzip":
		return gzip.NewReader(resp.Body)
	case "deflate":
		br := bufio.NewReader(resp.Body)
		if h, err := br.Peek(2); err == nil && h[0]&0x0f == 8 && (int(h[0])<<8|int(h[1]))%31 == 0 {
			return zlib.NewReader(br)
		}
		return flate.NewReader(br), nil
	default:
		return nil, fmt.Errorf("unsupported Content-Encoding %q from %s", enc, resp.Request.URL)
	}
}
