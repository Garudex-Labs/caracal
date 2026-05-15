// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for trace context, async writer metrics, and shutdown helpers.

package logging

import (
	"context"
	"strings"
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
