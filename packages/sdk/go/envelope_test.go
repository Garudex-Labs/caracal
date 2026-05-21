// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for wire envelope encoding, decoding, and baggage parsing.

package sdk_test

import (
	"net/http"
	"strings"
	"testing"

	sdk "github.com/garudex-labs/caracal/packages/sdk/go"
)

func TestParseTraceparentValid(t *testing.T) {
	traceID := sdk.ParseTraceparent("00-0123456789abcdef0123456789abcdef-aabbccddeeff0011-01")
	if traceID != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("unexpected trace id: %q", traceID)
	}
}

func TestParseTraceparentEmpty(t *testing.T) {
	if sdk.ParseTraceparent("") != "" {
		t.Error("empty input must return empty")
	}
}

func TestParseTraceparentAllZero(t *testing.T) {
	if sdk.ParseTraceparent("00-00000000000000000000000000000000-aabbccddeeff0011-01") != "" {
		t.Error("all-zero trace id must return empty")
	}
}

func TestParseTraceparentInvalidFormats(t *testing.T) {
	cases := []string{
		"invalid",
		"00-short-aabbccddeeff0011-01",
		"00-0123456789abcdef0123456789ABCDEF-aabbccddeeff0011-01", // uppercase
		"noteven",
	}
	for _, v := range cases {
		if sdk.ParseTraceparent(v) != "" {
			t.Errorf("expected empty for %q", v)
		}
	}
}

func TestParseBaggageKeyValue(t *testing.T) {
	bag := sdk.ParseBaggage("k1=v1,k2=v2")
	if bag["k1"] != "v1" || bag["k2"] != "v2" {
		t.Errorf("unexpected baggage: %v", bag)
	}
}

func TestParseBaggagePercentEncoded(t *testing.T) {
	bag := sdk.ParseBaggage("k=hello%20world")
	if bag["k"] != "hello world" {
		t.Errorf("expected decoded value, got %q", bag["k"])
	}
}

func TestParseBaggageMalformedSkipped(t *testing.T) {
	bag := sdk.ParseBaggage("noequal,k=v")
	if _, ok := bag["noequal"]; ok {
		t.Error("malformed entry without '=' must be skipped")
	}
	if bag["k"] != "v" {
		t.Errorf("valid entry must still parse, got %q", bag["k"])
	}
}

func TestParseBaggageEmpty(t *testing.T) {
	if len(sdk.ParseBaggage("")) != 0 {
		t.Error("empty string must produce empty map")
	}
}

func TestParseBaggageSemicolonStripsProperties(t *testing.T) {
	bag := sdk.ParseBaggage("k=v;property=ignored")
	if bag["k"] != "v" {
		t.Errorf("semicolon properties must be stripped, got %q", bag["k"])
	}
}

func TestDecodeEncodeEnvelopeRoundTrip(t *testing.T) {
	env := sdk.Envelope{
		SubjectToken:     "tok",
		AgentSessionID:   "sess1",
		DelegationEdgeID: "edge1",
		ParentEdgeID:     "parent1",
		SessionID:        "sid1",
		TraceID:          "0123456789abcdef0123456789abcdef",
		Hop:              3,
	}
	headers := map[string]string{}
	sdk.EncodeEnvelope(env, func(k, v string) { headers[k] = v })

	out := sdk.DecodeEnvelope(func(k string) string { return headers[k] })

	if out.SubjectToken != env.SubjectToken {
		t.Errorf("SubjectToken mismatch: %q vs %q", out.SubjectToken, env.SubjectToken)
	}
	if out.AgentSessionID != env.AgentSessionID {
		t.Errorf("AgentSessionID mismatch: %q vs %q", out.AgentSessionID, env.AgentSessionID)
	}
	if out.DelegationEdgeID != env.DelegationEdgeID {
		t.Errorf("DelegationEdgeID mismatch")
	}
	if out.SessionID != env.SessionID {
		t.Errorf("SessionID mismatch")
	}
	if out.TraceID != env.TraceID {
		t.Errorf("TraceID mismatch: %q vs %q", out.TraceID, env.TraceID)
	}
	if out.Hop != env.Hop {
		t.Errorf("Hop mismatch: %d vs %d", out.Hop, env.Hop)
	}
}

func TestDecodeEnvelopeBearerPrefix(t *testing.T) {
	env := sdk.DecodeEnvelope(func(k string) string {
		if k == sdk.HeaderAuthorization {
			return "Bearer mytoken"
		}
		return ""
	})
	if env.SubjectToken != "mytoken" {
		t.Errorf("expected mytoken, got %q", env.SubjectToken)
	}
}

func TestDecodeEnvelopeNonBearerIgnored(t *testing.T) {
	env := sdk.DecodeEnvelope(func(k string) string {
		if k == sdk.HeaderAuthorization {
			return "Basic dXNlcjpwYXNz"
		}
		return ""
	})
	if env.SubjectToken != "" {
		t.Errorf("non-bearer auth must be ignored, got %q", env.SubjectToken)
	}
}

func TestHopClamping(t *testing.T) {
	cases := []struct {
		raw  string
		want int
	}{
		{"0", 0},
		{"1", 1},
		{"32", sdk.MaxHop},
		{"33", sdk.MaxHop},
		{"100", sdk.MaxHop},
		{"-1", 0},
		{"-99", 0},
	}
	for _, tc := range cases {
		env := sdk.DecodeEnvelope(func(k string) string {
			if k == sdk.HeaderBaggage {
				return sdk.BaggageHop + "=" + tc.raw
			}
			return ""
		})
		if env.Hop != tc.want {
			t.Errorf("hop=%q: want %d got %d", tc.raw, tc.want, env.Hop)
		}
	}
}

func TestInjectFromHTTPRequestRoundTrip(t *testing.T) {
	env := sdk.Envelope{
		SubjectToken:   "tok",
		AgentSessionID: "sess",
		TraceID:        "abcdef0123456789abcdef0123456789",
		Hop:            2,
	}
	h := http.Header{}
	sdk.InjectHTTP(env, h)

	req, _ := http.NewRequest("GET", "http://example.com", nil)
	req.Header = h
	out := sdk.FromHTTPRequest(req)

	if out.SubjectToken != env.SubjectToken {
		t.Errorf("SubjectToken: %q vs %q", out.SubjectToken, env.SubjectToken)
	}
	if out.AgentSessionID != env.AgentSessionID {
		t.Errorf("AgentSessionID: %q vs %q", out.AgentSessionID, env.AgentSessionID)
	}
	if out.TraceID != env.TraceID {
		t.Errorf("TraceID: %q vs %q", out.TraceID, env.TraceID)
	}
	if out.Hop != env.Hop {
		t.Errorf("Hop: %d vs %d", out.Hop, env.Hop)
	}
}

func TestToMapFromMapRoundTrip(t *testing.T) {
	env := sdk.Envelope{
		SubjectToken:     "tok",
		AgentSessionID:   "sess",
		DelegationEdgeID: "edge",
		SessionID:        "sid",
		TraceID:          "0123456789abcdef0123456789abcdef",
		Hop:              1,
	}
	m := sdk.ToMap(env)
	out := sdk.FromMap(m)

	if out.SubjectToken != env.SubjectToken {
		t.Errorf("SubjectToken mismatch")
	}
	if out.AgentSessionID != env.AgentSessionID {
		t.Errorf("AgentSessionID mismatch")
	}
	if out.SessionID != env.SessionID {
		t.Errorf("SessionID mismatch")
	}
	if out.TraceID != env.TraceID {
		t.Errorf("TraceID mismatch")
	}
}

func TestToMapCaseInsensitive(t *testing.T) {
	env := sdk.Envelope{SubjectToken: "tok"}
	m := sdk.ToMap(env)

	// Uppercase the keys to test case-insensitive FromMap.
	upper := map[string]string{}
	for k, v := range m {
		upper[strings.ToUpper(k)] = v
	}
	out := sdk.FromMap(upper)
	if out.SubjectToken != "tok" {
		t.Errorf("case-insensitive key lookup failed: %q", out.SubjectToken)
	}
}

func TestEncodeEnvelopeGeneratesTraceIDWhenMissing(t *testing.T) {
	env := sdk.Envelope{SubjectToken: "tok"}
	got := map[string]string{}
	sdk.EncodeEnvelope(env, func(k, v string) { got[k] = v })

	tp := got[sdk.HeaderTraceparent]
	traceID := sdk.ParseTraceparent(tp)
	if traceID == "" {
		t.Errorf("encode must generate a traceparent when TraceID is empty, got %q", tp)
	}
}

func TestEncodeEnvelopeNoSubjectTokenOmitsAuth(t *testing.T) {
	env := sdk.Envelope{TraceID: "0123456789abcdef0123456789abcdef"}
	got := map[string]string{}
	sdk.EncodeEnvelope(env, func(k, v string) { got[k] = v })
	if _, ok := got[sdk.HeaderAuthorization]; ok {
		t.Error("Authorization must not be set when SubjectToken is empty")
	}
}
