package unifidevices

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const sample = `{"version":"x","devices":[
 {"sku":"U7-Pro-XGS","product":{"name":"Access Point U7 Pro XGS"},"deviceType":"access-point","shortnames":["U7PROXGS","U7-Pro-XGS"],"sysid":"A6A4","sysids":["a6a4"]},
 {"sku":"USW-Flex-Mini","product":{"abbrev":"x"},"deviceType":"switch","shortnames":["USMINI"],"sysids":[]},
 {"sku":"","product":{"name":"No SKU"},"shortnames":["X"]}
]}`

func TestParseKeepsWhatIsNeeded(t *testing.T) {
	got, err := Parse(strings.NewReader(sample))
	if err != nil {
		t.Fatal(err)
	}
	want := []Device{
		{SKU: "U7-Pro-XGS", Name: "Access Point U7 Pro XGS", Type: "access-point", Shortnames: []string{"U7PROXGS", "U7-Pro-XGS"}, SysIDs: []string{"a6a4"}},
		{SKU: "USW-Flex-Mini", Name: "USW-Flex-Mini", Type: "switch", Shortnames: []string{"USMINI"}, SysIDs: []string{}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestParseRejectsAnEmptyOrMalformedList(t *testing.T) {
	for _, body := range []string{`{"devices":[]}`, `{"devices":[{"sku":""}]}`, `not json`} {
		if _, err := Parse(strings.NewReader(body)); err == nil {
			t.Errorf("Parse(%q) succeeded", body)
		}
	}
}

func TestSourceCachesAndServesAStaleCopyOnFailure(t *testing.T) {
	var hits atomic.Int32
	fail := atomic.Bool{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		if fail.Load() {
			http.Error(w, "no", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(sample))
	}))
	defer ts.Close()

	now := time.Unix(1_000_000, 0)
	s := New("test")
	s.url = ts.URL
	s.now = func() time.Time { return now }

	if _, err := s.Devices(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Devices(context.Background()); err != nil || hits.Load() != 1 {
		t.Fatalf("second call should be cached: err=%v hits=%d", err, hits.Load())
	}
	fail.Store(true)
	now = now.Add(ttl + time.Second)
	got, err := s.Devices(context.Background())
	if err != nil || len(got) != 2 || hits.Load() != 2 {
		t.Fatalf("stale copy expected: %v %d %d", err, len(got), hits.Load())
	}
	// Not retried straight away.
	if _, err := s.Devices(context.Background()); err != nil || hits.Load() != 2 {
		t.Fatalf("retry too soon: err=%v hits=%d", err, hits.Load())
	}
}

func TestSourceWithNoCopyReportsTheError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { http.Error(w, "no", 500) }))
	defer ts.Close()
	s := New("test")
	s.url = ts.URL
	if _, err := s.Devices(context.Background()); err == nil {
		t.Fatal("expected an error")
	}
}
