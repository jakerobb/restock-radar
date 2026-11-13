package poller

import (
	"cmp"
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jakerobb/restock-radar/internal/config"
	"github.com/jakerobb/restock-radar/internal/metrics"
	"github.com/jakerobb/restock-radar/internal/notify"
	"github.com/jakerobb/restock-radar/internal/store"
	"github.com/jakerobb/restock-radar/internal/unistore"
)

type fakeFetcher struct {
	status string
	err    error
	price  int64  // cents; 0 means the default
	cat    string // category reported for the widget; empty means unknown

	// category is what the category page returns; categoryErr makes it fail.
	category    *unistore.Category
	categoryErr error
	// details are what the product endpoint returns for slugs other than the widget.
	details map[string]unistore.Product
	// Request counts.
	productCalls, categoryCalls int
	productSlugs                []string
	productErrFor               map[string]error
}

func (f *fakeFetcher) FetchProduct(_ context.Context, _ config.Region, slug string) (*unistore.Product, error) {
	f.productCalls++
	f.productSlugs = append(f.productSlugs, slug)
	if f.err != nil {
		return nil, f.err
	}
	if err := f.productErrFor[slug]; err != nil {
		return nil, err
	}
	if d, ok := f.details[slug]; ok {
		d.Detailed = true
		return &d, nil
	}
	return &unistore.Product{ID: "p1", Slug: "widget", Name: "W", Title: "Widget", Category: f.cat, Detailed: true, Variants: []unistore.Variant{{
		ID: "v1", SKU: "W-1", Title: "US", Status: f.status,
		Price: &unistore.Money{Amount: cmp.Or(f.price, 10900), Currency: "USD"},
	}}}, nil
}

func (f *fakeFetcher) FetchCategory(context.Context, config.Region, string) (*unistore.Category, error) {
	f.categoryCalls++
	if f.categoryErr != nil {
		return nil, f.categoryErr
	}
	return f.category, nil
}

// listing builds a product as it appears on a category page.
func listing(id, slug, cat, status string) unistore.Product {
	return unistore.Product{ID: id, Slug: slug, Name: slug, Title: strings.ToUpper(slug[:1]) + slug[1:], Category: cat,
		Variants: []unistore.Variant{{ID: "v-" + id, SKU: "S-" + id, Title: "US", Status: status,
			Price: &unistore.Money{Amount: 5000, Currency: "USD"}}}}
}

type fakeNotifier struct {
	sent []notify.Message
	fail bool
	// reject, when set, permanently rejects messages whose title contains it.
	reject string
}

func (n *fakeNotifier) Send(_ context.Context, m notify.Message) error {
	if n.reject != "" && strings.Contains(m.Title, n.reject) {
		return &notify.PermanentError{Err: errors.New("ntfy returned HTTP 400")}
	}
	if n.fail {
		return errors.New("ntfy down")
	}
	n.sent = append(n.sent, m)
	return nil
}

func setup(t *testing.T) (*Poller, *fakeFetcher, *fakeNotifier) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	cfg := &config.Config{
		FailureAlertAfter: 2,
		Regions:           []config.Region{{ID: "us", BaseURL: "https://store.example", Path: "us/en"}},
	}
	if _, _, err := st.SyncConfigItems(context.Background(), []store.ItemKey{{Region: "us", Slug: "widget"}}, time.Now()); err != nil {
		t.Fatal(err)
	}
	f, n := &fakeFetcher{status: "SoldOut"}, &fakeNotifier{}
	return New(cfg, f, st, n), f, n
}

func TestNotifiesOnRestockNotOnBaseline(t *testing.T) {
	p, f, n := setup(t)
	ctx := context.Background()

	p.cycle(ctx)
	if len(n.sent) != 0 {
		t.Fatalf("baseline must not notify, got %v", n.sent)
	}
	f.status = "Available"
	p.cycle(ctx)
	if len(n.sent) != 1 || n.sent[0].Click != "https://store.example/us/en/products/widget" {
		t.Fatalf("want one in-stock notification, got %+v", n.sent)
	}
	p.cycle(ctx)
	if len(n.sent) != 1 {
		t.Fatalf("no duplicate notification expected, got %d", len(n.sent))
	}
}

func TestRetriesFailedDelivery(t *testing.T) {
	p, f, n := setup(t)
	ctx := context.Background()
	p.cycle(ctx)
	f.status = "Available"
	n.fail = true
	p.cycle(ctx)
	if len(n.sent) != 0 {
		t.Fatal("send should have failed")
	}
	n.fail = false
	p.cycle(ctx)
	if len(n.sent) != 1 {
		t.Fatalf("undelivered event should be retried, got %d sent", len(n.sent))
	}
}

func TestFailureAlertOnceThenRecovery(t *testing.T) {
	p, f, n := setup(t)
	ctx := context.Background()
	f.err = unistore.ErrSchema
	p.cycle(ctx)
	if len(n.sent) != 0 {
		t.Fatal("one failure shouldn't alert")
	}
	p.cycle(ctx)
	p.cycle(ctx)
	if len(n.sent) != 1 {
		t.Fatalf("want exactly one failure alert, got %d", len(n.sent))
	}
	f.err = nil
	p.cycle(ctx)
	if len(n.sent) != 2 {
		t.Fatalf("want a recovery notice, got %d", len(n.sent))
	}
}

func TestBlockedAbandonsCycle(t *testing.T) {
	p, f, _ := setup(t)
	f.err = &unistore.HTTPError{Status: 429}
	if !p.cycle(context.Background()) {
		t.Fatal("429 should report blocked")
	}
}

func TestJitterBounds(t *testing.T) {
	for range 1000 {
		if j := jitter(time.Minute); j < -time.Minute || j >= time.Minute {
			t.Fatalf("jitter out of range: %v", j)
		}
	}
	if jitter(0) != 0 {
		t.Fatal("zero jitter must be zero")
	}
}

func TestAdd(t *testing.T) {
	ctx := context.Background()
	p, f, n := setup(t)
	f.status = "SoldOut"

	if _, err := p.Add(ctx, "bad slug", ""); err == nil {
		t.Fatal("invalid input should fail")
	} else if ue := new(UserError); !errors.As(err, &ue) {
		t.Fatalf("want a UserError, got %T", err)
	}

	f.err = unistore.ErrNotFound
	if _, err := p.Add(ctx, "nope", ""); err == nil || !errors.As(err, new(*UserError)) {
		t.Fatalf("missing product should be a UserError, got %v", err)
	}

	f.err = nil
	if _, err := p.Add(ctx, "https://other.example/us/en/products/widget", ""); err == nil {
		t.Fatal("a URL from an unknown store should fail")
	}
	res, err := p.Add(ctx, "Widget", "")
	if err != nil || res.AlreadyTracked || res.Slug != "widget" || res.Variants != 1 {
		t.Fatalf("unexpected result %+v err=%v", res, err)
	}
	items, _ := p.store.Items(ctx)
	var found bool
	for _, it := range items {
		found = found || (it.Slug == "widget" && it.ProductID == "p1")
	}
	if !found {
		t.Fatalf("item not recorded: %+v", items)
	}

	res, err = p.Add(ctx, "widget", "")
	if err != nil || !res.AlreadyTracked {
		t.Fatalf("second add should report already tracked: %+v err=%v", res, err)
	}

	// The baseline is silent, and a later restock alerts normally.
	f.status = "Available"
	p.cycle(ctx)
	if len(n.sent) != 1 {
		t.Fatalf("want one restock notification, got %d", len(n.sent))
	}
}

func TestMetricsFollowThePoll(t *testing.T) {
	p, f, n := setup(t)
	ctx := context.Background()
	render := func() string {
		var buf strings.Builder
		p.Metrics().Render(&buf, metrics.Gauges{})
		return buf.String()
	}

	p.cycle(ctx)
	f.status = "Available"
	p.cycle(ctx)
	out := render()
	for _, want := range []string{`fetches_total{result="ok"} 2`, `events_total{kind="status"} 1`, `notifications_total{result="sent"} 1`, "items_failing 0"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}

	f.err = &unistore.HTTPError{Status: 429}
	p.cycle(ctx)
	f.err = unistore.ErrSchema
	p.cycle(ctx)
	n.fail = true
	out = render()
	for _, want := range []string{`fetches_total{result="blocked"} 1`, `fetches_total{result="schema"} 1`, "items_failing 1"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}

	f.err = nil
	f.status = "SoldOut"
	p.cycle(ctx) // restock reverses; delivery fails
	if out = render(); !strings.Contains(out, `notifications_total{result="failed"} 1`) || !strings.Contains(out, "items_failing 0") {
		t.Errorf("failure metrics wrong:\n%s", out)
	}
}

func TestPermanentRejectionDoesNotBlockTheQueue(t *testing.T) {
	p, f, n := setup(t)
	ctx := context.Background()
	p.cycle(ctx) // baseline

	// Two changes in one pass: a status change, then a price change. The
	// status notification is the one the server will refuse.
	f.status = "Available"
	f.price = 9900
	n.reject = "in stock"
	p.cycle(ctx)

	if len(n.sent) != 1 || !strings.Contains(n.sent[0].Title, "price changed") {
		t.Fatalf("the price alert behind the rejected one must still go out: %+v", n.sent)
	}
	pending, _ := p.store.PendingEvents(ctx)
	if len(pending) != 0 {
		t.Fatalf("a rejected event must not stay pending: %+v", pending)
	}
	var buf strings.Builder
	p.Metrics().Render(&buf, metrics.Gauges{})
	if !strings.Contains(buf.String(), `notifications_total{result="dropped"} 1`) {
		t.Errorf("dropped metric missing:\n%s", buf.String())
	}

	// It is not retried on later cycles.
	n.reject = ""
	p.cycle(ctx)
	if len(n.sent) != 1 {
		t.Fatalf("a dropped event must stay dropped, got %d sent", len(n.sent))
	}
}

func TestAddRefusesWhenTheWatchListIsFull(t *testing.T) {
	p, f, _ := setup(t)
	f.status = "SoldOut"
	p.cfg.MaxItems = 1 // setup already put one item on the list
	_, err := p.Add(context.Background(), "other", "")
	var ue *UserError
	if !errors.As(err, &ue) || !strings.Contains(ue.Msg, "full") {
		t.Fatalf("want a 'full' UserError, got %v", err)
	}
}

func TestCategoryPageReplacesPerItemRequests(t *testing.T) {
	p, f, n := setup(t)
	ctx := context.Background()
	f.status = "SoldOut"
	f.cat = "c1"
	f.details = map[string]unistore.Product{}
	page := func(products ...unistore.Product) {
		f.category = &unistore.Category{Subcategories: []string{"c1"}, Products: products}
		for _, pr := range products {
			f.details[pr.Slug] = pr
		}
	}

	// The first pass doesn't know the widget's category, so it asks for the widget itself.
	p.cycle(ctx)
	if f.productCalls != 1 || f.categoryCalls != 0 {
		t.Fatalf("first cycle: %d product / %d category requests", f.productCalls, f.categoryCalls)
	}

	// From then on one category request covers it. The page's other products are
	// adopted silently, because this is the first look at the category.
	page(listing("p1", "widget", "c1", "SoldOut"), listing("p2", "gadget", "c1", "Available"))
	p.cycle(ctx)
	if f.productCalls != 2 || f.categoryCalls != 1 { // the discovered gadget is fetched once for its details
		t.Fatalf("second cycle: %d product / %d category requests", f.productCalls, f.categoryCalls)
	}
	if len(n.sent) != 0 {
		t.Fatalf("the first look at a category must not announce its products: %+v", n.sent)
	}
	var gadget *store.Item
	items, _ := p.store.Items(ctx)
	for i := range items {
		if items[i].Slug == "gadget" {
			gadget = &items[i]
		}
	}
	if gadget == nil || gadget.Source != store.SourceDiscovered || gadget.ProductID != "p2" || gadget.Category != "c1" {
		t.Fatalf("gadget should be tracked as discovered: %+v", items)
	}

	// A product that appears later is announced, and tracked from then on.
	page(listing("p1", "widget", "c1", "Available"), listing("p2", "gadget", "c1", "Available"), listing("p3", "gizmo", "c1", "SoldOut"))
	p.cycle(ctx)
	if f.productCalls != 3 || f.categoryCalls != 2 { // ...and so is the new gizmo
		t.Fatalf("third cycle: %d product / %d category requests", f.productCalls, f.categoryCalls)
	}
	if len(n.sent) != 2 {
		t.Fatalf("want a restock and a new-product notification, got %+v", n.sent)
	}
	var announced notify.Message
	for _, m := range n.sent {
		if strings.HasPrefix(m.Title, "New product!") {
			announced = m
		}
	}
	if announced.Title != "New product! Gizmo" || announced.Click != "https://store.example/us/en/products/gizmo" || announced.Body != "Sold out, $50.00." {
		t.Fatalf("unexpected announcement: %+v", announced)
	}
	// The announcement fires once.
	p.cycle(ctx)
	if len(n.sent) != 2 {
		t.Fatalf("no repeat notifications expected, got %d", len(n.sent))
	}

	// When the page stops listing a discovered product we leave it alone, but a
	// product someone chose to watch is checked directly.
	page(listing("p2", "gadget", "c1", "Available"))
	p.cycle(ctx)
	if f.productCalls != 4 {
		t.Fatalf("only the widget should be fetched individually, got %d product requests", f.productCalls)
	}
}

func TestCategoryFailureFallsBackToWatchedItems(t *testing.T) {
	p, f, _ := setup(t)
	ctx := context.Background()
	f.status = "SoldOut"
	f.cat = "c1"
	p.cycle(ctx) // learns the category

	f.categoryErr = unistore.ErrSchema
	p.cycle(ctx)
	if f.categoryCalls != 1 || f.productCalls != 2 {
		t.Fatalf("a failed category page should fall back to the widget: %d category / %d product", f.categoryCalls, f.productCalls)
	}

	f.categoryErr = &unistore.HTTPError{Status: 429}
	if !p.cycle(ctx) {
		t.Fatal("a blocked category page should report blocked")
	}
	if f.productCalls != 2 {
		t.Fatalf("a blocked cycle must stop asking: %d product requests", f.productCalls)
	}
}

func TestMaxItemsIgnoresDiscoveredProducts(t *testing.T) {
	p, f, _ := setup(t)
	ctx := context.Background()
	f.status = "SoldOut"
	f.cat = "c1"
	p.cycle(ctx)
	f.category = &unistore.Category{Subcategories: []string{"c1"}, Products: []unistore.Product{
		listing("p1", "widget", "c1", "SoldOut"), listing("p2", "gadget", "c1", "SoldOut"), listing("p3", "gizmo", "c1", "SoldOut")}}
	p.cycle(ctx)

	p.cfg.MaxItems = 2 // one listed item (the widget), two discovered
	if _, err := p.Add(ctx, "other", ""); err != nil {
		t.Fatalf("discovered products must not fill the watch list: %v", err)
	}
}

func TestBackfillFetchesDetailsForUndetailedProductsInBatches(t *testing.T) {
	p, f, _ := setup(t)
	ctx := context.Background()
	f.status = "SoldOut"
	f.cat = "c1"
	f.details = map[string]unistore.Product{}
	var page []unistore.Product
	for _, slug := range []string{"a", "b", "c", "d", "e", "f", "g"} {
		pr := listing("id-"+slug, slug, "c1", "Available")
		pr.Group = "The Group"
		f.details[slug] = pr
		page = append(page, pr)
	}
	// Category pages carry no group.
	listed := []unistore.Product{listing("p1", "widget", "c1", "SoldOut")}
	for _, pr := range page {
		pr.Group = ""
		listed = append(listed, pr)
	}
	f.category = &unistore.Category{Subcategories: []string{"c1"}, Products: listed}

	p.cycle(ctx) // learns the widget's category
	p.cycle(ctx) // adopts the seven discovered products, then backfills five of them
	if got := f.productCalls - 1; got != detailBatch {
		t.Fatalf("want %d backfill fetches, got %d (%v)", detailBatch, got, f.productSlugs)
	}
	p.cycle(ctx) // the remaining two
	if got := f.productCalls - 1; got != 7 {
		t.Fatalf("want 7 backfill fetches in all, got %d (%v)", got, f.productSlugs)
	}
	p.cycle(ctx) // nothing left
	if got := f.productCalls - 1; got != 7 {
		t.Fatalf("details are fetched once per product, got %d fetches (%v)", got, f.productSlugs)
	}

	vs, err := p.store.Variants(ctx, "us")
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range vs {
		if v.ProductSlug != "widget" && v.ProductGroup != "The Group" {
			t.Fatalf("%s: group %q not recorded", v.ProductSlug, v.ProductGroup)
		}
	}
}

func TestBackfillSkipsProductsThatFail(t *testing.T) {
	p, f, _ := setup(t)
	ctx := context.Background()
	f.status = "SoldOut"
	f.cat = "c1"
	f.details = map[string]unistore.Product{}
	var page []unistore.Product
	for _, slug := range []string{"a", "b", "c", "d", "e", "f", "g"} {
		page = append(page, listing("id-"+slug, slug, "c1", "Available"))
	}
	// Only "g" has details; the rest answer "not found".
	f.details["g"] = page[6]
	f.category = &unistore.Category{Subcategories: []string{"c1"}, Products: page}
	f.productErrFor = map[string]error{}
	for _, slug := range []string{"a", "b", "c", "d", "e", "f"} {
		f.productErrFor[slug] = unistore.ErrNotFound
	}

	p.cycle(ctx)
	p.cycle(ctx) // tries a-e, which fail
	p.cycle(ctx) // skips them: f, then g
	if !slices.Contains(f.productSlugs, "g") {
		t.Fatalf("a failing product must not starve the others: %v", f.productSlugs)
	}
}
