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
	// PriceWithSurcharges is Price plus the store's add-on charges (memory,
	// tariffs, ...). Nil when the response didn't give one; equal to Price when
	// the product carries no surcharge.
	PriceWithSurcharges *Money
	RestockETA          string
}

type Product struct {
	ID    string
	Slug  string
	Name  string
	Title string
	// ShortTitle is the store's compact name ("UniFi Etherlighting Patch Cable",
	// where Title may carry a qualifier like "(10 GbE)"); empty when not given.
	ShortTitle string
	// Group is the title the store's category breadcrumbs file the product
	// under ("UniFi Patch Cables"). Products sharing one are presented as a unit.
	// Only the product endpoint carries breadcrumbs, so it is empty otherwise.
	Group string
	// Detailed is true when the product came from the product endpoint, which
	// has fields the category endpoint lacks.
	Detailed bool
	// Category is the store's category id (e.g. "switching-enterprise"); empty when unknown.
	Category string
	// Collection is the slug of the store collection the product belongs to;
	// products sharing one are presented by the store as a single product with a
	// choice between them. Empty when the product stands alone or it is unknown.
	Collection string
	// Tags are the store's labels for the product (e.g. "black-friday",
	// "feature:4k"), sorted and without duplicates. Nil means the response
	// didn't say, which is different from having no tags.
	Tags []string
	// SurchargeTypes names every kind of surcharge the store adds on top of
	// the base price (e.g. "Memory"), in the store's order and unfiltered, so
	// kinds we have never seen are kept. Nil means the response didn't say.
	SurchargeTypes []string
	// Specs is the product's technical specification, in the store's order, with
	// entries that have no value left out. Only the product endpoint carries it
	// (category pages have just a short grid summary), so it is nil for anything
	// else, and also when the response had no specification at all: nil means
	// "not told", where an empty slice means the store says there is none.
	Specs []Spec
	// Linked are the products the store offers with this one on its page (a Cloud Gateway's SSDs, a UPS's PDU),
	// each a separate product with a variant of its own. Category pages give them, with little more than a
	// name, a price and stock; nil means the response didn't say, which is different from having none.
	Linked []Product
	// LinkLabels names each linked product's choice by its id ("1 TB"), and LinkBaseLabel the choice of having
	// none of them ("No Storage"), as the store's page words them. Only the product endpoint gives them.
	LinkLabels    map[string]string
	LinkBaseLabel string
	// SpecsSkipped counts specification entries dropped for being malformed
	// (no feature id, an unknown kind, an unreadable flag), so the caller can
	// say so. Entries that are merely empty aren't counted.
	SpecsSkipped int
	Variants     []Variant
}

// Kinds of Spec.
const (
	SpecText  = "text"  // a free-text value ("400W", "2 x 2 (DL/UL MU-MIMO)")
	SpecFlag  = "flag"  // a yes/no feature; Value is "true" or "false"
	SpecGroup = "group" // a heading with no value of its own; other entries name it as their parent
)

// Spec is one entry of a product's technical specification.
type Spec struct {
	// SectionID, Section and SectionType say where the entry is shown: the
	// store's id and label for the section ("Hardware"), and its type
	// ("Standard", or "Overview" for the grid summary, which repeats features
	// that appear in other sections).
	SectionID   string `json:"section_id"`
	Section     string `json:"section"`
	SectionType string `json:"section_type"`
	// FeatureID is the store's id for the feature, stable across products and
	// time, unlike its label. It is unique within a section but not within a
	// product. ParentID is the FeatureID of the group the entry sits under, or
	// empty at the top level.
	FeatureID string `json:"feature_id"`
	ParentID  string `json:"parent_id,omitempty"`
	Label     string `json:"label"`
	Kind      string `json:"kind"`
	// Value is the display text for SpecText, "true" or "false" for SpecFlag,
	// and empty for SpecGroup. Note is the store's footnote for the entry.
	Value string `json:"value,omitempty"`
	Note  string `json:"note,omitempty"`
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
					Breadcrumbs []struct {
						Title      string   `json:"title"`
						ProductIDs []string `json:"productIds"`
					} `json:"breadcrumbs"`
				} `json:"category"`
				Collection struct {
					Products []rawProduct `json:"products"`
					Sections []struct {
						Title       string   `json:"title"`
						ProductTags []string `json:"productTags"`
					} `json:"sections"`
				} `json:"collection"`
				LinkedProducts []rawProduct `json:"linkedProducts"`
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
			prod.Detailed = true
			if page.PageProps.LinkedProducts != nil {
				prod.Linked = offered(prod.Slug, convertLinked(page.PageProps.LinkedProducts))
				sections := make([]choiceSection, 0, len(page.PageProps.Collection.Sections))
				for _, sc := range page.PageProps.Collection.Sections {
					sections = append(sections, choiceSection{Title: sc.Title, Tags: sc.ProductTags})
				}
				prod.LinkBaseLabel, prod.LinkLabels = linkLabels(sections, prod.Tags, prod.Linked)
			}
			for _, b := range page.PageProps.Category.Breadcrumbs {
				if slices.Contains(b.ProductIDs, prod.ID) {
					prod.Group = b.Title
					break
				}
			}
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
	ID         string `json:"id"`
	Slug       string `json:"slug"`
	Name       string `json:"name"`
	Title      string `json:"title"`
	ShortTitle string `json:"shortTitle"`
	// The store shows products sharing a collection slug as one page with a
	// choice between them. Either field may carry it.
	ProCollectionSlug            string `json:"proCollectionSlug"`
	OrganizationalCollectionSlug string `json:"organizationalCollectionSlug"`
	Tags                         []struct {
		Name string `json:"name"`
	} `json:"tags"`
	SurchargeTypes []string `json:"productSurchargeTypes"`
	// LinkedProducts are other products sold with this one; only category pages carry them.
	LinkedProducts []rawProduct `json:"linkedProducts"`
	// TechnicalSpecification is on both endpoints, but category pages carry only
	// the grid summary, so only parseProduct reads it.
	TechnicalSpecification *rawSpecs `json:"technicalSpecification"`
	// Options are the choices a buyer makes (Color, Length, ...) in the order the
	// store shows them; each variant picks one value per option.
	Options []struct {
		Values []struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		} `json:"values"`
	} `json:"options"`
	Variants []struct {
		ID  string `json:"id"`
		SKU string `json:"sku"`
		// Title is only on the product endpoint; category pages omit it.
		Title          string    `json:"title"`
		OptionValueIDs []string  `json:"optionValueIds"`
		Status         string    `json:"status"`
		Price          *rawMoney `json:"displayPrice"`
		RegularPrice   *rawMoney `json:"displayRegularPrice"`
		// The price including surcharges, which the store shows as a smaller secondary price.
		PriceWithSurcharges *rawMoney `json:"displayPriceWithSurcharges"`
		RestockETA          *string   `json:"restockEtaAt"`
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
	if p != nil {
		p.Specs, p.SpecsSkipped = convertSpecs(raw.TechnicalSpecification)
	}
	return p, false, err
}

// convertProduct turns the store's JSON for one product into a Product,
// rejecting data too incomplete to track.
func convertProduct(raw *rawProduct) (*Product, error) {
	if len(raw.Variants) == 0 {
		return nil, fmt.Errorf("%w: product %q has no variants", ErrSchema, raw.Slug)
	}

	p := &Product{ID: raw.ID, Slug: raw.Slug, Name: raw.Name, Title: raw.Title, ShortTitle: raw.ShortTitle, Collection: raw.ProCollectionSlug}
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
	if raw.SurchargeTypes != nil {
		p.SurchargeTypes = []string{}
		for _, t := range raw.SurchargeTypes {
			if t != "" && !slices.Contains(p.SurchargeTypes, t) {
				p.SurchargeTypes = append(p.SurchargeTypes, t)
			}
		}
	}
	if raw.LinkedProducts != nil {
		p.Linked = offered(raw.Slug, convertLinked(raw.LinkedProducts))
	}
	for _, v := range raw.Variants {
		if v.ID == "" || v.Status == "" {
			return nil, fmt.Errorf("%w: variant of %q missing id or status", ErrSchema, raw.Slug)
		}
		label, resolved := optionLabel(raw, v.OptionValueIDs)
		title := label
		if !resolved {
			title = v.Title
		}
		pv := Variant{ID: v.ID, SKU: v.SKU, Title: title, Status: v.Status}
		pv.Price = money(v.Price)
		pv.RegularPrice = money(v.RegularPrice)
		pv.PriceWithSurcharges = money(v.PriceWithSurcharges)
		if v.RestockETA != nil {
			pv.RestockETA = *v.RestockETA
		}
		p.Variants = append(p.Variants, pv)
	}
	return p, nil
}

// optionLabel names a variant by the option values it picks, in the store's
// option order ("White / 0.2 m / 10-Pack"). Both endpoints carry the options, so
// unlike the variant's own title, which only the product endpoint has, this reads
// the same whichever one we asked. An option with a single value is left out: it
// tells variants nothing apart ("White" on a cabinet sold only in white), and
// the product's own title says what does. resolved is false when the ids match
// no option value, so the caller falls back to the store's title; it is true,
// with an empty label, when every value picked was a lone one.
func optionLabel(raw *rawProduct, ids []string) (label string, resolved bool) {
	var parts []string
	for _, o := range raw.Options {
		for _, val := range o.Values {
			if val.Title != "" && slices.Contains(ids, val.ID) {
				resolved = true
				if len(o.Values) > 1 {
					parts = append(parts, val.Title)
				}
				break
			}
		}
	}
	return strings.Join(parts, " / "), resolved
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

// convertLinked turns the store's linked products into Products, leaving out any too incomplete to track.
func convertLinked(raws []rawProduct) []Product {
	out := []Product{}
	for i := range raws {
		l := &raws[i]
		// A linked product has no title of its own here, so its name (the SKU, as the store calls it) stands in.
		lp, err := convertProduct(&rawProduct{ID: l.ID, Slug: l.Slug, Name: l.Name, Title: l.Name, Variants: l.Variants})
		if err != nil || lp.ID == "" || lp.Slug == "" {
			continue
		}
		for j := range lp.Variants {
			if lp.Variants[j].Title == "" {
				lp.Variants[j].Title = l.Name
			}
		}
		out = append(out, *lp)
	}
	return out
}

// choiceSection is one choice the store's collection page offers: a title ("1 TB") and the product tags that pick it.
type choiceSection struct {
	Title string
	Tags  []string
}

// linkLabels names the choices on a product's page. The store marks a linked product's choice with a tag
// that is the end of its slug (the tag "ssd-1tb" for "uacc-ssd-1tb"), and the choice of none of them with
// the tags of the product itself, the most specific such section ("No Storage" over the plain "Gateway").
func linkLabels(sections []choiceSection, baseTags []string, linked []Product) (base string, labels map[string]string) {
	labels = map[string]string{}
	taken := map[int]bool{}
	for _, l := range linked {
		for i, sc := range sections {
			if sc.Title != "" && slices.ContainsFunc(sc.Tags, func(t string) bool { return t != "" && (l.Slug == t || strings.HasSuffix(l.Slug, "-"+t)) }) {
				labels[l.ID] = sc.Title
				taken[i] = true
				break
			}
		}
	}
	best, tie := -1, false
	for i, sc := range sections {
		if taken[i] || sc.Title == "" || len(sc.Tags) == 0 {
			continue
		}
		if !slices.ContainsFunc(sc.Tags, func(t string) bool { return !slices.Contains(baseTags, t) }) {
			switch {
			case best < 0 || len(sc.Tags) > len(sections[best].Tags):
				best, tie = i, false
			case len(sc.Tags) == len(sections[best].Tags):
				tie = true
			}
		}
	}
	if best >= 0 && !tie {
		base = sections[best].Title
	}
	return base, labels
}

// offeredLinks is which linked products the store's page actually offers with a product, by the product's
// slug without its region suffix. The data lists more than that (the UPS 2U Pro and the Cloud Gateway Max
// list the same PDU and SSDs, and the store doesn't offer them there), so the choice is made in the
// storefront's own code, and is repeated here.
var offeredLinks = map[string][]string{
	"ucg-max-ns": {"uacc-ssd-1tb", "uacc-ssd-2tb"},
	"ucg-fiber":  {"uacc-ssd-1tb", "uacc-ssd-2tb"},
	"ups-2u":     {"usp-pdu-pro"},
}

// offered keeps the linked products the store offers with the product of this slug. Nil stays nil: not told.
func offered(slug string, linked []Product) []Product {
	if linked == nil {
		return nil
	}
	base := strings.TrimSuffix(strings.TrimSuffix(slug, "-us"), "-eu")
	out := []Product{}
	for _, l := range linked {
		if slices.Contains(offeredLinks[base], l.Slug) {
			out = append(out, l)
		}
	}
	return out
}
