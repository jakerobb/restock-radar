package api

import (
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jakerobb/restock-radar/internal/auth"
	"github.com/jakerobb/restock-radar/internal/specs"
	"github.com/jakerobb/restock-radar/internal/store"
)

const (
	overridesPerWindow = 30
	overridesWindow    = time.Minute
	maxOverrideBody    = 16 << 10

	maxTargetLen = 200
	maxValueLen  = 2000
	maxNoteLen   = 1000
	maxURLLen    = 500
)

// productSpecsResponse is a product's specification as it is used: with the
// user's overrides applied, and what is derived from it.
type productSpecsResponse struct {
	store.ProductRef
	// Specs is the effective specification, in the store's order. Each entry says
	// where it came from (published, override, or added), and an overridden one
	// carries the published value beside its own.
	Specs []specs.Effective `json:"specs"`
	// Overrides are the product's overrides and what each currently does.
	Overrides []store.OverrideStatus `json:"overrides"`
	// Derived is nil for a product with no specification to derive from.
	Derived *store.DerivedProduct `json:"derived"`
}

// handleProductSpecs serves one product's effective specification, its
// overrides, and what is derived from it.
func (srv *Server) handleProductSpecs(w http.ResponseWriter, r *http.Request) {
	region, slug := r.PathValue("region"), r.PathValue("slug")
	p, err := srv.store.ProductBySlug(r.Context(), region, slug)
	if err != nil {
		serverError(w, "failed to look up product", err)
		return
	}
	if p == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown product"})
		return
	}
	eff, _, err := srv.store.EffectiveSpecs(r.Context(), p.Region, p.ID)
	if err != nil {
		serverError(w, "failed to read specs", err)
		return
	}
	ovs, err := srv.store.Overrides(r.Context(), p.Region, p.Slug)
	if err != nil {
		serverError(w, "failed to list overrides", err)
		return
	}
	d, err := srv.store.Derived(r.Context(), p.Region, p.ID)
	if err != nil {
		serverError(w, "failed to read derived specs", err)
		return
	}
	srv.redactActors(r, ovs)
	writeJSON(w, http.StatusOK, productSpecsResponse{ProductRef: *p, Specs: nonNil(eff), Overrides: nonNil(ovs), Derived: d})
}

// handleDerived serves what is derived for every product, for searching and
// sorting: ports, PoE budgets, radios, numbers, rack and size.
func (srv *Server) handleDerived(w http.ResponseWriter, r *http.Request) {
	all, err := srv.store.AllDerived(r.Context(), r.URL.Query().Get("region"))
	if err != nil {
		serverError(w, "failed to read derived specs", err)
		return
	}
	writeJSON(w, http.StatusOK, nonNil(all))
}

// handleOverrides lists overrides, optionally for one product (?region=&slug=).
func (srv *Server) handleOverrides(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	ovs, err := srv.store.Overrides(r.Context(), q.Get("region"), q.Get("slug"))
	if err != nil {
		serverError(w, "failed to list overrides", err)
		return
	}
	srv.redactActors(r, ovs)
	writeJSON(w, http.StatusOK, nonNil(ovs))
}

// overrideRequest is the body of PUT /v1/overrides.
type overrideRequest struct {
	Region    string `json:"region"`
	Slug      string `json:"slug"`
	Action    string `json:"action"`
	Section   string `json:"section"`
	Group     string `json:"group"`
	Label     string `json:"label"`
	Kind      string `json:"kind"`
	Value     string `json:"value"`
	Note      string `json:"note"`
	SourceURL string `json:"source_url"`
	Reason    string `json:"reason"`
}

// guardMutation applies the checks every state-changing request gets: a cross-site
// request is refused, and so is a flood of them.
func (srv *Server) guardMutation(w http.ResponseWriter, r *http.Request, wantJSON bool) bool {
	if wantJSON {
		if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt != "application/json" {
			writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "send application/json"})
			return false
		}
	}
	if !sameOrigin(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "cross-site request refused"})
		return false
	}
	if ok, wait := srv.overrides.allow(); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many changes in the last minute; wait a moment and try again"})
		return false
	}
	return true
}

func badRequest(w http.ResponseWriter, msg string) {
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
}

// handlePutOverride creates an override, or replaces the one with the same
// target (product, section, group, label).
func (srv *Server) handlePutOverride(w http.ResponseWriter, r *http.Request) {
	if !srv.guardMutation(w, r, true) {
		return
	}
	var req overrideRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxOverrideBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		badRequest(w, "malformed request")
		return
	}

	if req.Region == "" && len(srv.cfg.Regions) == 1 {
		req.Region = srv.cfg.Regions[0].ID
	}
	if _, ok := srv.cfg.RegionByID(req.Region); !ok {
		badRequest(w, "unknown region")
		return
	}
	req.Slug = strings.TrimSpace(req.Slug)
	if req.Slug == "" {
		badRequest(w, "slug is required")
		return
	}
	for name, v := range map[string]struct {
		s   string
		max int
	}{
		"section": {req.Section, maxTargetLen}, "group": {req.Group, maxTargetLen}, "label": {req.Label, maxTargetLen},
		"value": {req.Value, maxValueLen}, "note": {req.Note, maxNoteLen}, "reason": {req.Reason, maxNoteLen}, "source_url": {req.SourceURL, maxURLLen},
	} {
		if len(v.s) > v.max {
			badRequest(w, name+" is too long")
			return
		}
	}
	if u := strings.TrimSpace(req.SourceURL); u != "" {
		pu, err := url.Parse(u)
		if err != nil || (pu.Scheme != "http" && pu.Scheme != "https") || pu.Host == "" {
			badRequest(w, "source_url must be an http or https URL")
			return
		}
	}

	st, err := srv.store.UpsertOverride(r.Context(), specs.Override{
		Region: req.Region, Slug: req.Slug, Action: req.Action, Section: req.Section, Group: req.Group, Label: req.Label,
		Kind: req.Kind, Value: req.Value, Note: req.Note, SourceURL: req.SourceURL, Reason: req.Reason,
		UpdatedBy: auth.FromContext(r.Context()).Actor(),
	}, time.Now())
	switch {
	case errors.Is(err, store.ErrUnknownProduct):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown product"})
	case errors.Is(err, store.ErrInvalidOverride):
		badRequest(w, strings.TrimPrefix(err.Error(), store.ErrInvalidOverride.Error()+": "))
	case err != nil:
		serverError(w, "failed to store override", err)
	default:
		writeJSON(w, http.StatusOK, st)
	}
}

// handleDeleteOverride removes an override.
func (srv *Server) handleDeleteOverride(w http.ResponseWriter, r *http.Request) {
	if !srv.guardMutation(w, r, false) {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		badRequest(w, "id must be a positive integer")
		return
	}
	ok, err := srv.store.DeleteOverride(r.Context(), id, auth.FromContext(r.Context()).Actor(), time.Now())
	switch {
	case err != nil:
		serverError(w, "failed to delete override", err)
	case !ok:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such override"})
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}
