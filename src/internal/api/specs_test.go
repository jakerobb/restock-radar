package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jakerobb/restock-radar/internal/config"
	"github.com/jakerobb/restock-radar/internal/store"
	"github.com/jakerobb/restock-radar/internal/unistore"
)

func txt(section, id, parent, label, value string) unistore.Spec {
	return unistore.Spec{SectionID: "s-" + section, Section: section, SectionType: "Standard", FeatureID: id, ParentID: parent, Label: label, Kind: unistore.SpecText, Value: value}
}

func grp(section, id, label string) unistore.Spec {
	return unistore.Spec{SectionID: "s-" + section, Section: section, SectionType: "Standard", FeatureID: id, Label: label, Kind: unistore.SpecGroup}
}

// newSpecsServer is a server with a gateway whose specification has been stored
// (and so derived), and an accessory with none.
func newSpecsServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	now := time.Now()
	gw := &unistore.Product{
		ID: "p-gw", Slug: "ucg-fiber", Name: "UCG-Fiber", Title: "Cloud Gateway Fiber", Category: "cloud-gateways-compact", Detailed: true,
		Variants: []unistore.Variant{{ID: "v1", SKU: "UCG-Fiber", Title: "US", Status: "Available", Price: &unistore.Money{Amount: 27900, Currency: "USD"}}},
		Specs: []unistore.Spec{
			txt("Overview", "f-ids", "", "IDS/IPS Throughput", "5 Gbps"),
			txt("Overview", "f-form", "", "Form Factor", "Compact desktop"),
			grp("Overview", "g-ports", "Port Layout"),
			txt("Overview", "f-p25", "g-ports", "2.5 GbE RJ45", "4\n(2.5G/1G/100M/10M)"),
			txt("Overview", "f-p10", "g-ports", "10 GbE RJ45", "1\n(10G/2.5G/1G)"),
			txt("Overview", "f-budget", "", "PoE Budget", "30W"),
		},
	}
	acc := &unistore.Product{
		ID: "p-acc", Slug: "plain-cover", Name: "Cover", Title: "Cover", Category: "accessories", Detailed: true,
		Variants: []unistore.Variant{{ID: "v2", SKU: "COVER", Title: "US", Status: "Available", Price: &unistore.Money{Amount: 1000, Currency: "USD"}}},
	}
	for _, p := range []*unistore.Product{gw, acc} {
		if _, err := st.Apply(context.Background(), "us", p, now); err != nil {
			t.Fatal(err)
		}
	}
	cfg := &config.Config{Regions: []config.Region{{ID: "us", BaseURL: "https://store.example", Path: "us/en"}}}
	return New(st, &fakePoller{}, cfg), st
}

func decode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("decoding %q: %v", rec.Body.String(), err)
	}
	return v
}

func putOverride(srv *Server, body string) *httptest.ResponseRecorder {
	return request(srv, "PUT", "/v1/overrides", body, jsonHeader)
}

const idsBody = `{"region":"us","slug":"ucg-fiber","action":"set","section":"Overview","label":"IDS/IPS Throughput","value":"8+ Gbps","source_url":"https://example.com/teardown","reason":"teardown"}`

func TestProductSpecs(t *testing.T) {
	srv, _ := newSpecsServer(t)
	rec := request(srv, "GET", "/v1/products/us/ucg-fiber/specs", "", nil)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	got := decode[map[string]any](t, rec)
	if got["slug"] != "ucg-fiber" || got["title"] != "Cloud Gateway Fiber" || got["region"] != "us" {
		t.Errorf("product = %v", got)
	}
	specsList := got["specs"].([]any)
	if len(specsList) != 6 {
		t.Fatalf("%d specs", len(specsList))
	}
	first := specsList[0].(map[string]any)
	if first["label"] != "IDS/IPS Throughput" || first["origin"] != "published" || first["value"] != "5 Gbps" || first["section"] != "Overview" {
		t.Errorf("first spec = %v", first)
	}
	if ov := got["overrides"].([]any); len(ov) != 0 {
		t.Errorf("overrides = %v", ov)
	}
	derived := got["derived"].(map[string]any)
	if len(derived["ports"].([]any)) != 2 || derived["known"].(map[string]any)["ports"] != true {
		t.Errorf("derived = %v", derived)
	}
	if !strings.Contains(rec.Header().Get("Cache-Control"), "no-store") {
		t.Error("API responses must not be cached")
	}
}

func TestProductSpecsForAProductWithNone(t *testing.T) {
	srv, _ := newSpecsServer(t)
	rec := request(srv, "GET", "/v1/products/us/plain-cover/specs", "", nil)
	got := decode[map[string]any](t, rec)
	if rec.Code != 200 || got["derived"] != nil || len(got["specs"].([]any)) != 0 || got["overrides"] == nil {
		t.Errorf("status %d: %s", rec.Code, rec.Body)
	}
}

func TestProductSpecsUnknownProduct(t *testing.T) {
	srv, _ := newSpecsServer(t)
	for _, path := range []string{"/v1/products/us/nope/specs", "/v1/products/eu/ucg-fiber/specs"} {
		if rec := request(srv, "GET", path, "", nil); rec.Code != 404 {
			t.Errorf("%s: status %d", path, rec.Code)
		}
	}
}

func TestPutOverrideAppliesImmediately(t *testing.T) {
	srv, _ := newSpecsServer(t)
	rec := putOverride(srv, idsBody)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	got := decode[map[string]any](t, rec)
	if got["id"].(float64) < 1 || got["status"] != "overrides" || got["value"] != "8+ Gbps" || got["published_value"] != "5 Gbps" ||
		got["published_now"] != "5 Gbps" || got["stale"] != false || got["source_url"] != "https://example.com/teardown" || got["slug"] != "ucg-fiber" {
		t.Errorf("override = %v", got)
	}

	spec := decode[map[string]any](t, request(srv, "GET", "/v1/products/us/ucg-fiber/specs", "", nil))
	entry := spec["specs"].([]any)[0].(map[string]any)
	if entry["value"] != "8+ Gbps" || entry["origin"] != "override" || entry["published_value"] != "5 Gbps" || entry["override_id"] != got["id"] {
		t.Errorf("entry = %v", entry)
	}
	derived := spec["derived"].(map[string]any)
	var found map[string]any
	for _, m := range derived["metrics"].([]any) {
		if m.(map[string]any)["name"] == "ids_ips_throughput_mbps" {
			found = m.(map[string]any)
		}
	}
	if found == nil || found["value"] != float64(8000) || found["at_least"] != true {
		t.Errorf("metric = %v", found)
	}
	over := derived["overridden"].(map[string]any)["metrics"].([]any)
	if len(over) != 1 || over[0].(map[string]any)["published"].(map[string]any)["value"] != float64(5000) {
		t.Errorf("overridden = %v", over)
	}
	if ovs := spec["overrides"].([]any); len(ovs) != 1 {
		t.Errorf("overrides = %v", ovs)
	}
}

func TestPutOverrideDefaultsTheOnlyRegion(t *testing.T) {
	srv, _ := newSpecsServer(t)
	body := `{"slug":"ucg-fiber","action":"set","section":"Overview","label":"IDS/IPS Throughput","value":"8 Gbps"}`
	if rec := putOverride(srv, body); rec.Code != 200 {
		t.Errorf("status %d: %s", rec.Code, rec.Body)
	}
}

func TestPutOverrideTwiceReplaces(t *testing.T) {
	srv, _ := newSpecsServer(t)
	a := decode[map[string]any](t, putOverride(srv, idsBody))
	b := decode[map[string]any](t, putOverride(srv, strings.Replace(idsBody, "8+ Gbps", "9 Gbps", 1)))
	if a["id"] != b["id"] || b["value"] != "9 Gbps" {
		t.Errorf("a = %v b = %v", a, b)
	}
	list := decode[[]map[string]any](t, request(srv, "GET", "/v1/overrides", "", nil))
	if len(list) != 1 {
		t.Errorf("%d overrides", len(list))
	}
}

func TestPutOverrideHide(t *testing.T) {
	srv, _ := newSpecsServer(t)
	rec := putOverride(srv, `{"slug":"ucg-fiber","action":"hide","section":"Overview","label":"PoE Budget"}`)
	if rec.Code != 200 || decode[map[string]any](t, rec)["status"] != "hides" {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	d := decode[map[string]any](t, request(srv, "GET", "/v1/products/us/ucg-fiber/specs", "", nil))["derived"].(map[string]any)
	if len(d["poe_budget"].([]any)) != 0 {
		t.Errorf("budget = %v", d["poe_budget"])
	}
}

func TestPutOverrideRejectsBadRequests(t *testing.T) {
	srv, _ := newSpecsServer(t)
	long := strings.Repeat("x", 3000)
	for _, tc := range []struct {
		name    string
		body    string
		headers map[string]string
		status  int
		msg     string
	}{
		{"not JSON", `nope`, jsonHeader, 400, "malformed"},
		{"an unknown field", `{"slug":"ucg-fiber","action":"set","section":"A","label":"B","value":"1","colour":"red"}`, jsonHeader, 400, "malformed"},
		{"the wrong content type", idsBody, map[string]string{"Content-Type": "text/plain"}, 415, "application/json"},
		{"no content type", idsBody, nil, 415, "application/json"},
		{"a cross-site origin", idsBody, map[string]string{"Content-Type": "application/json", "Origin": "https://evil.example"}, 403, "cross-site"},
		{"a cross-site fetch", idsBody, map[string]string{"Content-Type": "application/json", "Sec-Fetch-Site": "cross-site"}, 403, "cross-site"},
		{"an unknown region", strings.Replace(idsBody, `"us"`, `"eu"`, 1), jsonHeader, 400, "unknown region"},
		{"no slug", strings.Replace(idsBody, `"ucg-fiber"`, `""`, 1), jsonHeader, 400, "slug is required"},
		{"an unknown product", strings.Replace(idsBody, `"ucg-fiber"`, `"nope"`, 1), jsonHeader, 404, "unknown product"},
		{"a bad action", strings.Replace(idsBody, `"set"`, `"remove"`, 1), jsonHeader, 400, "action"},
		{"no label", strings.Replace(idsBody, `"label":"IDS/IPS Throughput"`, `"label":""`, 1), jsonHeader, 400, "section and label"},
		{"no value", strings.Replace(idsBody, `"value":"8+ Gbps"`, `"value":""`, 1), jsonHeader, 400, "value is required"},
		{"a too-long value", strings.Replace(idsBody, `8+ Gbps`, long, 1), jsonHeader, 400, "value is too long"},
		{"a too-long label", strings.Replace(idsBody, `IDS/IPS Throughput`, long, 1), jsonHeader, 400, "label is too long"},
		{"a javascript URL", strings.Replace(idsBody, `https://example.com/teardown`, `javascript:alert(1)`, 1), jsonHeader, 400, "http or https"},
		{"a relative URL", strings.Replace(idsBody, `https://example.com/teardown`, `/teardown`, 1), jsonHeader, 400, "http or https"},
		{"a group heading", strings.Replace(idsBody, `"label":"IDS/IPS Throughput"`, `"label":"Port Layout"`, 1), jsonHeader, 400, "group heading"},
		{"hiding nothing", `{"slug":"ucg-fiber","action":"hide","section":"Overview","label":"Nope"}`, jsonHeader, 400, "nothing to hide"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := putOverride2(srv, tc.body, tc.headers)
			if rec.Code != tc.status {
				t.Fatalf("status %d (%s), want %d", rec.Code, rec.Body, tc.status)
			}
			if msg := decode[map[string]string](t, rec)["error"]; !strings.Contains(msg, tc.msg) {
				t.Errorf("error %q lacks %q", msg, tc.msg)
			}
		})
	}
	if list := decode[[]any](t, request(srv, "GET", "/v1/overrides", "", nil)); len(list) != 0 {
		t.Errorf("a refused request stored something: %v", list)
	}
}

func putOverride2(srv *Server, body string, headers map[string]string) *httptest.ResponseRecorder {
	return request(srv, "PUT", "/v1/overrides", body, headers)
}

func TestPutOverrideAcceptsASameOriginBrowserRequest(t *testing.T) {
	srv, _ := newSpecsServer(t)
	rec := putOverride2(srv, idsBody, map[string]string{"Content-Type": "application/json; charset=utf-8", "Sec-Fetch-Site": "same-origin"})
	if rec.Code != 200 {
		t.Errorf("status %d: %s", rec.Code, rec.Body)
	}
}

func TestPutOverrideLimitsTheRate(t *testing.T) {
	srv, _ := newSpecsServer(t)
	for i := 0; i < overridesPerWindow; i++ {
		if rec := putOverride(srv, idsBody); rec.Code != 200 {
			t.Fatalf("request %d: status %d", i, rec.Code)
		}
	}
	rec := putOverride(srv, idsBody)
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") == "" {
		t.Errorf("status %d, Retry-After %q", rec.Code, rec.Header().Get("Retry-After"))
	}
}

func TestListOverrides(t *testing.T) {
	srv, _ := newSpecsServer(t)
	if rec := request(srv, "GET", "/v1/overrides", "", nil); rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Errorf("empty list = %q", rec.Body)
	}
	putOverride(srv, idsBody)
	putOverride(srv, `{"slug":"ucg-fiber","action":"set","section":"Overview","label":"PoE Budget","value":"40W"}`)
	all := decode[[]map[string]any](t, request(srv, "GET", "/v1/overrides?region=us&slug=ucg-fiber", "", nil))
	if len(all) != 2 || all[0]["label"] != "IDS/IPS Throughput" || all[1]["label"] != "PoE Budget" {
		t.Errorf("list = %v", all)
	}
	if none := decode[[]any](t, request(srv, "GET", "/v1/overrides?slug=plain-cover", "", nil)); len(none) != 0 {
		t.Errorf("list = %v", none)
	}
}

func TestDeleteOverride(t *testing.T) {
	srv, _ := newSpecsServer(t)
	id := decode[map[string]any](t, putOverride(srv, idsBody))["id"].(float64)
	path := "/v1/overrides/" + strconv.Itoa(int(id))

	if rec := request(srv, "DELETE", path, "", map[string]string{"Origin": "https://evil.example"}); rec.Code != 403 {
		t.Errorf("cross-site delete: status %d", rec.Code)
	}
	if rec := request(srv, "DELETE", path, "", nil); rec.Code != 204 || rec.Body.Len() != 0 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	if rec := request(srv, "DELETE", path, "", nil); rec.Code != 404 {
		t.Errorf("second delete: status %d", rec.Code)
	}
	for _, bad := range []string{"/v1/overrides/abc", "/v1/overrides/0", "/v1/overrides/-3"} {
		if rec := request(srv, "DELETE", bad, "", nil); rec.Code != 400 {
			t.Errorf("%s: status %d", bad, rec.Code)
		}
	}
	// The published value is back.
	spec := decode[map[string]any](t, request(srv, "GET", "/v1/products/us/ucg-fiber/specs", "", nil))
	if e := spec["specs"].([]any)[0].(map[string]any); e["value"] != "5 Gbps" || e["origin"] != "published" {
		t.Errorf("entry = %v", e)
	}
}

func TestDerived(t *testing.T) {
	srv, _ := newSpecsServer(t)
	rec := request(srv, "GET", "/v1/derived", "", nil)
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	all := decode[[]map[string]any](t, rec)
	if len(all) != 1 || all[0]["slug"] != "ucg-fiber" || all[0]["version"] == nil || all[0]["known"] == nil {
		t.Fatalf("derived = %v", all)
	}
	if len(all[0]["ports"].([]any)) != 2 || len(all[0]["metrics"].([]any)) == 0 || all[0]["overridden"] == nil {
		t.Errorf("derived = %v", all[0])
	}
	if one := decode[[]any](t, request(srv, "GET", "/v1/derived?region=us", "", nil)); len(one) != 1 {
		t.Errorf("us = %v", one)
	}
	rec = request(srv, "GET", "/v1/derived?region=eu", "", nil)
	if strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Errorf("eu = %q", rec.Body)
	}
}

func TestSpecsEndpointsAreNotTheUI(t *testing.T) {
	srv, _ := newSpecsServer(t)
	for _, tc := range [][2]string{{"POST", "/v1/overrides"}, {"PATCH", "/v1/overrides"}, {"POST", "/v1/derived"}, {"PUT", "/v1/derived"}} {
		if rec := request(srv, tc[0], tc[1], "{}", jsonHeader); rec.Code != http.StatusMethodNotAllowed && rec.Code != http.StatusNotFound {
			t.Errorf("%s %s: status %d", tc[0], tc[1], rec.Code)
		}
	}
}
