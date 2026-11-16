package specs

import (
	"slices"
	"testing"
)

func TestNormalize(t *testing.T) {
	for _, tc := range []struct{ name, in, want string }{
		{"plain text is unchanged", "5 Gbps", "5 Gbps"},
		{"blank lines and edge spaces go, inner line breaks stay", "  16 (8 PoE+; 8 PoE++)  \n\n  (1G/100M/10M)\n", "16 (8 PoE+; 8 PoE++)\n(1G/100M/10M)"},
		{"runs of blanks collapse", "2  x\t2", "2 x 2"},
		{"non-breaking and narrow spaces become spaces", "5 Gbps 10 Gbps", "5 Gbps 10 Gbps"},
		{"non-breaking hyphen becomes a hyphen", "44‑57V", "44-57V"},
		{"fullwidth less-than becomes ASCII", "＜ 0.05%", "< 0.05%"},
		{"curly quotes become straight", "17.4 x 12.8 x 1.7”", `17.4 x 12.8 x 1.7"`},
		{"a link is reduced to its text", `Version 5.10.5 and later<a href="https://x.example" target="_blank" rel="noopener">https://x.example</a>`, "Version 5.10.5 and later https://x.example"},
		{"a literal less-than is not a tag", "130 W, 8 Ω, < 0.05% THD+N", "130 W, 8 Ω, < 0.05% THD+N"},
		{"entities are decoded", "AT&amp;T", "AT&T"},
		{"carriage returns go", "a\r\nb", "a\nb"},
		{"empty stays empty", "  \n ", ""},
		{"the en dash is kept", "44–57V", "44–57V"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := Normalize(tc.in); got != tc.want {
				t.Errorf("Normalize(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestLines(t *testing.T) {
	got := Lines("a\n\n b \n \nc")
	if want := []string{"a", "b", "c"}; !slices.Equal(got, want) {
		t.Errorf("Lines = %q, want %q", got, want)
	}
	if got := Lines(""); len(got) != 0 {
		t.Errorf("Lines of nothing = %q", got)
	}
}
