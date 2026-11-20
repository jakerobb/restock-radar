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

	refreshRes *poller.RefreshResult
	refreshErr error
	refreshed  []string
}

func (f *fakePoller) Refresh(_ context.Context, region, slug string) (*poller.RefreshResult, error) {
	f.refreshed = append(f.refreshed, region+"/"+slug)
	return f.refreshRes, f.refreshErr
}

func (f *fakePoller) LastCycle() time.Time { return time.Time{} }
func (f *fakePoller) Diagnostics() poller.Diagnostics {
	return poller.Diagnostics{Cycles: 3, BackoffFactor: 2, Failing: []poller.ItemFailure{
		{Item: "us/widget", Consecutive: 4, Alerted: true, LastError: "boom", Result: "error"}}}
}
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
		{ID: "p2", Slug: "zeta", Title: "Zeta Cam", Collection: "cams", Tags: []string{"black-friday", "feature:4k"}, Variants: []unistore.Variant{
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
	if len(zeta.Tags) != 2 || zeta.Tags[0] != "black-friday" || got.Products[0].Tags == nil || len(got.Products[0].Tags) != 0 {
		t.Errorf("tags should be listed, and be [] rather than null when there are none: %+v / %+v", zeta.Tags, got.Products[0].Tags)
	}
	if zeta.Collection != "cams" || got.Products[0].Collection != "" {
		t.Errorf("collection should be passed through: %q / %q", zeta.Collection, got.Products[0].Collection)
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

func TestSecurityHeaders(t *testing.T) {
	srv, _ := newTestServer(t)
	for _, path := range []string{"/", "/v1/products", "/metrics", "/health", "/nope.js"} {
		h := request(srv, "GET", path, "", nil).Header()
		for k, want := range map[string]string{
			"X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
		} {
			if h.Get(k) != want {
				t.Errorf("%s: %s = %q, want %q", path, k, h.Get(k), want)
			}
		}
		if csp := h.Get("Content-Security-Policy"); !strings.Contains(csp, "default-src 'none'") || !strings.Contains(csp, "frame-ancestors 'none'") || strings.Contains(csp, "unsafe") {
			t.Errorf("%s: weak CSP %q", path, csp)
		}
	}
	for _, path := range []string{"/v1/products", "/metrics"} {
		if got := request(srv, "GET", path, "", nil).Header().Get("Cache-Control"); got != "no-store" {
			t.Errorf("%s should not be cacheable, got %q", path, got)
		}
	}
}

func TestAddItemIsRateLimited(t *testing.T) {
	srv, fp := newTestServer(t)
	fp.res = &poller.AddResult{Title: "X", Variants: 1}

	for i := 0; i < addsPerWindow; i++ {
		if rec := request(srv, "POST", "/v1/items", `{"item":"x"}`, jsonHeader); rec.Code != 200 {
			t.Fatalf("add %d: status %d", i, rec.Code)
		}
	}
	rec := request(srv, "POST", "/v1/items", `{"item":"x"}`, jsonHeader)
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("want 429 with Retry-After, got %d %v", rec.Code, rec.Header())
	}
	// Requests that never reach the store don't use up the allowance.
	srv2, fp2 := newTestServer(t)
	fp2.res = &poller.AddResult{Title: "X", Variants: 1}
	for i := 0; i < addsPerWindow+5; i++ {
		request(srv2, "POST", "/v1/items", `{`, jsonHeader) // malformed
	}
	if rec := request(srv2, "POST", "/v1/items", `{"item":"x"}`, jsonHeader); rec.Code == http.StatusTooManyRequests {
		t.Error("malformed requests must not count against the limit")
	}
}

func TestWindowLimiterSlides(t *testing.T) {
	now := time.Unix(0, 0)
	l := newWindowLimiter(2, time.Minute)
	l.now = func() time.Time { return now }

	if ok, _ := l.allow(); !ok {
		t.Fatal("first should pass")
	}
	now = now.Add(30 * time.Second)
	if ok, _ := l.allow(); !ok {
		t.Fatal("second should pass")
	}
	if ok, wait := l.allow(); ok || wait != 30*time.Second {
		t.Fatalf("third should wait for the first to age out, got ok=%v wait=%v", ok, wait)
	}
	now = now.Add(31 * time.Second)
	if ok, _ := l.allow(); !ok {
		t.Fatal("should pass once the first has aged out")
	}
}

func TestHistory(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := request(srv, "GET", "/v1/history", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var resp struct {
		Variants []struct {
			VariantID string `json:"variant_id"`
			Points    []struct {
				Status string `json:"status"`
			} `json:"points"`
		} `json:"variants"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Variants) != 3 || len(resp.Variants[0].Points) != 1 {
		t.Fatalf("unexpected history: %s", rec.Body)
	}
	if rec := request(srv, "GET", "/v1/history?days=0", "", nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("days=0 gave %d", rec.Code)
	}
}

func TestStatus(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := request(srv, "GET", "/v1/status", "", nil)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var got statusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Products != 2 || got.Variants != 3 || got.LastSync == nil || time.Since(*got.LastSync) > time.Minute {
		t.Errorf("counts or last sync wrong: %+v", got)
	}
	if got.Categories == nil || got.Regions["us"] != 2 || got.Specs.Without != 2 || got.TechSpecsURL.Without != 2 {
		t.Errorf("breakdowns wrong: %+v", got)
	}
}

func TestRefreshProduct(t *testing.T) {
	srv, fp := newTestServer(t)
	fp.refreshRes = &poller.RefreshResult{Region: "us", Slug: "zeta", Title: "Zeta Cam", Variants: 2, SpecEntries: 41, SpecsChanged: true, Events: 1}

	rec := request(srv, "POST", "/v1/products/us/zeta/refresh", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	var got refreshResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if want := (refreshResponse{Region: "us", Slug: "zeta", Title: "Zeta Cam", Variants: 2, SpecEntries: 41, SpecsChanged: true, Events: 1}); got != want {
		t.Errorf("response = %+v, want %+v", got, want)
	}
	if len(fp.refreshed) != 1 || fp.refreshed[0] != "us/zeta" {
		t.Errorf("refreshed %v", fp.refreshed)
	}
}

func TestRefreshProductErrors(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"not tracked", poller.ErrNotTracked, http.StatusNotFound},
		{"user error", &poller.UserError{Msg: "the us store no longer has it"}, http.StatusBadRequest},
		{"store trouble", errors.New("dial tcp: boom"), http.StatusBadGateway},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv, fp := newTestServer(t)
			fp.refreshErr = c.err
			rec := request(srv, "POST", "/v1/products/us/zeta/refresh", "", nil)
			if rec.Code != c.want {
				t.Fatalf("status = %d, want %d: %s", rec.Code, c.want, rec.Body)
			}
			// Internal detail (the dial error) must not reach the client.
			if strings.Contains(rec.Body.String(), "boom") {
				t.Errorf("leaked internal error: %s", rec.Body)
			}
		})
	}
}

func TestRefreshProductRefusesCrossSiteRequests(t *testing.T) {
	srv, fp := newTestServer(t)
	for _, h := range []map[string]string{
		{"Origin": "https://evil.example"},
		{"Sec-Fetch-Site": "cross-site"},
	} {
		rec := request(srv, "POST", "/v1/products/us/zeta/refresh", "", h)
		if rec.Code != http.StatusForbidden {
			t.Errorf("%v: status = %d, want 403", h, rec.Code)
		}
	}
	if len(fp.refreshed) != 0 {
		t.Errorf("a cross-site request reached the poller: %v", fp.refreshed)
	}
}

func TestRefreshProductIsPostOnlyAndRateLimited(t *testing.T) {
	srv, fp := newTestServer(t)
	fp.refreshRes = &poller.RefreshResult{Region: "us", Slug: "zeta"}
	if rec := request(srv, "GET", "/v1/products/us/zeta/refresh", "", nil); rec.Code == http.StatusOK {
		t.Errorf("GET refreshed a product")
	}
	var limited bool
	for range refreshesPerWindow + 1 {
		if request(srv, "POST", "/v1/products/us/zeta/refresh", "", nil).Code == http.StatusTooManyRequests {
			limited = true
		}
	}
	if !limited {
		t.Errorf("%d refreshes in a minute were all allowed", refreshesPerWindow+1)
	}
	if len(fp.refreshed) > refreshesPerWindow {
		t.Errorf("%d refreshes reached the poller, limit %d", len(fp.refreshed), refreshesPerWindow)
	}
}

func TestStatusBreaksDownByRegion(t *testing.T) {
	srv, _ := newTestServer(t)
	srv.cfg.PollInterval = 5 * time.Minute
	srv.cfg.Regions = append(srv.cfg.Regions,
		config.Region{ID: "eu", BaseURL: "https://eu.store.example", Path: "eu/en", PollEvery: time.Hour},
		config.Region{ID: "uk", BaseURL: "https://uk.store.example", Path: "uk/en", PollEvery: time.Minute}, // shorter than a cycle: read every cycle
	)
	// A variant in a region that is read hourly, last checked two hours ago, and one in the US checked half an hour ago.
	ctx := context.Background()
	if _, err := srv.store.Apply(ctx, "eu", &unistore.Product{ID: "e1", Slug: "zeta", Title: "Zeta Cam", Variants: []unistore.Variant{
		{ID: "ev1", SKU: "ZETA-B-EU", Title: "Black", Status: "Available", Price: &unistore.Money{Amount: 17900, Currency: "EUR"}}}}, time.Now().Add(-2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := srv.store.Apply(ctx, "us", &unistore.Product{ID: "p1", Slug: "alpha", Title: "Alpha Switch", Variants: []unistore.Variant{
		{ID: "v1", SKU: "ALPHA", Title: "Default", Status: "SoldOut", Price: &unistore.Money{Amount: 10900, Currency: "USD"}}}}, time.Now().Add(-30*time.Minute)); err != nil {
		t.Fatal(err)
	}

	rec := request(srv, "GET", "/v1/status", "", nil)
	var got statusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.ByRegion) != 3 || got.ByRegion[0].Region != "us" || got.ByRegion[1].Region != "eu" || got.ByRegion[2].Region != "uk" {
		t.Fatalf("every configured region, in config order: %+v", got.ByRegion)
	}
	us, eu, uk := got.ByRegion[0], got.ByRegion[1], got.ByRegion[2]
	if us.ReadEverySeconds != 300 || us.OverdueAfterSeconds != 900 || us.Variants != 3 || us.Products != 2 {
		t.Errorf("US: %+v", us)
	}
	// Half an hour is long past three 5-minute cycles for the US's variants; for the hourly EU region two hours is not yet three.
	if us.OverdueVariants == 0 {
		t.Errorf("US variants checked at test setup and half an hour ago are overdue at 15 minutes: %+v", us)
	}
	if eu.ReadEverySeconds != 3600 || eu.OverdueAfterSeconds != 10800 || eu.Variants != 1 || eu.InStock != 1 || eu.OverdueVariants != 0 || eu.OldestCheck == nil {
		t.Errorf("EU: %+v", eu)
	}
	if uk.ReadEverySeconds != 300 || uk.Variants != 0 || uk.LastCheck != nil || uk.OverdueVariants != 0 {
		t.Errorf("UK, which holds nothing, is still listed: %+v", uk)
	}
}

func TestDebugPoller(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := request(srv, "GET", "/v1/debug/poller", "", nil)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	for _, want := range []string{`"cycles":3`, `"backoff_factor":2`, `"item":"us/widget"`, `"last_error":"boom"`, `"alerted":true`} {
		if !strings.Contains(rec.Body.String(), want) {
			t.Errorf("response missing %s: %s", want, rec.Body)
		}
	}
}
