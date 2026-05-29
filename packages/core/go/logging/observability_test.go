// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for trace context, async writer metrics, and shutdown helpers.

package logging

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestParseTraceparent(t *testing.T) {
	tc := ParseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")
	if tc.TraceID != "0af7651916cd43dd8448eb211c80319c" {
		t.Fatalf("trace_id: %q", tc.TraceID)
	}
	if tc.SpanID != "b7ad6b7169203331" {
		t.Fatalf("span_id: %q", tc.SpanID)
	}
	if got := ParseTraceparent("garbage"); got.TraceID != "" {
		t.Fatalf("expected empty for garbage, got %+v", got)
	}
}

func TestParseTraceparentRejectsMalformedFields(t *testing.T) {
	if got := ParseTraceparent("00-tooshort-b7ad6b7169203331-01"); got != (TraceContext{}) {
		t.Fatalf("short trace id must yield zero value, got %+v", got)
	}
	if got := ParseTraceparent("00-0af7651916cd43dd8448eb211c80319c-short-01"); got != (TraceContext{}) {
		t.Fatalf("short span id must yield zero value, got %+v", got)
	}
}

func TestWithTrace(t *testing.T) {
	base := New("test-withtrace")

	plain := WithTrace(base, context.Background())
	_ = plain

	ctx := WithTraceContext(context.Background(), TraceContext{TraceID: "t1", SpanID: "s1"})
	decorated := WithTrace(base, ctx)

	buf := &captureWriter{}
	decorated = decorated.Output(buf)
	decorated.Info().Msg("hi")
	out := buf.String()
	if !strings.Contains(out, `"trace_id":"t1"`) || !strings.Contains(out, `"span_id":"s1"`) {
		t.Fatalf("expected trace fields in output, got %s", out)
	}
}

func TestWithTraceNoContextReturnsLoggerUnchanged(t *testing.T) {
	base := New("test-withtrace-empty")
	buf := &captureWriter{}
	out := WithTrace(base, context.Background()).Output(buf)
	out.Info().Msg("hi")
	if strings.Contains(buf.String(), "trace_id") {
		t.Fatalf("no trace context must not add trace fields, got %s", buf.String())
	}
}

func TestWithTraceOnlyTraceID(t *testing.T) {
	base := New("test-withtrace-partial")
	ctx := WithTraceContext(context.Background(), TraceContext{TraceID: "t1"})
	buf := &captureWriter{}
	out := WithTrace(base, ctx).Output(buf)
	out.Info().Msg("hi")
	logged := buf.String()
	if !strings.Contains(logged, `"trace_id":"t1"`) || strings.Contains(logged, "span_id") {
		t.Fatalf("expected only trace_id, got %s", logged)
	}
}

func TestTraceFromContextNilContext(t *testing.T) {
	if got := TraceFromContext(nil); got != (TraceContext{}) {
		t.Fatalf("nil context must yield zero value, got %+v", got)
	}
}

func TestIsDebugLine(t *testing.T) {
	if !isDebugLine([]byte(`{"level":"debug","msg":"x"}`)) {
		t.Fatal("debug line must be detected")
	}
	if isDebugLine([]byte(`{"level":"info","msg":"x"}`)) {
		t.Fatal("info line must not be detected as debug")
	}
	if isDebugLine([]byte(`{}`)) {
		t.Fatal("short line must not be detected as debug")
	}
}

type captureWriter struct {
	mu sync.Mutex
	b  strings.Builder
}

func (c *captureWriter) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.b.Write(p)
}

func (c *captureWriter) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.b.String()
}

func TestWithTraceContext(t *testing.T) {
	ctx := WithTraceContext(context.Background(), TraceContext{TraceID: "t1", SpanID: "s1"})
	tc := TraceFromContext(ctx)
	if tc.TraceID != "t1" || tc.SpanID != "s1" {
		t.Fatalf("trace round-trip failed: %+v", tc)
	}
}

func TestMetricsSnapshotIncrements(t *testing.T) {
	l := New("test-metrics")
	before := MetricsSnapshot().Emitted
	l.Info().Str("k", "v").Msg("hello")
	FlushDevLogs(200 * time.Millisecond)
	after := MetricsSnapshot().Emitted
	if after <= before {
		t.Fatalf("emitted did not advance: %d -> %d", before, after)
	}
}

func TestRedactCloudSecrets(t *testing.T) {
	cases := map[string]string{
		"aws":    "AKIA1234567890ABCDEF",
		"gcp":    "AIzaSyA-1234567890abcdefghijklmnopqrstuvw",
		"github": "ghp_1234567890abcdefghij1234567890abcdefgh",
		"slack":  "xoxb-12345-67890-abcdefghijklmnop",
	}
	for name, secret := range cases {
		if got := RedactString(secret); !strings.Contains(got, "***") {
			t.Fatalf("%s not redacted: %s", name, got)
		}
	}
}

func TestTruncateString(t *testing.T) {
	saved := MaxFieldBytes
	MaxFieldBytes = 16
	defer func() { MaxFieldBytes = saved }()
	s := strings.Repeat("x", 64)
	got := TruncateString(s)
	if !strings.HasSuffix(got, "[truncated]") {
		t.Fatalf("expected truncation marker, got %q", got)
	}
}
