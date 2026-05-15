// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Zerolog-backed structured JSON logger for Caracal Go services.

package logging

import (
	"context"
	"os"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/rs/zerolog"
)

var (
	hostnameOnce sync.Once
	hostname     string
	versionOnce  sync.Once
	version      string
)

func host() string {
	hostnameOnce.Do(func() {
		h, err := os.Hostname()
		if err != nil || h == "" {
			h = "unknown"
		}
		hostname = h
	})
	return hostname
}

func ver() string {
	versionOnce.Do(func() {
		if v := os.Getenv("CARACAL_VERSION"); v != "" {
			version = v
			return
		}
		if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
			version = info.Main.Version
			return
		}
		version = "dev"
	})
	return version
}

func env() string {
	if e := os.Getenv("CARACAL_ENV"); e != "" {
		return e
	}
	if e := os.Getenv("APP_ENV"); e != "" {
		return e
	}
	return "development"
}

// TraceContext carries W3C trace identifiers attached to a context. Empty
// fields are omitted from log output.
type TraceContext struct {
	TraceID string
	SpanID  string
}

type traceKey struct{}

// WithTraceContext returns a child context carrying the provided trace identifiers.
func WithTraceContext(ctx context.Context, tc TraceContext) context.Context {
	return context.WithValue(ctx, traceKey{}, tc)
}

// TraceFromContext extracts the trace context, returning an empty struct when absent.
func TraceFromContext(ctx context.Context) TraceContext {
	if ctx == nil {
		return TraceContext{}
	}
	v, _ := ctx.Value(traceKey{}).(TraceContext)
	return v
}

// ParseTraceparent decodes a W3C traceparent header
// (version-traceid-spanid-flags). Returns zero value on parse failure.
func ParseTraceparent(h string) TraceContext {
	parts := strings.Split(h, "-")
	if len(parts) < 4 {
		return TraceContext{}
	}
	if len(parts[1]) != 32 || len(parts[2]) != 16 {
		return TraceContext{}
	}
	return TraceContext{TraceID: parts[1], SpanID: parts[2]}
}

// WithTrace decorates a logger with trace_id and span_id from ctx when present.
func WithTrace(l zerolog.Logger, ctx context.Context) zerolog.Logger {
	tc := TraceFromContext(ctx)
	if tc.TraceID == "" && tc.SpanID == "" {
		return l
	}
	bc := l.With()
	if tc.TraceID != "" {
		bc = bc.Str("trace_id", tc.TraceID)
	}
	if tc.SpanID != "" {
		bc = bc.Str("span_id", tc.SpanID)
	}
	return bc.Logger()
}

// New returns a zerolog.Logger scoped to the named service with standard
// process-level fields (service, hostname, pid, version, env) bound once.
// Log level is read from the LOG_LEVEL environment variable (default: info).
func New(service string) zerolog.Logger {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnixMs
	zerolog.MessageFieldName = "msg"
	zerolog.LevelFieldName = "level"
	zerolog.TimestampFieldName = "time"
	zerolog.ErrorStackMarshaler = nil
	w := newAsyncWriter(os.Stderr)
	return zerolog.New(samplingHook{w: w}).Level(envLevel()).With().
		Timestamp().
		Str("service", service).
		Str("hostname", host()).
		Int("pid", os.Getpid()).
		Str("version", ver()).
		Str("env", env()).
		Logger()
}

// SetGlobalLevel updates zerolog's process-wide log level. Call once during service init.
func SetGlobalLevel() {
	zerolog.SetGlobalLevel(envLevel())
}

func envLevel() zerolog.Level {
	switch strings.ToLower(os.Getenv("LOG_LEVEL")) {
	case "debug":
		return zerolog.DebugLevel
	case "warn":
		return zerolog.WarnLevel
	case "error":
		return zerolog.ErrorLevel
	}
	return zerolog.InfoLevel
}

// debugSampleN is the 1-in-N sampler for DEBUG-level records. Values <=1
// disable sampling. Read once at init time from CARACAL_LOG_SAMPLE_DEBUG.
var debugSampleN = func() uint64 {
	if v := os.Getenv("CARACAL_LOG_SAMPLE_DEBUG"); v != "" {
		n, err := strconv.ParseUint(v, 10, 64)
		if err == nil && n > 0 {
			return n
		}
	}
	return 1
}()

var debugCounter atomic.Uint64

// samplingHook implements io.Writer; it inspects the JSON payload to drop
// debug-level lines per the configured sampling rate. zerolog calls Write once
// per record.
type samplingHook struct {
	w *asyncWriter
}

func (s samplingHook) Write(p []byte) (int, error) {
	if debugSampleN > 1 && isDebugLine(p) {
		n := debugCounter.Add(1)
		if n%debugSampleN != 0 {
			return len(p), nil
		}
	}
	return s.w.Write(p)
}

func isDebugLine(p []byte) bool {
	const marker = `"level":"debug"`
	if len(p) < len(marker)+1 {
		return false
	}
	return strings.Contains(string(p[:min(len(p), 64)]), marker)
}

