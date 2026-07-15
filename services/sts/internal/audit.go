// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Non-blocking audit event buffer with on-disk fallback for unflushed events.
//
// This STS-specific buffer is tightly integrated with STSMetrics atomics and the
// hot token-exchange path. Other services emit audit events through
// packages/core/go/audit.Client.

package internal

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog"

	"github.com/garudex-labs/caracal/packages/core/go/audit"
)

const (
	auditBufCap     = 10_000
	auditFlushN     = 1_000
	auditFlushTTL   = 50 * time.Millisecond
	auditStream     = "caracal.audit.events"
	auditReplayExt  = ".ndjson"
	auditReplayPerm = 0o600
	auditReplayDirP = 0o700
)

var errAuditEvidenceLost = errors.New("audit evidence lost")

// AuditBuffer decouples audit emission from the hot token-exchange path. Events that
// cannot reach Redis (sink error or shutdown with backlog) are persisted to disk and
// replayed on next startup so audit loss requires both Redis and disk failure.
type AuditBuffer struct {
	ch           chan AuditEvent
	redis        auditRedis
	log          zerolog.Logger
	dropped      atomic.Uint64
	auditHMACKey []byte
	replayDir    string
	metrics      *STSMetrics
	done         chan struct{}
}

type auditRedis interface {
	XAdd(context.Context, string, map[string]any) error
}

func newAuditBuffer(redis auditRedis, log zerolog.Logger, production bool, replayDir string, metrics *STSMetrics) (*AuditBuffer, error) {
	hexKey := os.Getenv("AUDIT_HMAC_KEY")
	var key []byte
	if hexKey == "" {
		if production {
			return nil, errors.New("AUDIT_HMAC_KEY is required in production")
		}
		log.Warn().Msg("AUDIT_HMAC_KEY not set; audit events will be unsigned")
	} else {
		k, err := hex.DecodeString(hexKey)
		if err != nil || len(k) < 32 {
			return nil, fmt.Errorf("AUDIT_HMAC_KEY must be hex-encoded with at least 32 bytes")
		}
		key = k
	}
	if replayDir == "" {
		return nil, errors.New("AUDIT_REPLAY_DIR is required")
	}
	if err := os.MkdirAll(replayDir, auditReplayDirP); err != nil {
		return nil, fmt.Errorf("audit replay dir: %w", err)
	}
	return &AuditBuffer{
		ch:           make(chan AuditEvent, auditBufCap),
		redis:        redis,
		log:          log,
		auditHMACKey: key,
		replayDir:    replayDir,
		metrics:      metrics,
	}, nil
}

// Emit enqueues an audit event and spills to replay storage when the buffer is full.
// A nil receiver is a no-op so unit tests that exercise the exchange path
// without a configured Redis sink do not need to wire one up.
func (a *AuditBuffer) Emit(event AuditEvent) {
	if a == nil {
		return
	}
	select {
	case a.ch <- event:
	default:
		a.log.Warn().Str("id", event.ID).Msg("audit buffer full; persisting event for replay")
		if err := a.persistBatch([]AuditEvent{event}); err != nil {
			a.recordLoss(1, err)
		}
	}
}

func (a *AuditBuffer) Dropped() uint64 {
	return a.dropped.Load()
}

func (a *AuditBuffer) Ready() error {
	if a == nil {
		return errors.New("audit buffer unavailable")
	}
	if a.Dropped() > 0 {
		return errAuditEvidenceLost
	}
	info, err := os.Stat(a.replayDir)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("audit replay path is not a directory")
	}
	f, err := os.CreateTemp(a.replayDir, ".ready-*")
	if err != nil {
		return err
	}
	name := f.Name()
	if err := f.Close(); err != nil {
		return err
	}
	return os.Remove(name)
}

func (a *AuditBuffer) RefreshReplayStats(now time.Time) {
	if a == nil || a.metrics == nil {
		return
	}
	stats := audit.ReplayStatsForDir(a.replayDir, now)
	a.metrics.AuditReplayFiles.Store(stats.Files)
	a.metrics.AuditReplayBytes.Store(stats.Bytes)
	a.metrics.AuditReplayOldestAge.Store(stats.OldestAgeSeconds)
}

func (a *AuditBuffer) sign(data []byte) string {
	if len(a.auditHMACKey) == 0 {
		return ""
	}
	mac := hmac.New(sha256.New, a.auditHMACKey)
	mac.Write(data)
	return hex.EncodeToString(mac.Sum(nil))
}

// OutboxFrame serialises and signs one event as the {id, data, sig} frame the
// transactional outbox carries, so an event enqueued inside a database transaction
// reaches the audit stream byte-identical to one emitted through the buffer.
func (a *AuditBuffer) OutboxFrame(ev AuditEvent) (OutboxAuditEvent, error) {
	data, err := json.Marshal(ev)
	if err != nil {
		return OutboxAuditEvent{}, err
	}
	frame := OutboxAuditEvent{ID: ev.ID, Data: string(data)}
	if a != nil {
		frame.Sig = a.sign(data)
	}
	return frame, nil
}

// xaddEvent serialises one event and pushes it to the audit stream.
func (a *AuditBuffer) xaddEvent(ctx context.Context, ev AuditEvent) error {
	data, err := json.Marshal(ev)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	values := map[string]any{
		"id":   ev.ID,
		"data": string(data),
	}
	if sig := a.sign(data); sig != "" {
		values["sig"] = sig
	}
	return a.redis.XAdd(ctx, auditStream, values)
}

// recordLoss escalates definitive audit loss: both the stream and the disk fallback
// failed, so the events are unrecoverable and the loss must be visible in logs and metrics.
func (a *AuditBuffer) recordLoss(count uint64, err error) {
	a.dropped.Add(count)
	if a.metrics != nil {
		a.metrics.AuditDropped.Add(count)
	}
	a.log.Error().Err(err).Uint64("count", count).Msg("audit events lost: stream and disk persistence both failed")
}

// persistBatch appends events to a per-process ndjson file so a later startup can
// replay them. Called on Redis push failure and on shutdown with a non-empty batch.
// Returns an error when the batch could not be durably persisted.
func (a *AuditBuffer) persistBatch(batch []AuditEvent) error {
	if len(batch) == 0 {
		return nil
	}
	lines := make([][]byte, len(batch))
	for i, ev := range batch {
		data, err := json.Marshal(ev)
		if err != nil {
			return fmt.Errorf("marshal audit event %q: %w", ev.ID, err)
		}
		lines[i] = append(data, '\n')
	}
	name := fmt.Sprintf("pending-%d-%d%s", os.Getpid(), time.Now().UnixNano(), auditReplayExt)
	path := filepath.Join(a.replayDir, name)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, auditReplayPerm)
	if err != nil {
		a.log.Error().Err(err).Str("path", path).Msg("audit replay file open")
		return err
	}
	closed := false
	defer func() {
		if !closed {
			if err := f.Close(); err != nil {
				a.log.Error().Err(err).Str("path", path).Msg("audit replay file close")
			}
		}
	}()
	w := bufio.NewWriter(f)
	for _, line := range lines {
		if _, err := w.Write(line); err != nil {
			a.log.Error().Err(err).Msg("audit replay file write")
			return err
		}
	}
	if err := w.Flush(); err != nil {
		a.log.Error().Err(err).Msg("audit replay file flush")
		return err
	}
	if err := f.Sync(); err != nil {
		a.log.Error().Err(err).Str("path", path).Msg("audit replay file sync")
		return err
	}
	if err := f.Close(); err != nil {
		closed = true
		a.log.Error().Err(err).Str("path", path).Msg("audit replay file close")
		return err
	}
	closed = true
	if err := syncReplayDir(a.replayDir); err != nil {
		a.log.Error().Err(err).Str("dir", a.replayDir).Msg("audit replay dir sync")
		return err
	}
	if a.metrics != nil {
		a.metrics.AuditReplayPending.Add(uint64(len(batch)))
	}
	a.log.Warn().Str("path", path).Int("count", len(batch)).Msg("audit batch persisted to disk for later replay")
	return nil
}

// replayPending streams persisted audit events to Redis for recovery. Files persist
// until fully consumed; XAdd failures leave files intact for retry.
func (a *AuditBuffer) replayPending(ctx context.Context) {
	entries, err := os.ReadDir(a.replayDir)
	if err != nil {
		a.log.Error().Err(err).Str("dir", a.replayDir).Msg("audit replay dir scan")
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != auditReplayExt {
			continue
		}
		path := filepath.Join(a.replayDir, entry.Name())
		if err := a.replayFile(ctx, path); err != nil {
			a.log.Error().Err(err).Str("path", path).Msg("audit replay file failed; will retry on next start")
			continue
		}
		if err := os.Remove(path); err != nil {
			a.log.Error().Err(err).Str("path", path).Msg("audit replay file remove")
		}
	}
}

func (a *AuditBuffer) replayFile(ctx context.Context, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	var replayed uint64
	for scanner.Scan() {
		var ev AuditEvent
		if err := json.Unmarshal(scanner.Bytes(), &ev); err != nil {
			a.log.Error().Err(err).Str("path", path).Msg("audit replay parse")
			continue
		}
		if err := a.xaddEvent(ctx, ev); err != nil {
			return err
		}
		replayed++
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if a.metrics != nil {
		a.metrics.AuditReplayReplayed.Add(replayed)
		if replayed > 0 {
			cur := a.metrics.AuditReplayPending.Load()
			if replayed > cur {
				replayed = cur
			}
			a.metrics.AuditReplayPending.Add(^uint64(replayed - 1))
		}
	}
	a.log.Info().Str("path", path).Uint64("count", replayed).Msg("audit replay file drained")
	return nil
}

// start launches the background flusher goroutine. The caller must invoke
// replayPending separately before start so pending events drain before live writes.
func (a *AuditBuffer) start(ctx context.Context) {
	a.done = make(chan struct{})
	go func() {
		defer close(a.done)
		ticker := time.NewTicker(auditFlushTTL)
		defer ticker.Stop()
		batch := make([]AuditEvent, 0, auditFlushN)

		flush := func() {
			failed := batch[:0:0]
			for _, ev := range batch {
				if err := a.xaddEvent(ctx, ev); err != nil {
					a.log.Error().Err(err).Str("id", ev.ID).Msg("xadd audit event")
					if a.metrics != nil {
						a.metrics.AuditSinkErrors.Add(1)
					}
					failed = append(failed, ev)
				}
			}
			if len(failed) > 0 {
				if err := a.persistBatch(failed); err != nil {
					a.recordLoss(uint64(len(failed)), err)
				}
			}
			batch = batch[:0]
		}

		for {
			select {
			case ev := <-a.ch:
				batch = append(batch, ev)
				if len(batch) >= auditFlushN {
					flush()
				}
			case <-ticker.C:
				if len(batch) > 0 {
					flush()
				}
			case <-ctx.Done():
				for drained := false; !drained; {
					select {
					case ev := <-a.ch:
						batch = append(batch, ev)
					default:
						drained = true
					}
				}
				if err := a.persistBatch(batch); err != nil {
					a.recordLoss(uint64(len(batch)), err)
				}
				return
			}
		}
	}()
}

func (a *AuditBuffer) Close(ctx context.Context) error {
	if a == nil || a.done == nil {
		return nil
	}
	select {
	case <-a.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func syncReplayDir(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
