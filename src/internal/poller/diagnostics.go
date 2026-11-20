package poller

import (
	"sort"
	"sync"
	"time"
)

// maxErrorLen bounds an error message kept for diagnostics.
const maxErrorLen = 500

// failureDetail is the latest failed fetch of one item.
type failureDetail struct {
	Error  string
	At     time.Time
	Result string // the fetches_total label: blocked, schema, not_found or error
}

// diagState is what the poller keeps for Diagnostics. The poll loop writes it
// and HTTP handlers read it, so it has a lock of its own; the poller's
// failures and alerted maps are guarded by it too.
type diagState struct {
	mu sync.Mutex

	started time.Time
	lastErr map[string]failureDetail // by "region/slug"

	cycles        int
	inCycle       bool
	cycleStart    time.Time // the running or last cycle's start
	lastDone      time.Time
	lastDuration  time.Duration
	lastBlocked   bool
	backoff       int
	nextCycleAt   time.Time
	blockedCycles int
}

func newDiagState(now time.Time) diagState {
	return diagState{started: now, lastErr: make(map[string]failureDetail), backoff: 1}
}

func (d *diagState) cycleStarted(at time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.inCycle = true
	d.cycleStart = at
	d.nextCycleAt = time.Time{}
}

func (d *diagState) cycleDone(at time.Time, took time.Duration, blocked bool, backoff int, wait time.Duration) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.inCycle = false
	d.cycles++
	d.lastDone = at
	d.lastDuration = took
	d.lastBlocked = blocked
	if blocked {
		d.blockedCycles++
	}
	d.backoff = backoff
	d.nextCycleAt = at.Add(wait)
}

// truncateError renders err for diagnostics, cut to maxErrorLen.
func truncateError(err error) string {
	s := err.Error()
	if len(s) > maxErrorLen {
		return s[:maxErrorLen] + "…"
	}
	return s
}

// ItemFailure is an item whose last fetches failed, and how.
type ItemFailure struct {
	Item string `json:"item"` // "region/slug"
	// Consecutive is how many fetches in a row have failed.
	Consecutive int `json:"consecutive"`
	// Alerted is whether the failure notification has gone out.
	Alerted   bool      `json:"alerted"`
	LastError string    `json:"last_error"`
	LastAt    time.Time `json:"last_at"`
	// Result classifies the last error the way fetches_total does.
	Result string `json:"result"`
}

// Diagnostics is the poller's in-memory state: what the database and metrics
// don't hold, and what is lost at a restart.
type Diagnostics struct {
	// Started is when the process started; everything here is since then.
	Started time.Time `json:"started"`
	// Cycles is how many poll cycles have finished since Started.
	Cycles int `json:"cycles"`
	// InCycle is true while a cycle is running; CycleStarted is when the
	// running (or last) one began, so a cycle that has run for hours is a hung one.
	InCycle      bool       `json:"in_cycle"`
	CycleStarted *time.Time `json:"cycle_started"`
	// LastCycleDone and LastCycleSeconds describe the last finished cycle.
	LastCycleDone    *time.Time `json:"last_cycle_done"`
	LastCycleSeconds float64    `json:"last_cycle_seconds"`
	// LastCycleBlocked is whether it ended because the store was blocking or
	// rate limiting; BlockedCycles counts those since Started.
	LastCycleBlocked bool `json:"last_cycle_blocked"`
	BlockedCycles    int  `json:"blocked_cycles"`
	// BackoffFactor multiplies the poll interval (1 when not backing off).
	BackoffFactor int `json:"backoff_factor"`
	// NextCycle is when the next cycle is due; null while one is running.
	NextCycle *time.Time `json:"next_cycle"`
	// Failing are items with at least one failed fetch since their last success,
	// most failures first.
	Failing []ItemFailure `json:"failing"`
}

// Diagnostics returns a snapshot of the poller's in-memory state.
func (p *Poller) Diagnostics() Diagnostics {
	d := &p.diag
	d.mu.Lock()
	defer d.mu.Unlock()

	out := Diagnostics{
		Started:          d.started.UTC(),
		Cycles:           d.cycles,
		InCycle:          d.inCycle,
		LastCycleSeconds: d.lastDuration.Seconds(),
		LastCycleBlocked: d.lastBlocked,
		BlockedCycles:    d.blockedCycles,
		BackoffFactor:    d.backoff,
		Failing:          make([]ItemFailure, 0, len(p.failures)),
	}
	utc := func(t time.Time) *time.Time {
		if t.IsZero() {
			return nil
		}
		t = t.UTC()
		return &t
	}
	out.CycleStarted = utc(d.cycleStart)
	out.LastCycleDone = utc(d.lastDone)
	out.NextCycle = utc(d.nextCycleAt)

	for key, n := range p.failures {
		f := d.lastErr[key]
		out.Failing = append(out.Failing, ItemFailure{
			Item: key, Consecutive: n, Alerted: p.alerted[key],
			LastError: f.Error, LastAt: f.At, Result: f.Result,
		})
	}
	sort.Slice(out.Failing, func(i, j int) bool {
		a, b := out.Failing[i], out.Failing[j]
		if a.Consecutive != b.Consecutive {
			return a.Consecutive > b.Consecutive
		}
		return a.Item < b.Item
	})
	return out
}
