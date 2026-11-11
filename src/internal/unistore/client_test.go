package unistore

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jakerobb/restock-radar/internal/config"
)

const productJSON = `{"pageProps":{"currentProductId":"p1","collection":{"products":[
	{"id":"other","slug":"other","name":"Other","title":"Other","variants":[]},
	{"id":"p1","slug":"widget","name":"Widget","title":"Widget Title","variants":[
		{"id":"v1","sku":"W-1","title":"US","status":"SoldOut","displayPrice":{"amount":10900,"currency":"USD"},
		 "displayRegularPrice":null,"restockEtaAt":null}]}]}}}`

func newTestServer(t *testing.T, currentBuild *string) (*httptest.Server, config.Region) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/us/en", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`<html>..."buildId":"` + *currentBuild + `"...</html>`))
	})
	mux.HandleFunc("/_next/data/{build}/us/en/products/{slug}", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("build") != *currentBuild {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{}`))
			return
		}
		switch r.PathValue("slug") {
		case "widget.json":
			_, _ = w.Write([]byte(productJSON))
		case "old-widget.json":
			_, _ = w.Write([]byte(`{"pageProps":{"__N_REDIRECT":"/us/en/products/widget","__N_REDIRECT_STATUS":307}}`))
		case "category-thing.json":
			_, _ = w.Write([]byte(`{"pageProps":{"__N_REDIRECT":"/us/en/category/x"}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"notFound":true}`))
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, config.Region{ID: "us", BaseURL: srv.URL, Path: "us/en"}
}

func TestFetchProduct(t *testing.T) {
	build := "b1"
	_, region := newTestServer(t, &build)
	c := New("test")

	p, err := c.FetchProduct(context.Background(), region, "widget")
	if err != nil {
		t.Fatal(err)
	}
	if p.ID != "p1" || len(p.Variants) != 1 {
		t.Fatalf("unexpected product: %+v", p)
	}
	v := p.Variants[0]
	if v.Status != "SoldOut" || v.Price == nil || v.Price.Amount != 10900 || v.RegularPrice != nil {
		t.Errorf("unexpected variant: %+v", v)
	}
}

func TestFetchProductFollowsRedirect(t *testing.T) {
	build := "b1"
	_, region := newTestServer(t, &build)
	p, err := New("test").FetchProduct(context.Background(), region, "old-widget")
	if err != nil {
		t.Fatal(err)
	}
	if p.Slug != "widget" {
		t.Errorf("got slug %q", p.Slug)
	}
}

func TestFetchProductRefreshesStaleBuildID(t *testing.T) {
	build := "b1"
	_, region := newTestServer(t, &build)
	c := New("test")
	if _, err := c.FetchProduct(context.Background(), region, "widget"); err != nil {
		t.Fatal(err)
	}
	build = "b2" // store deploys
	if _, err := c.FetchProduct(context.Background(), region, "widget"); err != nil {
		t.Fatalf("should recover from a stale buildId: %v", err)
	}
}

func TestFetchProductErrors(t *testing.T) {
	build := "b1"
	_, region := newTestServer(t, &build)
	c := New("test")

	if _, err := c.FetchProduct(context.Background(), region, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("want ErrNotFound, got %v", err)
	}
	if _, err := c.FetchProduct(context.Background(), region, "category-thing"); !errors.Is(err, ErrSchema) {
		t.Errorf("want ErrSchema, got %v", err)
	}
}

func TestBlockedStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := New("test").FetchProduct(context.Background(), config.Region{BaseURL: srv.URL, Path: "us/en"}, "widget")
	var he *HTTPError
	if !errors.As(err, &he) || !he.Blocked() || he.RetryAfter.Seconds() != 30 {
		t.Fatalf("want blocked HTTPError with Retry-After, got %v", err)
	}
}

const categoryJSON = `{"pageProps":{"subCategories":[
	{"id":"cat-a","products":[
		{"id":"p1","slug":"widget","name":"Widget","title":"Widget Title","variants":[
			{"id":"v1","sku":"W-1","title":"US","status":"SoldOut","displayPrice":{"amount":10900,"currency":"USD"},
			 "displayRegularPrice":null,"restockEtaAt":null}]},
		{"id":"empty","slug":"empty","name":"Empty","title":"Empty","variants":[]}]},
	{"id":"cat-b","products":[
		{"id":"p2","slug":"gadget","name":"Gadget","title":"Gadget","variants":[
			{"id":"v2","sku":"G-1","title":"US","status":"Available","displayPrice":{"amount":500,"currency":"USD"},
			 "displayRegularPrice":null,"restockEtaAt":null}]},
		{"id":"p1","slug":"widget","name":"Widget","title":"Widget Title","variants":[]}]}]}}`

// newCategoryServer serves categoryJSON, encoding it as the request allows
// (or as forced, to cover encodings the client didn't ask for).
func newCategoryServer(t *testing.T, force string) (config.Region, *[]string) {
	t.Helper()
	var encodings []string
	mux := http.NewServeMux()
	mux.HandleFunc("/us/en", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`..."buildId":"b1"...`))
	})
	mux.HandleFunc("/_next/data/b1/us/en/category/{id}", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("id") != "cat-a.json" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"notFound":true}`))
			return
		}
		ae := r.Header.Get("Accept-Encoding")
		encodings = append(encodings, ae)
		enc := force
		if enc == "" {
			switch {
			case strings.Contains(ae, "deflate"):
				enc = "deflate"
			case strings.Contains(ae, "gzip"):
				enc = "gzip"
			}
		}
		var buf bytes.Buffer
		switch enc {
		case "gzip":
			zw := gzip.NewWriter(&buf)
			_, _ = zw.Write([]byte(categoryJSON))
			_ = zw.Close()
		case "deflate":
			zw := zlib.NewWriter(&buf)
			_, _ = zw.Write([]byte(categoryJSON))
			_ = zw.Close()
		case "raw-deflate":
			zw, _ := flate.NewWriter(&buf, flate.DefaultCompression)
			_, _ = zw.Write([]byte(categoryJSON))
			_ = zw.Close()
			enc = "deflate"
		default:
			buf.WriteString(categoryJSON)
		}
		if enc != "" {
			w.Header().Set("Content-Encoding", enc)
		}
		_, _ = w.Write(buf.Bytes())
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return config.Region{ID: "us", BaseURL: srv.URL, Path: "us/en"}, &encodings
}

func TestFetchCategory(t *testing.T) {
	for _, enc := range []string{"", "gzip", "deflate", "raw-deflate", "identity"} {
		t.Run("encoding="+enc, func(t *testing.T) {
			region, asked := newCategoryServer(t, enc)
			cat, err := New("test").FetchCategory(context.Background(), region, "cat-a")
			if err != nil {
				t.Fatal(err)
			}
			if got := strings.Join(cat.Subcategories, ","); got != "cat-a,cat-b" {
				t.Errorf("subcategories: %s", got)
			}
			// "empty" has no variants and p1 repeats (without variants) under cat-b.
			if len(cat.Products) != 2 || cat.Skipped != 1 {
				t.Fatalf("want 2 products and 1 skipped, got %+v", cat)
			}
			if p := cat.Products[0]; p.ID != "p1" || p.Category != "cat-a" || p.Variants[0].Price.Amount != 10900 {
				t.Errorf("unexpected first product: %+v", p)
			}
			if p := cat.Products[1]; p.ID != "p2" || p.Category != "cat-b" {
				t.Errorf("a product takes the category listing it: %+v", p)
			}
			if len(*asked) != 1 || !strings.Contains((*asked)[0], "deflate") || !strings.Contains((*asked)[0], "gzip") {
				t.Errorf("should advertise gzip and deflate, sent %q", *asked)
			}
		})
	}
}

func TestFetchCategoryErrors(t *testing.T) {
	region, _ := newCategoryServer(t, "")
	c := New("test")
	if _, err := c.FetchCategory(context.Background(), region, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("want ErrNotFound, got %v", err)
	}

	build := "b1"
	_, productRegion := newTestServer(t, &build)
	// The product test server answers category paths with a 404 that lacks the notFound marker.
	if _, err := c.FetchCategory(context.Background(), productRegion, "x"); err == nil {
		t.Error("an unexpected 404 should be an error")
	}
}

func TestRejectsUnknownContentEncoding(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Encoding", "br")
		_, _ = w.Write([]byte("whatever"))
	}))
	defer srv.Close()
	if _, err := New("test").FetchProduct(context.Background(), config.Region{BaseURL: srv.URL, Path: "us/en"}, "widget"); err == nil {
		t.Fatal("an encoding we can't decode must be an error, not garbage")
	}
}

func TestConvertProductTags(t *testing.T) {
	parse := func(js string) *Product {
		t.Helper()
		var raw rawProduct
		if err := json.Unmarshal([]byte(js), &raw); err != nil {
			t.Fatal(err)
		}
		p, err := convertProduct(&raw)
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	const variants = `"variants":[{"id":"v","status":"Available"}]`

	p := parse(`{"id":"p","slug":"s","tags":[{"name":"feature:color-black"},{"name":"black-friday"},
		{"name":"pro-sort-weight:4075"},{"name":"techspecs-sort-weight:9585"},{"name":"black-friday"},{"name":""}],` + variants + `}`)
	if got := strings.Join(p.Tags, ","); got != "black-friday,feature:color-black" {
		t.Errorf("tags should be sorted, de-duplicated and free of sort weights, got %q", got)
	}

	if p := parse(`{"id":"p","slug":"s","tags":[],` + variants + `}`); p.Tags == nil || len(p.Tags) != 0 {
		t.Errorf("an empty list means no tags, got %#v", p.Tags)
	}
	if p := parse(`{"id":"p","slug":"s",` + variants + `}`); p.Tags != nil {
		t.Errorf("a missing list means unknown, got %#v", p.Tags)
	}
}

func TestConvertProductCollection(t *testing.T) {
	parse := func(js string) *Product {
		t.Helper()
		var raw rawProduct
		if err := json.Unmarshal([]byte(js), &raw); err != nil {
			t.Fatal(err)
		}
		p, err := convertProduct(&raw)
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	const variants = `"variants":[{"id":"v","status":"Available"}]`
	if p := parse(`{"id":"p","slug":"s","proCollectionSlug":"pro-c","organizationalCollectionSlug":"org-c",` + variants + `}`); p.Collection != "pro-c" {
		t.Errorf("pro collection slug should win, got %q", p.Collection)
	}
	if p := parse(`{"id":"p","slug":"s","organizationalCollectionSlug":"org-c",` + variants + `}`); p.Collection != "org-c" {
		t.Errorf("organizational slug is the fallback, got %q", p.Collection)
	}
	if p := parse(`{"id":"p","slug":"s",` + variants + `}`); p.Collection != "" {
		t.Errorf("no slug means standalone, got %q", p.Collection)
	}
}
