package specs

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	powerRe = regexp.MustCompile(numRe + `\s*(m?W)\b`)
	rateTpl = regexp.MustCompile(numRe + `(\+?)\s*(Tbps|Gbps|Mbps|Kbps)`)
	ppsRe   = regexp.MustCompile(numRe + `(\+?)\s*(Bpps|Gpps|Mpps|Kpps)`)
)

// deriveMetrics reads the plain numeric facts: power draw, switching capacity,
// throughput. Each is found by the label the store uses for it.
func deriveMetrics(ix *index, r *Result) {
	// Power draw. "9W (Excluding PoE Output) with PoE input | 210W (Including PoE
	// Output)": the largest figure is the most the device can draw, and the
	// largest of those that exclude PoE output is what the device itself needs.
	if e, ok := ix.scalar("Max. Power Consumption", "Power Consumption"); ok {
		lines := Lines(e.Value)
		maxAll, maxExcl, haveAll, haveExcl := 0.0, 0.0, false, false
		for _, l := range lines {
			for _, m := range powerRe.FindAllStringSubmatch(l, -1) {
				v, ok := num(m[1])
				if !ok {
					continue
				}
				if m[2] == "mW" {
					v /= 1000
				}
				if !haveAll || v > maxAll {
					maxAll, haveAll = v, true
				}
				if strings.Contains(strings.ToLower(l), "excluding poe") && (!haveExcl || v > maxExcl) {
					maxExcl, haveExcl = v, true
				}
			}
		}
		raw := strings.Join(lines, " | ")
		if haveAll {
			r.Metrics = append(r.Metrics, Metric{Name: "power_draw_max_w", Value: maxAll, Unit: "W", Raw: raw})
		} else {
			ix.issue("metrics", e, "no watts")
		}
		if haveExcl {
			r.Metrics = append(r.Metrics, Metric{Name: "power_draw_excl_poe_w", Value: maxExcl, Unit: "W", Raw: raw})
		}
	}

	rate := func(name, unit string, labels ...string) {
		e, ok := ix.scalar(labels...)
		if !ok {
			return
		}
		text := strings.Join(Lines(e.Value), " | ")
		m := rateTpl.FindStringSubmatch(text)
		if m == nil {
			ix.issue("metrics", e, "no data rate")
			return
		}
		v, _ := num(m[1])
		switch unit + "/" + m[3] {
		case "Mbps/Tbps":
			v *= 1_000_000
		case "Mbps/Gbps":
			v *= 1000
		case "Mbps/Kbps":
			v /= 1000
		case "Gbps/Tbps":
			v *= 1000
		case "Gbps/Mbps":
			v /= 1000
		case "Gbps/Kbps":
			v /= 1_000_000
		}
		r.Metrics = append(r.Metrics, Metric{Name: name, Value: v, Unit: unit, AtLeast: m[2] == "+", Raw: text})
	}
	rate("switching_capacity_gbps", "Gbps", "Switching Capacity")
	rate("nonblocking_throughput_gbps", "Gbps", "Total Non-Blocking Throughput")
	rate("ids_ips_throughput_mbps", "Mbps", "IDS/IPS Throughput")

	if e, ok := ix.scalar("Forwarding Rate"); ok {
		text := strings.Join(Lines(e.Value), " | ")
		if m := ppsRe.FindStringSubmatch(text); m != nil {
			v, _ := num(m[1])
			switch m[3] {
			case "Gpps", "Bpps": // billions of packets a second
				v *= 1000
			case "Kpps":
				v /= 1000
			}
			r.Metrics = append(r.Metrics, Metric{Name: "forwarding_rate_mpps", Value: v, Unit: "Mpps", AtLeast: m[2] == "+", Raw: text})
		} else {
			ix.issue("metrics", e, "no packet rate")
		}
	}

	if e, ok := ix.scalar("WiFi Standard", "WiFi Standards"); ok {
		text := strings.Join(Lines(e.Value), " | ")
		if g, ok := wifiGeneration(text); ok {
			r.Metrics = append(r.Metrics, Metric{Name: "wifi_generation", Value: float64(g), Unit: "", Raw: text})
		} else {
			ix.issue("metrics", e, "no WiFi generation")
		}
	}
}

var (
	rackRe  = regexp.MustCompile(`(?i)\brack[ -]?mount`)
	unitsRe = regexp.MustCompile(`(?i)\b(\d+)\s*U\b`)
	fullRe  = regexp.MustCompile(`(?i)full[- ]depth`)
	dimRe   = regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)(?:\s*[x×]\s*(\d+(?:\.\d+)?))?\s*mm`)
	roundRe = regexp.MustCompile(`(?i)[⌀Ø∅]\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*mm`)
	labelRe = regexp.MustCompile(`^([^:0-9]{1,40}):\s*(.*)$`)
	// labelOnlyRe is a line that is nothing but a label.
	labelOnlyRe = regexp.MustCompile(`^([^:0-9]{1,40}):\s*$`)
	deviceRe    = regexp.MustCompile(`(?i)^(device|unit|switch|gateway|system|chassis|body)$`)
)

// Rack describes whether the device mounts in a 19-inch rack as shipped.
type Rack struct {
	// Mountable is true for "Rack mount (1U)" and the like. Devices that can be
	// racked with an optional kit but aren't described that way are not.
	Mountable bool `json:"mountable"`
	// Units is the height in rack units, 0 when not stated.
	Units     int  `json:"units"`
	FullDepth bool `json:"full_depth"`
}

// deriveRack reads "Form Factor".
func deriveRack(ix *index, r *Result) {
	e, ok := ix.scalar("Form Factor")
	if !ok {
		return
	}
	text := oneLine(e.Value)
	r.Known.Rack = true
	r.Rack.FullDepth = fullRe.MatchString(text)
	if !rackRe.MatchString(text) {
		return
	}
	r.Rack.Mountable = true
	if m := unitsRe.FindStringSubmatch(text); m != nil {
		r.Rack.Units, _ = strconv.Atoi(m[1])
	}
}

// Dims is the size of the device in millimetres.
type Dims struct {
	// MinMM, MidMM and MaxMM are the three dimensions in ascending order. The
	// store lists them in no consistent order (width, depth, height for some
	// products, width, height, depth for others), so these are all that can be
	// said of an arbitrary device. A round device (⌀206 x 46) has its diameter
	// twice.
	MinMM float64 `json:"min_mm"`
	MidMM float64 `json:"mid_mm"`
	MaxMM float64 `json:"max_mm"`
	Round bool    `json:"round,omitempty"`
	// WidthMM, DepthMM and HeightMM are set only where the axes can be told
	// apart: for a rack-mount device of known height, whose height is that of its
	// units and whose width is that of a 19-inch rack.
	WidthMM  *float64 `json:"width_mm,omitempty"`
	DepthMM  *float64 `json:"depth_mm,omitempty"`
	HeightMM *float64 `json:"height_mm,omitempty"`
}

const rackUnitMM = 44.45

// rackWidths are the widths of 19-inch equipment as the store lists it: the
// body (442.4 mm) or the panel with ears (482.6 mm, 19 inches).
var rackWidths = []float64{442.4, 482.6}

func deriveDims(ix *index, r *Result) {
	e, ok := ix.scalar("Dimensions")
	if !ok {
		return
	}
	d, ok := pickDims(e)
	if !ok {
		ix.issue("dims", e, "no unambiguous device size in millimetres")
		return
	}
	r.Known.Dims = true
	r.Dims = d
	if !r.Rack.Mountable || r.Rack.Units == 0 || d.Round {
		return
	}
	vals := d.sorted()
	h := -1
	tol := float64(r.Rack.Units)*3 + 3
	for i, v := range vals {
		if abs(v-float64(r.Rack.Units)*rackUnitMM) <= tol {
			if h >= 0 {
				return // two candidates for the height
			}
			h = i
		}
	}
	if h < 0 {
		return
	}
	var rest []float64
	for i, v := range vals {
		if i != h {
			rest = append(rest, v)
		}
	}
	// The width is the remaining dimension nearest a 19-inch rack's; a clear
	// winner is needed, as a deep device can be near it too.
	best, second := -1, -1
	dist := func(v float64) float64 {
		m := abs(v - rackWidths[0])
		if x := abs(v - rackWidths[1]); x < m {
			m = x
		}
		return m
	}
	for i, v := range rest {
		switch {
		case best < 0 || dist(v) < dist(rest[best]):
			best, second = i, best
		case second < 0 || dist(v) < dist(rest[second]):
			second = i
		}
	}
	if best < 0 || dist(rest[best]) > 6 || second >= 0 && dist(rest[second]) <= 6 && dist(rest[second])-dist(rest[best]) < 1 {
		return
	}
	w, dep, ht := rest[best], rest[1-best], vals[h]
	d.WidthMM, d.DepthMM, d.HeightMM = &w, &dep, &ht
	r.Dims = d
}

func abs(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}

func (d Dims) sorted() []float64 { return []float64{d.MinMM, d.MidMM, d.MaxMM} }

// pickDims finds the device's size in an entry that may hold several: the
// unlabelled one, or the one labelled as the device. An entry that sizes only
// accessories or packaging, or several unlabelled alternatives, is left alone.
func pickDims(e Effective) (Dims, bool) {
	var plain, device []string
	var labelled []labelledLine
	pending := "" // a label on a line of its own names the size on the next line
	for _, l := range Lines(e.Value) {
		if m := labelOnlyRe.FindStringSubmatch(l); m != nil {
			pending = strings.TrimSpace(m[1])
			continue
		}
		label, text := pending, l
		pending = ""
		if m := labelRe.FindStringSubmatch(l); m != nil {
			label, text = strings.TrimSpace(m[1]), m[2]
		}
		switch {
		case label != "" && deviceRe.MatchString(label):
			device = append(device, text)
		case label != "" && (dimRe.MatchString(text) || roundRe.MatchString(text)):
			labelled = append(labelled, labelledLine{label, text})
		case label == "" && (dimRe.MatchString(text) || roundRe.MatchString(text)):
			plain = append(plain, text)
		}
	}
	cands := plain
	switch {
	case len(device) > 0:
		cands = device
	case len(plain) == 0:
		cands = bareDevice(labelled)
	}
	if len(cands) != 1 {
		return Dims{}, false
	}
	l := cands[0]
	if m := roundRe.FindStringSubmatch(l); m != nil {
		dia, _ := num(m[1])
		h, _ := num(m[2])
		return sortDims(dia, dia, h, true), true
	}
	m := dimRe.FindStringSubmatch(l)
	if m == nil {
		return Dims{}, false
	}
	a, _ := num(m[1])
	b, _ := num(m[2])
	if m[3] == "" {
		return Dims{}, false
	}
	c, _ := num(m[3])
	return sortDims(a, b, c, false), true
}

var (
	packagingRe = regexp.MustCompile(`(?i)\bpackag`)
	withoutRe   = regexp.MustCompile(`(?i)\bwithout\b`)
)

// bareDevice chooses among sizes that are all labelled, none of them "Device":
// the packaging is never the device, and of several configurations ("With
// mount", "Without mount") the bare one is. It returns nothing when that
// doesn't leave exactly one.
func bareDevice(labelled []labelledLine) []string {
	var rest []labelledLine
	for _, l := range labelled {
		if !packagingRe.MatchString(l.label) {
			rest = append(rest, l)
		}
	}
	if len(rest) == 1 {
		return []string{rest[0].text}
	}
	var without []string
	for _, l := range rest {
		if withoutRe.MatchString(l.label) {
			without = append(without, l.text)
		}
	}
	if len(without) == 1 {
		return without
	}
	return nil
}

type labelledLine struct{ label, text string }

func sortDims(a, b, c float64, round bool) Dims {
	v := []float64{a, b, c}
	for i := 1; i < 3; i++ {
		for j := i; j > 0 && v[j] < v[j-1]; j-- {
			v[j], v[j-1] = v[j-1], v[j]
		}
	}
	return Dims{MinMM: v[0], MidMM: v[1], MaxMM: v[2], Round: round}
}
