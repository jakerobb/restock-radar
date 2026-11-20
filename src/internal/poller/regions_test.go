package poller

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jakerobb/restock-radar/internal/config"
	"github.com/jakerobb/restock-radar/internal/store"
	"github.com/jakerobb/restock-radar/internal/unistore"
)

// regionFetcher serves category pages by region and category; a page it has
// none for is one the store redirects away from, which the client reports as not found.
type regionFetcher struct {
	fakeFetcher
	pages map[string]*unistore.Category
	calls []string
}

func (f *regionFetcher) FetchCategory(_ context.Context, r config.Region, id string) (*unistore.Category, error) {
	f.calls = append(f.calls, r.ID+"/"+id)
	if c, ok := f.pages[r.ID+"/"+id]; ok {
		return c, nil
	}
	return nil, fmt.Errorf("%w: category %q redirects", unistore.ErrNotFound, id)
}

func (f *regionFetcher) callsTo(key string) int {
	n := 0
	for _, c := range f.calls {
		if c == key {
			n++
		}
	}
	return n
}

func TestEveryRegionIsAskedAboutTheCategoriesOthersHave(t *testing.T) {
	p, base, n := setup(t)
	ctx := context.Background()
	p.cfg.Regions = append(p.cfg.Regions, config.Region{ID: "eu", BaseURL: "https://eu.store.example", Path: "eu/en"})
	base.cat = "c1"
	f := &regionFetcher{fakeFetcher: *base, pages: map[string]*unistore.Category{}}
	f.details = map[string]unistore.Product{}
	p.fetcher = f
	page := func(region string, subs []string, products ...unistore.Product) {
		f.pages[region+"/c1"] = &unistore.Category{Subcategories: subs, Products: products}
		for _, pr := range products {
			f.details[pr.Slug] = pr
		}
	}

	// The first cycle reads the widget on its own, which is how its category is learned.
	p.cycle(ctx)
	// The US page lists a second category, which the EU page doesn't.
	page("us", []string{"c1", "c3"}, listing("p1", "widget", "c1", "SoldOut"), listing("p9", "wonder", "c3", "Available"))
	page("eu", []string{"c1"}, listing("e1", "widget-eu", "c1", "Available"))
	p.cycle(ctx)
	p.cycle(ctx) // the second EU read must not announce what the first adopted

	items, _ := p.store.Items(ctx)
	var eu []string
	for _, it := range items {
		if it.Region == "eu" {
			if it.Source != store.SourceDiscovered {
				t.Errorf("EU product %s should be discovered", it.Slug)
			}
			eu = append(eu, it.Slug)
		}
	}
	if len(eu) != 1 || eu[0] != "widget-eu" {
		t.Fatalf("EU should be tracking what its own page lists: %v", eu)
	}
	if len(n.sent) != 0 {
		t.Fatalf("adopting a region's catalogue must be silent: %+v", n.sent)
	}

	// c3 is asked of the EU store once, found missing, and left alone after that.
	if got := f.callsTo("eu/c3"); got != 1 {
		t.Errorf("eu/c3 requested %d times, want 1 (then remembered as missing)", got)
	}

	// A product that later appears on the EU page is announced, labelled with its region.
	page("eu", []string{"c1"}, listing("e1", "widget-eu", "c1", "Available"), listing("e2", "gizmo-eu", "c1", "Available"))
	p.cycle(ctx)
	if len(n.sent) != 1 || !strings.HasPrefix(n.sent[0].Title, "New product! [EU] Gizmo") {
		t.Fatalf("want one EU new-product announcement, got %+v", n.sent)
	}

	// Once the recheck time has passed the missing page is asked about again.
	p.missing["eu/c3"] = time.Now().Add(-missingRecheck - time.Minute)
	p.cycle(ctx)
	if got := f.callsTo("eu/c3"); got != 2 {
		t.Errorf("eu/c3 requested %d times after the recheck, want 2", got)
	}
}

func TestARollingRegionReadsTheShareThatHasWaitedLongest(t *testing.T) {
	p, _, _ := setup(t)
	p.cfg.PollInterval = 5 * time.Minute
	eu := config.Region{ID: "eu", PollEvery: time.Hour}
	us := config.Region{ID: "us"}

	keys := make([]string, 24)
	for i := range keys {
		keys[i] = fmt.Sprintf("cat:eu/c%02d", i)
	}

	// 24 pages every 12 cycles is 2 a cycle, and over 12 cycles each is read exactly once.
	counts := map[string]int{}
	base := time.Now()
	for cycle := range 12 {
		got := p.due(eu, keys)
		if len(got) != 2 {
			t.Fatalf("cycle %d reads %d pages, want 2", cycle, len(got))
		}
		for k := range got {
			counts[k]++
			p.lastPolled[k] = base.Add(time.Duration(cycle) * 5 * time.Minute)
		}
	}
	for _, k := range keys {
		if counts[k] != 1 {
			t.Errorf("%s read %d times in an hour, want 1", k, counts[k])
		}
	}
	// The next cycle starts again with the one read longest ago.
	if got := p.due(eu, keys); len(got) != 2 || !got["cat:eu/c00"] || !got["cat:eu/c01"] {
		t.Errorf("want the two oldest pages next, got %v", got)
	}

	// A region with no poll_every reads everything, and a small one still reads something.
	if got := p.due(us, keys); len(got) != len(keys) {
		t.Errorf("a region with no poll_every reads all %d, got %d", len(keys), len(got))
	}
	if got := p.due(eu, keys[:3]); len(got) != 1 {
		t.Errorf("3 pages hourly at 5-minute cycles should read 1, got %d", len(got))
	}
	if got := p.due(eu, nil); len(got) != 0 {
		t.Errorf("nothing to read, got %v", got)
	}
}
