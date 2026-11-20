// Package specs turns the store's published specification into things that can
// be searched and sorted, and layers the user's own corrections over it.
//
// Everything here is a pure function of its input. The stored specification is
// kept exactly as the store published it; this package reads it (after Apply
// has laid any overrides over it) and derives ports, radios, PoE budgets and
// other numbers from the display text. Bump Version when the derivation
// changes, and the server re-derives every product from what it already has.
package specs

import (
	"html"
	"regexp"
	"strings"
)

// Version identifies the derivation. A product derived with an older one is
// derived again at startup. TestDerivationVersion fails when the derived output
// for the captured products changes without a bump; after bumping, record the
// new output with: go test ./internal/specs -run TestDerivationVersion -update
const Version = 12

var (
	tagRe   = regexp.MustCompile(`</?[a-zA-Z][^>]*>`)
	blankRe = regexp.MustCompile(`[ \t]+`)
)

// unicodeFixes maps the lookalikes the store mixes into its text (non-breaking
// and narrow spaces, non-breaking hyphens, a fullwidth "<", curly quotes) to
// plain ASCII, so patterns written for the plain forms match.
var unicodeFixes = strings.NewReplacer(
	" ", " ", " ", " ", " ", " ", " ", " ",
	"‐", "-", "‑", "-",
	"＜", "<", "＞", ">",
	"“", `"`, "”", `"`, "‘", "'", "’", "'",
	"\r", "",
)

// Normalize returns s as plain text: markup removed (a few values carry <a>
// links), entities decoded, lookalike characters replaced with ASCII, runs of
// blanks collapsed, each line trimmed, and empty lines dropped. Line breaks are
// kept, since the store uses them to separate alternatives. It is for parsing;
// what is displayed is the stored text.
func Normalize(s string) string {
	return strings.Join(Lines(s), "\n")
}

// Lines is Normalize split into its lines.
func Lines(s string) []string {
	s = tagRe.ReplaceAllString(s, " ")
	s = html.UnescapeString(s)
	s = unicodeFixes.Replace(s)
	var out []string
	for _, l := range strings.Split(s, "\n") {
		l = strings.TrimSpace(blankRe.ReplaceAllString(l, " "))
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

// oneLine is Normalize with the line breaks replaced by spaces.
func oneLine(s string) string { return strings.Join(Lines(s), " ") }
