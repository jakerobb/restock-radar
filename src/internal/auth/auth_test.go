package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/jakerobb/restock-radar/internal/config"
)

// validated runs the config through the real loader's validation by way of its
// exported result, so these tests build their Auth the way the service does.
func validated(t *testing.T, yaml string) config.Auth {
	t.Helper()
	dir := t.TempDir()
	path := dir + "/c.yaml"
	if err := writeFile(path, "ntfy: {url: \"https://n\", topic: t}\n"+yaml); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.LoadFromPath(path)
	if err != nil {
		t.Fatal(err)
	}
	return cfg.Auth
}

func req(remote string, headers map[string]string) *http.Request {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = remote
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

const proxyYAML = `
auth:
  mode: proxy
  trusted_proxies: ["10.244.0.0/16", "192.168.1.10", "fd00::/8"]
  roles:
    admin: [admins]
    editor: [editors, Helpers]
`

func TestOpenModeTrustsEveryone(t *testing.T) {
	a := New(config.Auth{})
	p := a.Authenticate(req("203.0.113.9:1234", nil))
	if a.Mode() != "open" || !p.Open || p.Authenticated {
		t.Fatalf("mode %q, principal %+v", a.Mode(), p)
	}
	for _, perm := range []Permission{OverridesWrite, WatchlistWrite, ProductsRefresh} {
		if !p.Can(perm) {
			t.Errorf("open mode lacks %s", perm)
		}
	}
	if p.Actor() != "open" {
		t.Errorf("actor = %q", p.Actor())
	}
}

func TestProxyModeReadsTheIdentityOfATrustedProxy(t *testing.T) {
	a := New(validated(t, proxyYAML))
	p := a.Authenticate(req("10.244.3.7:5555", map[string]string{
		"Remote-User": "jake", "Remote-Name": "Jake R", "Remote-Email": "jake@example.com", "Remote-Groups": "users, Editors",
	}))
	if a.Mode() != "proxy" || !p.Authenticated || p.Open || p.User != "jake" || p.Name != "Jake R" || p.Email != "jake@example.com" {
		t.Fatalf("principal = %+v", p)
	}
	if !slices.Equal(p.Roles, []Role{RoleEditor}) {
		t.Errorf("roles = %v", p.Roles)
	}
	if !p.Can(OverridesWrite) || !p.Can(ProductsRefresh) || p.Can(WatchlistWrite) {
		t.Errorf("an editor's permissions = %v", p.Permissions())
	}
	if p.Actor() != "jake" {
		t.Errorf("actor = %q", p.Actor())
	}
}

func TestProxyModeGroupsMapToRoles(t *testing.T) {
	a := New(validated(t, proxyYAML))
	for _, tc := range []struct {
		groups string
		want   []Role
	}{
		{"admins", []Role{RoleAdmin}},
		{"ADMINS", []Role{RoleAdmin}}, // group names are matched without regard to case
		{"helpers", []Role{RoleEditor}},
		{"editors,admins", []Role{RoleAdmin, RoleEditor}},
		{"users,dev", []Role{}},
		{"", []Role{}},
	} {
		p := a.Authenticate(req("10.244.0.1:1", map[string]string{"Remote-User": "u", "Remote-Groups": tc.groups}))
		if !slices.Equal(p.Roles, tc.want) {
			t.Errorf("groups %q: roles %v, want %v", tc.groups, p.Roles, tc.want)
		}
	}
}

func TestProxyModeIgnoresIdentityFromAnyoneElse(t *testing.T) {
	a := New(validated(t, proxyYAML))
	forged := map[string]string{"Remote-User": "jake", "Remote-Groups": "admins"}
	for _, remote := range []string{"203.0.113.9:1", "10.245.0.1:1", "192.168.1.11:1", "[2001:db8::1]:1", "garbage", ""} {
		p := a.Authenticate(req(remote, forged))
		if p.Authenticated || p.User != "" || p.Can(OverridesWrite) || len(p.Roles) != 0 {
			t.Errorf("%q was believed: %+v", remote, p)
		}
	}
	// A forwarded-for header is the sender's to write, so it never makes a proxy trusted.
	p := a.Authenticate(req("203.0.113.9:1", map[string]string{"X-Forwarded-For": "10.244.0.1", "Remote-User": "jake", "Remote-Groups": "admins"}))
	if p.Authenticated {
		t.Errorf("X-Forwarded-For was believed: %+v", p)
	}
}

func TestProxyModeAcceptsEveryWayOfWritingATrustedAddress(t *testing.T) {
	a := New(validated(t, proxyYAML))
	for _, remote := range []string{"10.244.0.1:1", "192.168.1.10:9", "[fd00::5]:1", "[::ffff:10.244.0.9]:1"} {
		if !a.Authenticate(req(remote, map[string]string{"Remote-User": "u"})).Authenticated {
			t.Errorf("%q was not trusted", remote)
		}
	}
}

func TestProxyModeWithoutAUserIsAnonymous(t *testing.T) {
	a := New(validated(t, proxyYAML))
	p := a.Authenticate(req("10.244.0.1:1", map[string]string{"Remote-Groups": "admins"}))
	if p.Authenticated || p.Can(OverridesWrite) {
		t.Errorf("groups without a user were believed: %+v", p)
	}
	if p.Actor() != "anonymous" {
		t.Errorf("actor = %q", p.Actor())
	}
	if perms := p.Permissions(); perms == nil || len(perms) != 0 {
		t.Errorf("an anonymous visitor's permissions = %#v, want an empty (non-nil) list", perms)
	}
}

func TestProxyModeRefusesOddIdentityValues(t *testing.T) {
	a := New(validated(t, proxyYAML))
	for name, user := range map[string]string{
		"too long":      strings.Repeat("a", maxUserLen+1),
		"control chars": "ja\x00ke",
		"escape":        "jake\x1b[31m",
	} {
		if p := a.Authenticate(req("10.244.0.1:1", map[string]string{"Remote-User": user, "Remote-Groups": "admins"})); p.Authenticated {
			t.Errorf("%s: believed %+v", name, p)
		}
	}
	// An odd name or email is dropped, not the user.
	p := a.Authenticate(req("10.244.0.1:1", map[string]string{"Remote-User": "jake", "Remote-Name": strings.Repeat("n", maxNameLen+1), "Remote-Email": "a\x00b"}))
	if !p.Authenticated || p.Name != "" || p.Email != "" {
		t.Errorf("principal = %+v", p)
	}
}

func TestProxyModeUsesTheConfiguredHeaders(t *testing.T) {
	a := New(validated(t, `
auth:
  mode: proxy
  trusted_proxies: ["10.0.0.0/8"]
  user_header: X-Auth-User
  groups_header: X-Auth-Groups
  roles: {admin: [ops]}
`))
	p := a.Authenticate(req("10.1.1.1:1", map[string]string{"X-Auth-User": "kim", "X-Auth-Groups": "ops", "Remote-User": "someone-else"}))
	if p.User != "kim" || !p.Can(WatchlistWrite) {
		t.Errorf("principal = %+v", p)
	}
}

func TestAMisconfigurationFailsClosed(t *testing.T) {
	for name, cfg := range map[string]config.Auth{
		"proxy without proxies": {Mode: config.AuthModeProxy},
		"public but open":       {Mode: config.AuthModeOpen, Public: true},
		"unknown mode":          {Mode: "magic"},
	} {
		a := New(cfg)
		p := a.Authenticate(req("10.244.0.1:1", map[string]string{"Remote-User": "jake", "Remote-Groups": "admins"}))
		if a.Mode() != "closed" || p.Open || p.Authenticated || p.Can(OverridesWrite) {
			t.Errorf("%s: mode %q, principal %+v", name, a.Mode(), p)
		}
	}
}

func TestPrincipalInContext(t *testing.T) {
	if p := FromContext(context.Background()); p.Can(OverridesWrite) || p.Authenticated {
		t.Errorf("an empty context gave %+v", p)
	}
	want := Principal{Authenticated: true, User: "jake", Roles: []Role{RoleAdmin}}
	if got := FromContext(NewContext(context.Background(), want)); got.User != "jake" || !got.Can(WatchlistWrite) {
		t.Errorf("got %+v", got)
	}
}

func TestPermissionsAreSortedAndUnique(t *testing.T) {
	p := Principal{Roles: []Role{RoleEditor, RoleAdmin}}
	want := []Permission{OverridesWrite, ProductsRefresh, WatchlistWrite}
	if got := p.Permissions(); !slices.Equal(got, want) {
		t.Errorf("permissions = %v, want %v", got, want)
	}
}

func writeFile(path, content string) error { return os.WriteFile(path, []byte(content), 0o600) }
