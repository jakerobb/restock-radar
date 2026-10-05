package metrics

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestRender(t *testing.T) {
	start := time.Unix(1_000, 0)
	m := New(start)
	var buf bytes.Buffer
	m.Render(&buf, Gauges{VariantsByStatus: map[string]int{"Available": 3, "SoldOut": 1}, WatchedItems: 4, PendingEvents: 2})
	out := buf.String()

	for _, want := range []string{
		"restock_radar_last_success_timestamp_seconds 1000\n", // starts at process start
		"restock_radar_last_cycle_timestamp_seconds 0\n",
		`restock_radar_fetches_total{result="ok"} 0`, // series exist before any fetch
		`restock_radar_fetches_total{result="blocked"} 0`,
		`restock_radar_events_total{kind="price"} 0`,
		`restock_radar_notifications_total{result="failed"} 0`,
		"restock_radar_items_failing 0\n",
		"restock_radar_watched_items 4\n",
		"restock_radar_pending_events 2\n",
		`restock_radar_variants{status="Available"} 3`,
		`restock_radar_variants{status="SoldOut"} 1`,
		"# TYPE restock_radar_fetches_total counter",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}

func TestUpdates(t *testing.T) {
	m := New(time.Unix(1_000, 0))
	m.Fetch(FetchBlocked, time.Unix(2_000, 0))
	m.Fetch(FetchOK, time.Unix(3_000, 0))
	m.Fetch(FetchOK, time.Unix(4_000, 0))
	m.Event("status")
	m.Notification(NotifyFailed)
	m.CycleDone(time.Unix(5_000, 0))
	m.SetItemsFailing(2)

	var buf bytes.Buffer
	m.Render(&buf, Gauges{})
	out := buf.String()
	for _, want := range []string{
		`restock_radar_fetches_total{result="ok"} 2`,
		`restock_radar_fetches_total{result="blocked"} 1`,
		"restock_radar_last_success_timestamp_seconds 4000\n", // only successes move it
		"restock_radar_last_cycle_timestamp_seconds 5000\n",
		`restock_radar_events_total{kind="status"} 1`,
		`restock_radar_notifications_total{result="failed"} 1`,
		"restock_radar_items_failing 2\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}
