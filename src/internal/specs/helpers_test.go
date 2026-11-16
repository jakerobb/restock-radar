package specs

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

// builder assembles a specification for a test: entries in standard sections,
// with ids made up.
type builder struct {
	specs []Effective
	n     int
}

func (b *builder) id() string { b.n++; return fmt.Sprintf("f%d", b.n) }

func (b *builder) add(section, parent, label, kind, value, note string) string {
	id := b.id()
	b.specs = append(b.specs, Effective{Spec: unistore.Spec{
		SectionID: "sec-" + section, Section: section, SectionType: "Standard",
		FeatureID: id, ParentID: parent, Label: label, Kind: kind, Value: value, Note: note,
	}, Origin: OriginPublished})
	return id
}

// text adds a top-level text entry.
func (b *builder) text(section, label, value string) *builder {
	b.add(section, "", label, unistore.SpecText, value, "")
	return b
}

// group adds a group with children given as label, value pairs.
func (b *builder) group(section, group string, kv ...string) *builder {
	g := b.add(section, "", group, unistore.SpecGroup, "", "")
	for i := 0; i+1 < len(kv); i += 2 {
		b.add(section, g, kv[i], unistore.SpecText, kv[i+1], "")
	}
	return b
}

// groupNoted is group, with a footnote on the child at index note (counting pairs).
func (b *builder) groupNoted(section, group string, kv []string, noteAt int, note string) *builder {
	g := b.add(section, "", group, unistore.SpecGroup, "", "")
	for i := 0; i+1 < len(kv); i += 2 {
		n := ""
		if i/2 == noteAt {
			n = note
		}
		b.add(section, g, kv[i], unistore.SpecText, kv[i+1], n)
	}
	return b
}

// grid adds an entry in the store's grid overview section.
func (b *builder) grid(label, value string) *builder {
	id := b.id()
	b.specs = append(b.specs, Effective{Spec: unistore.Spec{
		SectionID: "sec-grid", Section: "Grid overview", SectionType: "Overview",
		FeatureID: id, Label: label, Kind: unistore.SpecText, Value: value,
	}, Origin: OriginPublished})
	return b
}

func (b *builder) derive() Result { return Derive(Input{Slug: "x", Specs: b.specs}) }

type fixture struct {
	Title, Category string
	Specs           []unistore.Spec
}

// fixtures loads real specifications captured from the store, keyed by slug.
func fixtures(t testing.TB) map[string]fixture {
	t.Helper()
	b, err := os.ReadFile("testdata/products.json")
	if err != nil {
		t.Fatal(err)
	}
	m := map[string]fixture{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// derived runs Derive over a captured product.
func derived(t testing.TB, slug string) Result {
	t.Helper()
	f, ok := fixtures(t)[slug]
	if !ok {
		t.Fatalf("no fixture for %s", slug)
	}
	return Derive(Input{Slug: slug, Title: f.Title, Category: f.Category, Specs: Plain(f.Specs)})
}

func metric(r Result, name string) *Metric {
	for i := range r.Metrics {
		if r.Metrics[i].Name == name {
			return &r.Metrics[i]
		}
	}
	return nil
}

func ptr[T any](v T) *T { return &v }

func jsonEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}
