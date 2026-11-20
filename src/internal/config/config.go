package config

import (
	"errors"
	"fmt"
	"io/fs"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"slices"
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
	DefaultMaxItems       = 200
	DefaultBackupInterval = 24 * time.Hour
	DefaultBackupKeep     = 14
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
	// MaxItems caps the watch list, so adding products (from the UI, say)
	// can't make a poll pass arbitrarily long or the store arbitrarily busy.
	MaxItems int `yaml:"max_items"`
	// BackupDir, when set, is where the database is copied to every
	// BackupInterval, keeping the newest BackupKeep copies. Empty disables backups.
	BackupDir            string        `yaml:"backup_dir"`
	BackupIntervalString string        `yaml:"backup_interval"`
	BackupInterval       time.Duration `yaml:"-"`
	BackupKeep           int           `yaml:"backup_keep"`
	Ntfy                 Ntfy          `yaml:"ntfy"`
	Auth                 Auth          `yaml:"auth"`
	Regions              []Region      `yaml:"regions"`
	Items                []Item        `yaml:"items"`
}

// Auth says who may change things. By default (mode "open") every request is
// trusted, which suits a deployment only its owner can reach. In mode "proxy"
// the service believes the identity an authenticating reverse proxy (Authelia,
// oauth2-proxy, ...) forwards in headers, but only on requests that come from
// one of TrustedProxies, so that a direct request can't claim to be anybody.
type Auth struct {
	// Mode is "open" (the default) or "proxy".
	Mode string `yaml:"mode"`
	// Public marks a deployment reachable by people the owner doesn't know. It is
	// refused in mode "open", where anyone could change data.
	Public bool `yaml:"public"`
	// TrustedProxies are the networks (CIDR, or a single address) whose requests
	// may carry identity headers. Required in mode "proxy".
	TrustedProxies []string `yaml:"trusted_proxies"`
	// The headers the proxy sets; the defaults are Authelia's.
	UserHeader   string `yaml:"user_header"`
	NameHeader   string `yaml:"name_header"`
	EmailHeader  string `yaml:"email_header"`
	GroupsHeader string `yaml:"groups_header"`
	// Roles maps a role ("editor", "admin") to the proxy groups that hold it.
	Roles map[string][]string `yaml:"roles"`

	// TrustedPrefixes is TrustedProxies, parsed.
	TrustedPrefixes []netip.Prefix `yaml:"-"`
}

const (
	AuthModeOpen  = "open"
	AuthModeProxy = "proxy"
)

// AuthRoles are the roles Auth.Roles may name.
var AuthRoles = []string{"editor", "admin"}

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
	// PollEveryString is how often the whole region is read ("1h"). Empty means
	// every poll cycle. When it is longer than the poll interval, each cycle
	// reads the share of the region that has waited longest, so a region read
	// hourly with a five-minute interval gets a twelfth of its pages each cycle.
	PollEveryString string        `yaml:"poll_every"`
	PollEvery       time.Duration `yaml:"-"`
}

// KnownRegions are the storefronts that answer with product data, as the store's
// own region list gives them. A configured region naming one of these ids may
// leave base_url and path out. Each has its own host, and its path carries the
// storefront's default language ("jp/ja"), which is what the store redirects to.
var KnownRegions = []Region{
	{ID: "us", BaseURL: "https://store.ui.com", Path: "us/en"},
	{ID: "ca", BaseURL: "https://ca.store.ui.com", Path: "ca/en"},
	{ID: "eu", BaseURL: "https://eu.store.ui.com", Path: "eu/en"},
	{ID: "uk", BaseURL: "https://uk.store.ui.com", Path: "uk/en"},
	{ID: "jp", BaseURL: "https://jp.store.ui.com", Path: "jp/ja"},
	{ID: "br", BaseURL: "https://br.store.ui.com", Path: "br/pt"},
	{ID: "tw", BaseURL: "https://tw.store.ui.com", Path: "tw/zh-tw"},
	{ID: "sg", BaseURL: "https://sg.store.ui.com", Path: "sg/en"},
}

// knownRegion returns the built-in storefront with the given id.
func knownRegion(id string) (Region, bool) {
	for _, r := range KnownRegions {
		if r.ID == id {
			return r, true
		}
	}
	return Region{}, false
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
	if cfg.MaxItems == 0 {
		cfg.MaxItems = DefaultMaxItems
	}
	if cfg.MaxItems < 0 {
		return fmt.Errorf("max_items must be positive, got %d", cfg.MaxItems)
	}
	if cfg.BackupInterval, err = parseDuration("backup_interval", cfg.BackupIntervalString, DefaultBackupInterval, false); err != nil {
		return err
	}
	if cfg.BackupKeep == 0 {
		cfg.BackupKeep = DefaultBackupKeep
	}
	if cfg.BackupKeep < 0 {
		return fmt.Errorf("backup_keep must be positive, got %d", cfg.BackupKeep)
	}

	if err := validateAuth(&cfg.Auth); err != nil {
		return err
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
		// A bare `{id: eu}` means that storefront, not the US one at another name.
		if known, ok := knownRegion(r.ID); ok {
			if r.BaseURL == "" {
				r.BaseURL = known.BaseURL
			}
			if r.Path == "" {
				r.Path = known.Path
			}
			cfg.Regions[i] = r
		}
		if r.BaseURL == "" {
			cfg.Regions[i].BaseURL = DefaultBaseURL
		}
		cfg.Regions[i].BaseURL = strings.TrimRight(cfg.Regions[i].BaseURL, "/")
		cfg.Regions[i].Path = strings.Trim(r.Path, "/")
		if cfg.Regions[i].Path == "" {
			return fmt.Errorf("regions[%d]: path is required (e.g. us/en)", i)
		}
		if cfg.Regions[i].PollEvery, err = parseDuration(fmt.Sprintf("regions[%d].poll_every", i), r.PollEveryString, 0, true); err != nil {
			return err
		}
	}

	// items may be empty: products can also be added from the web UI.
	if len(cfg.Items) > cfg.MaxItems {
		return fmt.Errorf("%d items listed but max_items is %d", len(cfg.Items), cfg.MaxItems)
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

var slugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

// ParseItem turns user input into a region and product slug. Input is either
// a bare slug (case-insensitive, in regionID or the first region if empty) or
// a store URL, which picks its own region. Errors are safe to show to users.
func (c *Config) ParseItem(input, regionID string) (Region, string, error) {
	s := strings.TrimSpace(input)
	if s == "" {
		return Region{}, "", errors.New("enter a product slug or a store URL")
	}

	if strings.ContainsAny(s, "/.:") {
		return c.parseItemURL(s)
	}

	region := c.Regions[0]
	if regionID != "" {
		r, ok := c.RegionByID(regionID)
		if !ok {
			return Region{}, "", fmt.Errorf("unknown region %q", regionID)
		}
		region = r
	}
	slug := strings.ToLower(s)
	if !slugRe.MatchString(slug) {
		return Region{}, "", fmt.Errorf("%q isn't a valid product slug (letters, digits and dashes only)", s)
	}
	return region, slug, nil
}

func (c *Config) parseItemURL(s string) (Region, string, error) {
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return Region{}, "", errors.New("couldn't read that as a URL")
	}

	path := strings.Trim(u.Path, "/")
	var region *Region
	for i, r := range c.Regions {
		base, err := url.Parse(r.BaseURL)
		if err == nil && strings.EqualFold(base.Host, u.Host) && strings.HasPrefix(path+"/", r.Path+"/") {
			region = &c.Regions[i]
			break
		}
	}
	if region == nil {
		return Region{}, "", errors.New("that URL isn't from a store this server watches")
	}

	segments := strings.Split(path, "/")
	for i := len(segments) - 2; i >= 0; i-- {
		if segments[i] == "products" {
			slug := strings.ToLower(segments[i+1])
			if !slugRe.MatchString(slug) {
				break
			}
			return *region, slug, nil
		}
	}
	return Region{}, "", errors.New("couldn't find /products/<slug> in that URL")
}

// validateAuth checks the auth block and fills in its defaults.
func validateAuth(a *Auth) error {
	if a.Mode == "" {
		a.Mode = AuthModeOpen
	}
	switch a.Mode {
	case AuthModeOpen:
		if a.Public {
			return errors.New("auth.public is set but auth.mode is \"open\", which would let anyone change data; use auth.mode: proxy")
		}
		return nil
	case AuthModeProxy:
	default:
		return fmt.Errorf("auth.mode must be %q or %q, got %q", AuthModeOpen, AuthModeProxy, a.Mode)
	}

	if len(a.TrustedProxies) == 0 {
		return errors.New("auth.trusted_proxies is required in proxy mode: the networks whose requests may carry identity headers")
	}
	a.TrustedPrefixes = a.TrustedPrefixes[:0]
	for i, raw := range a.TrustedProxies {
		raw = strings.TrimSpace(raw)
		p, err := netip.ParsePrefix(raw)
		if err != nil {
			addr, aerr := netip.ParseAddr(raw)
			if aerr != nil {
				return fmt.Errorf("auth.trusted_proxies[%d]: %q is neither a CIDR nor an address", i, raw)
			}
			p = netip.PrefixFrom(addr.Unmap(), addr.Unmap().BitLen())
		}
		if p.Bits() == 0 {
			return fmt.Errorf("auth.trusted_proxies[%d]: %q trusts every address, which makes the identity headers forgeable", i, raw)
		}
		a.TrustedPrefixes = append(a.TrustedPrefixes, p.Masked())
	}

	for field, def := range map[*string]string{&a.UserHeader: "Remote-User", &a.NameHeader: "Remote-Name", &a.EmailHeader: "Remote-Email", &a.GroupsHeader: "Remote-Groups"} {
		if *field = strings.TrimSpace(*field); *field == "" {
			*field = def
		}
	}
	for role, groups := range a.Roles {
		if !slices.Contains(AuthRoles, role) {
			return fmt.Errorf("auth.roles: unknown role %q (known: %s)", role, strings.Join(AuthRoles, ", "))
		}
		for _, g := range groups {
			if strings.TrimSpace(g) == "" {
				return fmt.Errorf("auth.roles.%s: a group name is empty", role)
			}
		}
	}
	return nil
}
