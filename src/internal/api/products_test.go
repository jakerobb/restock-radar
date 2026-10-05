package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jakerobb/restock-radar/internal/config"
	"github.com/jakerobb/restock-radar/internal/metrics"
	"github.com/jakerobb/restock-radar/internal/poller"
	"github.com/jakerobb/restock-radar/internal/store"
	"github.com/jakerobb/restock-radar/internal/unistore"
)

type fakePoller struct {
	res *poller.AddResult
	err error
	got addItemRequest
}

func (f *fakePoller) LastCycle() time.Time { return time.Time{} }
func (f *fakePoller) Metrics() *metrics.Metrics {
	return metrics.New(time.Unix(1_000, 0))
}
func (f *fakePoller) Add(_ context.Context, input, region string) (*poller.AddResult, error) {
	f.got = addItemRequest{Item: input, Region: region}
	return f.res, f.err
}

func newTestServer(t *testing.T) (*Server, *fakePoller) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	now := time.Now()
	price := func(a int64) *unistore.Money { return &unistore.Money{Amount: a, Currency: "USD"} }
	for _, p := range []*unistore.Product{
		{ID: "p2", Slug: "zeta", Title: "Zeta Cam", Variants: []unistore.Variant{
			{ID: "v3", SKU: "ZETA-B", Title: "Black", Status: "Available", Price: price(19900)},
			{ID: "v4", SKU: "ZETA-W", Title: "White", Status: "SoldOut", Price: price(24900), RegularPrice: price(29900)}}},
		{ID: "p1", Slug: "alpha", Title: "Alpha Switch", Variants: []unistore.Variant{
			{ID: "v1", SKU: "ALPHA", Title: "Default", Status: "SoldOut", Price: price(10900)}}},
	} {
		if _, err := st.Apply(context.Background(), "us", p, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.AddItem(context.Background(), "us", "waiting-slug", store.SourceUI, "", now); err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{Regions: []config.Region{{ID: "us", BaseURL: "https://store.example", Path: "us/en"}}}
	fp := &fakePoller{}
	return New(st, fp, cfg), fp
}

func request(srv *Server, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

var jsonHeader = map[string]string{"Content-Type": "application/json"}

func TestProductsGroupsVariants(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := request(srv, "GET", "/v1/products", "", nil)
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	var got productsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}

	if len(got.Products) != 2 || got.Products[0].Title != "Alpha Switch" || got.Products[1].Title != "Zeta Cam" {
		t.Fatalf("products should be two, ordered by title: %+v", got.Products)
	}
	zeta := got.Products[1]
	if len(zeta.Variants) != 2 || zeta.URL != "https://store.example/us/en/products/zeta" {
		t.Errorf("variants must be grouped under their product: %+v", zeta)
	}
	if v := zeta.Variants[1]; v.RegularPriceCents == nil || *v.RegularPriceCents != 29900 || *v.PriceCents != 24900 {
		t.Errorf("discount lost: %+v", v)
	}
	if got.LastSync == nil || time.Since(*got.LastSync) > time.Minute {
		t.Errorf("last_sync should be recent: %v", got.LastSync)
	}
	if len(got.Pending) != 1 || got.Pending[0].Slug != "waiting-slug" || len(got.Regions) != 1 {
		t.Errorf("pending/regions wrong: %+v %+v", got.Pending, got.Regions)
	}
}

func TestProductsEmptyIsArraysNotNull(t *testing.T) {
	st, _ := store.Open(filepath.Join(t.TempDir(), "e.db"))
	t.Cleanup(func() { _ = st.Close() })
	srv := New(st, &fakePoller{}, &config.Config{Regions: []config.Region{{ID: "us"}}})
	body := request(srv, "GET", "/v1/products", "", nil).Body.String()
	for _, want := range []string{`"products":[]`, `"pending":[]`, `"last_sync":null`} {
		if !strings.Contains(body, want) {
			t.Errorf("empty response missing %s: %s", want, body)
		}
	}
}

func TestAddItem(t *testing.T) {
	srv, fp := newTestServer(t)

	fp.res = &poller.AddResult{Region: "us", Slug: "ucg-fiber", Title: "Cloud Gateway Fiber", Variants: 1}
	rec := request(srv, "POST", "/v1/items", `{"item":"UCG-Fiber","region":"us"}`, jsonHeader)
	var ok addItemResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &ok); err != nil || rec.Code != 200 || ok.Title != "Cloud Gateway Fiber" || ok.AlreadyTracked {
		t.Fatalf("success: %d %s", rec.Code, rec.Body.String())
	}
	if fp.got.Item != "UCG-Fiber" || fp.got.Region != "us" {
		t.Errorf("input not passed through: %+v", fp.got)
	}

	fp.res = &poller.AddResult{Title: "X", AlreadyTracked: true}
	if rec := request(srv, "POST", "/v1/items", `{"item":"x"}`, jsonHeader); !strings.Contains(rec.Body.String(), `"already_tracked":true`) {
		t.Errorf("already tracked flag missing: %s", rec.Body.String())
	}

	fp.res, fp.err = nil, &poller.UserError{Msg: `no product "x"`}
	rec = request(srv, "POST", "/v1/items", `{"item":"x"}`, jsonHeader)
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), `no product`) {
		t.Errorf("user error: %d %s", rec.Code, rec.Body.String())
	}

	fp.err = errors.New("dial tcp: secret internal detail")
	rec = request(srv, "POST", "/v1/items", `{"item":"x"}`, jsonHeader)
	if rec.Code != 502 || strings.Contains(rec.Body.String(), "secret internal detail") {
		t.Errorf("internal errors must not leak: %d %s", rec.Code, rec.Body.String())
	}
}

func TestAddItemRejectsBadRequests(t *testing.T) {
	srv, fp := newTestServer(t)
	fp.res = &poller.AddResult{Title: "X", Variants: 1}

	cases := []struct {
		name    string
		body    string
		headers map[string]string
		want    int
	}{
		{"form post", "item=x", map[string]string{"Content-Type": "application/x-www-form-urlencoded"}, 415},
		{"text/plain post", `{"item":"x"}`, map[string]string{"Content-Type": "text/plain"}, 415},
		{"malformed JSON", `{`, jsonHeader, 400},
		{"foreign origin", `{"item":"x"}`, map[string]string{"Content-Type": "application/json", "Origin": "https://evil.example"}, 403},
		{"cross-site fetch", `{"item":"x"}`, map[string]string{"Content-Type": "application/json", "Sec-Fetch-Site": "cross-site"}, 403},
		{"same origin", `{"item":"x"}`, map[string]string{"Content-Type": "application/json", "Origin": "http://example.com"}, 200},
		{"same-origin fetch", `{"item":"x"}`, map[string]string{"Content-Type": "application/json", "Sec-Fetch-Site": "same-origin"}, 200},
		{"charset parameter", `{"item":"x"}`, map[string]string{"Content-Type": "application/json; charset=utf-8"}, 200},
	}
	for _, c := range cases {
		if rec := request(srv, "POST", "/v1/items", c.body, c.headers); rec.Code != c.want {
			t.Errorf("%s: want %d, got %d", c.name, c.want, rec.Code)
		}
	}
}

func TestUnknownAPIPathIsNotTheUI(t *testing.T) {
	srv, _ := newTestServer(t)
	if rec := request(srv, "GET", "/v1/nope", "", nil); rec.Code != http.StatusNotFound {
		t.Errorf("want 404, got %d", rec.Code)
	}
}

func TestMetricsEndpoint(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := request(srv, "GET", "/metrics", "", nil)
	if rec.Code != 200 || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/plain; version=0.0.4") {
		t.Fatalf("status %d, type %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	body := rec.Body.String()
	for _, want := range []string{
		"restock_radar_last_success_timestamp_seconds 1000",
		"restock_radar_watched_items 1",                // the one pending item the fixture adds
		`restock_radar_variants{status="Available"} 1`, // from the fixture's products
		`restock_radar_variants{status="SoldOut"} 2`,
		"restock_radar_pending_events 0",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in:\n%s", want, body)
		}
	}
}
