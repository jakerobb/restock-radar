package unistore

import (
	"slices"
	"strings"
)

// rawSpecs is the store's technicalSpecification: sections of entries, each of
// which is a text value, a flag, or a group heading.
type rawSpecs struct {
	Sections []struct {
		Section struct {
			ID    string `json:"id"`
			Label string `json:"label"`
			Type  string `json:"type"`
		} `json:"section"`
		Features []struct {
			// Typename is SpecificationEntitySectionFeatureEntryText, ...EntryFlag
			// or ...FeatureGroup.
			Typename string  `json:"__typename"`
			Note     *string `json:"note"`
			Value    *string `json:"value"`
			Flag     *string `json:"flag"`
			Feature  struct {
				ID       string  `json:"id"`
				Label    string  `json:"label"`
				ParentID *string `json:"parentId"`
			} `json:"feature"`
		} `json:"features"`
	} `json:"sections"`
}

// convertSpecs flattens the store's specification into Specs. It returns nil
// when the response carried none (see Product.Specs), and otherwise a non-nil
// slice, which is empty for a specification with nothing in it.
//
// The store lists every feature its category defines, whether or not the product
// has a value for it, marking the blanks with a flag of "Empty". Those are
// dropped, as are groups left with nothing under them. Malformed entries are
// dropped too, and counted, rather than failing the product: the specification
// is secondary to the stock and price we are here to track.
func convertSpecs(raw *rawSpecs) (specs []Spec, skipped int) {
	if raw == nil {
		return nil, 0
	}
	specs = []Spec{}
	for _, sec := range raw.Sections {
		var entries []Spec
		for _, f := range sec.Features {
			if f.Feature.ID == "" {
				skipped++
				continue
			}
			s := Spec{
				SectionID: sec.Section.ID, Section: sec.Section.Label, SectionType: sec.Section.Type,
				FeatureID: f.Feature.ID, Label: f.Feature.Label,
			}
			if f.Feature.ParentID != nil {
				s.ParentID = *f.Feature.ParentID
			}
			if f.Note != nil {
				s.Note = strings.TrimSpace(*f.Note)
			}
			switch {
			case strings.HasSuffix(f.Typename, "EntryText"):
				if f.Value == nil || strings.TrimSpace(*f.Value) == "" {
					continue
				}
				s.Kind, s.Value = SpecText, strings.TrimSpace(*f.Value)
			case strings.HasSuffix(f.Typename, "EntryFlag"):
				switch {
				case f.Flag == nil, strings.EqualFold(*f.Flag, "Empty"):
					continue
				case strings.EqualFold(*f.Flag, "True"):
					s.Kind, s.Value = SpecFlag, "true"
				case strings.EqualFold(*f.Flag, "False"):
					s.Kind, s.Value = SpecFlag, "false"
				default:
					skipped++
					continue
				}
			case strings.HasSuffix(f.Typename, "FeatureGroup"):
				s.Kind = SpecGroup
			default:
				skipped++
				continue
			}
			entries = append(entries, s)
		}
		specs = append(specs, pruneGroups(entries)...)
	}
	return specs, skipped
}

// pruneGroups removes the groups that have no entries under them, repeating
// until none are left, since removing one can empty its parent. A parent is
// found by feature id, which is unique within one section's entries.
func pruneGroups(entries []Spec) []Spec {
	for {
		parents := map[string]bool{}
		for _, e := range entries {
			if e.ParentID != "" {
				parents[e.ParentID] = true
			}
		}
		pruned := slices.DeleteFunc(slices.Clone(entries), func(e Spec) bool { return e.Kind == SpecGroup && !parents[e.FeatureID] })
		if len(pruned) == len(entries) {
			return entries
		}
		entries = pruned
	}
}
