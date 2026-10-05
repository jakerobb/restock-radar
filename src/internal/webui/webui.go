// Package webui serves the compiled web UI (built from /ui) that is embedded
// into the binary. The Docker build compiles the UI into dist/ before the Go
// build; a plain `go build` without that step embeds an empty dist/ and serves
// a notice instead.
package webui

import (
	"bytes"
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

//go:embed all:dist
var dist embed.FS

// Handler serves the embedded UI. Files are served by path; any other path
// without a file extension gets index.html, so client-side routes survive a
// reload. Paths under /v1/ are always a 404, so a mistyped API path never returns HTML.
func Handler() http.Handler {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err) // dist is embedded at compile time
	}
	return handlerFor(sub)
}

func handlerFor(root fs.FS) http.Handler {
	files := http.FileServerFS(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/") {
			http.NotFound(w, r)
			return
		}
		if _, err := fs.Stat(root, "index.html"); err != nil {
			http.Error(w, "the web UI wasn't built into this binary; run `npm run build` in ui/ (the Docker image does this)", http.StatusServiceUnavailable)
			return
		}

		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "" {
			name = "index.html"
		}
		if _, err := fs.Stat(root, name); err != nil {
			if path.Ext(name) != "" {
				http.NotFound(w, r)
				return
			}
			name = "index.html"
		}

		// Vite fingerprints everything under /assets/, so it can be cached
		// forever. index.html must be revalidated to pick up new builds.
		if strings.HasPrefix(name, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		if name == "index.html" {
			// FileServer redirects /index.html to ./, so serve the bytes directly.
			data, err := fs.ReadFile(root, name)
			if err != nil {
				http.Error(w, "failed to read index.html", http.StatusInternalServerError)
				return
			}
			http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
			return
		}
		files.ServeHTTP(w, r)
	})
}
