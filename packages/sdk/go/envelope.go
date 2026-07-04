// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Wire envelope using W3C Trace Context (traceparent/tracestate) and W3C Baggage.
//
// Caracal correlation fields (session, agent_session, delegation_edge,
// parent_edge, hop) ride in Baggage under the caracal.* namespace alongside
// pass-through third-party entries; trace identity rides in traceparent and
// tracestate. Decoding reads the subject token from Authorization, but
// encoding never writes it: credential emission is an explicit client-layer
// decision. Baggage is unsigned routing metadata; verifiers must treat signed
// token claims as the only authoritative source of delegation state.

package sdk

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

const (
	HeaderAuthorization = "Authorization"
	HeaderTraceparent   = "traceparent"
	HeaderTracestate    = "tracestate"
	HeaderBaggage       = "baggage"

	BaggageAgentSession   = "caracal.agent_session"
	BaggageDelegationEdge = "caracal.delegation_edge"
	BaggageParentEdge     = "caracal.parent_edge"
	BaggageSession        = "caracal.session"
	BaggageHop            = "caracal.hop"

	MaxHop = 10

	maxBaggageBytes   = 8192
	maxBaggageMembers = 64
)

var caracalBaggageKeys = []string{
	BaggageAgentSession,
	BaggageDelegationEdge,
	BaggageParentEdge,
	BaggageSession,
	BaggageHop,
}

var (
	bearerRE  = regexp.MustCompile(`^(?i:bearer) +(.+)$`)
	hex2RE    = regexp.MustCompile(`^[0-9a-f]{2}$`)
	hex16RE   = regexp.MustCompile(`^[0-9a-f]{16}$`)
	traceIDRE = regexp.MustCompile(`^[0-9a-f]{32}$`)
	hopRE     = regexp.MustCompile(`^[0-9]+$`)
)

// Envelope is the transport-neutral identity propagation payload.
type Envelope struct {
	SubjectToken     string
	AgentSessionID   string
	DelegationEdgeID string
	ParentEdgeID     string
	SessionID        string
	TraceID          string
	TraceFlags       string
	TraceState       string
	Baggage          map[string]string
	Hop              int
}

func newRandomHex(byteLen int) string {
	b := make([]byte, byteLen)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func newTraceID() string { return newRandomHex(16) }
func newSpanID() string  { return newRandomHex(8) }

// FormatTraceparent renders a W3C traceparent for the given trace id and flags.
func FormatTraceparent(traceID, flags string) string {
	if !hex2RE.MatchString(flags) {
		flags = "01"
	}
	return "00-" + traceID + "-" + newSpanID() + "-" + flags
}

// ParseTraceparent extracts the trace id and flags from a W3C traceparent value,
// accepting future spec versions with additional fields.
func ParseTraceparent(value string) (string, string) {
	parts := strings.Split(strings.TrimSpace(value), "-")
	if len(parts) < 4 {
		return "", ""
	}
	version, traceID, spanID, flags := parts[0], parts[1], parts[2], parts[3]
	if !hex2RE.MatchString(version) || version == "ff" {
		return "", ""
	}
	if version == "00" && len(parts) != 4 {
		return "", ""
	}
	if !traceIDRE.MatchString(traceID) || traceID == strings.Repeat("0", 32) {
		return "", ""
	}
	if !hex16RE.MatchString(spanID) || spanID == strings.Repeat("0", 16) {
		return "", ""
	}
	if !hex2RE.MatchString(flags) {
		return "", ""
	}
	return traceID, flags
}

func percentEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '.' || c == '_' || c == '~' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func percentDecode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			if d, err := hex.DecodeString(s[i+1 : i+3]); err == nil {
				b.WriteByte(d[0])
				i += 2
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// EncodeBaggage renders a W3C baggage header from the supplied entries in
// deterministic key order.
func EncodeBaggage(entries map[string]string) string {
	keys := make([]string, 0, len(entries))
	for k, v := range entries {
		if v == "" {
			continue
		}
		keys = append(keys, k)
	}
	slices.Sort(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+percentEncode(entries[k]))
	}
	return strings.Join(parts, ",")
}

// ParseBaggage parses a W3C baggage header into a key/value map, discarding
// headers that exceed the W3C size limits.
func ParseBaggage(value string) map[string]string {
	out := map[string]string{}
	if value == "" || len(value) > maxBaggageBytes {
		return out
	}
	pieces := strings.Split(value, ",")
	if len(pieces) > maxBaggageMembers {
		return out
	}
	for _, piece := range pieces {
		eq := strings.Index(piece, "=")
		if eq <= 0 {
			continue
		}
		k := strings.TrimSpace(piece[:eq])
		if k == "" {
			continue
		}
		raw := piece[eq+1:]
		if semi := strings.Index(raw, ";"); semi >= 0 {
			raw = raw[:semi]
		}
		out[k] = percentDecode(strings.TrimSpace(raw))
	}
	return out
}

// FromHTTPRequest extracts an Envelope from an *http.Request, joining
// repeated baggage headers per RFC 9110 list semantics.
func FromHTTPRequest(r *http.Request) Envelope {
	return DecodeEnvelope(func(name string) string {
		if strings.EqualFold(name, HeaderBaggage) {
			return strings.Join(r.Header.Values(HeaderBaggage), ",")
		}
		return r.Header.Get(name)
	})
}

// DecodeEnvelope reads envelope fields using the provided getter.
func DecodeEnvelope(get func(string) string) Envelope {
	subject := ""
	if a := get(HeaderAuthorization); a != "" {
		if m := bearerRE.FindStringSubmatch(strings.TrimSpace(a)); m != nil {
			subject = m[1]
		}
	}
	traceID, traceFlags := "", ""
	if tp := get(HeaderTraceparent); tp != "" {
		traceID, traceFlags = ParseTraceparent(tp)
	}
	traceState := strings.TrimSpace(get(HeaderTracestate))
	bag := ParseBaggage(get(HeaderBaggage))
	extras := map[string]string{}
	for k, v := range bag {
		if !slices.Contains(caracalBaggageKeys, k) {
			extras[k] = v
		}
	}
	if len(extras) == 0 {
		extras = nil
	}
	hop := 0
	if raw := bag[BaggageHop]; hopRE.MatchString(raw) {
		if n, err := strconv.Atoi(raw); err == nil {
			hop = min(MaxHop, n)
		} else {
			hop = MaxHop
		}
	}
	return Envelope{
		SubjectToken:     subject,
		AgentSessionID:   bag[BaggageAgentSession],
		DelegationEdgeID: bag[BaggageDelegationEdge],
		ParentEdgeID:     bag[BaggageParentEdge],
		SessionID:        bag[BaggageSession],
		TraceID:          traceID,
		TraceFlags:       traceFlags,
		TraceState:       traceState,
		Baggage:          extras,
		Hop:              hop,
	}
}

// EncodeEnvelope writes envelope context headers using the provided setter.
// A non-nil get enables merge semantics: an existing valid traceparent or
// tracestate is left untouched and existing baggage entries are preserved,
// with the envelope's caracal.* fields always winning. The subject token is
// never written; credential placement is a client-layer decision.
func EncodeEnvelope(env Envelope, set func(name, value string), get func(string) string) {
	existingTp := ""
	if get != nil {
		existingTp = get(HeaderTraceparent)
	}
	if tid, _ := ParseTraceparent(existingTp); tid == "" {
		traceID := env.TraceID
		if !traceIDRE.MatchString(traceID) {
			traceID = newTraceID()
		}
		set(HeaderTraceparent, FormatTraceparent(traceID, env.TraceFlags))
	}
	if env.TraceState != "" && (get == nil || get(HeaderTracestate) == "") {
		set(HeaderTracestate, env.TraceState)
	}
	merged := map[string]string{}
	for k, v := range env.Baggage {
		merged[k] = v
	}
	if get != nil {
		for k, v := range ParseBaggage(get(HeaderBaggage)) {
			merged[k] = v
		}
	}
	for _, k := range caracalBaggageKeys {
		delete(merged, k)
	}
	if env.AgentSessionID != "" {
		merged[BaggageAgentSession] = env.AgentSessionID
	}
	if env.DelegationEdgeID != "" {
		merged[BaggageDelegationEdge] = env.DelegationEdgeID
	}
	if env.ParentEdgeID != "" {
		merged[BaggageParentEdge] = env.ParentEdgeID
	}
	if env.SessionID != "" {
		merged[BaggageSession] = env.SessionID
	}
	if env.Hop > 0 || env.AgentSessionID != "" || env.DelegationEdgeID != "" ||
		env.ParentEdgeID != "" || env.SessionID != "" {
		merged[BaggageHop] = strconv.Itoa(env.Hop)
	}
	if bag := EncodeBaggage(merged); bag != "" {
		set(HeaderBaggage, bag)
	}
}

// InjectHTTP merges Caracal context headers onto an outbound http.Header.
func InjectHTTP(env Envelope, h http.Header) {
	EncodeEnvelope(env, func(name, value string) {
		h.Set(http.CanonicalHeaderKey(name), value)
	}, func(name string) string {
		if strings.EqualFold(name, HeaderBaggage) {
			return strings.Join(h.Values(HeaderBaggage), ",")
		}
		return h.Get(name)
	})
}

// ToHeaders serializes the envelope to a plain string map (for gRPC metadata,
// MCP _meta, queue headers, etc.).
func ToHeaders(env Envelope) map[string]string {
	out := make(map[string]string, 4)
	EncodeEnvelope(env, func(name, value string) {
		out[name] = value
	}, nil)
	return out
}

// FromHeaders deserializes an Envelope from a plain string map.
func FromHeaders(m map[string]string) Envelope {
	get := func(name string) string {
		lower := strings.ToLower(name)
		for k, v := range m {
			if strings.ToLower(k) == lower {
				return v
			}
		}
		return ""
	}
	return DecodeEnvelope(get)
}
