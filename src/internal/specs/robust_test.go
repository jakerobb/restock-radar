package specs

import (
	"strings"
	"testing"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

// hostile is text a parser might choke on: empty, odd punctuation, huge numbers,
// unbalanced brackets, repeated separators, non-ASCII, and the shapes of the
// formats it does read, slightly broken.
var hostile = []string{
	"", " ", "\n", "\n\n\n", "(", ")", "((", "))", "()", "(()", "(1)", "(1) (2)", ":", "::", ": :", "x", "x x x", "1 x", "1 x 2 x", "x 1 x 2 mm",
	"mm", "W", "0W", "-1W", "99999999999999999999999999999W", "1e309 Gbps", "NaN Gbps", "Inf dBm", "1,2,3W", "1.2.3 GbE", ".5 GHz", "1/", "/1", "//", "G/M/G",
	"10G/", "/10G", "10G//1G", "(10G/", "1 (PoE+", "1 PoE+)", "1 (PoE+++++)", "-3 (All PoE+)", "0 (All PoE+)", "99999999999999999999 (All PoE+)",
	"All PoE+", "1 (All PoE+; 2 PoE++ input,, 3 PoE)", "8 (8 PoE+; 8 PoE++)", "⌀", "⌀ x mm", "⌀0 x 0 mm", "0 x 0 x 0 mm", "-1 x -1 x -1 mm", "1 x 2 x 3 mm\n⌀4 x 5 mm",
	"Device:", "Device: Device:", ": 1 x 2 x 3 mm", "A:\nB:\nC:", "With:", "Without: 1 x 2 x 3 mm", strings.Repeat("(", 200), strings.Repeat("1/", 200), strings.Repeat("x", 20000),
	strings.Repeat("1 x ", 1000) + "mm", "\u0000", "\u202e", "\ufffd", "💥", "<a href=\"", "<<<>>>", "&amp;amp;", "0 dBm\n0 dBi\n0 x 0\n0 Gbps", "99 Tbps", "1 Bpps", "1 mW", "Rack mount (0U)", "Rack mount (99999999999999999999U)",
	"WiFi", "WiFi 99", "WiFi 6E WiFi 7 WiFi 3", "802.11", "be", "ax ac n",
}

// labels the parsers read, with the section they sit in, as top-level entries.
var scalarLabels = []string{
	"Max. PoE Output", "Total PoE Availability", "PoE Budget", "Total Available PoE", "Power Supply", "Networking Interface", "Max. Power Consumption",
	"Power Consumption", "Switching Capacity", "Total Non-Blocking Throughput", "IDS/IPS Throughput", "Forwarding Rate", "WiFi Standard", "WiFi Standards",
	"Form Factor", "Dimensions",
}

// groups the parsers read, with child labels to put under them.
var groupChildren = map[string][]string{
	"Port Layout":                      {"1 GbE RJ45", "2.5 GbE RJ45", "10G SFP+", "25G SFP28", "Console", "SMA", "MGMT", "Weird Port"},
	"Max. PoE Wattage per Port by PSE": {"PoE", "PoE+", "PoE++", "PoE+++", "Other"},
	"Antenna Gain":                     {"2.4 GHz", "5 GHz", "6 GHz", "60 GHz", "Bluetooth", "SuperLink", "Mystery"},
	"Max. TX Power":                    {"2.4 GHz", "5 GHz", "6 GHz", "60 GHz", "Bluetooth", "SuperLink", "Mystery"},
	"MIMO":                             {"2.4 GHz", "5 GHz", "6 GHz", "Mystery"},
	"Max. Data Rate":                   {"2.4 GHz", "5 GHz", "6 GHz", "Mystery"},
}

func TestDeriveNeverPanicsOnHostileText(t *testing.T) {
	for _, h := range hostile {
		b := &builder{}
		for _, l := range scalarLabels {
			b.add("Overview", "", l, unistore.SpecText, h, h)
		}
		for g, kids := range groupChildren {
			id := b.add("Overview", "", g, unistore.SpecGroup, "", "")
			for _, k := range kids {
				b.add("Overview", id, k, unistore.SpecText, h, h)
			}
		}
		r := b.derive()
		for _, is := range r.Issues {
			if is.Area == "derive" {
				t.Fatalf("a parser panicked on %q: %s", truncate(h), is.Problem)
			}
		}
		if !jsonEqual(r, b.derive()) {
			t.Errorf("not deterministic on %q", truncate(h))
		}
		// A count is believable, whatever the text said.
		for _, p := range r.Ports {
			if p.Count < 0 || p.Count > maxPlausiblePorts {
				t.Errorf("implausible count %+v on %q", p, truncate(h))
			}
		}
	}
}

func TestDeriveNeverPanicsOnBrokenStructure(t *testing.T) {
	// Groups with nothing under them, children of nothing, children of a child,
	// a group in a group, repeated ids, empty labels, entries of the wrong kind.
	b := &builder{}
	b.add("Overview", "missing-parent", "Weight", unistore.SpecText, "1 kg", "")
	b.add("Overview", "", "", unistore.SpecText, "", "")
	b.add("Overview", "", "Port Layout", unistore.SpecGroup, "", "")
	b.add("Overview", "", "Port Layout", unistore.SpecFlag, "true", "")
	g := b.add("Overview", "", "Antenna Gain", unistore.SpecGroup, "", "")
	g2 := b.add("Overview", g, "5 GHz", unistore.SpecGroup, "", "")
	b.add("Overview", g2, "6 GHz", unistore.SpecText, "5 dBi", "")
	b.add("Overview", g, "5 GHz", unistore.SpecFlag, "true", "")
	b.add("Overview", "", "Dimensions", unistore.SpecFlag, "true", "")
	b.add("Overview", "", "Form Factor", unistore.SpecGroup, "", "")
	b.add("Overview", "", "Total PoE Availability", unistore.SpecText, "", "")
	r := b.derive()
	for _, is := range r.Issues {
		if is.Area == "derive" {
			t.Fatalf("panicked: %s", is.Problem)
		}
	}
	// And no specification at all.
	if r := Derive(Input{}); len(r.Issues) != 0 || r.Known != (Known{}) {
		t.Errorf("empty input: %+v", r)
	}
	if r := Derive(Input{Specs: []Effective{}}); r.Ports == nil || r.Radios == nil || r.Metrics == nil || r.PoEBudget == nil || r.Issues == nil {
		t.Errorf("lists should be empty, not nil: %+v", r)
	}
}

func TestDerivePanicIsRecoveredAndReported(t *testing.T) {
	// Provoke a panic through a hook, to check the safety net itself.
	r := deriveWith(Input{Specs: Plain(nil)}, func() { panic("boom") })
	if len(r.Issues) != 1 || r.Issues[0].Area != "derive" || !strings.Contains(r.Issues[0].Problem, "boom") {
		t.Errorf("issues = %+v", r.Issues)
	}
	if r.Ports == nil || r.Metrics == nil {
		t.Error("the result should still have its (empty) lists")
	}
}

func truncate(s string) string {
	if len(s) > 40 {
		return s[:40] + "…"
	}
	return s
}
