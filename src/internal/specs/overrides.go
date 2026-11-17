package specs

import (
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

// Override actions.
const (
	// ActionSet gives an entry a value of the user's choosing, replacing the
	// published one, or adding the entry if the product has none like it.
	ActionSet = "set"
	// ActionHide drops a published entry as though the store had not listed it.
	ActionHide = "hide"
)

// Where an effective entry came from.
const (
	OriginPublished = "published" // as the store published it
	OriginOverride  = "override"  // a published entry whose value the user replaced
	OriginAdded     = "added"     // an entry the store doesn't have, added by the user
)

// Override is one of the user's corrections to a product's specification. It is
// found by what it targets, not by position or by the store's ids, so it
// survives the store republishing the product: the entry in Section, under the
// group named Group (empty for a top-level entry), labelled Label.
type Override struct {
	ID     int64  `json:"id"`
	Region string `json:"region"`
	Slug   string `json:"slug"`
	Action string `json:"action"`

	Section string `json:"section"`
	Group   string `json:"group"`
	Label   string `json:"label"`

	// Kind is "text" or "flag"; empty keeps the published entry's kind (and
	// means text for an added entry). Value is the display text, written the way
	// the store writes it ("8 Gbps"), because the same parsers read it. Note
	// replaces the published footnote when set.
	Kind  string `json:"kind"`
	Value string `json:"value"`
	Note  string `json:"note"`

	// SourceURL and Reason say where the correction comes from ("teardown post")
	// and why, for whoever looks at it later.
	SourceURL string `json:"source_url"`
	Reason    string `json:"reason"`

	// PublishedValue is the value the store published when the override was made,
	// nil when there was none (an added entry). If the store later publishes
	// something else, the override still applies but is reported as stale, so it
	// can be reviewed.
	PublishedValue *string `json:"published_value"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	// CreatedBy and UpdatedBy say who made and last changed the override (see
	// auth.Principal.Actor). When storing one, UpdatedBy is the person doing it.
	CreatedBy string `json:"created_by,omitempty"`
	UpdatedBy string `json:"updated_by,omitempty"`
}

// Effective is a specification entry after overrides: what the rest of the
// system reads. The published value stays visible beside an overridden one.
type Effective struct {
	unistore.Spec
	Origin string `json:"origin"`
	// Published is what the store published, set when Origin is "override".
	Published *string `json:"published_value,omitempty"`
	// OverrideID is the override that produced the entry, when it has one.
	OverrideID int64 `json:"override_id,omitempty"`
	// Stale reports that the store's published value is no longer the one the
	// override was written against.
	Stale bool `json:"stale,omitempty"`
}

// Applied says what an override did to a product's specification.
type Applied struct {
	OverrideID int64 `json:"override_id"`
	// Status is "overrides" (replaced a published entry), "hides" (removed one),
	// "adds" (created an entry), or "orphan" (a hide whose target isn't there, so
	// it does nothing).
	Status string `json:"status"`
	// Stale is set when the published value differs from the one recorded when
	// the override was made.
	Stale bool `json:"stale"`
}

const (
	StatusOverrides = "overrides"
	StatusHides     = "hides"
	StatusAdds      = "adds"
	StatusOrphan    = "orphan"
)

type target struct{ section, group, label string }

func targetOf(section, group, label string) target {
	f := func(s string) string { return strings.ToLower(strings.TrimSpace(oneLine(s))) }
	return target{f(section), f(group), f(label)}
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

func slug(s string) string {
	return strings.Trim(slugRe.ReplaceAllString(strings.ToLower(s), "-"), "-")
}

// NormalizeTarget cleans the three parts of an override's target the way they
// are matched: blanks collapsed and trimmed. (Matching ignores case as well.)
func NormalizeTarget(section, group, label string) (string, string, string) {
	f := func(s string) string { return strings.TrimSpace(oneLine(s)) }
	return f(section), f(group), f(label)
}

// FindPublished returns the published entry an override with this target would
// replace or hide: an entry (never a group heading) in the section, under the
// group of that name (none for a top-level one), with the label.
func FindPublished(published []unistore.Spec, section, group, label string) (unistore.Spec, bool) {
	want := targetOf(section, group, label)
	groupLabel := map[[2]string]string{}
	for _, s := range published {
		if s.Kind == unistore.SpecGroup {
			groupLabel[[2]string{s.SectionID, s.FeatureID}] = s.Label
		}
	}
	for _, s := range published {
		if s.Kind != unistore.SpecGroup && targetOf(s.Section, groupLabel[[2]string{s.SectionID, s.ParentID}], s.Label) == want {
			return s, true
		}
	}
	return unistore.Spec{}, false
}

// IsGroup reports whether the target names a group heading in the published
// specification and not an entry, which an override can't change.
func IsGroup(published []unistore.Spec, section, group, label string) bool {
	if strings.TrimSpace(group) != "" {
		return false
	}
	want := targetOf(section, "", label)
	for _, s := range published {
		if s.Kind == unistore.SpecGroup && targetOf(s.Section, "", s.Label) == want {
			return true
		}
	}
	return false
}

// Apply lays overrides over a product's published specification and returns the
// effective one, with a report of what each override did. Groups are never
// targets; the entries under them are. A group left with nothing under it by a
// hide is dropped, as the same is done to published data.
func Apply(published []unistore.Spec, overrides []Override) ([]Effective, []Applied) {
	byTarget := make(map[target]*Override, len(overrides))
	for i := range overrides {
		o := &overrides[i]
		byTarget[targetOf(o.Section, o.Group, o.Label)] = o
	}

	groupLabel := map[[2]string]string{} // section id + feature id -> group label
	for _, s := range published {
		if s.Kind == unistore.SpecGroup {
			groupLabel[[2]string{s.SectionID, s.FeatureID}] = s.Label
		}
	}

	matched := map[int64]bool{}
	stale := map[int64]bool{}
	out := make([]Effective, 0, len(published)+len(overrides))
	for _, s := range published {
		e := Effective{Spec: s, Origin: OriginPublished}
		var o *Override
		if s.Kind != unistore.SpecGroup {
			o = byTarget[targetOf(s.Section, groupLabel[[2]string{s.SectionID, s.ParentID}], s.Label)]
		}
		if o == nil {
			out = append(out, e)
			continue
		}
		matched[o.ID] = true
		if o.PublishedValue != nil && *o.PublishedValue != s.Value {
			stale[o.ID] = true
		}
		if o.Action == ActionHide {
			continue
		}
		pub := s.Value
		e.Origin, e.Published, e.OverrideID, e.Stale = OriginOverride, &pub, o.ID, stale[o.ID]
		e.Value = o.Value
		if o.Kind != "" {
			e.Kind = o.Kind
		}
		if o.Note != "" {
			e.Note = o.Note
		}
		out = append(out, e)
	}

	// Entries the store doesn't have, in the order they were made.
	var adds []*Override
	for i := range overrides {
		if o := &overrides[i]; o.Action == ActionSet && !matched[o.ID] {
			adds = append(adds, o)
		}
	}
	slices.SortFunc(adds, func(a, b *Override) int { return int(a.ID - b.ID) })
	for _, o := range adds {
		out = insertAdded(out, o)
	}

	out = dropEmptyGroups(out)

	applied := make([]Applied, 0, len(overrides))
	for i := range overrides {
		o := &overrides[i]
		a := Applied{OverrideID: o.ID, Stale: stale[o.ID]}
		switch {
		case o.Action == ActionHide && matched[o.ID]:
			a.Status = StatusHides
		case o.Action == ActionHide:
			a.Status = StatusOrphan
		case matched[o.ID]:
			a.Status = StatusOverrides
		default:
			a.Status = StatusAdds
		}
		applied = append(applied, a)
	}
	slices.SortFunc(applied, func(a, b Applied) int { return int(a.OverrideID - b.OverrideID) })
	return out, applied
}

// insertAdded places an entry the store doesn't have at the end of its section
// (a new section goes at the end), under its group, creating the group if the
// section has none by that name.
func insertAdded(out []Effective, o *Override) []Effective {
	sectionID, sectionType, last := "custom:"+slug(o.Section), "Standard", -1
	for i, e := range out {
		if strings.EqualFold(strings.TrimSpace(e.Section), strings.TrimSpace(o.Section)) {
			sectionID, sectionType, last = e.SectionID, e.SectionType, i
		}
	}
	label := strings.TrimSpace(o.Section)
	for _, e := range out {
		if e.SectionID == sectionID {
			label = e.Section
			break
		}
	}
	base := unistore.Spec{SectionID: sectionID, Section: label, SectionType: sectionType}

	var add []Effective
	parent := ""
	if g := strings.TrimSpace(o.Group); g != "" {
		for _, e := range out {
			if e.SectionID == sectionID && e.Kind == unistore.SpecGroup && strings.EqualFold(e.Label, g) {
				parent = e.FeatureID
				break
			}
		}
		if parent == "" {
			parent = "custom:" + slug(o.Section) + "/" + slug(g)
			gs := base
			gs.FeatureID, gs.Label, gs.Kind = parent, g, unistore.SpecGroup
			add = append(add, Effective{Spec: gs, Origin: OriginAdded, OverrideID: o.ID})
		}
	}
	s := base
	s.FeatureID = "custom:" + slug(o.Section) + "/" + slug(o.Group) + "/" + slug(o.Label)
	s.ParentID, s.Label, s.Kind, s.Value, s.Note = parent, o.Label, o.Kind, o.Value, o.Note
	if s.Kind == "" {
		s.Kind = unistore.SpecText
	}
	add = append(add, Effective{Spec: s, Origin: OriginAdded, OverrideID: o.ID})

	if last < 0 {
		return append(out, add...)
	}
	return slices.Insert(out, last+1, add...)
}

// dropEmptyGroups removes groups with no entries under them, repeatedly, since
// removing one can empty its parent.
func dropEmptyGroups(es []Effective) []Effective {
	for {
		parents := map[[2]string]bool{}
		for _, e := range es {
			if e.ParentID != "" {
				parents[[2]string{e.SectionID, e.ParentID}] = true
			}
		}
		pruned := slices.DeleteFunc(slices.Clone(es), func(e Effective) bool {
			return e.Kind == unistore.SpecGroup && !parents[[2]string{e.SectionID, e.FeatureID}]
		})
		if len(pruned) == len(es) {
			return es
		}
		es = pruned
	}
}

// Plain wraps published entries as effective ones with no overrides.
func Plain(published []unistore.Spec) []Effective {
	out := make([]Effective, len(published))
	for i, s := range published {
		out[i] = Effective{Spec: s, Origin: OriginPublished}
	}
	return out
}
