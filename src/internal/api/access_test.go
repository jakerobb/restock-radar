package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jakerobb/restock-radar/internal/auth"
	"github.com/jakerobb/restock-radar/internal/config"
	"github.com/jakerobb/restock-radar/internal/poller"
)

const proxyConfig = `
auth:
  mode: proxy
  trusted_proxies: ["10.244.0.0/16"]
  roles:
    admin: [admins]
    editor: [editors]
`

// withProxyAuth makes the server believe the identity headers of requests from
// the trusted network, as the config would.
func withProxyAuth(t *testing.T, srv *Server) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "c.yaml")
	if err := os.WriteFile(path, []byte("ntfy: {url: \"https://n\", topic: t}\n"+proxyConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.LoadFromPath(path)
	if err != nil {
		t.Fatal(err)
	}
	srv.auth = auth.New(cfg.Auth)
	// What an allowed request that reaches the poller gets back.
	fp := srv.poller.(*fakePoller)
	fp.res, fp.refreshRes = &poller.AddResult{}, &poller.RefreshResult{}
}

// as sends a request that appears to come from remote with the given identity.
func as(srv *Server, remote, user, groups, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.RemoteAddr = remote
	req.Header.Set("Content-Type", "application/json")
	if user != "" {
		req.Header.Set("Remote-User", user)
		req.Header.Set("Remote-Groups", groups)
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

const (
	proxyAddr = "10.244.1.5:4000"
	otherAddr = "203.0.113.7:4000"
)

// routes that change something or reveal who did, and what each needs.
var guarded = []struct {
	name, method, path, body string
	needs                    auth.Permission
}{
	{"add a product", "POST", "/v1/items", `{"item":"ucg-fiber"}`, auth.WatchlistWrite},
	{"refresh a product", "POST", "/v1/products/us/ucg-fiber/refresh", ``, auth.ProductsRefresh},
	{"set an override", "PUT", "/v1/overrides", idsBody, auth.OverridesWrite},
	{"delete an override", "DELETE", "/v1/overrides/1", ``, auth.OverridesWrite},
	{"read override history", "GET", "/v1/overrides/history", ``, auth.OverridesWrite},
}

func TestGuardedRoutesWantTheirPermission(t *testing.T) {
	for _, g := range guarded {
		t.Run(g.name, func(t *testing.T) {
			srv, _ := newSpecsServer(t)
			withProxyAuth(t, srv)

			if rec := as(srv, proxyAddr, "", "", g.method, g.path, g.body); rec.Code != http.StatusUnauthorized {
				t.Errorf("anonymous: %d, want 401: %s", rec.Code, rec.Body)
			}
			if rec := as(srv, proxyAddr, "kim", "users", g.method, g.path, g.body); rec.Code != http.StatusForbidden {
				t.Errorf("signed in without a role: %d, want 403: %s", rec.Code, rec.Body)
			}
			// Identity from anywhere but the proxy counts for nothing, however well forged.
			if rec := as(srv, otherAddr, "kim", "admins", g.method, g.path, g.body); rec.Code != http.StatusUnauthorized {
				t.Errorf("forged admin from outside: %d, want 401: %s", rec.Code, rec.Body)
			}
			for group, allowed := range map[string]bool{"editors": g.needs != auth.WatchlistWrite, "admins": true} {
				rec := as(srv, proxyAddr, "kim", group, g.method, g.path, g.body)
				denied := rec.Code == http.StatusUnauthorized || rec.Code == http.StatusForbidden
				if denied == allowed {
					t.Errorf("%s: %d (allowed should be %v): %s", group, rec.Code, allowed, rec.Body)
				}
			}
		})
	}
}

func TestADeniedRequestNeverReachesTheHandler(t *testing.T) {
	srv, _ := newSpecsServer(t)
	withProxyAuth(t, srv)
	fp := srv.poller.(*fakePoller)

	as(srv, proxyAddr, "", "", "POST", "/v1/products/us/ucg-fiber/refresh", "")
	as(srv, proxyAddr, "kim", "users", "POST", "/v1/items", `{"item":"ucg-fiber"}`)
	as(srv, otherAddr, "kim", "admins", "POST", "/v1/products/us/ucg-fiber/refresh", "")
	if len(fp.refreshed) != 0 || fp.got.Item != "" {
		t.Errorf("handlers ran: refreshed %v, add %+v", fp.refreshed, fp.got)
	}
	if rec := as(srv, proxyAddr, "kim", "editors", "PUT", "/v1/overrides", idsBody); rec.Code != 200 {
		t.Fatalf("an editor's override: %d %s", rec.Code, rec.Body)
	}
	if rec := as(srv, proxyAddr, "", "", "PUT", "/v1/overrides", strings.Replace(idsBody, "8+ Gbps", "100 Gbps", 1)); rec.Code != 401 {
		t.Fatalf("an anonymous override: %d", rec.Code)
	}
	got := decode[[]map[string]any](t, request(srv, "GET", "/v1/overrides", "", nil))
	if len(got) != 1 || got[0]["value"] != "8+ Gbps" {
		t.Errorf("overrides = %v", got)
	}
}

func TestReadingNeedsNoPermission(t *testing.T) {
	srv, _ := newSpecsServer(t)
	withProxyAuth(t, srv)
	for _, path := range []string{"/v1/products", "/v1/derived", "/v1/overrides", "/v1/products/us/ucg-fiber/specs", "/v1/status", "/v1/history", "/v1/me", "/health"} {
		if rec := as(srv, otherAddr, "", "", "GET", path, ""); rec.Code != 200 {
			t.Errorf("anonymous GET %s: %d", path, rec.Code)
		}
	}
}

func TestOverridesRecordWhoMadeThem(t *testing.T) {
	srv, _ := newSpecsServer(t)
	withProxyAuth(t, srv)
	if rec := as(srv, proxyAddr, "kim", "editors", "PUT", "/v1/overrides", idsBody); rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if rec := as(srv, proxyAddr, "lee", "admins", "PUT", "/v1/overrides", strings.Replace(idsBody, "8+ Gbps", "9 Gbps", 1)); rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}

	// Those who may review corrections see who made them...
	ovs := decode[[]map[string]any](t, as(srv, proxyAddr, "kim", "editors", "GET", "/v1/overrides", ""))
	if len(ovs) != 1 || ovs[0]["created_by"] != "kim" || ovs[0]["updated_by"] != "lee" {
		t.Errorf("as an editor: %v", ovs)
	}
	// ...but the public sees the corrections without the people behind them.
	for _, path := range []string{"/v1/overrides", "/v1/products/us/ucg-fiber/specs"} {
		body := as(srv, otherAddr, "", "", "GET", path, "").Body.String()
		if strings.Contains(body, "kim") || strings.Contains(body, "lee") || strings.Contains(body, "created_by") {
			t.Errorf("anonymous GET %s shows who: %s", path, body)
		}
		if !strings.Contains(body, "9 Gbps") {
			t.Errorf("anonymous GET %s lost the override itself: %s", path, body)
		}
	}
	if body := as(srv, proxyAddr, "kim", "editors", "GET", "/v1/products/us/ucg-fiber/specs", "").Body.String(); !strings.Contains(body, `"updated_by":"lee"`) {
		t.Errorf("an editor doesn't see the actor in the specs: %s", body)
	}

	hist := decode[[]map[string]any](t, as(srv, proxyAddr, "kim", "editors", "GET", "/v1/overrides/history?slug=ucg-fiber", ""))
	if len(hist) != 2 || hist[0]["actor"] != "lee" || hist[0]["change"] != "update" || hist[1]["actor"] != "kim" || hist[1]["change"] != "create" {
		t.Errorf("history = %v", hist)
	}

	if rec := as(srv, proxyAddr, "lee", "admins", "DELETE", "/v1/overrides/1", ""); rec.Code != 204 {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body)
	}
	hist = decode[[]map[string]any](t, as(srv, proxyAddr, "kim", "editors", "GET", "/v1/overrides/history", ""))
	if len(hist) != 3 || hist[0]["change"] != "delete" || hist[0]["actor"] != "lee" || hist[0]["after"] != nil || hist[0]["before"] == nil {
		t.Errorf("history after a delete = %v", hist)
	}
}

func TestOpenModeRecordsAnOpenActor(t *testing.T) {
	srv, _ := newSpecsServer(t)
	if rec := putOverride(srv, idsBody); rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	hist := decode[[]map[string]any](t, request(srv, "GET", "/v1/overrides/history", "", nil))
	if len(hist) != 1 || hist[0]["actor"] != "open" {
		t.Errorf("history = %v", hist)
	}
}

func TestHistoryLimit(t *testing.T) {
	srv, _ := newSpecsServer(t)
	for _, v := range []string{"1 Gbps", "2 Gbps", "3 Gbps"} {
		putOverride(srv, strings.Replace(idsBody, "8+ Gbps", v, 1))
	}
	if got := decode[[]map[string]any](t, request(srv, "GET", "/v1/overrides/history?limit=2", "", nil)); len(got) != 2 {
		t.Errorf("limit=2 gave %d", len(got))
	}
	for _, bad := range []string{"0", "-1", "lots"} {
		if rec := request(srv, "GET", "/v1/overrides/history?limit="+bad, "", nil); rec.Code != 400 {
			t.Errorf("limit=%s: %d", bad, rec.Code)
		}
	}
}

func TestMe(t *testing.T) {
	srv, _ := newSpecsServer(t)

	open := decode[map[string]any](t, request(srv, "GET", "/v1/me", "", nil))
	if open["mode"] != "open" || open["open"] != true || open["authenticated"] != false || len(open["permissions"].([]any)) != 3 {
		t.Errorf("open mode: %v", open)
	}

	withProxyAuth(t, srv)
	anon := decode[map[string]any](t, as(srv, otherAddr, "", "", "GET", "/v1/me", ""))
	if anon["mode"] != "proxy" || anon["authenticated"] != false || anon["open"] != false || len(anon["permissions"].([]any)) != 0 {
		t.Errorf("anonymous: %v", anon)
	}
	rec := as(srv, proxyAddr, "kim", "editors", "GET", "/v1/me", "")
	editor := decode[map[string]any](t, rec)
	perms := editor["permissions"].([]any)
	if editor["authenticated"] != true || editor["user"] != "kim" || len(perms) != 2 || perms[0] != "overrides:write" || perms[1] != "products:refresh" {
		t.Errorf("editor: %v", editor)
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("Cache-Control = %q: who someone is must not be cached", rec.Header().Get("Cache-Control"))
	}
}

func TestAMisconfiguredServerRefusesChanges(t *testing.T) {
	srv, _ := newSpecsServer(t)
	srv.auth = auth.New(config.Auth{Mode: config.AuthModeProxy}) // no trusted proxies
	for _, g := range guarded {
		if rec := request(srv, g.method, g.path, g.body, jsonHeader); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s: %d, want 401", g.name, rec.Code)
		}
	}
	if m := decode[map[string]any](t, request(srv, "GET", "/v1/me", "", nil)); m["mode"] != "closed" {
		t.Errorf("me = %v", m)
	}
}
