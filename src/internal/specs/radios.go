package specs

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

// Radio is one radio a device has, with the figures the specification gives for
// it. A radio is any band named under the antenna gain, TX power, MIMO or data
// rate groups; a figure the specification doesn't give is nil.
type Radio struct {
	// Band is "2.4 GHz", "5 GHz", "6 GHz", "60 GHz", "Bluetooth" or "SuperLink".
	Band string `json:"band"`
	// Tech is "wifi" (2.4, 5 and 6 GHz), "wigig" (60 GHz), "bluetooth" or "superlink".
	Tech string `json:"tech"`

	AntennaGainDBi *float64 `json:"antenna_gain_dbi"`
	TxPowerDBm     *float64 `json:"tx_power_dbm"`
	// TxPowerExtendedDBm is the higher power some radios reach in a special mode
	// (6 GHz Extended Range), when the footnote gives it.
	TxPowerExtendedDBm *float64 `json:"tx_power_extended_dbm,omitempty"`
	// Streams is the number of spatial streams (the first number of "2 x 2").
	Streams     *int     `json:"streams"`
	MaxRateMbps *float64 `json:"max_rate_mbps"`

	// Multi is set when a figure spans several antennas or sub-bands ("Low Band:
	// ...", "Internal: ... External omni: ..."); the number kept is the largest.
	Multi bool `json:"multi,omitempty"`
	// The text each figure came from, for display.
	AntennaGainRaw string `json:"antenna_gain_raw,omitempty"`
	TxPowerRaw     string `json:"tx_power_raw,omitempty"`
	TxPowerNote    string `json:"tx_power_note,omitempty"`
	MIMORaw        string `json:"mimo_raw,omitempty"`
	MaxRateRaw     string `json:"max_rate_raw,omitempty"`
}

var bandOrder = []string{"2.4 GHz", "5 GHz", "6 GHz", "60 GHz", "Bluetooth", "SuperLink"}

var bandTech = map[string]string{
	"2.4 GHz": "wifi", "5 GHz": "wifi", "6 GHz": "wifi", "60 GHz": "wigig",
	"Bluetooth": "bluetooth", "SuperLink": "superlink",
}

var bandLabelRe = regexp.MustCompile(`(?i)^(2\.4|5|6|60)\s*GHz$`)

// canonicalBand names a band the way the store labels it, or "".
func canonicalBand(label string) string {
	l := strings.TrimSpace(oneLine(label))
	if m := bandLabelRe.FindStringSubmatch(l); m != nil {
		return m[1] + " GHz"
	}
	switch strings.ToLower(l) {
	case "bluetooth", "ble":
		return "Bluetooth"
	case "superlink":
		return "SuperLink"
	}
	return ""
}

var (
	dbiRe     = regexp.MustCompile(`(-?\d+(?:\.\d+)?)\s*dBi\b`)
	dbmRe     = regexp.MustCompile(`(-?\d+(?:\.\d+)?)\s*dBm\b`)
	eirpRe    = regexp.MustCompile(`\([^()]*EIRP[^()]*\)`)
	mimoRe    = regexp.MustCompile(`(\d+)\s*[x×]\s*(\d+)`)
	rateRe    = regexp.MustCompile(`(\d+(?:\.\d+)?)\s*(Gbps|Mbps)`)
	standards = regexp.MustCompile(`(?i)wi-?fi\s*(\d+)(E?)`)
)

func maxFloat(re *regexp.Regexp, s string) (float64, bool) {
	best, found := 0.0, false
	for _, m := range re.FindAllStringSubmatch(s, -1) {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil && (!found || v > best) {
			best, found = v, true
		}
	}
	return best, found
}

// deriveRadios builds the device's radios from the four per-band groups. The
// bands are the union across them, because the groups don't all list every band
// (a bridge gives gain for its 5 GHz radio but TX power only for some).
func deriveRadios(ix *index, r *Result) {
	radios := map[string]*Radio{}
	get := func(band string) *Radio {
		if radios[band] == nil {
			radios[band] = &Radio{Band: band, Tech: bandTech[band]}
		}
		return radios[band]
	}
	multi := func(rd *Radio, e Effective) {
		if len(Lines(e.Value)) > 1 {
			rd.Multi = true
		}
	}

	read := func(group string, fn func(rd *Radio, e Effective, text string)) {
		for _, c := range ix.group(group) {
			if c.Kind != unistore.SpecText {
				continue
			}
			band := canonicalBand(c.Label)
			if band == "" {
				ix.issue("radios", c, "unrecognised band under "+group)
				continue
			}
			rd := get(band)
			fn(rd, c, strings.Join(Lines(c.Value), "\n"))
			multi(rd, c)
		}
	}
	read("Antenna Gain", func(rd *Radio, e Effective, t string) {
		if v, ok := maxFloat(dbiRe, t); ok {
			rd.AntennaGainDBi, rd.AntennaGainRaw = &v, oneLine(t)
		} else {
			ix.issue("radios", e, "no dBi figure")
		}
	})
	read("Max. TX Power", func(rd *Radio, e Effective, t string) {
		// "(30 dBm EIRP)" restates the figure as radiated power; the conducted
		// figure is the one given first.
		if v, ok := maxFloat(dbmRe, eirpRe.ReplaceAllString(t, "")); ok {
			rd.TxPowerDBm, rd.TxPowerRaw = &v, oneLine(t)
		} else {
			ix.issue("radios", e, "no dBm figure")
		}
		if n := oneLine(e.Note); n != "" {
			rd.TxPowerNote = n
			if v, ok := maxFloat(dbmRe, n); ok {
				rd.TxPowerExtendedDBm = &v
			}
		}
	})
	read("MIMO", func(rd *Radio, e Effective, t string) {
		best := 0
		for _, m := range mimoRe.FindAllStringSubmatch(t, -1) {
			if n, _ := strconv.Atoi(m[1]); n > best {
				best = n
			}
		}
		if best > 0 {
			rd.Streams, rd.MIMORaw = &best, oneLine(t)
		} else {
			ix.issue("radios", e, "no stream count")
		}
	})
	read("Max. Data Rate", func(rd *Radio, e Effective, t string) {
		best, found := 0.0, false
		for _, m := range rateRe.FindAllStringSubmatch(t, -1) {
			v, _ := strconv.ParseFloat(m[1], 64)
			if m[2] == "Gbps" {
				v *= 1000
			}
			if !found || v > best {
				best, found = v, true
			}
		}
		if found {
			rd.MaxRateMbps, rd.MaxRateRaw = &best, oneLine(t)
		} else {
			ix.issue("radios", e, "no data rate")
		}
	})

	for _, b := range bandOrder {
		if rd := radios[b]; rd != nil {
			r.Radios = append(r.Radios, *rd)
		}
	}
	r.Known.Radios = len(r.Radios) > 0
}

// wifiGeneration reads the WiFi generation from "WiFi Standard(s)": "WiFi 7",
// "WiFi 6E", "802.11a/b/g/n/ac/ax/be (WiFi 6/6E, WiFi 7)". It returns the highest
// and whether 6E (the 6 GHz band) was named for it.
func wifiGeneration(text string) (gen int, ok bool) {
	for _, m := range standards.FindAllStringSubmatch(text, -1) {
		if n, err := strconv.Atoi(m[1]); err == nil && n >= 4 && n > gen {
			gen, ok = n, true
		}
	}
	if ok {
		return gen, true
	}
	// Without "WiFi N", the amendment letters say it: be=7, ax=6, ac=5, n=4.
	l := strings.ToLower(text)
	for _, c := range []struct {
		re  string
		gen int
	}{{`\bbe\b|/be\b`, 7}, {`\bax\b|/ax\b`, 6}, {`\bac\b|/ac\b`, 5}, {`/n\b|\bn\b`, 4}} {
		if regexp.MustCompile(c.re).MatchString(l) {
			return c.gen, true
		}
	}
	return 0, false
}
