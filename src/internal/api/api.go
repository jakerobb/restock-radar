package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/jakerobb/restock-radar/internal/store"
)

const (
	defaultEventLimit = 100
	maxEventLimit     = 1000
)

// Server exposes current state and change history as JSON. Everything is
// region-aware: an empty ?region= means all regions.
type Server struct {
	store     *store.Store
	lastCycle func() time.Time
	port      int
}

func New(s *store.Store, lastCycle func() time.Time, port int) *Server {
	return &Server{store: s, lastCycle: lastCycle, port: port}
}

func (srv *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", srv.handleHealth)
	mux.HandleFunc("GET /v1/variants", srv.handleVariants)
	mux.HandleFunc("GET /v1/events", srv.handleEvents)
	return mux
}

// Serve listens until ctx is cancelled, then shuts down gracefully.
func (srv *Server) Serve(ctx context.Context) error {
	server := &http.Server{
		Addr:              fmt.Sprintf("0.0.0.0:%d", srv.port),
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
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

// handleHealth reports the process is up and when the poller last finished.
func (srv *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	body := map[string]any{"status": "ok"}
	if t := srv.lastCycle(); !t.IsZero() {
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
