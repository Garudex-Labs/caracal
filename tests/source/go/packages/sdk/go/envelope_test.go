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
	traceID, flags := sdk.ParseTraceparent("00-0123456789abcdef0123456789abcdef-aabbccddeeff0011-01")
	if traceID != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("unexpected trace id: %q", traceID)
	}
	if flags != "01" {
		t.Fatalf("unexpected flags: %q", flags)
	}
}

func TestParseTraceparentFutureVersion(t *testing.T) {
	traceID, flags := sdk.ParseTraceparent("01-0123456789abcdef0123456789abcdef-aabbccddeeff0011-00-extrafield")
	if traceID != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("future version with extra fields must parse, got %q", traceID)
	}
	if flags != "00" {
		t.Fatalf("unexpected flags: %q", flags)
	}
}

func TestParseTraceparentEmpty(t *testing.T) {
	if traceID, _ := sdk.ParseTraceparent(""); traceID != "" {
		t.Error("empty input must return empty")
	}
}

func TestParseTraceparentAllZero(t *testing.T) {
	if traceID, _ := sdk.ParseTraceparent("00-00000000000000000000000000000000-aabbccddeeff0011-01"); traceID != "" {
		t.Error("all-zero trace id must return empty")
	}
	if traceID, _ := sdk.ParseTraceparent("00-0123456789abcdef0123456789abcdef-0000000000000000-01"); traceID != "" {
		t.Error("all-zero span id must return empty")
	}
}

func TestParseTraceparentInvalidFormats(t *testing.T) {
	cases := []string{
		"invalid",
		"00-short-aabbccddeeff0011-01",
		"00-0123456789abcdef0123456789ABCDEF-aabbccddeeff0011-01", // uppercase
		"ff-0123456789abcdef0123456789abcdef-aabbccddeeff0011-01", // forbidden version
		"00-0123456789abcdef0123456789abcdef-aabbccddeeff0011-01-extra", // version 00 with extra field
		"noteven",
	}
	for _, v := range cases {
		if traceID, _ := sdk.ParseTraceparent(v); traceID != "" {
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

func TestParseBaggagePlusIsLiteral(t *testing.T) {
	bag := sdk.ParseBaggage("k=a+b")
	if bag["k"] != "a+b" {
		t.Errorf("'+' must stay literal per W3C Baggage, got %q", bag["k"])
	}
}

func TestParseBaggageMalformedPercentKeptRaw(t *testing.T) {
	bag := sdk.ParseBaggage("k=broken%zz")
	if bag["k"] != "broken%zz" {
		t.Errorf("malformed percent escape must stay raw, got %q", bag["k"])
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

func TestParseBaggageOversizeDiscarded(t *testing.T) {
	if len(sdk.ParseBaggage("k=" + strings.Repeat("a", 9000))) != 0 {
		t.Error("headers above the W3C size limit must be discarded")
	}
	members := make([]string, 65)
	for i := range members {
		members[i] = "k" + string(rune('a'+i%26)) + "=v"
	}
	if len(sdk.ParseBaggage(strings.Join(members, ","))) != 0 {
		t.Error("headers above the W3C member limit must be discarded")
	}
}

func TestParseBaggageSemicolonStripsProperties(t *testing.T) {
	bag := sdk.ParseBaggage("k=v;property=ignored")
	if bag["k"] != "v" {
		t.Errorf("semicolon properties must be stripped, got %q", bag["k"])
	}
}

func TestEncodeBaggageDeterministicOrder(t *testing.T) {
	got := sdk.EncodeBaggage(map[string]string{"zeta": "1", "alpha": "2", "mid": "3"})
	if got != "alpha=2,mid=3,zeta=1" {
		t.Errorf("baggage must encode in sorted key order, got %q", got)
	}
}

func TestEncodeBaggagePercentEncodesReserved(t *testing.T) {
	got := sdk.EncodeBaggage(map[string]string{"k": "a b%c,d=e"})
	if got != "k=a%20b%25c%2Cd%3De" {
		t.Errorf("reserved characters must percent-encode, got %q", got)
	}
	back := sdk.ParseBaggage(got)
	if back["k"] != "a b%c,d=e" {
		t.Errorf("round trip mismatch: %q", back["k"])
	}
}

func TestEncodeEnvelopeNeverEmitsAuthorization(t *testing.T) {
	env := sdk.Envelope{SubjectToken: "tok", TraceID: "0123456789abcdef0123456789abcdef", Hop: 1}
	got := map[string]string{}
	sdk.EncodeEnvelope(env, func(k, v string) { got[k] = v }, nil)
	if _, ok := got[sdk.HeaderAuthorization]; ok {
		t.Error("encode must never emit Authorization; credential placement is a client-layer decision")
	}
}

func TestDecodeEncodeEnvelopeRoundTrip(t *testing.T) {
	env := sdk.Envelope{
		AgentSessionID:   "sess1",
		DelegationEdgeID: "edge1",
		ParentEdgeID:     "parent1",
		SessionID:        "sid1",
		TraceID:          "0123456789abcdef0123456789abcdef",
		TraceFlags:       "00",
		TraceState:       "vendor=value",
		Baggage:          map[string]string{"tenant": "pied-piper"},
		Hop:              3,
	}
	headers := map[string]string{}
	sdk.EncodeEnvelope(env, func(k, v string) { headers[k] = v }, nil)

	out := sdk.DecodeEnvelope(func(k string) string { return headers[k] })

	if out.AgentSessionID != env.AgentSessionID {
		t.Errorf("AgentSessionID mismatch: %q vs %q", out.AgentSessionID, env.AgentSessionID)
	}
	if out.DelegationEdgeID != env.DelegationEdgeID {
		t.Errorf("DelegationEdgeID mismatch")
	}
	if out.ParentEdgeID != env.ParentEdgeID {
		t.Errorf("ParentEdgeID mismatch")
	}
	if out.SessionID != env.SessionID {
		t.Errorf("SessionID mismatch")
	}
	if out.TraceID != env.TraceID {
		t.Errorf("TraceID mismatch: %q vs %q", out.TraceID, env.TraceID)
	}
	if out.TraceFlags != env.TraceFlags {
		t.Errorf("TraceFlags mismatch: %q vs %q", out.TraceFlags, env.TraceFlags)
	}
	if out.TraceState != env.TraceState {
		t.Errorf("TraceState mismatch: %q vs %q", out.TraceState, env.TraceState)
	}
	if out.Baggage["tenant"] != "pied-piper" {
		t.Errorf("third-party baggage must round trip, got %v", out.Baggage)
	}
	if out.Hop != env.Hop {
		t.Errorf("Hop mismatch: %d vs %d", out.Hop, env.Hop)
	}
}

func TestDecodeEnvelopeBearerPrefix(t *testing.T) {
	cases := map[string]string{
		"Bearer mytoken":      "mytoken",
		"bearer mytoken":      "mytoken",
		"BEARER   mytoken   ": "mytoken",
	}
	for raw, want := range cases {
		env := sdk.DecodeEnvelope(func(k string) string {
			if k == sdk.HeaderAuthorization {
				return raw
			}
			return ""
		})
		if env.SubjectToken != want {
			t.Errorf("%q: expected %q, got %q", raw, want, env.SubjectToken)
		}
	}
}

func TestDecodeEnvelopeNonBearerIgnored(t *testing.T) {
	for _, raw := range []string{"Basic dXNlcjpwYXNz", "Bearer", "Bearer ", "Bearertok"} {
		env := sdk.DecodeEnvelope(func(k string) string {
			if k == sdk.HeaderAuthorization {
				return raw
			}
			return ""
		})
		if env.SubjectToken != "" {
			t.Errorf("%q must be ignored, got %q", raw, env.SubjectToken)
		}
	}
}

func TestHopClamping(t *testing.T) {
	cases := []struct {
		raw  string
		want int
	}{
		{"0", 0},
		{"1", 1},
		{"10", sdk.MaxHop},
		{"11", sdk.MaxHop},
		{"100", sdk.MaxHop},
		{"99999999999999999999", sdk.MaxHop},
		{"-1", 0},
		{"-99", 0},
		{"+3", 0},
		{"3x", 0},
		{"1e2", 0},
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

func TestEncodeEnvelopeOmitsHopZeroWithoutIdentityFields(t *testing.T) {
	got := map[string]string{}
	sdk.EncodeEnvelope(sdk.Envelope{TraceID: "0123456789abcdef0123456789abcdef"}, func(k, v string) { got[k] = v }, nil)
	if _, ok := got[sdk.HeaderBaggage]; ok {
		t.Errorf("baggage must be omitted for a root envelope, got %q", got[sdk.HeaderBaggage])
	}
}

func TestEncodeEnvelopeMergePreservesExistingHeaders(t *testing.T) {
	existing := map[string]string{
		sdk.HeaderTraceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab-bbbbbbbbbbbbbbbb-01",
		sdk.HeaderTracestate:  "otel=span",
		sdk.HeaderBaggage:     "tenant=hooli," + sdk.BaggageHop + "=9",
	}
	env := sdk.Envelope{
		AgentSessionID: "sess",
		TraceID:        "0123456789abcdef0123456789abcdef",
		TraceState:     "caracal=ignored",
		Hop:            2,
	}
	sdk.EncodeEnvelope(env, func(k, v string) { existing[k] = v }, func(k string) string { return existing[k] })

	if existing[sdk.HeaderTraceparent] != "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab-bbbbbbbbbbbbbbbb-01" {
		t.Errorf("an existing valid traceparent must win, got %q", existing[sdk.HeaderTraceparent])
	}
	if existing[sdk.HeaderTracestate] != "otel=span" {
		t.Errorf("an existing tracestate must win, got %q", existing[sdk.HeaderTracestate])
	}
	bag := sdk.ParseBaggage(existing[sdk.HeaderBaggage])
	if bag["tenant"] != "hooli" {
		t.Errorf("existing third-party baggage must survive, got %v", bag)
	}
	if bag[sdk.BaggageAgentSession] != "sess" || bag[sdk.BaggageHop] != "2" {
		t.Errorf("envelope caracal.* fields must win over stale entries, got %v", bag)
	}
}

func TestInjectFromHTTPRequestRoundTrip(t *testing.T) {
	env := sdk.Envelope{
		AgentSessionID: "sess",
		TraceID:        "abcdef0123456789abcdef0123456789",
		Hop:            2,
	}
	h := http.Header{}
	sdk.InjectHTTP(env, h)

	req, _ := http.NewRequest("GET", "http://example.com", nil)
	req.Header = h
	out := sdk.FromHTTPRequest(req)

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

func TestFromHTTPRequestJoinsRepeatedBaggageHeaders(t *testing.T) {
	req, _ := http.NewRequest("GET", "http://example.com", nil)
	req.Header.Add("Baggage", sdk.BaggageAgentSession+"=sess")
	req.Header.Add("Baggage", "tenant=hooli")
	out := sdk.FromHTTPRequest(req)
	if out.AgentSessionID != "sess" {
		t.Errorf("first baggage header lost: %q", out.AgentSessionID)
	}
	if out.Baggage["tenant"] != "hooli" {
		t.Errorf("second baggage header lost: %v", out.Baggage)
	}
}

func TestToMapFromMapRoundTrip(t *testing.T) {
	env := sdk.Envelope{
		AgentSessionID:   "sess",
		DelegationEdgeID: "edge",
		SessionID:        "sid",
		TraceID:          "0123456789abcdef0123456789abcdef",
		Hop:              1,
	}
	m := sdk.ToHeaders(env)
	out := sdk.FromHeaders(m)

	if out.AgentSessionID != env.AgentSessionID {
		t.Errorf("AgentSessionID mismatch")
	}
	if out.DelegationEdgeID != env.DelegationEdgeID {
		t.Errorf("DelegationEdgeID mismatch")
	}
	if out.SessionID != env.SessionID {
		t.Errorf("SessionID mismatch")
	}
	if out.TraceID != env.TraceID {
		t.Errorf("TraceID mismatch")
	}
}

func TestFromHeadersCaseInsensitive(t *testing.T) {
	out := sdk.FromHeaders(map[string]string{"AUTHORIZATION": "Bearer tok"})
	if out.SubjectToken != "tok" {
		t.Errorf("case-insensitive key lookup failed: %q", out.SubjectToken)
	}
}

func TestEncodeEnvelopeGeneratesTraceIDWhenMissing(t *testing.T) {
	env := sdk.Envelope{Hop: 1}
	got := map[string]string{}
	sdk.EncodeEnvelope(env, func(k, v string) { got[k] = v }, nil)

	tp := got[sdk.HeaderTraceparent]
	if traceID, _ := sdk.ParseTraceparent(tp); traceID == "" {
		t.Errorf("encode must generate a traceparent when TraceID is empty, got %q", tp)
	}
}

func TestEncodeEnvelopePropagatesTraceFlags(t *testing.T) {
	env := sdk.Envelope{TraceID: "0123456789abcdef0123456789abcdef", TraceFlags: "00", Hop: 1}
	got := map[string]string{}
	sdk.EncodeEnvelope(env, func(k, v string) { got[k] = v }, nil)
	if _, flags := sdk.ParseTraceparent(got[sdk.HeaderTraceparent]); flags != "00" {
		t.Errorf("trace flags must propagate, got %q", got[sdk.HeaderTraceparent])
	}
}
