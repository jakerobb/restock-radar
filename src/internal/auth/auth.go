// Package auth decides who is making a request and what they may do.
//
// The service has no login of its own. Who someone is comes from one of two
// places, chosen in the config: nobody is asked (mode "open", for a deployment
// only its owner can reach), or an authenticating reverse proxy in front of the
// service says who they are in request headers (mode "proxy"). Either way the
// rest of the code sees only a Principal and the permissions it holds, so a
// third source (accounts of the service's own, say) changes nothing else.
package auth

import (
	"context"
	"log/slog"
	"net/http"
	"net/netip"
	"slices"
	"strings"
	"unicode"

	"github.com/jakerobb/restock-radar/internal/config"
)

// Permission is one kind of change somebody may be allowed to make.
type Permission string

const (
	// OverridesWrite creates, changes and removes spec overrides, and reads who did.
	OverridesWrite Permission = "overrides:write"
	// WatchlistWrite adds products to the watch list.
	WatchlistWrite Permission = "watchlist:write"
	// ProductsRefresh reads a product from the store on demand.
	ProductsRefresh Permission = "products:refresh"
)

// Role is a named set of permissions.
type Role string

const (
	RoleEditor Role = "editor"
	RoleAdmin  Role = "admin"
)

// rolePermissions is what each role may do. Anyone, signed in or not, may read.
var rolePermissions = map[Role][]Permission{
	RoleEditor: {OverridesWrite, ProductsRefresh},
	RoleAdmin:  {OverridesWrite, WatchlistWrite, ProductsRefresh},
}

// Principal is whoever made a request.
type Principal struct {
	// Authenticated is true when the proxy named the user.
	Authenticated bool `json:"authenticated"`
	// Open is true when nobody is asked who they are (mode "open"); the
	// principal then holds every permission.
	Open  bool   `json:"open"`
	User  string `json:"user,omitempty"`
	Name  string `json:"name,omitempty"`
	Email string `json:"email,omitempty"`
	Roles []Role `json:"roles"`
}

// Can reports whether the principal holds a permission.
func (p Principal) Can(perm Permission) bool {
	for _, r := range p.Roles {
		if slices.Contains(rolePermissions[r], perm) {
			return true
		}
	}
	return false
}

// Permissions lists everything the principal may do, sorted.
func (p Principal) Permissions() []Permission {
	var out []Permission
	for _, r := range p.Roles {
		for _, perm := range rolePermissions[r] {
			if !slices.Contains(out, perm) {
				out = append(out, perm)
			}
		}
	}
	slices.Sort(out)
	if out == nil {
		out = []Permission{}
	}
	return out
}

// Actor names the principal in the record of a change.
func (p Principal) Actor() string {
	switch {
	case p.User != "":
		return p.User
	case p.Open:
		return "open"
	}
	return "anonymous"
}

// Authenticator works out who is making a request.
type Authenticator interface {
	Authenticate(r *http.Request) Principal
	// Mode is "open", "proxy" or "closed".
	Mode() string
}

type ctxKey struct{}

// NewContext returns ctx carrying p.
func NewContext(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, ctxKey{}, p)
}

// FromContext is the principal a request was authenticated as; the zero
// Principal (nobody, no permissions) if it wasn't.
func FromContext(ctx context.Context) Principal {
	p, _ := ctx.Value(ctxKey{}).(Principal)
	return p
}

// New builds the Authenticator the config asks for. It never fails open: a
// config it can't make sense of gets an Authenticator that treats everybody as
// nobody, so a mistake costs the ability to change things, not the protection.
func New(cfg config.Auth) Authenticator {
	switch cfg.Mode {
	case "", config.AuthModeOpen:
		if cfg.Public {
			slog.Error("auth.public is set but auth.mode is open; refusing all changes")
			return closed{}
		}
		return open{}
	case config.AuthModeProxy:
		if len(cfg.TrustedPrefixes) == 0 {
			slog.Error("auth.mode is proxy but no trusted_proxies are configured; refusing all changes")
			return closed{}
		}
		return newProxy(cfg)
	}
	slog.Error("unknown auth.mode; refusing all changes", "mode", cfg.Mode)
	return closed{}
}

// open treats every request as an administrator's.
type open struct{}

func (open) Authenticate(*http.Request) Principal {
	return Principal{Open: true, Roles: []Role{RoleAdmin}}
}
func (open) Mode() string { return config.AuthModeOpen }

// closed treats every request as nobody's.
type closed struct{}

func (closed) Authenticate(*http.Request) Principal { return Principal{Roles: []Role{}} }
func (closed) Mode() string                         { return "closed" }

// proxy believes the identity headers of requests from trusted proxies.
type proxy struct {
	trusted                               []netip.Prefix
	userHdr, nameHdr, emailHdr, groupsHdr string
	groupRoles                            map[string][]Role
}

func newProxy(cfg config.Auth) *proxy {
	p := &proxy{
		trusted: cfg.TrustedPrefixes, userHdr: cfg.UserHeader, nameHdr: cfg.NameHeader,
		emailHdr: cfg.EmailHeader, groupsHdr: cfg.GroupsHeader, groupRoles: map[string][]Role{},
	}
	for role, groups := range cfg.Roles {
		for _, g := range groups {
			g = strings.ToLower(strings.TrimSpace(g))
			p.groupRoles[g] = append(p.groupRoles[g], Role(role))
		}
	}
	return p
}

func (*proxy) Mode() string { return config.AuthModeProxy }

const (
	maxUserLen  = 128
	maxNameLen  = 128
	maxEmailLen = 254
	maxGroups   = 64
)

func (p *proxy) Authenticate(r *http.Request) Principal {
	anonymous := Principal{Roles: []Role{}}
	if !p.fromTrustedProxy(r) {
		return anonymous
	}
	user := clean(r.Header.Get(p.userHdr), maxUserLen)
	if user == "" {
		return anonymous
	}
	pr := Principal{
		Authenticated: true, User: user,
		Name: clean(r.Header.Get(p.nameHdr), maxNameLen), Email: clean(r.Header.Get(p.emailHdr), maxEmailLen),
		Roles: []Role{},
	}
	for i, g := range strings.Split(r.Header.Get(p.groupsHdr), ",") {
		if i >= maxGroups {
			break
		}
		for _, role := range p.groupRoles[strings.ToLower(strings.TrimSpace(g))] {
			if !slices.Contains(pr.Roles, role) {
				pr.Roles = append(pr.Roles, role)
			}
		}
	}
	slices.Sort(pr.Roles)
	return pr
}

// fromTrustedProxy reports whether the request's own connection (not any header
// it carries, which the sender controls) came from a trusted network.
func (p *proxy) fromTrustedProxy(r *http.Request) bool {
	ap, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	addr := ap.Addr().Unmap()
	for _, prefix := range p.trusted {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

// clean trims a header value and refuses one holding control characters or
// longer than max, rather than store something odd in a record of who did what.
func clean(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) > max || strings.IndexFunc(s, unicode.IsControl) >= 0 {
		return ""
	}
	return s
}
