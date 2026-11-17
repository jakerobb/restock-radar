package api

import (
	"net/http"
	"strconv"

	"github.com/jakerobb/restock-radar/internal/auth"
	"github.com/jakerobb/restock-radar/internal/store"
)

// require runs h only for a request whose principal holds perm. Nobody who
// hasn't signed in is told to sign in (401); somebody who has, but may not, is
// refused (403). Reading never needs a permission, so only routes that change
// something, or that reveal who did, are wrapped.
//
// The principal travels with the request (auth.FromContext) so handlers can
// record who acted without looking at headers themselves.
func (srv *Server) require(perm auth.Permission, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p := srv.auth.Authenticate(r)
		if !p.Can(perm) {
			if !p.Authenticated && !p.Open {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in to do that"})
				return
			}
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "you don't have permission to do that"})
			return
		}
		h(w, r.WithContext(auth.NewContext(r.Context(), p)))
	}
}

// meResponse is what GET /v1/me says about the caller: who the service takes
// them to be, and what they may do, so a page can offer only what will work.
type meResponse struct {
	// Mode is how identity is decided: "open", "proxy" or "closed".
	Mode string `json:"mode"`
	auth.Principal
	Permissions []auth.Permission `json:"permissions"`
}

func (srv *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	p := srv.auth.Authenticate(r)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, meResponse{Mode: srv.auth.Mode(), Principal: p, Permissions: p.Permissions()})
}

// redactActors removes who made each override from what is shown to somebody
// who may not review them, so the people behind corrections aren't published
// along with the corrections.
func (srv *Server) redactActors(r *http.Request, ovs []store.OverrideStatus) {
	if srv.auth.Authenticate(r).Can(auth.OverridesWrite) {
		return
	}
	for i := range ovs {
		ovs[i].CreatedBy, ovs[i].UpdatedBy = "", ""
	}
}

const maxHistory = 500

// handleOverrideHistory lists changes to overrides, newest first, with who made
// each and what it was before and after (?region=&slug=&limit=).
func (srv *Server) handleOverrideHistory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 100
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			badRequest(w, "limit must be a positive number")
			return
		}
		limit = min(n, maxHistory)
	}
	changes, err := srv.store.OverrideHistory(r.Context(), q.Get("region"), q.Get("slug"), limit)
	if err != nil {
		serverError(w, "failed to read override history", err)
		return
	}
	writeJSON(w, http.StatusOK, nonNil(changes))
}
