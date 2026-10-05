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
