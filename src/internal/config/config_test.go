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
		"no items":       base,
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
