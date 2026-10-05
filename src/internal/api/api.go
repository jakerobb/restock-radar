package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/jakerobb/restock-radar/internal/config"
	"github.com/jakerobb/restock-radar/internal/metrics"
	"github.com/jakerobb/restock-radar/internal/poller"
	"github.com/jakerobb/restock-radar/internal/store"
	"github.com/jakerobb/restock-radar/internal/webui"
)

const (
	defaultEventLimit = 100
	maxEventLimit     = 1000
)

// Poller is the part of the poller the server needs.
type Poller interface {
	Metrics() *metrics.Metrics
	LastCycle() time.Time
	Add(ctx context.Context, input, regionID string) (*poller.AddResult, error)
}

// Server serves the web UI and exposes current state and change history as
// JSON. The JSON API is region-aware: an empty ?region= means all regions.
type Server struct {
	store  *store.Store
	poller Poller
	cfg    *config.Config
	// adds limits how fast products can be added, since each one is checked
	// against the live store.
	adds *windowLimiter
}

const (
	addsPerWindow = 10
	addsWindow    = time.Minute
)

func New(s *store.Store, p Poller, cfg *config.Config) *Server {
	return &Server{store: s, poller: p, cfg: cfg, adds: newWindowLimiter(addsPerWindow, addsWindow)}
}

func (srv *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/products", srv.handleProducts)
	mux.HandleFunc("POST /v1/items", srv.handleAddItem)
	mux.HandleFunc("GET /health", srv.handleHealth)
	mux.HandleFunc("GET /metrics", srv.handleMetrics)
	mux.HandleFunc("GET /v1/variants", srv.handleVariants)
	mux.HandleFunc("GET /v1/events", srv.handleEvents)
	// Everything else is the web UI; the patterns above are more specific.
	mux.Handle("GET /", webui.Handler())
	return securityHeaders(mux)
}

// Serve listens until ctx is cancelled, then shuts down gracefully.
func (srv *Server) Serve(ctx context.Context) error {
	server := &http.Server{
		Addr:              fmt.Sprintf("0.0.0.0:%d", srv.cfg.HTTPPort),
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       15 * time.Second,
		// Adding a product fetches from the store, which can take most of
		// addTimeout; the write timeout leaves room for the response after it.
		WriteTimeout:   addTimeout + 15*time.Second,
		IdleTimeout:    60 * time.Second,
		MaxHeaderBytes: 16 << 10,
	}
	errCh := make(chan error, 1)
	go func() { errCh <- server.ListenAndServe() }()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return server.Shutdown(shutdownCtx)
	}
}

// handleMetrics serves Prometheus metrics: the poller's counters plus a few
// gauges read from the database.
func (srv *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	stats, err := srv.store.Stats(r.Context())
	if err != nil {
		serverError(w, "failed to read stats", err)
		return
	}
	// Render into a buffer first, so a failure above can still be a 500.
	var buf bytes.Buffer
	srv.poller.Metrics().Render(&buf, metrics.Gauges{
		WatchedItems: stats.Items, PendingEvents: stats.PendingEvents, VariantsByStatus: stats.VariantsByStatus,
	})
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	if _, err := w.Write(buf.Bytes()); err != nil {
		slog.Error("failed to write metrics response", "err", err)
	}
}

// handleHealth reports the process is up and when the poller last finished.
func (srv *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	body := map[string]any{"status": "ok"}
	if t := srv.poller.LastCycle(); !t.IsZero() {
		body["last_poll"] = t.UTC()
	}
	writeJSON(w, http.StatusOK, body)
}

func (srv *Server) handleVariants(w http.ResponseWriter, r *http.Request) {
	variants, err := srv.store.Variants(r.Context(), r.URL.Query().Get("region"))
	if err != nil {
		serverError(w, "failed to list variants", err)
		return
	}
	writeJSON(w, http.StatusOK, nonNil(variants))
}

// handleEvents lists changes with id > ?since (default 0), oldest first, so
// a client can page forward by passing the last id it saw.
func (srv *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	since, limit := int64(0), defaultEventLimit
	if v := q.Get("since"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "since must be a non-negative integer"})
			return
		}
		since = n
	}
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "limit must be a positive integer"})
			return
		}
		limit = min(n, maxEventLimit)
	}

	events, err := srv.store.Events(r.Context(), q.Get("region"), since, limit)
	if err != nil {
		serverError(w, "failed to list events", err)
		return
	}
	writeJSON(w, http.StatusOK, nonNil(events))
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

func serverError(w http.ResponseWriter, msg string, err error) {
	slog.Error(msg, "err", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": msg})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("failed to encode JSON response", "err", err)
	}
}
