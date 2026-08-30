// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"net"
	"strings"
	"sync"
	"time"
)

// maxTries bounds transient-failure retries per report.
const maxTries = 4

// IsTransient reports whether an error looks like a recoverable dependency
// outage worth a bounded retry; anything else is permanent for this
// attempt and must surface as a visible failure.
func IsTransient(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}
	message := strings.ToLower(err.Error())
	for _, marker := range []string{
		"connection refused", "connection reset", "broken pipe",
		"unreachable", "timeout", "timed out", "too many connections",
		"conn busy", "conn closed", "failed to connect",
	} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

// backoffSeconds is exponential with full jitter: ~30s, ~60s, ~120s,
// capped at ten minutes.
func backoffSeconds(try int) time.Duration {
	base := 30.0 * float64(int(1)<<max(try-1, 0))
	if base > 600 {
		base = 600
	}
	seconds := base * (0.5 + rand.Float64()/2)
	return time.Duration(seconds * float64(time.Second))
}

// JobStore is the persistence surface the runner drives.
type JobStore interface {
	ReapStale(ctx context.Context) (int, error)
	ClaimPending(ctx context.Context) (*job, error)
	Fail(ctx context.Context, reportID, message string) error
}

// Runner drains pending insight reports with bounded concurrency. The
// database is the queue: pending rows survive restarts, running rows
// stranded by a crash are reaped on the next claim cycle.
type Runner struct {
	Jobs JobStore
	// Run generates one claimed report.
	Run func(ctx context.Context, j *job) error
	// Workers bounds concurrent generations; zero means one.
	Workers int
	// Backoff is the transient-retry wait; nil uses the jittered default.
	Backoff func(try int) time.Duration

	nudge chan struct{}
	once  sync.Once
}

func (r *Runner) init() {
	r.once.Do(func() {
		r.nudge = make(chan struct{}, 1)
	})
}

// Nudge wakes the workers; safe from any goroutine, never blocks.
func (r *Runner) Nudge() {
	r.init()
	select {
	case r.nudge <- struct{}{}:
	default:
	}
}

// Start launches the workers tied to ctx and returns immediately. A poll
// interval backstops lost nudges and picks up rows queued by other
// replicas.
func (r *Runner) Start(ctx context.Context) {
	r.init()
	workers := r.Workers
	if workers < 1 {
		workers = 1
	}
	for i := 0; i < workers; i++ {
		go r.work(ctx)
	}
	r.Nudge()
	slog.Info("insight report runner started", "workers", workers)
}

func (r *Runner) work(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		r.drain(ctx)
		select {
		case <-ctx.Done():
			return
		case <-r.nudge:
		case <-ticker.C:
		}
	}
}

// drain claims and runs pending reports until none remain.
func (r *Runner) drain(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		if reaped, err := r.Jobs.ReapStale(ctx); err != nil {
			slog.Warn("stale report reap failed", "error", err)
		} else if reaped > 0 {
			slog.Warn("stale running reports failed", "count", reaped)
		}
		j, err := r.Jobs.ClaimPending(ctx)
		if err != nil {
			slog.Warn("report claim failed", "error", err)
			return
		}
		if j == nil {
			return
		}
		r.runWithRetries(ctx, j)
	}
}

// runWithRetries drives one claimed report to completed or failed: the
// pipeline error decides between a jittered retry (transient) and an
// immediate failure record (permanent).
func (r *Runner) runWithRetries(ctx context.Context, j *job) {
	backoff := r.Backoff
	if backoff == nil {
		backoff = backoffSeconds
	}
	for try := 1; ; try++ {
		err := r.Run(ctx, j)
		if err == nil {
			return
		}
		if !IsTransient(err) {
			slog.Error("insight report failed", "report_id", j.ReportID, "try", try, "error", err)
			if failErr := r.Jobs.Fail(ctx, j.ReportID, err.Error()); failErr != nil {
				slog.Error("failure record write failed", "report_id", j.ReportID, "error", failErr)
			}
			return
		}
		if try >= maxTries {
			slog.Error("insight report exhausted retries", "report_id", j.ReportID, "tries", try, "error", err)
			if failErr := r.Jobs.Fail(ctx, j.ReportID, err.Error()); failErr != nil {
				slog.Error("failure record write failed", "report_id", j.ReportID, "error", failErr)
			}
			return
		}
		wait := backoff(try)
		slog.Warn("insight report hit a transient failure",
			"report_id", j.ReportID, "try", try, "retry_in", wait, "error", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

// Service bundles the engine, store, and runner behind the surface the
// HTTP handlers need.
type Service struct {
	Engine *Engine
	Store  *Store
	Runner *Runner
}

// NewService wires the generation pipeline onto the runner.
func NewService(engine *Engine, store *Store, workers int) *Service {
	s := &Service{Engine: engine, Store: store}
	s.Runner = &Runner{
		Jobs:    store,
		Workers: workers,
		Run: func(ctx context.Context, j *job) error {
			return s.generate(ctx, j)
		},
	}
	return s
}

// Enqueue wakes the runner after a report row was inserted.
func (s *Service) Enqueue() {
	s.Runner.Nudge()
}

// Start launches the runner tied to the server lifecycle.
func (s *Service) Start(ctx context.Context) {
	s.Runner.Start(ctx)
}

// generate produces one claimed report end to end.
func (s *Service) generate(ctx context.Context, j *job) error {
	agentName := s.Store.AgentName(ctx, j.AgentID)
	agentConfig, err := s.Store.LoadAgentConfig(ctx, j.AgentID)
	if err != nil {
		return err
	}
	previousMetrics := s.Store.PreviousMetrics(ctx, j.PreviousReportID)
	scope := agentScope(s.Store.AgentCreator(ctx, j.AgentID), agentConfig)

	content := s.Engine.GenerateReportContent(ctx, &pipelineInput{
		AgentName:              agentName,
		AgentID:                j.AgentID,
		AgentVersion:           j.AgentVersion,
		ComparisonAgentVersion: j.ComparisonAgentVersion,
		PeriodStart:            j.PeriodStart.UTC().Format("2006-01-02 15:04:05"),
		PeriodEnd:              j.PeriodEnd.UTC().Format("2006-01-02 15:04:05"),
		PreviousMetrics:        previousMetrics,
		AgentConfig:            agentConfig,
		Scope:                  scope,
		Progress: func(phase string, current, total int, message string) {
			s.Store.UpdateProgress(ctx, j.ReportID, phase, current, total, message)
		},
	})

	s.Store.UpdateProgress(ctx, j.ReportID, "saving", 9, 9, "Saving report")
	if err := s.Store.Complete(ctx, j, agentName, content); err != nil {
		return err
	}
	slog.Info("insight report completed",
		"report_id", j.ReportID, "sessions", content.SessionsAnalyzed,
		"has_narrative", content.Narrative != nil)
	return nil
}
