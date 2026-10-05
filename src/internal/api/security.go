package api

import (
	"net/http"
	"strings"
	"sync"
	"time"
)

// csp allows only same-origin scripts, styles, images and fetches. The UI is
// compiled to static files with no inline script or style, so nothing more is
// needed, and a page that can't load anything else can't be turned against the
// viewer even if a title from the store were ever rendered unsafely.
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
	"connect-src 'self'; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

// securityHeaders sets the browser-facing protections on every response, and
// marks API and metrics responses uncacheable (the UI's own cache headers come
// from the static file handler).
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
		if strings.HasPrefix(r.URL.Path, "/v1/") || r.URL.Path == "/metrics" {
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// windowLimiter allows at most max events in any sliding window. It guards
// the one endpoint that makes the server call out to the store on demand.
type windowLimiter struct {
	mu     sync.Mutex
	times  []time.Time
	max    int
	window time.Duration
	now    func() time.Time
}

func newWindowLimiter(max int, window time.Duration) *windowLimiter {
	return &windowLimiter{max: max, window: window, now: time.Now}
}

// allow records an event if there's room, and otherwise says how long until
// there will be.
func (l *windowLimiter) allow() (ok bool, retryAfter time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	cutoff := now.Add(-l.window)
	kept := l.times[:0]
	for _, t := range l.times {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	l.times = kept

	if len(l.times) >= l.max {
		return false, l.times[0].Add(l.window).Sub(now)
	}
	l.times = append(l.times, now)
	return true, 0
}
