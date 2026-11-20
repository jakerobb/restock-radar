package poller

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jakerobb/restock-radar/internal/unistore"
)

func TestDiagnosticsFailingItems(t *testing.T) {
	p, f, _ := setup(t)
	ctx := context.Background()

	if d := p.Diagnostics(); len(d.Failing) != 0 || d.Failing == nil {
		t.Fatalf("fresh poller: want an empty, non-nil list, got %#v", d.Failing)
	}

	f.err = unistore.ErrSchema
	p.cycle(ctx)
	p.cycle(ctx)
	p.cycle(ctx)
	d := p.Diagnostics()
	if len(d.Failing) != 1 {
		t.Fatalf("want one failing item, got %+v", d.Failing)
	}
	got := d.Failing[0]
	if got.Item != "us/widget" || got.Consecutive != 3 || !got.Alerted || got.Result != "schema" ||
		got.LastError == "" || got.LastAt.IsZero() {
		t.Errorf("unexpected failure detail: %+v", got)
	}

	f.err = nil
	p.cycle(ctx)
	if d := p.Diagnostics(); len(d.Failing) != 0 {
		t.Errorf("a success should clear the failure, got %+v", d.Failing)
	}
}

func TestDiagnosticsLongErrorIsCut(t *testing.T) {
	p, f, _ := setup(t)
	f.err = errors.New(strings.Repeat("x", 5000))
	p.cycle(context.Background())
	got := p.Diagnostics().Failing[0].LastError
	if len(got) > maxErrorLen+len("…") {
		t.Errorf("error not cut: %d bytes", len(got))
	}
}

func TestDiagnosticsWorstFirst(t *testing.T) {
	p, _, _ := setup(t)
	p.diag.mu.Lock()
	p.failures["us/a"], p.failures["us/b"], p.failures["us/c"] = 1, 5, 5
	p.diag.mu.Unlock()
	d := p.Diagnostics()
	order := d.Failing[0].Item + d.Failing[1].Item + d.Failing[2].Item
	if order != "us/bus/cus/a" {
		t.Errorf("want most failures first, ties by name; got %s", order)
	}
}

func TestDiagnosticsCycleTracking(t *testing.T) {
	p, f, _ := setup(t)
	f.err = &unistore.HTTPError{Status: 429}
	p.cfg.PollInterval = time.Hour

	if d := p.Diagnostics(); d.Cycles != 0 || d.CycleStarted != nil || d.NextCycle != nil || d.BackoffFactor != 1 {
		t.Fatalf("before the first cycle: %+v", d)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()
	deadline := time.Now().Add(5 * time.Second)
	for p.Diagnostics().Cycles == 0 {
		if time.Now().After(deadline) {
			t.Fatal("no cycle finished")
		}
		time.Sleep(5 * time.Millisecond)
	}
	d := p.Diagnostics()
	cancel()
	<-done

	if d.InCycle || d.CycleStarted == nil || d.LastCycleDone == nil || d.NextCycle == nil {
		t.Errorf("after a cycle: %+v", d)
	}
	if !d.LastCycleBlocked || d.BlockedCycles != 1 || d.BackoffFactor != 2 {
		t.Errorf("a blocked cycle should show and double the backoff: %+v", d)
	}
	if !d.NextCycle.After(*d.LastCycleDone) {
		t.Errorf("next cycle %v should follow the last %v", d.NextCycle, d.LastCycleDone)
	}
}
