package techspecs

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestURL(t *testing.T) {
	const b = "https://techspecs.ui.com/unifi/"
	cases := []struct{ category, slug, want string }{
		{"cloud-gateways-compact", "ucg-fiber", b + "cloud-gateways/ucg-fiber"},
		{"all-cloud-gateways", "ucg-fiber", b + "cloud-gateways/ucg-fiber"},
		{"switching-professional-max-xg", "usw-pro-max-24", b + "switching/usw-pro-max-24"},
		{"wifi-flagship", "u7-pro", b + "wifi/u7-pro"},
		{"physical-security-ptz", "uvc-g5-ptz", b + "physical-security/uvc-g5-ptz"},
		{"door-access-readers", "ua-reader", b + "door-access/ua-reader"},
		{"accessories-storage", "uacc-x", b + "accessories/uacc-x"},
		{"integrations-power-tech", "usp-x", b + "integrations/usp-x"},
		// Filed under Integrations on the tech specs site, though the store has them apart.
		{"internet-solutions", "ufiber-x", b + "integrations/ufiber-x"},
		{"network-storage", "unas-pro", b + "integrations/unas-pro"},
		{"wifi-flagship", "U7-Pro", b + "wifi/u7-pro"},
		{"", "ucg-fiber", ""},
		{"something-new", "ucg-fiber", ""},
		{"switching", "", ""},
	}
	for _, c := range cases {
		if got := URL(c.category, c.slug); got != c.want {
			t.Errorf("URL(%q, %q) = %q, want %q", c.category, c.slug, got, c.want)
		}
	}
}

func TestExists(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead || r.Header.Get("User-Agent") != "ua" {
			t.Errorf("want HEAD with the configured user agent, got %s %q", r.Method, r.Header.Get("User-Agent"))
		}
		switch r.URL.Path {
		case "/ok":
		case "/moved":
			http.Redirect(w, r, "/", http.StatusTemporaryRedirect)
		case "/gone":
			w.WriteHeader(http.StatusNotFound)
		case "/limited":
			w.WriteHeader(http.StatusTooManyRequests)
		default:
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer srv.Close()
	c := New("ua")

	for path, want := range map[string]bool{"/ok": true, "/moved": false, "/gone": false} {
		if got, err := c.Exists(context.Background(), srv.URL+path); err != nil || got != want {
			t.Errorf("Exists(%s) = %v, %v; want %v", path, got, err, want)
		}
	}
	for path, blocked := range map[string]bool{"/limited": true, "/boom": false} {
		_, err := c.Exists(context.Background(), srv.URL+path)
		var he *HTTPError
		if !errors.As(err, &he) || he.Blocked() != blocked {
			t.Errorf("Exists(%s) error = %v; want an HTTPError with Blocked() = %v", path, err, blocked)
		}
	}
}
