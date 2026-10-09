package api

import (
	"net/http"
	"strconv"
	"time"
)

const (
	defaultHistoryDays = 30
	maxHistoryDays     = 365
)

// handleHistory returns each variant's stock and price timeline over the last
// ?days (default 30).
func (srv *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	days := defaultHistoryDays
	if v := r.URL.Query().Get("days"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "days must be a positive integer"})
			return
		}
		days = min(n, maxHistoryDays)
	}
	until := time.Now().UTC()
	since := until.AddDate(0, 0, -days)

	history, err := srv.store.History(r.Context(), since)
	if err != nil {
		serverError(w, "failed to read history", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"since": since, "until": until, "variants": nonNil(history)})
}
