// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Non-blocking audit event buffer with on-disk fallback for unflushed events.

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

// AuditBuffer decouples audit emission from the hot token-exchange path. Events that
// cannot reach Redis (sink error or shutdown with backlog) are persisted to disk and
// replayed on next startup so audit loss requires both Redis and disk failure.
type AuditBuffer struct {
	ch        chan AuditEvent
	redis     *RedisClient
	log       zerolog.Logger
	dropped   atomic.Uint64
	hmacKey   []byte
	replayDir string
	metrics   *STSMetrics
}

func newAuditBuffer(redis *RedisClient, log zerolog.Logger, production bool, replayDir string, metrics *STSMetrics) (*AuditBuffer, error) {
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
		ch:        make(chan AuditEvent, auditBufCap),
		redis:     redis,
		log:       log,
		hmacKey:   key,
		replayDir: replayDir,
		metrics:   metrics,
	}, nil
}

// Emit enqueues an audit event and records pressure when the buffer is full.
// A nil receiver is a no-op so unit tests that exercise the exchange path
// without a configured Redis sink do not need to wire one up.
func (a *AuditBuffer) Emit(event AuditEvent) {
	if a == nil {
		return
	}
	select {
	case a.ch <- event:
	default:
		dropped := a.dropped.Add(1)
		if a.metrics != nil {
			a.metrics.AuditDropped.Add(1)
		}
		if dropped == 1 || dropped%1000 == 0 {
			a.log.Warn().Uint64("dropped", dropped).Msg("audit buffer full")
		}
	}
}

func (a *AuditBuffer) Dropped() uint64 {
	return a.dropped.Load()
}

func (a *AuditBuffer) sign(data []byte) string {
	if len(a.hmacKey) == 0 {
		return ""
	}
	mac := hmac.New(sha256.New, a.hmacKey)
	mac.Write(data)
	return hex.EncodeToString(mac.Sum(nil))
}

// xaddEvent serialises one event and pushes it to the audit stream.
func (a *AuditBuffer) xaddEvent(ctx context.Context, ev AuditEvent) error {
	data, err := json.Marshal(ev)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	values := map[string]interface{}{
		"id":   ev.ID,
		"data": string(data),
	}
	if sig := a.sign(data); sig != "" {
		values["sig"] = sig
	}
	return a.redis.XAdd(ctx, auditStream, values)
}

// persistBatch appends events to a per-process ndjson file so a later startup can
// replay them. Called on Redis push failure and on shutdown with a non-empty batch.
func (a *AuditBuffer) persistBatch(batch []AuditEvent) {
	if len(batch) == 0 {
		return
	}
	name := fmt.Sprintf("pending-%d-%d%s", os.Getpid(), time.Now().UnixNano(), auditReplayExt)
	path := filepath.Join(a.replayDir, name)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, auditReplayPerm)
	if err != nil {
		a.log.Error().Err(err).Str("path", path).Msg("audit replay file open")
		return
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	for _, ev := range batch {
		data, err := json.Marshal(ev)
		if err != nil {
			a.log.Error().Err(err).Str("id", ev.ID).Msg("marshal audit event")
			continue
		}
		if _, err := w.Write(append(data, '\n')); err != nil {
			a.log.Error().Err(err).Msg("audit replay file write")
			return
		}
	}
	if err := w.Flush(); err != nil {
		a.log.Error().Err(err).Msg("audit replay file flush")
		return
	}
	if a.metrics != nil {
		a.metrics.AuditReplayPending.Add(uint64(len(batch)))
	}
	a.log.Warn().Str("path", path).Int("count", len(batch)).Msg("audit batch persisted to disk for later replay")
}

// replayPending streams every previously-persisted file to Redis. A file is deleted
// only after every event in it has been XAdded successfully; partial successes leave
// the file in place for a future retry, which is safe because each event carries a
// unique ID and the consumer side dedupes by it.
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
// replayPending separately before start so that pending events are drained before
// new ones are written.
func (a *AuditBuffer) start(ctx context.Context) {
	go func() {
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
				a.persistBatch(failed)
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
				a.persistBatch(batch)
				return
			}
		}
	}()
}
