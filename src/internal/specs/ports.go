package specs

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

// Port is a group of identical ports on a device, or the part of one group that
// shares a PoE capability: "16 (8 PoE+; 8 PoE++)" is two Ports of 8.
type Port struct {
	// Label is what the store calls the port ("10 GbE RJ45").
	Label string `json:"label"`
	// Media is "rj45", "sfp", "sfp+", "sfp28", "qsfp28", ... or "other".
	Media string `json:"media"`
	// Role is "data", "console", "mgmt" (out-of-band management), "sma"
	// (antenna), or "stacking" (cannot carry traffic to the network).
	Role  string `json:"role"`
	Count int    `json:"count"`
	// MaxSpeedMbps is the fastest the port runs; SpeedsMbps is every speed it
	// supports, fastest first. Zero and empty when the store doesn't say.
	MaxSpeedMbps int   `json:"max_speed_mbps"`
	SpeedsMbps   []int `json:"speeds_mbps"`
	// PoEClass is "PoE", "PoE+", "PoE++" or "PoE+++", empty for a port with no
	// PoE. PoEDirection is "out" (the port powers what is plugged in), "in" (the
	// device is powered through it), or empty. PoEInferred marks a direction we
	// worked out, not one the store stated.
	PoEClass     string `json:"poe_class"`
	PoEDirection string `json:"poe_direction"`
	PoEInferred  bool   `json:"poe_inferred,omitempty"`
	// PoEWatts is the most the device supplies through one such port, from the
	// device's own table of watts per class; nil when it has none.
	PoEWatts *float64 `json:"poe_watts,omitempty"`
	// Combo is set for a port that shares its position with another (a combo
	// RJ45/SFP+ pair), so the two aren't both available at once.
	Combo bool   `json:"combo,omitempty"`
	Note  string `json:"note,omitempty"`
	// Source is the field the port came from: "port_layout" or "networking_interface".
	Source string `json:"source"`
}

var (
	speedsRe    = regexp.MustCompile(`^[0-9.]+[GM]?(?:/[0-9.]+[GM]?)*$`)
	parenRe     = regexp.MustCompile(`\(([^()]*)\)`)
	rj45Re      = regexp.MustCompile(`(?i)^(\d+(?:\.\d+)?)\s*([GM])b?E\s+RJ45$`)
	sfpRe       = regexp.MustCompile(`(?i)^(\d+(?:\.\d+)?)\s*([GM])\s+(Q?SFP[0-9+]*)$`)
	poeAllRe    = regexp.MustCompile(`^All\s+(PoE\+{0,3})$`)
	poeBareRe   = regexp.MustCompile(`^(PoE\+{0,3})$`)
	poeSegRe    = regexp.MustCompile(`^(\d+)\s+(PoE\+{0,3})(\s+input)?$`)
	portCountRe = regexp.MustCompile(`^(\d+)\s*(.*)$`)
)

// parseSpeeds reads "10G/5G/2.5G/1G/100M" into Mbps, fastest first. The store
// sometimes leaves a unit off ("10G/5G/2.5/1G"); lists run fastest to slowest, so
// a bare number takes whichever unit keeps it below the one before.
func parseSpeeds(s string) []int {
	var vals []int
	prev := 0
	for _, t := range strings.Split(s, "/") {
		if t == "" {
			return nil
		}
		unit := ""
		if last := t[len(t)-1]; last == 'G' || last == 'M' {
			unit, t = string(last), t[:len(t)-1]
		}
		f, err := strconv.ParseFloat(t, 64)
		if err != nil {
			return nil
		}
		mbps := f
		switch {
		case unit == "G":
			mbps = f * 1000
		case unit == "" && (prev > 0 && f*1000 < float64(prev) || prev == 0 && f < 100):
			mbps = f * 1000
		}
		v := int(math.Round(mbps))
		vals = append(vals, v)
		prev = v
	}
	sortDesc(vals)
	return vals
}

func sortDesc(v []int) {
	for i := 1; i < len(v); i++ {
		for j := i; j > 0 && v[j] > v[j-1]; j-- {
			v[j], v[j-1] = v[j-1], v[j]
		}
	}
}

// maxPlausiblePorts is the most ports of one kind a device could have; a count
// beyond it is a misreading, not a switch.
const maxPlausiblePorts = 1000

// parseCount reads a port count, refusing the implausible and the overflowing.
func parseCount(s string) (int, bool) {
	n, err := strconv.Atoi(s)
	return n, err == nil && n >= 0 && n <= maxPlausiblePorts
}

type portKind struct {
	media, role string
	speed       int
	ok          bool
}

// parsePortLabel reads the store's name for a port: "2.5 GbE RJ45", "10G SFP+",
// "100 MbE RJ45", "Console", "SMA", "MGMT".
func parsePortLabel(label string) portKind {
	l := oneLine(label)
	toMbps := func(n, unit string) int {
		f, _ := strconv.ParseFloat(n, 64)
		if strings.EqualFold(unit, "G") {
			f *= 1000
		}
		return int(math.Round(f))
	}
	if m := rj45Re.FindStringSubmatch(l); m != nil {
		return portKind{media: "rj45", role: "data", speed: toMbps(m[1], m[2]), ok: true}
	}
	if m := sfpRe.FindStringSubmatch(l); m != nil {
		return portKind{media: strings.ToLower(m[3]), role: "data", speed: toMbps(m[1], m[2]), ok: true}
	}
	switch strings.ToLower(l) {
	case "console":
		return portKind{media: "console", role: "console", ok: true}
	case "sma":
		return portKind{media: "sma", role: "sma", ok: true}
	case "mgmt", "management":
		return portKind{media: "rj45", role: "mgmt", ok: true}
	}
	return portKind{}
}

type poeSeg struct {
	class string
	count int
	input bool
}

// parsePoE reads the PoE part of a port entry: "All PoE+++", "PoE+++" (all of
// them), "8 PoE+; 8 PoE++", "8 PoE+; 1 PoE++ input", "2 PoE+++, 2 PoE+". The
// boolean is false when the text isn't one of these.
func parsePoE(text string, count int) ([]poeSeg, bool) {
	t := strings.TrimSpace(text)
	if m := poeAllRe.FindStringSubmatch(t); m != nil {
		return []poeSeg{{class: m[1], count: count}}, true
	}
	if m := poeBareRe.FindStringSubmatch(t); m != nil {
		return []poeSeg{{class: m[1], count: count}}, true
	}
	var segs []poeSeg
	for _, part := range strings.FieldsFunc(t, func(r rune) bool { return r == ';' || r == ',' }) {
		m := poeSegRe.FindStringSubmatch(strings.TrimSpace(part))
		if m == nil {
			return nil, false
		}
		n, ok := parseCount(m[1])
		if !ok {
			return nil, false
		}
		segs = append(segs, poeSeg{class: m[2], count: n, input: m[3] != ""})
	}
	return segs, len(segs) > 0
}

// derivePorts reads the device's ports from its "Port Layout" group or, for
// devices without one (access points, cameras), from "Networking Interface".
func derivePorts(ix *index, r *Result) {
	watts := poeWattsByClass(ix)
	maxRank := poeRank(r.PoEMaxClass)

	children := ix.group("Port Layout")
	if len(children) > 0 {
		for _, c := range children {
			if c.Kind != unistore.SpecText {
				continue
			}
			r.Ports = append(r.Ports, portsFromLayoutEntry(ix, c, watts, maxRank)...)
		}
	} else if e, ok := ix.scalar("Networking Interface"); ok {
		r.Ports = append(r.Ports, portsFromInterface(ix, e)...)
	}
	r.Known.Ports = len(r.Ports) > 0
}

// portsFromLayoutEntry turns one "Port Layout" entry into its Ports.
func portsFromLayoutEntry(ix *index, c Effective, watts map[string]float64, maxRank int) []Port {
	kind := parsePortLabel(c.Label)
	if !kind.ok {
		ix.issue("ports", c, "unrecognised port type")
		kind = portKind{media: "other", role: "data"}
	}
	base := Port{Label: oneLine(c.Label), Media: kind.media, Role: kind.role, Source: "port_layout", Note: oneLine(c.Note), SpeedsMbps: []int{}}
	note := strings.ToLower(c.Note)
	switch {
	case strings.Contains(note, "stacking port only"):
		base.Role = "stacking"
	case strings.Contains(note, "oob"):
		base.Role = "mgmt"
	}
	base.Combo = strings.Contains(note, "combo")

	m := portCountRe.FindStringSubmatch(oneLine(c.Value))
	if m == nil {
		ix.issue("ports", c, "no port count")
		return nil
	}
	count, ok := parseCount(m[1])
	if !ok {
		ix.issue("ports", c, "implausible port count")
		return nil
	}
	rest := m[2]

	var poeText string
	for _, pm := range parenRe.FindAllStringSubmatch(rest, -1) {
		inner := strings.TrimSpace(pm[1])
		if speedsRe.MatchString(inner) {
			base.SpeedsMbps = parseSpeeds(inner)
		} else if poeText == "" {
			poeText = inner
		} else {
			ix.issue("ports", c, "more than one non-speed note")
		}
	}
	if left := strings.TrimSpace(parenRe.ReplaceAllString(rest, "")); left != "" {
		ix.issue("ports", c, "unexpected text after the count: "+left)
	}
	base.MaxSpeedMbps = kind.speed
	if len(base.SpeedsMbps) > 0 && base.SpeedsMbps[0] > base.MaxSpeedMbps {
		base.MaxSpeedMbps = base.SpeedsMbps[0]
	}

	if poeText == "" {
		base.Count = count
		return []Port{base}
	}
	segs, ok := parsePoE(poeText, count)
	if !ok {
		ix.issue("ports", c, "unrecognised PoE description: "+poeText)
		base.Count = count
		return []Port{base}
	}

	var out []Port
	rest0 := count
	for _, s := range segs {
		p := base
		p.Count, p.PoEClass, p.PoEDirection = s.count, s.class, "out"
		rest0 -= s.count
		switch {
		case s.input:
			p.PoEDirection = "in"
		case maxRank > 0 && poeRank(s.class) > maxRank:
			// The text doesn't say "input", but a port can't supply more than the
			// device does, so it must be the one the device is powered through.
			p.PoEDirection, p.PoEInferred = "in", true
		}
		if p.PoEDirection == "out" {
			if w, ok := watts[s.class]; ok {
				w := w
				p.PoEWatts = &w
			}
		}
		out = append(out, p)
	}
	if rest0 > 0 {
		p := base
		p.Count = rest0
		out = append(out, p)
	} else if rest0 < 0 {
		ix.issue("ports", c, fmt.Sprintf("PoE ports (%d) outnumber the ports (%d)", count-rest0, count))
	}
	return out
}

var wattsRe = regexp.MustCompile(numRe + `\s*W\b`)

// poeWattsByClass reads "Max. PoE Wattage per Port by PSE": the watts one port
// supplies at each class, which differs between devices (PoE+ is 30W on some and
// 32W on others).
func poeWattsByClass(ix *index) map[string]float64 {
	out := map[string]float64{}
	for _, c := range ix.group("Max. PoE Wattage per Port by PSE") {
		class := classRe.FindString(oneLine(c.Label))
		m := wattsRe.FindStringSubmatch(oneLine(c.Value))
		if class == "" || m == nil {
			continue
		}
		if w, ok := num(m[1]); ok {
			out[class] = w
		}
	}
	return out
}

var (
	ifaceItemRe = regexp.MustCompile(`\((\d+)\)\s*(?:(Data[ -]in|Data[ -]out):\s*)?([^()]*?)\s*(RJ45|SFP28|QSFP28|SFP\+|SFP)\s+(?:(uplink|downlink)\s+)?ports?\b(?:\s*\(([0-9./GM]+)\))?`)
	ifaceClass  = regexp.MustCompile(`PoE\+{0,3}`)
	ifaceSpd    = regexp.MustCompile(`(?i)^([0-9.]+(?:/[0-9.]+)*)?\s*(Gbps|Mbps|GbE|MbE|G|M|FE|GE)?$`)
	ifaceSplit  = regexp.MustCompile(`\s*[,&]\s*`)
	ifaceWords  = regexp.MustCompile(`(?i)\b(MGMT|management)\b`)
)

// portsFromInterface reads "Networking Interface", the free-text list of ports
// that devices without a "Port Layout" have: "(1) 1/2.5 GbE RJ45 port". Only
// the ethernet and SFP ports are taken; radios, USB, DC inputs and the like are
// not ports.
func portsFromInterface(ix *index, e Effective) []Port {
	var out []Port
	for _, line := range Lines(e.Value) {
		for _, seg := range ifaceSplit.Split(line, -1) {
			for _, m := range ifaceItemRe.FindAllStringSubmatch(seg, -1) {
				if p, ok := interfacePort(ix, e, m); ok {
					out = append(out, p)
				}
			}
		}
	}
	return out
}

// interfacePort builds a Port from one match of ifaceItemRe: count, direction
// ("Data in"), the words before the media ("1/2.5 GbE", "GbE MGMT"), the media,
// "uplink" or "downlink", and optionally a list of speeds after it. A "PoE" among
// the words before the media gives power out on a "downlink" port (an NVR's PoE
// ports) and in on an "uplink" one; with neither word it is not said which way
// the power goes, so no class is claimed.
func interfacePort(ix *index, e Effective, m []string) (Port, bool) {
	spec := strings.TrimSpace(m[3])
	if strings.Contains(strings.ToUpper(spec), "DC") {
		return Port{}, false // a DC injection port, not a data port
	}
	n, ok := parseCount(m[1])
	if !ok {
		ix.issue("ports", e, "implausible port count")
		return Port{}, false
	}
	p := Port{Label: strings.TrimSpace(m[3] + " " + m[4]), Media: strings.ToLower(m[4]), Role: "data", Count: n, Source: "networking_interface", SpeedsMbps: []int{}}
	if m[2] != "" {
		p.Note = m[2]
	}
	if ifaceWords.MatchString(spec) {
		p.Role = "mgmt"
		spec = strings.TrimSpace(ifaceWords.ReplaceAllString(spec, ""))
	}
	if class := ifaceClass.FindString(spec); class != "" {
		spec = strings.TrimSpace(ifaceClass.ReplaceAllString(spec, ""))
		switch m[5] {
		case "downlink":
			p.PoEClass, p.PoEDirection = class, "out"
		case "uplink":
			p.PoEClass, p.PoEDirection = class, "in"
		}
	}
	if m[6] != "" {
		p.SpeedsMbps = parseSpeeds(m[6])
	} else if spec != "" {
		p.SpeedsMbps = speedsFromWords(spec)
	}
	if len(p.SpeedsMbps) == 0 && (spec != "" || m[6] != "") {
		ix.issue("ports", e, "unrecognised port speed: "+spec)
	}
	if len(p.SpeedsMbps) > 0 {
		p.MaxSpeedMbps = p.SpeedsMbps[0]
	}
	return p, true
}

// speedsFromWords reads the speed words of an interface list: "2.5 GbE",
// "1/2.5 GbE", "GbE", "10/100 Mbps", "FE", "10G".
func speedsFromWords(s string) []int {
	m := ifaceSpd.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil || m[1] == "" && m[2] == "" {
		return nil
	}
	unit := "G"
	switch strings.ToUpper(m[2]) {
	case "MBPS", "MBE", "M":
		unit = "M"
	case "FE":
		return []int{100}
	}
	numbers := m[1]
	if numbers == "" {
		numbers = "1" // "GbE" is one gigabit
	}
	toks := strings.Split(numbers, "/")
	for i := range toks {
		toks[i] += unit
	}
	return parseSpeeds(strings.Join(toks, "/"))
}
