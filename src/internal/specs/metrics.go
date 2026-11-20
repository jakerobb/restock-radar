package specs

import (
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

var (
	powerRe = regexp.MustCompile(numRe + `\s*(m?W)\b`)
	rateTpl = regexp.MustCompile(numRe + `(\+?)\s*(Tbps|Gbps|Mbps|Kbps)`)
	ppsRe   = regexp.MustCompile(numRe + `(\+?)\s*(Bpps|Gpps|Mpps|Kpps)`)

	// "140 m² (1,500 ft²)": the area an access point covers.
	areaM2Re  = regexp.MustCompile(numRe + `\s*m²`)
	areaFt2Re = regexp.MustCompile(numRe + `\s*ft²`)
	// "500 m (1,640 ft)", "5 km (3.1 mi)": how far a bridge reaches.
	reachRe = regexp.MustCompile(numRe + `\s*(km|m)\b`)
)

const sqftPerSqM = 10.7639

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

	deriveCoverage(ix, r)
	deriveCameras(ix, r)
	deriveStorage(ix, r)
	deriveBitrate(ix, r)
	deriveApps(ix, r)
	deriveManaged(ix, r)

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
	// Label is what the store called the size ("Device", "Without mount"); empty
	// when the entry gave only one, unlabelled.
	Label string `json:"label,omitempty"`
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
// unlabelled one, or the one labelled as the device. Where that doesn't settle
// on a single line (several configurations, accessories alongside, or
// alternatives), the smallest by volume is taken: the bare device is the
// smallest of the sizes a store lists for it. The size's label, if any, is kept.
// An entry with no three-dimensional size in millimetres is left alone.
func pickDims(e Effective) (Dims, bool) {
	var plain, device, labelled []labelledLine
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
		if !dimRe.MatchString(text) && !roundRe.MatchString(text) {
			continue
		}
		ll := labelledLine{label, text}
		switch {
		case label == "":
			plain = append(plain, ll)
		case deviceRe.MatchString(label):
			device = append(device, ll)
		default:
			labelled = append(labelled, ll)
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
		// Nothing settles it, so take the smallest volume of every size that
		// can be read, packaging aside unless it is all there is.
		all := append(append(append([]labelledLine{}, plain...), device...), labelled...)
		cands = nil
		for _, l := range all {
			if !packagingRe.MatchString(l.label) {
				cands = append(cands, l)
			}
		}
		if len(cands) == 0 {
			cands = all
		}
	}
	var best Dims
	bestVol, found := 0.0, false
	for _, l := range cands {
		d, vol, ok := parseDims(l)
		if ok && (!found || vol < bestVol) {
			best, bestVol, found = d, vol, true
		}
	}
	return best, found
}

// parseDims reads one line's size and its volume in cubic millimetres. A line
// that doesn't give all three dimensions is not a size.
func parseDims(l labelledLine) (Dims, float64, bool) {
	if m := roundRe.FindStringSubmatch(l.text); m != nil {
		dia, _ := num(m[1])
		h, _ := num(m[2])
		d := sortDims(dia, dia, h, true)
		d.Label = l.label
		return d, math.Pi / 4 * dia * dia * h, true
	}
	m := dimRe.FindStringSubmatch(l.text)
	if m == nil || m[3] == "" {
		return Dims{}, 0, false
	}
	a, _ := num(m[1])
	b, _ := num(m[2])
	c, _ := num(m[3])
	d := sortDims(a, b, c, false)
	d.Label = l.label
	return d, a * b * c, true
}

var (
	packagingRe = regexp.MustCompile(`(?i)\bpackag`)
	withoutRe   = regexp.MustCompile(`(?i)\bwithout\b`)
)

// bareDevice chooses among sizes that are all labelled, none of them "Device":
// the packaging is never the device, and of several configurations ("With
// mount", "Without mount") the bare one is. It returns nothing when that
// doesn't leave exactly one.
func bareDevice(labelled []labelledLine) []labelledLine {
	var rest []labelledLine
	for _, l := range labelled {
		if !packagingRe.MatchString(l.label) {
			rest = append(rest, l)
		}
	}
	if len(rest) == 1 {
		return rest
	}
	var without []labelledLine
	for _, l := range rest {
		if withoutRe.MatchString(l.label) {
			without = append(without, l)
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

// deriveCoverage reads "Coverage Area". Access points give an area ("115 m²
// (1,250 ft²)"), which becomes coverage_m2 and coverage_sqft: each as the store
// published it, and the other worked out only if the store gave one unit. Wireless
// bridges give a distance ("5 km (3.1 mi)"), which becomes range_m.
func deriveCoverage(ix *index, r *Result) {
	e, ok := ix.scalar("Coverage Area")
	if !ok {
		return
	}
	text := strings.Join(Lines(e.Value), " | ")
	m2, haveM2 := firstNumber(areaM2Re, text)
	ft2, haveFt2 := firstNumber(areaFt2Re, text)
	switch {
	case haveM2 || haveFt2:
		switch {
		case !haveFt2:
			ft2 = math.Round(m2 * sqftPerSqM)
		case !haveM2:
			m2 = math.Round(ft2 / sqftPerSqM)
		}
		if m2 <= 0 || ft2 <= 0 {
			ix.issue("metrics", e, "coverage area isn't positive")
			return
		}
		r.Metrics = append(r.Metrics,
			Metric{Name: "coverage_m2", Value: m2, Unit: "m²", Raw: text},
			Metric{Name: "coverage_sqft", Value: ft2, Unit: "ft²", Raw: text})
	default:
		m := reachRe.FindStringSubmatch(text)
		if m == nil {
			ix.issue("metrics", e, "no coverage area or range")
			return
		}
		v, ok := num(m[1])
		if !ok || v <= 0 {
			ix.issue("metrics", e, "range isn't positive")
			return
		}
		if m[2] == "km" {
			v *= 1000
		}
		r.Metrics = append(r.Metrics, Metric{Name: "range_m", Value: v, Unit: "m", Raw: text})
	}
}

// firstNumber is the number captured by the first match of re in text.
func firstNumber(re *regexp.Regexp, text string) (float64, bool) {
	m := re.FindStringSubmatch(text)
	if m == nil {
		return 0, false
	}
	return num(m[1])
}

var (
	// "(15) HD", "(8) 2K", "(6) 4K": how many cameras of each class an NVR manages.
	nvrCapRe = regexp.MustCompile(`(?i)\((\d+)\)\s*(HD|2K|4K)\b`)
	// "(2) 8MP 3840 x 2160 (16:9)": one sensor's resolution, with how many sensors when more than one.
	sensorRe = regexp.MustCompile(`(?i)(?:\((\d+)\)\s*)?` + numRe + `\s*MP\s+\d+\s*[x×]\s*\d+`)
	// "4K", "2K", "FHD", "5MP": the headline resolution, for products with no pixel dimensions.
	headlineRe = regexp.MustCompile(`(?i)\b(?:(4K|2K|FHD|HD)|` + numRe + `\s*MP)\b`)
)

// Megapixels of the headline names the store uses.
var headlineMP = map[string]float64{"4K": 8.3, "2K": 4, "FHD": 2.1, "HD": 2.1}

// deriveCameras reads what a camera records at and what an NVR can manage.
//
// For an NVR, "Managed Cameras" lists a count per class: "(60) HD (30) 2K
// (18) 4K". Some give a second list for another configuration ("With built-in
// HDMI Viewport in use"); only the first, the usual one, is read.
//
// For a camera, camera_megapixels is the resolution of one sensor (a multi-sensor
// camera is still one camera), from the pixel dimensions where given, else from
// the headline ("4K", "5MP").
func deriveCameras(ix *index, r *Result) {
	if e, ok := ix.scalar("Managed Cameras"); ok {
		found := map[string]float64{}
		for _, line := range Lines(e.Value) {
			ms := nvrCapRe.FindAllStringSubmatch(line, -1)
			if len(ms) == 0 {
				if len(found) > 0 {
					break // a heading for the next configuration
				}
				continue
			}
			for _, m := range ms {
				n, _ := num(m[1])
				found[strings.ToLower(m[2])] = n
			}
		}
		raw := strings.Join(Lines(e.Value), " | ")
		if len(found) == 0 {
			ix.issue("metrics", e, "no camera counts")
		}
		for _, class := range []string{"hd", "2k", "4k"} {
			if n, ok := found[class]; ok {
				r.Metrics = append(r.Metrics, Metric{Name: "nvr_cameras_" + class, Value: n, Unit: "cameras", Raw: raw})
			}
		}
		return
	}

	best, raw, have := 0.0, "", false
	sensors := 1.0
	for _, e := range ix.all("Resolution") {
		text := strings.Join(Lines(e.Value), " | ")
		ms := sensorRe.FindAllStringSubmatch(text, -1)
		count := 0.0 // how many sensors the entry lists: "(4) 8MP" is four, and a main and a package camera two
		for _, m := range ms {
			n := 1.0
			if m[1] != "" {
				n, _ = num(m[1])
			}
			count += n
		}
		for _, m := range ms {
			if mp, ok := num(m[2]); ok && (!have || mp > best) {
				best, raw, have, sensors = mp, text, true, count
			}
		}
	}
	if !have {
		for _, e := range ix.all("Resolution") {
			text := strings.Join(Lines(e.Value), " | ")
			for _, m := range headlineRe.FindAllStringSubmatch(text, -1) {
				mp := headlineMP[strings.ToUpper(m[1])]
				if m[2] != "" {
					mp, _ = num(m[2])
				}
				if mp > best {
					best, raw, have = mp, text, true
				}
			}
		}
	}
	if have {
		r.Metrics = append(r.Metrics, Metric{Name: "camera_megapixels", Value: best, Unit: "MP", Raw: raw})
		if sensors > 1 {
			r.Metrics = append(r.Metrics, Metric{Name: "camera_sensors", Value: sensors, Unit: "sensors", Raw: raw})
		}
	}
}

var (
	// "(4) 2.5/3.5" drive bays", "(2) 3.5" NVR HDD bays": how many drives an NVR takes.
	driveBaysRe = regexp.MustCompile(`(?i)^\s*\((\d+)\)[^\n]*\bbays?\b`)
	// "1 TB 2.5" SATA SSD", "128 GB microSD": storage an NVR comes with that can't be changed.
	fixedStorageRe = regexp.MustCompile(`(?i)(?:^|pre-installed\s+)` + numRe + `\s*(TB|GB)\b`)
)

// deriveStorage reads the drive bays of an NVR (nvr_drive_bays), where the buyer chooses the drives, and for
// one without any the storage it comes with (nvr_storage_tb: a microSD card, or the CloudKey+'s SSD).
func deriveStorage(ix *index, r *Result) {
	if _, ok := ix.scalar("Managed Cameras"); !ok {
		return
	}
	for _, label := range []string{"Storage Capacity", "NVR Storage", "Storage", "Hard Drive Capacity"} {
		for _, e := range ix.all(label) {
			for _, line := range Lines(e.Value) {
				if m := driveBaysRe.FindStringSubmatch(line); m != nil {
					n, _ := num(m[1])
					r.Metrics = append(r.Metrics, Metric{Name: "nvr_drive_bays", Value: n, Unit: "bays", Raw: line})
					return
				}
			}
		}
	}
	for _, label := range []string{"Hard Drive Capacity", "NVR Storage"} {
		for _, e := range ix.all(label) {
			for _, line := range Lines(e.Value) {
				m := fixedStorageRe.FindStringSubmatch(line)
				if m == nil {
					continue
				}
				n, ok := num(m[1])
				if !ok {
					continue
				}
				if strings.EqualFold(m[2], "GB") {
					n /= 1000
				}
				r.Metrics = append(r.Metrics, Metric{Name: "nvr_storage_tb", Value: n, Unit: "TB", Raw: line})
				return
			}
		}
	}
}

// deriveBitrate reads what a camera records at, as camera_bitrate_mbps. The store doesn't publish it, so it exists only
// where the owner adds the fact (an entry labelled "Recording Bitrate": "24 Mbps"), to override the estimate by resolution.
func deriveBitrate(ix *index, r *Result) {
	e, ok := ix.scalar("Recording Bitrate")
	if !ok {
		return
	}
	text := strings.Join(Lines(e.Value), " | ")
	if v, ok := firstNumber(regexp.MustCompile(`(?i)`+numRe+`\s*Mbps\b`), text); ok && v > 0 {
		r.Metrics = append(r.Metrics, Metric{Name: "camera_bitrate_mbps", Value: v, Unit: "Mbps", Raw: text})
	}
}

// appNames maps the words the store uses for UniFi applications to the app_ metrics' suffixes.
var appNames = map[string]string{"network": "network", "protect": "protect", "access": "access", "talk": "talk"}

// deriveApps reads which UniFi applications a product runs, as app_network, app_protect, app_access and
// app_talk (1 each): a gateway or console lists them as flags under "UniFi Application Suite", and an NVR
// names them in "Management Application". Products that are only managed by an application say the same
// things (a phone's suite lists Talk, a camera's lists Protect, a reader's names Access), so either counts
// only for a product that says how many devices, cameras or access hubs it manages.
func deriveApps(ix *index, r *Result) {
	_, devices := ix.scalar("Managed UniFi Devices")
	_, cameras := ix.scalar("Managed Cameras")
	_, hubs := ix.scalar("Managed Access Hubs")
	if !devices && !cameras && !hubs {
		return
	}
	seen := map[string]bool{}
	add := func(app, raw string) {
		if !seen[app] {
			seen[app] = true
			r.Metrics = append(r.Metrics, Metric{Name: "app_" + app, Value: 1, Unit: "", Raw: raw})
		}
	}
	for _, e := range ix.group("UniFi Application Suite") {
		if app, ok := appNames[key(e.Label)]; ok && e.Kind == unistore.SpecFlag && e.Value == "true" {
			add(app, "UniFi Application Suite: "+strings.TrimSpace(e.Label))
		}
	}
	if e, ok := ix.scalar("Management Application"); ok {
		text := strings.Join(Lines(e.Value), " | ")
		for word, app := range appNames {
			if strings.Contains(strings.ToLower(text), word) {
				add(app, text)
			}
		}
	}
}

var managedRe = regexp.MustCompile(`^\s*(\d[\d,]*)\s*(\+?)`)

// deriveManaged reads how many UniFi devices a console manages (managed_devices) and how many access hubs
// (managed_access_hubs), as published: "100+" is at least 100.
func deriveManaged(ix *index, r *Result) {
	for _, m := range []struct{ label, name string }{{"Managed UniFi Devices", "managed_devices"}, {"Managed Access Hubs", "managed_access_hubs"}} {
		e, ok := ix.scalar(m.label)
		if !ok {
			continue
		}
		lines := Lines(e.Value)
		if len(lines) == 0 {
			continue
		}
		g := managedRe.FindStringSubmatch(lines[0])
		if g == nil {
			ix.issue("metrics", e, "no device count")
			continue
		}
		n, _ := num(g[1])
		r.Metrics = append(r.Metrics, Metric{Name: m.name, Value: n, Unit: "devices", AtLeast: g[2] == "+", Raw: strings.Join(lines, " | ")})
	}
}

var (
	hotSwapRe = regexp.MustCompile(`(?i)hot[- ]?swappable`)
	psuWordRe = regexp.MustCompile(`(?i)\b(psus?|power|crps)\b`)
	acceleRe  = regexp.MustCompile(`(?i)hardware|accelerat|offload|^\s*(yes|true|supported)\s*$`)
)

// deriveFeatures reads three yes-or-no capabilities, each 1 when present: shadow_mode (a gateway that can
// back another up as a VRRP pair), hot_swap_psu (power supplies that can be changed with the device running,
// the CRPS form: a flag labelled CRPS, or a power or redundancy entry that says its PSUs or power modules
// are hot-swappable; fans alone don't count, and RPS, the external backup unit, is no such thing) and
// pppoe_acceleration (which the store doesn't publish, so it is there only where an override says so: an
// entry whose label names PPPoE, a flag that is true or a text that speaks of hardware acceleration).
func deriveFeatures(ix *index, r *Result) {
	seen := map[string]bool{}
	add := func(name, raw string) {
		if !seen[name] {
			seen[name] = true
			r.Metrics = append(r.Metrics, Metric{Name: name, Value: 1, Raw: raw})
		}
	}
	for _, e := range ix.std {
		if e.Kind == unistore.SpecGroup {
			continue
		}
		label := key(e.Label)
		text := strings.Join(Lines(e.Value), " | ")
		on := e.Kind == unistore.SpecFlag && e.Value == "true"
		if strings.Contains(label, "shadow mode") && (on || e.Kind == unistore.SpecText && text != "") || strings.Contains(strings.ToLower(text), "shadow mode") {
			add("shadow_mode", strings.TrimSpace(e.Label)+": "+text)
		}
		if label == "crps" && on {
			add("hot_swap_psu", "CRPS")
		}
		if e.Kind == unistore.SpecText {
			for _, line := range Lines(e.Value) {
				if hotSwapRe.MatchString(line) && psuWordRe.MatchString(line) {
					add("hot_swap_psu", line)
				}
			}
		}
		if strings.Contains(label, "pppoe") && (on || e.Kind == unistore.SpecText && acceleRe.MatchString(text)) {
			add("pppoe_acceleration", strings.TrimSpace(e.Label)+": "+text)
		}
	}
}
