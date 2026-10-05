package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

const (
	DefaultBaseURL        = "https://store.ui.com"
	DefaultRegion         = "us"
	DefaultRegionPath     = "us/en"
	DefaultUserAgent      = "restock-radar (+https://github.com/jakerobb/restock-radar)"
	DefaultPollInterval   = 20 * time.Minute
	DefaultPollJitter     = time.Minute
	DefaultRequestDelay   = 2 * time.Second
	DefaultDBPath         = "/data/restock-radar.db"
	DefaultHTTPPort       = 8080
	DefaultFailureAlertAt = 3
)

// DefaultPaths are the config locations tried, in order, when CONFIG_PATH isn't set.
var DefaultPaths = []string{"/etc/restock-radar/config.yaml"}

type Config struct {
	PollIntervalString string        `yaml:"poll_interval"`
	PollJitterString   string        `yaml:"poll_jitter"`
	RequestDelayString string        `yaml:"request_delay"`
	PollInterval       time.Duration `yaml:"-"`
	PollJitter         time.Duration `yaml:"-"`
	RequestDelay       time.Duration `yaml:"-"`
	HTTPPort           int           `yaml:"http_port"`
	DBPath             string        `yaml:"db_path"`
	UserAgent          string        `yaml:"user_agent"`
	FailureAlertAfter  int           `yaml:"failure_alert_after"`
	Ntfy               Ntfy          `yaml:"ntfy"`
	Regions            []Region      `yaml:"regions"`
	Items              []Item        `yaml:"items"`
}

type Ntfy struct {
	URL   string `yaml:"url"`
	Topic string `yaml:"topic"`
	Token string `yaml:"token"`
}

// Region is one UniFi storefront. Stock and prices don't sync across regions.
type Region struct {
	ID      string `yaml:"id"`
	BaseURL string `yaml:"base_url"`
	// Path is the storefront's locale prefix, e.g. "us/en".
	Path string `yaml:"path"`
}

// Item is a product to watch, identified by its store slug (not by URL, so it
// survives category reshuffles).
type Item struct {
	Slug   string `yaml:"slug"`
	Region string `yaml:"region"`
}

var envVarRe = regexp.MustCompile(`\$\{([^}]+)}`)

// interpolate replaces ${VAR_NAME} references with environment variable values.
func interpolate(s string) string {
	return envVarRe.ReplaceAllStringFunc(s, func(match string) string {
		return os.Getenv(envVarRe.FindStringSubmatch(match)[1])
	})
}

// Load reads the config from CONFIG_PATH if set, else the first of
// DefaultPaths that exists.
func Load() (*Config, error) {
	if path := os.Getenv("CONFIG_PATH"); path != "" {
		return LoadFromPath(path)
	}
	for _, path := range DefaultPaths {
		if _, err := os.Stat(path); errors.Is(err, fs.ErrNotExist) {
			continue
		}
		return LoadFromPath(path)
	}
	return nil, fmt.Errorf("no config found at %s", strings.Join(DefaultPaths, " or "))
}

func LoadFromPath(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading config from path %s: %w", path, err)
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parsing config from path %s: %w", path, err)
	}

	cfg.Ntfy.URL = interpolate(cfg.Ntfy.URL)
	cfg.Ntfy.Topic = interpolate(cfg.Ntfy.Topic)
	cfg.Ntfy.Token = interpolate(cfg.Ntfy.Token)

	if err := validate(&cfg); err != nil {
		return nil, fmt.Errorf("invalid config from path %s: %w", path, err)
	}
	return &cfg, nil
}

// RegionByID returns the configured region with the given ID.
func (c *Config) RegionByID(id string) (Region, bool) {
	for _, r := range c.Regions {
		if r.ID == id {
			return r, true
		}
	}
	return Region{}, false
}

func parseDuration(field, raw string, def time.Duration, allowZero bool) (time.Duration, error) {
	if raw == "" {
		return def, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("invalid %s `%s`: %w", field, raw, err)
	}
	if d < 0 || (d == 0 && !allowZero) {
		return 0, fmt.Errorf("%s must be positive, got %s", field, raw)
	}
	return d, nil
}

func validate(cfg *Config) error {
	var err error
	if cfg.PollInterval, err = parseDuration("poll_interval", cfg.PollIntervalString, DefaultPollInterval, false); err != nil {
		return err
	}
	if cfg.PollJitter, err = parseDuration("poll_jitter", cfg.PollJitterString, DefaultPollJitter, true); err != nil {
		return err
	}
	if cfg.RequestDelay, err = parseDuration("request_delay", cfg.RequestDelayString, DefaultRequestDelay, true); err != nil {
		return err
	}

	if cfg.HTTPPort == 0 {
		cfg.HTTPPort = DefaultHTTPPort
	}
	if cfg.DBPath == "" {
		cfg.DBPath = DefaultDBPath
	}
	if cfg.UserAgent == "" {
		cfg.UserAgent = DefaultUserAgent
	}
	if cfg.FailureAlertAfter == 0 {
		cfg.FailureAlertAfter = DefaultFailureAlertAt
	}

	if cfg.Ntfy.URL == "" {
		return fmt.Errorf("ntfy.url is required")
	}
	if cfg.Ntfy.Topic == "" {
		return fmt.Errorf("ntfy.topic is required")
	}

	if len(cfg.Regions) == 0 {
		cfg.Regions = []Region{{ID: DefaultRegion, BaseURL: DefaultBaseURL, Path: DefaultRegionPath}}
	}
	regions := make(map[string]bool)
	for i, r := range cfg.Regions {
		if r.ID == "" {
			return fmt.Errorf("regions[%d]: id is required", i)
		}
		if regions[r.ID] {
			return fmt.Errorf("regions[%d]: duplicate id %q", i, r.ID)
		}
		regions[r.ID] = true
		if r.BaseURL == "" {
			cfg.Regions[i].BaseURL = DefaultBaseURL
		}
		cfg.Regions[i].BaseURL = strings.TrimRight(cfg.Regions[i].BaseURL, "/")
		cfg.Regions[i].Path = strings.Trim(r.Path, "/")
		if cfg.Regions[i].Path == "" {
			return fmt.Errorf("regions[%d]: path is required (e.g. us/en)", i)
		}
	}

	if len(cfg.Items) == 0 {
		return fmt.Errorf("at least one entry in items is required")
	}
	seen := make(map[string]bool)
	for i, it := range cfg.Items {
		it.Slug = strings.TrimSpace(it.Slug)
		if it.Slug == "" {
			return fmt.Errorf("items[%d]: slug is required", i)
		}
		if it.Region == "" {
			it.Region = cfg.Regions[0].ID
		}
		if !regions[it.Region] {
			return fmt.Errorf("items[%d]: unknown region %q", i, it.Region)
		}
		key := it.Region + "/" + it.Slug
		if seen[key] {
			return fmt.Errorf("items[%d]: duplicate item %s", i, key)
		}
		seen[key] = true
		cfg.Items[i] = it
	}
	return nil
}
