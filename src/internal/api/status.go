package api

import (
	"context"
	"net/http"
	"os"
	"time"

	"github.com/jakerobb/restock-radar/internal/store"
)

type statusCategoryJSON struct {
	Region   string `json:"region"`
	ID       string `json:"id"`
	Products int    `json:"products"`
}

// presenceJSON splits the products by whether something has been collected for them.
type presenceJSON struct {
	With    int `json:"with"`
	Without int `json:"without"`
	// NotChecked are among Without: nothing has been fetched for them yet, so
	// "without" may only mean "not yet".
	NotChecked int `json:"not_checked"`
}

// statusRegionJSON is one region's share of the numbers, and how it is read.
type statusRegionJSON struct {
	Region     string `json:"region"`
	Products   int    `json:"products"`
	Variants   int    `json:"variants"`
	InStock    int    `json:"in_stock"`
	Categories int    `json:"categories"`
	// LastCheck and OldestCheck are the newest and the stalest variant check in the region.
	LastCheck   *time.Time `json:"last_check"`
	OldestCheck *time.Time `json:"oldest_check"`
	// ReadEverySeconds is how often the whole region is read: poll_every, or
	// poll_interval for a region read every cycle. OverdueVariants have gone
	// unchecked for over OverdueAfterSeconds, a few times that.
	ReadEverySeconds    int `json:"read_every_seconds"`
	OverdueAfterSeconds int `json:"overdue_after_seconds"`
	OverdueVariants     int `json:"overdue_variants"`
}

// overdueFactor is how many read intervals a variant may go unchecked before it is called overdue.
const overdueFactor = 3

type statusResponse struct {
	Now      time.Time `json:"now"`
	Products int       `json:"products"`
	Variants int       `json:"variants"`
	// LastSync is when the newest variant was last checked; OldestCheck is the stalest.
	LastSync    *time.Time `json:"last_sync"`
	OldestCheck *time.Time `json:"oldest_check"`
	// LastPoll is when the poller last finished a pass; null until one has since this process started.
	LastPoll *time.Time `json:"last_poll"`

	Regions map[string]int `json:"regions"`
	// ByRegion has one entry for every configured region, in config order, then any region that has data but is no longer configured.
	ByRegion      []statusRegionJSON   `json:"by_region"`
	Categories    []statusCategoryJSON `json:"categories"`
	Uncategorized int                  `json:"uncategorized"`

	Specs        presenceJSON `json:"specs"`
	TechSpecsURL presenceJSON `json:"techspecs_url"`
	// NeverDetailed are products whose own page hasn't been read yet.
	NeverDetailed int `json:"never_detailed"`

	VariantsByStatus map[string]int `json:"variants_by_status"`

	WatchedFromConfig int `json:"watched_from_config"`
	WatchedFromUI     int `json:"watched_from_ui"`
	PendingItems      int `json:"pending_items"`

	Events24h     int        `json:"events_24h"`
	Events7d      int        `json:"events_7d"`
	PendingEvents int        `json:"pending_events"`
	FailedEvents  int        `json:"failed_events"`
	LatestEvent   *time.Time `json:"latest_event"`

	// DBBytes is the size of the database file; null when it can't be read.
	DBBytes *int64 `json:"db_bytes"`
}

// handleStatus returns the counts behind the /status page.
func (srv *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC()
	st, err := srv.store.Status(r.Context(), now)
	if err != nil {
		serverError(w, "failed to read status", err)
		return
	}
	resp := statusResponse{
		Now: now, Products: st.Products, Variants: st.Variants,
		LastSync: st.LastChecked, OldestCheck: st.OldestChecked,
		Regions: st.ProductsByRegion, Categories: []statusCategoryJSON{}, Uncategorized: st.Uncategorized,
		Specs:             presenceJSON{With: st.WithSpecs, Without: st.SpecsEmpty + st.SpecsNotFetched, NotChecked: st.SpecsNotFetched},
		TechSpecsURL:      presenceJSON{With: st.WithTechSpecsURL, Without: st.NoTechSpecsURL + st.TechSpecsNotChecked, NotChecked: st.TechSpecsNotChecked},
		NeverDetailed:     st.NeverDetailed,
		VariantsByStatus:  st.VariantsByStatus,
		WatchedFromConfig: st.WatchedFromConfig, WatchedFromUI: st.WatchedFromUI, PendingItems: st.PendingItems,
		Events24h: st.Events24h, Events7d: st.Events7d, PendingEvents: st.PendingEvents, FailedEvents: st.FailedEvents,
		LatestEvent: st.LatestEvent,
	}
	resp.ByRegion, err = srv.regionStatus(r.Context(), now)
	if err != nil {
		serverError(w, "failed to read region status", err)
		return
	}
	for _, c := range st.Categories {
		resp.Categories = append(resp.Categories, statusCategoryJSON{Region: c.Region, ID: c.ID, Products: c.Products})
	}
	if t := srv.poller.LastCycle(); !t.IsZero() {
		t = t.UTC()
		resp.LastPoll = &t
	}
	if fi, err := os.Stat(srv.cfg.DBPath); err == nil {
		n := fi.Size()
		resp.DBBytes = &n
	}
	writeJSON(w, http.StatusOK, resp)
}

// readEvery is how often a region is read in full.
func (srv *Server) readEvery(region string) time.Duration {
	if r, ok := srv.cfg.RegionByID(region); ok && r.PollEvery > srv.cfg.PollInterval {
		return r.PollEvery
	}
	return srv.cfg.PollInterval
}

func (srv *Server) regionStatus(ctx context.Context, now time.Time) ([]statusRegionJSON, error) {
	stats, err := srv.store.RegionStats(ctx, func(region string) time.Time {
		return now.Add(-overdueFactor * srv.readEvery(region))
	})
	if err != nil {
		return nil, err
	}
	byID := map[string]store.RegionStat{}
	for _, st := range stats {
		byID[st.Region] = st
	}
	out := []statusRegionJSON{}
	add := func(id string) {
		st := byID[id]
		every := srv.readEvery(id)
		out = append(out, statusRegionJSON{
			Region: id, Products: st.Products, Variants: st.Variants, InStock: st.InStock, Categories: st.Categories,
			LastCheck: st.LastCheck, OldestCheck: st.Oldest,
			ReadEverySeconds: int(every / time.Second), OverdueAfterSeconds: int(overdueFactor * every / time.Second), OverdueVariants: st.Overdue,
		})
		delete(byID, id)
	}
	for _, r := range srv.cfg.Regions {
		add(r.ID)
	}
	for _, st := range stats { // sorted, so the leftovers are too
		if _, ok := byID[st.Region]; ok {
			add(st.Region)
		}
	}
	return out, nil
}
