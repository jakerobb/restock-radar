// Package unifidevices reads Ubiquiti's public device list (the one UniFi
// applications use to recognise what they adopt) so that the codes a console
// reports for its devices ("UAPA6A4", "USMINI") can be matched to the products
// they are. The list is public and undocumented: its shape may change, so what
// is read is only what is needed, and the last good copy is kept for when a
// fetch fails.
package unifidevices

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// URL is where the device list is published.
const URL = "https://static.ui.com/fingerprint/ui/public.json"

const (
	// maxBody bounds what is read; the list is under a megabyte.
	maxBody = 8 << 20
	// ttl is how long a copy is used before another is fetched.
	ttl = 24 * time.Hour
	// retryAfter is how long after a failed fetch before trying again, while an older copy is served.
	retryAfter = 10 * time.Minute
)

// Device is what is kept of one entry of the list.
type Device struct {
	// SKU is the product's SKU, without the region the store adds ("USW-Pro-HD-24-PoE").
	SKU  string `json:"sku"`
	Name string `json:"name"`
	// Type is Ubiquiti's kind of device ("switch", "access-point", "console").
	Type string `json:"type"`
	// Shortnames are the codes devices report (and the SKUs of its regional versions), such as "USPH24P".
	Shortnames []string `json:"shortnames"`
	// SysIDs are hex system ids, lower case. A device's model code ends in its system id ("UAPA6A4" is a6a4).
	SysIDs []string `json:"sysids"`
}

type rawList struct {
	Devices []struct {
		SKU     string `json:"sku"`
		Product struct {
			Name string `json:"name"`
		} `json:"product"`
		DeviceType string   `json:"deviceType"`
		Shortnames []string `json:"shortnames"`
		SysID      string   `json:"sysid"`
		SysIDs     []string `json:"sysids"`
	} `json:"devices"`
}

// Parse reads the list, keeping the devices that name a SKU. A list with none is an error, since it would
// mean the format has changed.
func Parse(r io.Reader) ([]Device, error) {
	var raw rawList
	if err := json.NewDecoder(io.LimitReader(r, maxBody)).Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode device list: %w", err)
	}
	var out []Device
	for _, d := range raw.Devices {
		sku := strings.TrimSpace(d.SKU)
		if sku == "" {
			continue
		}
		seen := map[string]bool{}
		var ids []string
		for _, id := range append([]string{d.SysID}, d.SysIDs...) {
			id = strings.ToLower(strings.TrimSpace(id))
			if id != "" && !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
		name := strings.TrimSpace(d.Product.Name)
		if name == "" {
			name = sku
		}
		out = append(out, Device{SKU: sku, Name: name, Type: d.DeviceType, Shortnames: nonNil(d.Shortnames), SysIDs: nonNil(ids)})
	}
	if len(out) == 0 {
		return nil, errors.New("device list has no devices")
	}
	return out, nil
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// Source fetches the list when asked, and keeps it.
type Source struct {
	http      *http.Client
	url       string
	userAgent string
	now       func() time.Time

	mu      sync.Mutex
	devices []Device
	// next is when another fetch is due.
	next time.Time
}

func New(userAgent string) *Source {
	return &Source{http: &http.Client{Timeout: 30 * time.Second}, url: URL, userAgent: userAgent, now: time.Now}
}

// Devices returns the list, fetching it if there is none or it is old. When a fetch fails the previous copy
// is returned if there is one (and the fetch isn't tried again for a while); with none, the error.
func (s *Source) Devices(ctx context.Context) ([]Device, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.devices != nil && s.now().Before(s.next) {
		return s.devices, nil
	}
	devices, err := s.fetch(ctx)
	if err != nil {
		if s.devices != nil {
			s.next = s.now().Add(retryAfter)
			return s.devices, nil
		}
		return nil, err
	}
	s.devices, s.next = devices, s.now().Add(ttl)
	return devices, nil
}

func (s *Source) fetch(ctx context.Context) ([]Device, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", s.userAgent)
	resp, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d from %s", resp.StatusCode, s.url)
	}
	return Parse(resp.Body)
}
