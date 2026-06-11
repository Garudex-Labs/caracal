// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Wire envelope using W3C Trace Context (traceparent) and W3C Baggage.
//
// Subject token rides in Authorization. Caracal-specific cross-cutting fields
// (session, agent_session, delegation_edge, parent_edge, hop) ride in Baggage under
// the caracal.* namespace. Trace identifiers ride in traceparent.

package sdk

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const (
	HeaderAuthorization = "Authorization"
	HeaderTraceparent   = "traceparent"
	HeaderBaggage       = "baggage"

	BaggageAgentSession   = "caracal.agent_session"
	BaggageDelegationEdge = "caracal.delegation_edge"
	BaggageParentEdge     = "caracal.parent_edge"
	BaggageSession        = "caracal.session"
	BaggageHop            = "caracal.hop"

	MaxHop = 32
)

var (
	traceparentRE = regexp.MustCompile(`^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$`)
	traceIDRE     = regexp.MustCompile(`^[0-9a-f]{32}$`)
)

// Envelope is the transport-neutral identity propagation payload.
type Envelope struct {
	SubjectToken     string
	AgentSessionID   string
	DelegationEdgeID string
	ParentEdgeID     string
	SessionID        string
	TraceID          string
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

// FormatTraceparent renders a W3C traceparent for the given trace id.
func FormatTraceparent(traceID string) string {
	return "00-" + traceID + "-" + newSpanID() + "-01"
}

// ParseTraceparent extracts the trace id from a W3C traceparent value.
func ParseTraceparent(value string) string {
	m := traceparentRE.FindStringSubmatch(strings.TrimSpace(value))
	if m == nil {
		return ""
	}
	if m[2] == strings.Repeat("0", 32) {
		return ""
	}
	return m[2]
}

// EncodeBaggage renders a W3C baggage header from the supplied entries.
func EncodeBaggage(entries map[string]string) string {
	parts := make([]string, 0, len(entries))
	for k, v := range entries {
		if v == "" {
			continue
		}
		parts = append(parts, k+"="+url.QueryEscape(v))
	}
	return strings.Join(parts, ",")
}

// ParseBaggage parses a W3C baggage header into a key/value map.
func ParseBaggage(value string) map[string]string {
	out := map[string]string{}
	if value == "" {
		return out
	}
	for _, piece := range strings.Split(value, ",") {
		eq := strings.Index(piece, "=")
		if eq <= 0 {
			continue
		}
		k := strings.TrimSpace(piece[:eq])
		raw := piece[eq+1:]
		if semi := strings.Index(raw, ";"); semi >= 0 {
			raw = raw[:semi]
		}
		raw = strings.TrimSpace(raw)
		if dec, err := url.QueryUnescape(raw); err == nil {
			out[k] = dec
		} else {
			out[k] = raw
		}
	}
	return out
}

// FromHTTPRequest extracts an Envelope from an *http.Request.
func FromHTTPRequest(r *http.Request) Envelope {
	return DecodeEnvelope(func(name string) string {
		return r.Header.Get(name)
	})
}

// DecodeEnvelope reads envelope fields using the provided getter.
func DecodeEnvelope(get func(string) string) Envelope {
	subject := ""
	if a := get(HeaderAuthorization); a != "" && len(a) > 7 && strings.EqualFold(a[:7], "Bearer ") {
		subject = strings.TrimSpace(a[7:])
	}
	traceID := ""
	if tp := get(HeaderTraceparent); tp != "" {
		traceID = ParseTraceparent(tp)
	}
	bag := ParseBaggage(get(HeaderBaggage))
	hop := 0
	if raw := bag[BaggageHop]; raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			hop = max(0, min(MaxHop, n))
		}
	}
	return Envelope{
		SubjectToken:     subject,
		AgentSessionID:   bag[BaggageAgentSession],
		DelegationEdgeID: bag[BaggageDelegationEdge],
		ParentEdgeID:     bag[BaggageParentEdge],
		SessionID:        bag[BaggageSession],
		TraceID:          traceID,
		Hop:              hop,
	}
}

// EncodeEnvelope writes envelope fields using the provided setter.
func EncodeEnvelope(env Envelope, set func(name, value string)) {
	if env.SubjectToken != "" {
		set(HeaderAuthorization, "Bearer "+env.SubjectToken)
	}
	traceID := env.TraceID
	if traceID == "" || !traceIDRE.MatchString(traceID) {
		traceID = newTraceID()
	}
	set(HeaderTraceparent, FormatTraceparent(traceID))
	bag := EncodeBaggage(map[string]string{
		BaggageAgentSession:   env.AgentSessionID,
		BaggageDelegationEdge: env.DelegationEdgeID,
		BaggageParentEdge:     env.ParentEdgeID,
		BaggageSession:        env.SessionID,
		BaggageHop:            strconv.Itoa(env.Hop),
	})
	if bag != "" {
		set(HeaderBaggage, bag)
	}
}

// InjectHTTP sets Caracal headers on an outbound http.Header.
func InjectHTTP(env Envelope, h http.Header) {
	EncodeEnvelope(env, func(name, value string) {
		h.Set(http.CanonicalHeaderKey(name), value)
	})
}

// ToHeaders serializes the envelope to a plain string map (for gRPC metadata,
// MCP _meta, queue headers, etc.).
func ToHeaders(env Envelope) map[string]string {
	out := make(map[string]string, 4)
	EncodeEnvelope(env, func(name, value string) {
		out[name] = value
	})
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
