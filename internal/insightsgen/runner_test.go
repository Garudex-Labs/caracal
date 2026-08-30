// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

func TestIsTransient(t *testing.T) {
	transient := []error{
		context.DeadlineExceeded,
		&net.DNSError{IsTimeout: true},
		errors.New("dial tcp: connection refused"),
		errors.New("read: connection reset by peer"),
		errors.New("pool timed out waiting"),
		errors.New("conn busy"),
	}
	for _, err := range transient {
		if !IsTransient(err) {
			t.Errorf("%v must be transient", err)
		}
	}
	permanent := []error{nil, errors.New("syntax error at or near"), errors.New("model rejected the prompt")}
	for _, err := range permanent {
		if IsTransient(err) {
			t.Errorf("%v must be permanent", err)
		}
	}
}

func TestBackoffSecondsBounds(t *testing.T) {
	for try := 1; try <= 8; try++ {
		base := 30.0 * float64(int(1)<<max(try-1, 0))
		if base > 600 {
			base = 600
		}
		for i := 0; i < 5; i++ {
			d := backoffSeconds(try).Seconds()
			if d < base*0.5 || d > base {
				t.Errorf("try %d: backoff %.1fs outside [%.1f, %.1f]", try, d, base*0.5, base)
			}
		}
	}
}

// fakeJobs is a scripted JobStore.
type fakeJobs struct {
	mu       sync.Mutex
	reapErr  error
	reaped   int
	queue    []*job
	claimErr error
	fails    []string
}

func (f *fakeJobs) ReapStale(context.Context) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reaped, f.reapErr
}

func (f *fakeJobs) ClaimPending(context.Context) (*job, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.claimErr != nil {
		return nil, f.claimErr
	}
	if len(f.queue) == 0 {
		return nil, nil
	}
	j := f.queue[0]
	f.queue = f.queue[1:]
	return j, nil
}

func (f *fakeJobs) Fail(_ context.Context, reportID, message string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fails = append(f.fails, reportID+": "+message)
	return nil
}

func (f *fakeJobs) failCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.fails)
}

func TestRunWithRetriesPermanentFailureRecordsOnce(t *testing.T) {
	jobs := &fakeJobs{}
	runs := 0
	r := &Runner{Jobs: jobs, Run: func(context.Context, *job) error {
		runs++
		return errors.New("permanent breakage")
	}}
	r.runWithRetries(context.Background(), &job{ReportID: "r1"})
	if runs != 1 || jobs.failCount() != 1 {
		t.Errorf("runs = %d, fails = %d", runs, jobs.failCount())
	}
	if !strings.Contains(jobs.fails[0], "permanent breakage") {
		t.Errorf("failure message: %v", jobs.fails)
	}
}

func TestRunWithRetriesTransientThenSuccess(t *testing.T) {
	jobs := &fakeJobs{}
	runs := 0
	r := &Runner{
		Jobs:    jobs,
		Backoff: func(int) time.Duration { return 0 },
		Run: func(context.Context, *job) error {
			runs++
			if runs == 1 {
				return errors.New("connection refused")
			}
			return nil
		},
	}
	r.runWithRetries(context.Background(), &job{ReportID: "r1"})
	if runs != 2 || jobs.failCount() != 0 {
		t.Errorf("runs = %d, fails = %d", runs, jobs.failCount())
	}
}

func TestRunWithRetriesExhaustsTries(t *testing.T) {
	jobs := &fakeJobs{}
	runs := 0
	r := &Runner{
		Jobs:    jobs,
		Backoff: func(int) time.Duration { return 0 },
		Run: func(context.Context, *job) error {
			runs++
			return errors.New("timeout waiting for backend")
		},
	}
	r.runWithRetries(context.Background(), &job{ReportID: "r1"})
	if runs != maxTries || jobs.failCount() != 1 {
		t.Errorf("runs = %d (want %d), fails = %d", runs, maxTries, jobs.failCount())
	}
}

func TestRunWithRetriesStopsOnCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	jobs := &fakeJobs{}
	r := &Runner{
		Jobs:    jobs,
		Backoff: func(int) time.Duration { return time.Hour },
		Run: func(context.Context, *job) error {
			cancel()
			return errors.New("connection refused")
		},
	}
	done := make(chan struct{})
	go func() {
		r.runWithRetries(ctx, &job{ReportID: "r1"})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("runWithRetries did not stop on canceled context")
	}
	if jobs.failCount() != 0 {
		t.Errorf("canceled retry must not record a failure: %v", jobs.fails)
	}
}

func TestDrainRunsUntilQueueEmpty(t *testing.T) {
	jobs := &fakeJobs{
		reapErr: errors.New("reap unavailable"),
		queue:   []*job{{ReportID: "r1"}, {ReportID: "r2"}},
	}
	ran := []string{}
	r := &Runner{Jobs: jobs, Run: func(_ context.Context, j *job) error {
		ran = append(ran, j.ReportID)
		return nil
	}}
	r.drain(context.Background())
	if len(ran) != 2 || ran[0] != "r1" || ran[1] != "r2" {
		t.Errorf("ran = %v", ran)
	}
}

func TestDrainStopsOnClaimError(t *testing.T) {
	jobs := &fakeJobs{claimErr: errors.New("db down"), reaped: 2}
	runs := 0
	r := &Runner{Jobs: jobs, Run: func(context.Context, *job) error { runs++; return nil }}
	r.drain(context.Background())
	if runs != 0 {
		t.Errorf("claim failure must not run jobs: %d", runs)
	}
}

func TestDrainRespectsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	jobs := &fakeJobs{queue: []*job{{ReportID: "r1"}}}
	runs := 0
	r := &Runner{Jobs: jobs, Run: func(context.Context, *job) error { runs++; return nil }}
	r.drain(ctx)
	if runs != 0 {
		t.Errorf("canceled drain must not claim: %d", runs)
	}
}

func TestNudgeNeverBlocks(t *testing.T) {
	r := &Runner{}
	r.Nudge()
	r.Nudge()
	r.Nudge()
}

func TestRunnerStartExitsWithContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := &Runner{Jobs: &fakeJobs{}, Workers: 2, Run: func(context.Context, *job) error { return nil }}
	r.Start(ctx)
}

// emptyPipelineService wires a Service whose engine sees no sessions.
func emptyPipelineService(db *fakeDB) *Service {
	ch := &fakeCH{fn: func(int, string, clickhouse.Settings) ([]map[string]any, error) {
		return nil, errors.New("analytics store empty")
	}}
	engine := &Engine{
		DB:     db,
		CH:     ch,
		Config: &Config{Settings: fakeSettings{}},
		LLM:    &recordingCompleter{},
	}
	return NewService(engine, &Store{DB: db}, 1)
}

func TestServiceGenerateEmptyPeriod(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "SELECT name FROM agents", rows: &fakeRows{rows: [][]any{{"Review Bot"}}}},
		{match: "SELECT created_by::text FROM agents", rows: &fakeRows{rows: [][]any{{testOwnerID}}}},
	}}
	s := emptyPipelineService(db)
	j := &job{
		ReportID:    testReportID,
		AgentID:     testAgentID,
		PeriodStart: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC),
		PeriodEnd:   time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC),
	}
	if err := s.generate(context.Background(), j); err != nil {
		t.Fatal(err)
	}
	if got := db.sqlCalls("status = 'completed'"); len(got) != 1 {
		t.Errorf("completion updates = %d", len(got))
	}
	// The empty report still records progress.
	if got := db.sqlCalls("progress_phase = $2"); len(got) == 0 {
		t.Error("no progress updates recorded")
	}
}

func TestServiceEnqueueAndStart(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s := emptyPipelineService(&fakeDB{})
	s.Enqueue()
	s.Start(ctx)
}
