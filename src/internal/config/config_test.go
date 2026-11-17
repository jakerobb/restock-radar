package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func load(t *testing.T, yaml string) (*Config, error) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(yaml), 0o600); err != nil {
		t.Fatal(err)
	}
	return LoadFromPath(path)
}

func TestDefaults(t *testing.T) {
	t.Setenv("NTFY_TOKEN", "secret")
	cfg, err := load(t, `
ntfy: {url: "https://ntfy.example", topic: restock, token: "${NTFY_TOKEN}"}
items:
  - slug: usw-lite-8-poe
`)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PollInterval != 20*time.Minute || cfg.HTTPPort != 8080 || cfg.Ntfy.Token != "secret" {
		t.Errorf("unexpected defaults: %+v", cfg)
	}
	if len(cfg.Regions) != 1 || cfg.Regions[0].Path != "us/en" || cfg.Items[0].Region != "us" {
		t.Errorf("default region not applied: %+v %+v", cfg.Regions, cfg.Items)
	}
}

func TestValidationErrors(t *testing.T) {
	base := `ntfy: {url: "https://n", topic: t}` + "\n"
	cases := map[string]string{
		"bad region":     base + "items:\n  - {slug: a, region: zz}\n",
		"duplicate item": base + "items:\n  - {slug: a}\n  - {slug: a}\n",
		"bad interval":   base + "poll_interval: soon\nitems:\n  - {slug: a}\n",
		"no ntfy":        "items:\n  - {slug: a}\n",
	}
	for name, yaml := range cases {
		if _, err := load(t, yaml); err == nil {
			t.Errorf("%s: expected an error", name)
		} else if strings.TrimSpace(err.Error()) == "" {
			t.Errorf("%s: empty error", name)
		}
	}
}

func TestParseItem(t *testing.T) {
	cfg, err := load(t, `
ntfy: {url: "https://n", topic: t}
regions:
  - {id: us, path: us/en}
  - {id: gb, base_url: "https://uk.example", path: gb/en}
`)
	if err != nil {
		t.Fatal(err)
	}

	ok := []struct{ in, region, wantRegion, wantSlug string }{
		{"UCG-Fiber", "", "us", "ucg-fiber"},
		{"  ucg-fiber ", "gb", "gb", "ucg-fiber"},
		{"https://store.ui.com/us/en/category/cloud-gateways-compact/collections/cloud-gateway-fiber/products/ucg-fiber", "", "us", "ucg-fiber"},
		{"https://store.ui.com/us/en/products/UCG-Fiber?variant=x", "", "us", "ucg-fiber"},
		{"store.ui.com/us/en/products/ucg-fiber/", "", "us", "ucg-fiber"},
		{"https://uk.example/gb/en/products/foo", "us", "gb", "foo"},
	}
	for _, c := range ok {
		r, slug, err := cfg.ParseItem(c.in, c.region)
		if err != nil || r.ID != c.wantRegion || slug != c.wantSlug {
			t.Errorf("ParseItem(%q, %q) = %q, %q, %v; want %s, %s", c.in, c.region, r.ID, slug, err, c.wantRegion, c.wantSlug)
		}
	}

	for _, in := range []string{"", "bad slug", "https://evil.example/us/en/products/x", "https://store.ui.com/us/en/category/switching",
		"https://store.ui.com/de/en/products/x"} {
		if _, _, err := cfg.ParseItem(in, ""); err == nil {
			t.Errorf("ParseItem(%q) should fail", in)
		}
	}
	if _, _, err := cfg.ParseItem("x", "zz"); err == nil {
		t.Error("unknown region should fail")
	}
}

func TestMaxItemsAndBackupSettings(t *testing.T) {
	cfg, err := load(t, `
ntfy: {url: "https://n", topic: t}
items: [{slug: a}]
`)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxItems != 200 || cfg.BackupDir != "" || cfg.BackupInterval != 24*time.Hour || cfg.BackupKeep != 14 {
		t.Errorf("unexpected defaults: %+v", cfg)
	}

	cfg, err = load(t, `
ntfy: {url: "https://n", topic: t}
max_items: 5
backup_dir: /backups
backup_interval: 6h
backup_keep: 3
`)
	if err != nil || cfg.MaxItems != 5 || cfg.BackupDir != "/backups" || cfg.BackupInterval != 6*time.Hour || cfg.BackupKeep != 3 {
		t.Fatalf("explicit settings not applied: %+v %v", cfg, err)
	}

	for name, yaml := range map[string]string{
		"more items than max": "max_items: 1\nitems: [{slug: a}, {slug: b}]\n",
		"negative max":        "max_items: -1\n",
		"bad interval":        "backup_interval: daily\n",
		"negative keep":       "backup_keep: -2\n",
	} {
		if _, err := load(t, `ntfy: {url: "https://n", topic: t}`+"\n"+yaml); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestAuthDefaultsToOpen(t *testing.T) {
	cfg, err := load(t, `ntfy: {url: "https://n", topic: t}`)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Auth.Mode != AuthModeOpen || cfg.Auth.Public {
		t.Errorf("auth = %+v", cfg.Auth)
	}
}

func TestAuthProxyMode(t *testing.T) {
	cfg, err := load(t, `
ntfy: {url: "https://n", topic: t}
auth:
  mode: proxy
  public: true
  trusted_proxies: ["10.244.0.0/16", "192.168.1.10", "fd00::/8"]
  roles:
    admin: [admins]
    editor: [editors, helpers]
`)
	if err != nil {
		t.Fatal(err)
	}
	a := cfg.Auth
	if len(a.TrustedPrefixes) != 3 || a.TrustedPrefixes[0].String() != "10.244.0.0/16" || a.TrustedPrefixes[1].String() != "192.168.1.10/32" {
		t.Errorf("prefixes = %v", a.TrustedPrefixes)
	}
	if a.UserHeader != "Remote-User" || a.NameHeader != "Remote-Name" || a.EmailHeader != "Remote-Email" || a.GroupsHeader != "Remote-Groups" {
		t.Errorf("header defaults: %+v", a)
	}
	if len(a.Roles["editor"]) != 2 {
		t.Errorf("roles = %v", a.Roles)
	}

	cfg, err = load(t, `
ntfy: {url: "https://n", topic: t}
auth: {mode: proxy, trusted_proxies: ["10.0.0.0/8"], user_header: X-Forwarded-User}
`)
	if err != nil || cfg.Auth.UserHeader != "X-Forwarded-User" {
		t.Errorf("custom header: %v %+v", err, cfg.Auth)
	}
}

func TestAuthValidationErrors(t *testing.T) {
	base := `ntfy: {url: "https://n", topic: t}` + "\n"
	cases := map[string]string{
		"public but open":       "auth: {public: true}",
		"unknown mode":          "auth: {mode: magic}",
		"proxy without proxies": "auth: {mode: proxy}",
		"bad network":           "auth: {mode: proxy, trusted_proxies: [\"nowhere\"]}",
		"trust everything (v4)": "auth: {mode: proxy, trusted_proxies: [\"0.0.0.0/0\"]}",
		"trust everything (v6)": "auth: {mode: proxy, trusted_proxies: [\"::/0\"]}",
		"unknown role":          "auth: {mode: proxy, trusted_proxies: [\"10.0.0.0/8\"], roles: {root: [x]}}",
		"empty group":           "auth: {mode: proxy, trusted_proxies: [\"10.0.0.0/8\"], roles: {admin: [\"\"]}}",
	}
	for name, block := range cases {
		if _, err := load(t, base+block); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
