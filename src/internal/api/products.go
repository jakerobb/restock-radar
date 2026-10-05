package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/jakerobb/restock-radar/internal/poller"
)

// variantJSON is one variant's latest state, as the UI sees it.
type variantJSON struct {
	ID                string    `json:"id"`
	SKU               string    `json:"sku"`
	Title             string    `json:"title"`
	Status            string    `json:"status"`
	PriceCents        *int64    `json:"price_cents"`
	RegularPriceCents *int64    `json:"regular_price_cents"`
	Currency          string    `json:"currency"`
	RestockETA        string    `json:"restock_eta,omitempty"`
	LastChecked       time.Time `json:"last_checked"`
	LastChanged       time.Time `json:"last_changed"`
}

type productJSON struct {
	Region   string        `json:"region"`
	ID       string        `json:"id"`
	Slug     string        `json:"slug"`
	Title    string        `json:"title"`
	URL      string        `json:"url"`
	Variants []variantJSON `json:"variants"`
}

type pendingJSON struct {
	Region string `json:"region"`
	Slug   string `json:"slug"`
}

type productsResponse struct {
	// LastSync is when the newest variant was last checked; null before the first poll.
	LastSync *time.Time    `json:"last_sync"`
	Regions  []string      `json:"regions"`
	Products []productJSON `json:"products"`
	// Pending are watched items that haven't been checked successfully yet.
	Pending []pendingJSON `json:"pending"`
}

// handleProducts returns every tracked product with its variants grouped
// beneath it, ordered by title, plus what the page header needs.
func (srv *Server) handleProducts(w http.ResponseWriter, r *http.Request) {
	variants, err := srv.store.Variants(r.Context(), "")
	if err != nil {
		serverError(w, "failed to list variants", err)
		return
	}
	items, err := srv.store.Items(r.Context())
	if err != nil {
		serverError(w, "failed to list items", err)
		return
	}

	resp := productsResponse{Regions: []string{}, Products: []productJSON{}, Pending: []pendingJSON{}}
	for _, reg := range srv.cfg.Regions {
		resp.Regions = append(resp.Regions, reg.ID)
	}

	index := map[[2]string]int{}
	for _, v := range variants {
		if resp.LastSync == nil || v.LastChecked.After(*resp.LastSync) {
			t := v.LastChecked
			resp.LastSync = &t
		}
		key := [2]string{v.Region, v.ProductID}
		i, ok := index[key]
		if !ok {
			p := productJSON{Region: v.Region, ID: v.ProductID, Slug: v.ProductSlug, Title: v.ProductTitle, Variants: []variantJSON{}}
			if reg, ok := srv.cfg.RegionByID(v.Region); ok {
				p.URL = fmt.Sprintf("%s/%s/products/%s", reg.BaseURL, reg.Path, url.PathEscape(v.ProductSlug))
			}
			resp.Products = append(resp.Products, p)
			i = len(resp.Products) - 1
			index[key] = i
		}
		resp.Products[i].Variants = append(resp.Products[i].Variants, variantJSON{
			ID: v.VariantID, SKU: v.SKU, Title: v.VariantTitle, Status: v.Status,
			PriceCents: v.PriceCents, RegularPriceCents: v.RegularPriceCents, Currency: v.Currency,
			RestockETA: v.RestockETA, LastChecked: v.LastChecked, LastChanged: v.LastChanged,
		})
	}
	sort.Slice(resp.Products, func(i, j int) bool {
		a, b := resp.Products[i], resp.Products[j]
		if ta, tb := strings.ToLower(a.Title), strings.ToLower(b.Title); ta != tb {
			return ta < tb
		}
		return a.Region < b.Region
	})

	for _, it := range items {
		if it.ProductID == "" {
			resp.Pending = append(resp.Pending, pendingJSON{Region: it.Region, Slug: it.Slug})
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

type addItemRequest struct {
	Item   string `json:"item"`
	Region string `json:"region"`
}

type addItemResponse struct {
	Region         string `json:"region"`
	Slug           string `json:"slug"`
	Title          string `json:"title"`
	Variants       int    `json:"variants"`
	AlreadyTracked bool   `json:"already_tracked"`
}

// handleAddItem adds a product, given as a slug or store URL, to the watch list.
func (srv *Server) handleAddItem(w http.ResponseWriter, r *http.Request) {
	// A JSON body can't be sent cross-site without a CORS preflight, which
	// this server never grants; the Origin check backs that up.
	if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt != "application/json" {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "send application/json"})
		return
	}
	if !sameOrigin(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "cross-site request refused"})
		return
	}

	var req addItemRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	if err := dec.Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "malformed request"})
		return
	}

	res, err := srv.poller.Add(r.Context(), req.Item, req.Region)
	var ue *poller.UserError
	switch {
	case errors.As(err, &ue):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": ue.Msg})
	case err != nil:
		slog.Error("failed to add item", "input", req.Item, "err", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "couldn't reach the store to check that product; try again in a moment"})
	default:
		writeJSON(w, http.StatusOK, addItemResponse{
			Region: res.Region, Slug: res.Slug, Title: res.Title, Variants: res.Variants, AlreadyTracked: res.AlreadyTracked,
		})
	}
}

// sameOrigin rejects requests a browser marks as cross-site. Non-browser
// clients send neither header and pass.
func sameOrigin(r *http.Request) bool {
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		return err == nil && strings.EqualFold(u.Host, r.Host)
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" {
		return site == "same-origin" || site == "none"
	}
	return true
}
