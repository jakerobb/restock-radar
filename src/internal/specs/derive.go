package specs

import (
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

// Input is what Derive reads: a product and its effective specification.
type Input struct {
	Slug     string
	Title    string
	Category string
	Specs    []Effective
}

// Result is everything derived from one product's specification.
type Result struct {
	Ports []Port `json:"ports"`
	// PoEBudget lists the PoE budgets the specification gives. Most products have
	// one; some depend on how they are powered.
	PoEBudget []PoEScenario `json:"poe_budget"`
	// PoEMaxClass is the highest PoE class the device can supply ("PoE", "PoE+",
	// "PoE++" or "PoE+++"), empty when it supplies none or doesn't say.
	PoEMaxClass string   `json:"poe_max_class"`
	Radios      []Radio  `json:"radios"`
	Metrics     []Metric `json:"metrics"`
	// Power lists the ways the product can be powered (PoE, AC, USB-C, ...).
	// Empty when the specification doesn't say.
	Power []PowerSource `json:"power"`
	Rack  Rack          `json:"rack"`
	Dims  Dims          `json:"dims"`
	// Known says which of the above could be derived at all. "No ports" is only a
	// statement about a product whose ports were found; for the others it means we
	// don't know.
	Known  Known   `json:"known"`
	Issues []Issue `json:"issues"`
}

// Known records which kinds of fact were present in the specification.
type Known struct {
	Ports  bool `json:"ports"`
	PoE    bool `json:"poe"`
	Radios bool `json:"radios"`
	Rack   bool `json:"rack"`
	Dims   bool `json:"dims"`
}

// Issue is something in the specification that looked relevant but couldn't be
// read. They are for the person maintaining the parsers (and for deciding what
// to override); nothing fails because of them.
type Issue struct {
	Area    string `json:"area"`
	Label   string `json:"label"`
	Value   string `json:"value"`
	Problem string `json:"problem"`
}

// Metric is a number extracted from a text value.
type Metric struct {
	Name  string  `json:"name"`
	Value float64 `json:"value"`
	Unit  string  `json:"unit"`
	// AtLeast marks a value published as "N+".
	AtLeast bool `json:"at_least"`
	// Raw is the text the number came from.
	Raw string `json:"raw"`
}

// Derive reads a product's effective specification. Only the standard sections
// are read: the store's grid overview is a summary of them.
//
// A bug in a parser must not stop the product being tracked, so a panic is
// recovered and reported as an issue, and whatever was derived before it is kept.
func Derive(in Input) Result { return deriveWith(in, nil) }

// deriveWith is Derive with a hook run after the index is built, for testing
// that a panic is contained.
func deriveWith(in Input, hook func()) (r Result) {
	ix := newIndex(in.Specs)
	r = Result{Ports: []Port{}, PoEBudget: []PoEScenario{}, Radios: []Radio{}, Metrics: []Metric{}, Power: []PowerSource{}, Issues: []Issue{}}
	ix.res = &r
	defer func() {
		if p := recover(); p != nil {
			r.Issues = append(r.Issues, Issue{Area: "derive", Problem: fmt.Sprintf("internal error: %v", p)})
			r.Known.PoE = len(r.PoEBudget) > 0 || r.PoEMaxClass != "" || slicesAnyPoE(r.Ports)
			slices.SortFunc(r.Metrics, func(a, b Metric) int { return strings.Compare(a.Name, b.Name) })
		}
	}()

	if hook != nil {
		hook()
	}
	r.PoEMaxClass = poeMaxClass(ix)
	derivePorts(ix, &r)
	derivePoEBudget(ix, &r)
	deriveRadios(ix, &r)
	deriveMetrics(ix, &r)
	deriveFeatures(ix, &r)
	derivePower(ix, &r)
	deriveInjector(ix, in, &r)
	deriveRack(ix, &r)
	deriveDims(ix, &r)

	r.Known.PoE = len(r.PoEBudget) > 0 || r.PoEMaxClass != "" || slicesAnyPoE(r.Ports)
	slices.SortFunc(r.Metrics, func(a, b Metric) int { return strings.Compare(a.Name, b.Name) })
	return r
}

func slicesAnyPoE(ports []Port) bool {
	for _, p := range ports {
		if p.PoEClass != "" && p.PoEDirection == "out" {
			return true
		}
	}
	return false
}

// index finds entries by label.
type index struct {
	std      []Effective
	overview []Effective               // the grid overview: a summary, read only for what the standard sections lack
	children map[[2]string][]Effective // section id, group feature id -> entries under it
	groups   map[string][]Effective    // lower-cased label -> group entries
	res      *Result
}

func newIndex(specs []Effective) *index {
	ix := &index{children: map[[2]string][]Effective{}, groups: map[string][]Effective{}}
	for _, e := range specs {
		if e.SectionType == "Overview" {
			ix.overview = append(ix.overview, e)
			continue
		}
		ix.std = append(ix.std, e)
		if e.Kind == unistore.SpecGroup {
			ix.groups[key(e.Label)] = append(ix.groups[key(e.Label)], e)
		}
		if e.ParentID != "" {
			k := [2]string{e.SectionID, e.ParentID}
			ix.children[k] = append(ix.children[k], e)
		}
	}
	return ix
}

func key(label string) string { return strings.ToLower(strings.TrimSpace(oneLine(label))) }

// group returns the entries under the group with the given label.
func (ix *index) group(label string) []Effective {
	var out []Effective
	for _, g := range ix.groups[key(label)] {
		out = append(out, ix.children[[2]string{g.SectionID, g.FeatureID}]...)
	}
	return out
}

// scalar returns the first top-level text entry with one of the labels, trying
// them in order.
func (ix *index) scalar(labels ...string) (Effective, bool) {
	for _, l := range labels {
		for _, e := range ix.std {
			if e.ParentID == "" && e.Kind == unistore.SpecText && key(e.Label) == key(l) {
				return e, true
			}
		}
	}
	return Effective{}, false
}

// all returns every text entry with the label, grouped or not, in order: some
// labels are used in more than one place (a camera's "Resolution", a headline in
// the overview and the pixels under "Video").
func (ix *index) all(label string) []Effective {
	var out []Effective
	for _, e := range ix.std {
		if e.Kind == unistore.SpecText && key(e.Label) == key(label) {
			out = append(out, e)
		}
	}
	return out
}

func (ix *index) issue(area string, e Effective, problem string) {
	if len(ix.res.Issues) >= 100 {
		return
	}
	v := oneLine(e.Value)
	if len(v) > 200 {
		v = v[:200]
	}
	ix.res.Issues = append(ix.res.Issues, Issue{Area: area, Label: e.Label, Value: v, Problem: problem})
}

var numRe = `(\d+(?:[.,]\d+)*)`

// num parses a number as the store writes it, with thousands separators.
func num(s string) (float64, bool) {
	f, err := strconv.ParseFloat(strings.ReplaceAll(s, ",", ""), 64)
	return f, err == nil
}

var classRe = regexp.MustCompile(`PoE\+{0,3}`)

// poeRank orders PoE classes by capability: af, at, bt type 3, bt type 4.
func poeRank(class string) int {
	switch class {
	case "PoE":
		return 1
	case "PoE+":
		return 2
	case "PoE++":
		return 3
	case "PoE+++":
		return 4
	}
	return 0
}

// poeMaxClass is the highest class named by "Max. PoE Output" ("Up to PoE++").
func poeMaxClass(ix *index) string {
	e, ok := ix.scalar("Max. PoE Output")
	if !ok {
		return ""
	}
	return classRe.FindString(oneLine(e.Value))
}

func formatFloat(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }
