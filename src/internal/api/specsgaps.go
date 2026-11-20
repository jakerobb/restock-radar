package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jakerobb/restock-radar/internal/auth"
	"github.com/jakerobb/restock-radar/internal/store"
)

const maxNotExpectedBody = 4 << 10

type specsGapsResponse struct {
	// Products are the tracked products with no tech specs stored: those the store published none for
	// (fetched_at is set) and those not collected yet (it is null).
	Products []store.SpecsGap `json:"products"`
	// NotExpected are the products marked as having no tech specs to expect, by slug without its region suffix.
	NotExpected []store.SpecsNotExpected `json:"not_expected"`
}

// handleSpecsGaps lists the products with no tech specs, and those marked as not expected to have any.
func (srv *Server) handleSpecsGaps(w http.ResponseWriter, r *http.Request) {
	gaps, expected, err := srv.store.SpecsGaps(r.Context())
	if err != nil {
		serverError(w, "failed to list products without specs", err)
		return
	}
	if !srv.auth.Authenticate(r).Can(auth.OverridesWrite) {
		for i := range expected {
			expected[i].CreatedBy = ""
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, specsGapsResponse{Products: nonNil(gaps), NotExpected: nonNil(expected)})
}

type notExpectedRequest struct {
	Slug   string `json:"slug"`
	Reason string `json:"reason"`
}

// handleMarkSpecsNotExpected says no tech specs are expected for a product (in any region it is sold in).
func (srv *Server) handleMarkSpecsNotExpected(w http.ResponseWriter, r *http.Request) {
	if !srv.guardMutation(w, r, true) {
		return
	}
	var req notExpectedRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxNotExpectedBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		badRequest(w, "malformed request")
		return
	}
	if strings.TrimSpace(req.Slug) == "" {
		badRequest(w, "slug is required")
		return
	}
	if len(req.Slug) > maxTargetLen || len(req.Reason) > maxNoteLen {
		badRequest(w, "slug or reason is too long")
		return
	}
	e, err := srv.store.MarkSpecsNotExpected(r.Context(), req.Slug, req.Reason, auth.FromContext(r.Context()).Actor(), time.Now())
	switch {
	case errors.Is(err, store.ErrUnknownProduct):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown product"})
	case errors.Is(err, store.ErrInvalidOverride):
		badRequest(w, strings.TrimPrefix(err.Error(), store.ErrInvalidOverride.Error()+": "))
	case err != nil:
		serverError(w, "failed to store the entry", err)
	default:
		writeJSON(w, http.StatusOK, e)
	}
}

// handleUnmarkSpecsNotExpected takes a product off the list, so a plan holding it is unsure again without specs.
func (srv *Server) handleUnmarkSpecsNotExpected(w http.ResponseWriter, r *http.Request) {
	if !srv.guardMutation(w, r, false) {
		return
	}
	ok, err := srv.store.UnmarkSpecsNotExpected(r.Context(), r.PathValue("slug"))
	switch {
	case err != nil:
		serverError(w, "failed to remove the entry", err)
	case !ok:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not on the list"})
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}
