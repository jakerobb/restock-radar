package webui

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func get(h http.Handler, path string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
	return rec
}

func TestHandler(t *testing.T) {
	h := handlerFor(fstest.MapFS{
		"index.html":      {Data: []byte("<html>app</html>")},
		"assets/app-1.js": {Data: []byte("js")},
		"favicon.svg":     {Data: []byte("<svg/>")},
	})

	if rec := get(h, "/"); rec.Code != 200 || !strings.Contains(rec.Body.String(), "app") || rec.Header().Get("Cache-Control") != "no-cache" {
		t.Errorf("index: %d %q %q", rec.Code, rec.Body.String(), rec.Header().Get("Cache-Control"))
	}
	if rec := get(h, "/assets/app-1.js"); rec.Code != 200 || !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
		t.Errorf("asset: %d %q", rec.Code, rec.Header().Get("Cache-Control"))
	}
	if rec := get(h, "/some/client/route"); rec.Code != 200 || !strings.Contains(rec.Body.String(), "app") {
		t.Errorf("SPA fallback: %d", rec.Code)
	}
	for _, p := range []string{"/v1/nope", "/missing.js"} {
		if rec := get(h, p); rec.Code != 404 {
			t.Errorf("%s should 404, got %d", p, rec.Code)
		}
	}
}

func TestHandlerWithoutBuild(t *testing.T) {
	if rec := get(handlerFor(fstest.MapFS{}), "/"); rec.Code != http.StatusServiceUnavailable {
		t.Errorf("want 503 without a built UI, got %d", rec.Code)
	}
}
