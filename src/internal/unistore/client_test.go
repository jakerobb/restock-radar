package unistore

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
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
