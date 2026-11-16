package specs

import "reflect"

// Overridden says which parts of a derived result the user's overrides changed,
// compared with deriving from what the store published alone.
type Overridden struct {
	Ports     bool `json:"ports"`
	PoEBudget bool `json:"poe_budget"`
	Radios    bool `json:"radios"`
	Rack      bool `json:"rack"`
	Dims      bool `json:"dims"`
	// Metrics are the numbers that differ, each with what the store's own
	// specification gives (nil when it gives nothing, so the number is wholly the
	// user's).
	Metrics []OverriddenMetric `json:"metrics"`
}

// OverriddenMetric is a metric the overrides changed or created.
type OverriddenMetric struct {
	Name      string  `json:"name"`
	Published *Metric `json:"published"`
}

// Any reports whether the overrides changed anything that was derived.
func (o Overridden) Any() bool {
	return o.Ports || o.PoEBudget || o.Radios || o.Rack || o.Dims || len(o.Metrics) > 0
}

// Compare finds what differs between a result derived from the effective
// specification and one derived from the published specification alone. Metrics
// the overrides removed (a hidden entry) are reported with no effective value
// elsewhere; here only metrics present in the effective result are listed, as
// those are the ones with something to show.
func Compare(effective, published Result) Overridden {
	o := Overridden{Metrics: []OverriddenMetric{}}
	o.Ports = !reflect.DeepEqual(effective.Ports, published.Ports) || effective.PoEMaxClass != published.PoEMaxClass
	o.PoEBudget = !reflect.DeepEqual(effective.PoEBudget, published.PoEBudget)
	o.Radios = !reflect.DeepEqual(effective.Radios, published.Radios)
	o.Rack = effective.Rack != published.Rack
	o.Dims = !reflect.DeepEqual(effective.Dims, published.Dims)

	pub := map[string]Metric{}
	for _, m := range published.Metrics {
		pub[m.Name] = m
	}
	for _, m := range effective.Metrics {
		p, had := pub[m.Name]
		if had && p == m {
			continue
		}
		om := OverriddenMetric{Name: m.Name}
		if had {
			p := p
			om.Published = &p
		}
		o.Metrics = append(o.Metrics, om)
	}
	return o
}
