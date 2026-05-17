// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Reusable audit emit client with HMAC signing, bounded buffering, and disk-spill fallback.

package audit

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
	DefaultStream     = "caracal.audit.events"
	defaultBufferCap  = 10_000
	defaultFlushBatch = 1_000
	defaultFlushTTL   = 50 * time.Millisecond
	replayFileExt     = ".ndjson"
	replayFilePerm    = 0o600
	replayDirPerm     = 0o700
)

// Streamer is the minimal Redis-stream interface the client needs. Any concrete
// Redis wrapper that exposes XAdd can satisfy it; this keeps the client free of
// a hard dependency on a particular client library.
type Streamer interface {
	XAdd(ctx context.Context, stream string, values map[string]any) error
}

// MetricsHook reports observable buffer state. All callbacks are optional and
// may be nil; nil values disable that signal.
type MetricsHook struct {
	OnDropped         func(total uint64)
	OnSinkError       func()
	OnReplayPersisted func(n uint64)
	OnReplayDrained   func(n uint64)
}

// ClientConfig configures a reusable audit Client.
type ClientConfig struct {
	Stream       string
	AuditHMACKey []byte
	ReplayDir    string
	BufferCap    int
	FlushBatch   int
	FlushTTL     time.Duration
	Logger       zerolog.Logger
	Metrics      MetricsHook
	Production   bool
}

// Client buffers audit events, signs and emits them to a Redis stream, and
// persists unflushed batches to disk so events survive process restarts.
type Client struct {
	cfg        ClientConfig
	stream     Streamer
	ch         chan Event
	dropped    atomic.Uint64
	emitted    atomic.Uint64
	persisted  atomic.Uint64
	drained    atomic.Uint64
	sinkErrors atomic.Uint64
}

// Metrics captures a stable snapshot of audit client counters.
type Metrics struct {
	Emitted    uint64 `json:"emitted"`
	Dropped    uint64 `json:"dropped"`
	Persisted  uint64 `json:"persisted"`
	Drained    uint64 `json:"drained"`
	SinkErrors uint64 `json:"sink_errors"`
	QueueDepth uint64 `json:"queue_depth"`
	QueueCap   uint64 `json:"queue_cap"`
}

// Snapshot returns a stable view of all observability counters.
func (c *Client) Snapshot() Metrics {
	if c == nil {
		return Metrics{}
	}
	return Metrics{
		Emitted:    c.emitted.Load(),
		Dropped:    c.dropped.Load(),
		Persisted:  c.persisted.Load(),
		Drained:    c.drained.Load(),
		SinkErrors: c.sinkErrors.Load(),
		QueueDepth: uint64(len(c.ch)),
		QueueCap:   uint64(cap(c.ch)),
	}
}

// NewClient validates configuration and prepares the on-disk replay directory.
func NewClient(s Streamer, cfg ClientConfig) (*Client, error) {
	if s == nil {
		return nil, errors.New("audit: streamer is required")
	}
	if cfg.ReplayDir == "" {
		return nil, errors.New("audit: ReplayDir is required")
	}
	if cfg.Production && len(cfg.AuditHMACKey) == 0 {
		return nil, errors.New("audit: AuditHMACKey is required in production")
	}
	if len(cfg.AuditHMACKey) > 0 && len(cfg.AuditHMACKey) < 32 {
		return nil, errors.New("audit: AuditHMACKey must be at least 32 bytes")
	}
	if cfg.Stream == "" {
		cfg.Stream = DefaultStream
	}
	if cfg.BufferCap <= 0 {
		cfg.BufferCap = defaultBufferCap
	}
	if cfg.FlushBatch <= 0 {
		cfg.FlushBatch = defaultFlushBatch
	}
	if cfg.FlushTTL <= 0 {
		cfg.FlushTTL = defaultFlushTTL
	}
	if err := os.MkdirAll(cfg.ReplayDir, replayDirPerm); err != nil {
		return nil, fmt.Errorf("audit: replay dir: %w", err)
	}
	return &Client{
		cfg:    cfg,
		stream: s,
		ch:     make(chan Event, cfg.BufferCap),
	}, nil
}

// Emit enqueues an event. Returns immediately; on overflow the event is dropped
// and counted. A nil receiver is a no-op so callers without configured audit
// (e.g. unit tests) need not branch.
func (c *Client) Emit(ev Event) {
	if c == nil {
		return
	}
	select {
	case c.ch <- ev:
		c.emitted.Add(1)
	default:
		dropped := c.dropped.Add(1)
		if c.cfg.Metrics.OnDropped != nil {
			c.cfg.Metrics.OnDropped(dropped)
		}
		if dropped == 1 || dropped%1000 == 0 {
			c.cfg.Logger.Warn().Uint64("dropped", dropped).Msg("audit buffer full")
		}
	}
}

// Dropped returns the cumulative number of dropped events.
func (c *Client) Dropped() uint64 {
	if c == nil {
		return 0
	}
	return c.dropped.Load()
}

// Ready verifies the replay directory is writable.
func (c *Client) Ready() error {
	if c == nil {
		return errors.New("audit: client unavailable")
	}
	info, err := os.Stat(c.cfg.ReplayDir)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("audit: replay path is not a directory")
	}
	f, err := os.CreateTemp(c.cfg.ReplayDir, ".ready-*")
	if err != nil {
		return err
	}
	name := f.Name()
	if err := f.Close(); err != nil {
		return err
	}
	return os.Remove(name)
}

// Start launches the background flush loop. Caller must invoke ReplayPending
// before Start so persisted events drain ahead of live traffic.
func (c *Client) Start(ctx context.Context) {
	go c.run(ctx)
}

// ReplayPending streams persisted batches back to the stream. Files are removed
// only after a successful XAdd of every line; partial-failure files are left
// for retry on the next start.
func (c *Client) ReplayPending(ctx context.Context) {
	entries, err := os.ReadDir(c.cfg.ReplayDir)
	if err != nil {
		c.cfg.Logger.Error().Err(err).Str("dir", c.cfg.ReplayDir).Msg("audit replay dir scan")
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != replayFileExt {
			continue
		}
		path := filepath.Join(c.cfg.ReplayDir, entry.Name())
		if err := c.replayFile(ctx, path); err != nil {
			c.cfg.Logger.Error().Err(err).Str("path", path).Msg("audit replay file failed; will retry on next start")
			continue
		}
		if err := os.Remove(path); err != nil {
			c.cfg.Logger.Error().Err(err).Str("path", path).Msg("audit replay file remove")
		}
	}
}

func (c *Client) sign(data []byte) string {
	if len(c.cfg.AuditHMACKey) == 0 {
		return ""
	}
	mac := hmac.New(sha256.New, c.cfg.AuditHMACKey)
	mac.Write(data)
	return hex.EncodeToString(mac.Sum(nil))
}

func (c *Client) xadd(ctx context.Context, ev Event) error {
	data, err := json.Marshal(ev)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	values := map[string]any{
		"id":   ev.ID,
		"data": string(data),
	}
	if sig := c.sign(data); sig != "" {
		values["sig"] = sig
	}
	return c.stream.XAdd(ctx, c.cfg.Stream, values)
}

func (c *Client) persistBatch(batch []Event) {
	if len(batch) == 0 {
		return
	}
	name := fmt.Sprintf("pending-%d-%d%s", os.Getpid(), time.Now().UnixNano(), replayFileExt)
	path := filepath.Join(c.cfg.ReplayDir, name)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, replayFilePerm)
	if err != nil {
		c.cfg.Logger.Error().Err(err).Str("path", path).Msg("audit replay file open")
		return
	}
	closed := false
	defer func() {
		if !closed {
			if err := f.Close(); err != nil {
				c.cfg.Logger.Error().Err(err).Str("path", path).Msg("audit replay file close")
			}
		}
	}()
	w := bufio.NewWriter(f)
	for _, ev := range batch {
		data, err := json.Marshal(ev)
		if err != nil {
			c.cfg.Logger.Error().Err(err).Str("id", ev.ID).Msg("marshal audit event")
			continue
		}
		if _, err := w.Write(append(data, '\n')); err != nil {
			c.cfg.Logger.Error().Err(err).Msg("audit replay file write")
			return
		}
	}
	if err := w.Flush(); err != nil {
		c.cfg.Logger.Error().Err(err).Msg("audit replay file flush")
		return
	}
	if err := f.Close(); err != nil {
		closed = true
		c.cfg.Logger.Error().Err(err).Str("path", path).Msg("audit replay file close")
		return
	}
	closed = true
	if c.cfg.Metrics.OnReplayPersisted != nil {
		c.cfg.Metrics.OnReplayPersisted(uint64(len(batch)))
	}
	c.persisted.Add(uint64(len(batch)))
	c.cfg.Logger.Warn().Str("path", path).Int("count", len(batch)).Msg("audit batch persisted to disk for later replay")
}

func (c *Client) replayFile(ctx context.Context, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	var replayed uint64
	for scanner.Scan() {
		var ev Event
		if err := json.Unmarshal(scanner.Bytes(), &ev); err != nil {
			c.cfg.Logger.Error().Err(err).Str("path", path).Msg("audit replay parse")
			continue
		}
		if err := c.xadd(ctx, ev); err != nil {
			return err
		}
		replayed++
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if c.cfg.Metrics.OnReplayDrained != nil && replayed > 0 {
		c.cfg.Metrics.OnReplayDrained(replayed)
	}
	c.drained.Add(replayed)
	c.cfg.Logger.Info().Str("path", path).Uint64("count", replayed).Msg("audit replay file drained")
	return nil
}

func (c *Client) run(ctx context.Context) {
	ticker := time.NewTicker(c.cfg.FlushTTL)
	defer ticker.Stop()
	batch := make([]Event, 0, c.cfg.FlushBatch)

	flush := func() {
		failed := batch[:0:0]
		for _, ev := range batch {
			if err := c.xadd(ctx, ev); err != nil {
				c.cfg.Logger.Error().Err(err).Str("id", ev.ID).Msg("xadd audit event")
				c.sinkErrors.Add(1)
				if c.cfg.Metrics.OnSinkError != nil {
					c.cfg.Metrics.OnSinkError()
				}
				failed = append(failed, ev)
			}
		}
		if len(failed) > 0 {
			c.persistBatch(failed)
		}
		batch = batch[:0]
	}

	for {
		select {
		case ev := <-c.ch:
			batch = append(batch, ev)
			if len(batch) >= c.cfg.FlushBatch {
				flush()
			}
		case <-ticker.C:
			if len(batch) > 0 {
				flush()
			}
		case <-ctx.Done():
			for drained := false; !drained; {
				select {
				case ev := <-c.ch:
					batch = append(batch, ev)
				default:
					drained = true
				}
			}
			c.persistBatch(batch)
			return
		}
	}
}
