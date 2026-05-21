// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for CaracalContext bind/current and envelope projection.

package sdk_test

import (
	"context"
	"strings"
	"testing"

	sdk "github.com/garudex-labs/caracal/packages/sdk/go"
)

func TestBindCurrentRoundTrip(t *testing.T) {
	c := sdk.CaracalContext{
		SubjectToken:     "tok",
		ZoneID:           "z1",
		ClientID:         "app1",
		AgentSessionID:   "sess",
		DelegationEdgeID: "edge",
		SessionID:        "sid",
		Hop:              2,
	}
	ctx := sdk.Bind(context.Background(), c)
	got, ok := sdk.Current(ctx)
	if !ok {
		t.Fatal("Current must return true after Bind")
	}
	if got.SubjectToken != c.SubjectToken {
		t.Errorf("SubjectToken: %q vs %q", got.SubjectToken, c.SubjectToken)
	}
	if got.ZoneID != c.ZoneID {
		t.Errorf("ZoneID: %q vs %q", got.ZoneID, c.ZoneID)
	}
	if got.Hop != c.Hop {
		t.Errorf("Hop: %d vs %d", got.Hop, c.Hop)
	}
}

func TestCurrentOnFreshContext(t *testing.T) {
	_, ok := sdk.Current(context.Background())
	if ok {
		t.Error("Current must return false on a context with no Bind")
	}
}

func TestBindDoesNotMutateParent(t *testing.T) {
	parent := context.Background()
	sdk.Bind(parent, sdk.CaracalContext{SubjectToken: "tok"})
	_, ok := sdk.Current(parent)
	if ok {
		t.Error("Bind must not modify the parent context")
	}
}

func TestFromEnvelopeFullFields(t *testing.T) {
	env := sdk.Envelope{
		SubjectToken:     "tok",
		AgentSessionID:   "sess",
		DelegationEdgeID: "edge",
		ParentEdgeID:     "parent",
		SessionID:        "sid",
		TraceID:          "0123456789abcdef0123456789abcdef",
		Hop:              4,
	}
	c, err := sdk.FromEnvelope(env, "zone1", "app1")
	if err != nil {
		t.Fatal(err)
	}
	if c.SubjectToken != "tok" {
		t.Errorf("SubjectToken: %q", c.SubjectToken)
	}
	if c.ZoneID != "zone1" {
		t.Errorf("ZoneID: %q", c.ZoneID)
	}
	if c.AgentSessionID != "sess" {
		t.Errorf("AgentSessionID: %q", c.AgentSessionID)
	}
	if c.SessionID != "sid" {
		t.Errorf("SessionID: %q", c.SessionID)
	}
	if c.Hop != 4 {
		t.Errorf("Hop: %d", c.Hop)
	}
}

func TestFromEnvelopeMissingSubjectTokenErrors(t *testing.T) {
	_, err := sdk.FromEnvelope(sdk.Envelope{}, "z", "a")
	if err == nil {
		t.Fatal("expected error for missing subject token")
	}
}

func TestToEnvelopeRoundTrip(t *testing.T) {
	c := sdk.CaracalContext{
		SubjectToken:     "tok",
		AgentSessionID:   "sess",
		DelegationEdgeID: "edge",
		ParentEdgeID:     "parent",
		SessionID:        "sid",
		TraceID:          "0123456789abcdef0123456789abcdef",
		Hop:              2,
	}
	env := sdk.ToEnvelope(c)
	if env.SubjectToken != c.SubjectToken {
		t.Errorf("SubjectToken: %q vs %q", env.SubjectToken, c.SubjectToken)
	}
	if env.AgentSessionID != c.AgentSessionID {
		t.Errorf("AgentSessionID: %q vs %q", env.AgentSessionID, c.AgentSessionID)
	}
	if env.TraceID != c.TraceID {
		t.Errorf("TraceID: %q vs %q", env.TraceID, c.TraceID)
	}
	if env.SessionID != c.SessionID {
		t.Errorf("SessionID: %q vs %q", env.SessionID, c.SessionID)
	}
	if env.Hop != c.Hop {
		t.Errorf("Hop: %d vs %d", env.Hop, c.Hop)
	}
}

func TestToEnvelopeFromEnvelopeRoundTrip(t *testing.T) {
	orig := sdk.CaracalContext{
		SubjectToken:     "tok",
		ZoneID:           "z",
		ClientID:         "app",
		AgentSessionID:   "sess",
		DelegationEdgeID: "edge",
		SessionID:        "sid",
		Hop:              1,
	}
	env := sdk.ToEnvelope(orig)
	restored, err := sdk.FromEnvelope(env, orig.ZoneID, orig.ClientID)
	if err != nil {
		t.Fatal(err)
	}
	if restored.SubjectToken != orig.SubjectToken {
		t.Errorf("SubjectToken mismatch")
	}
	if restored.AgentSessionID != orig.AgentSessionID {
		t.Errorf("AgentSessionID mismatch")
	}
	if restored.SessionID != orig.SessionID {
		t.Errorf("SessionID mismatch")
	}
}

func TestDescribeAuthorityRedactsSubjectToken(t *testing.T) {
	ctx := sdk.Bind(context.Background(), sdk.CaracalContext{
		SubjectToken:     "tok",
		ZoneID:           "z",
		ClientID:         "app",
		SessionID:        "sid",
		AgentSessionID:   "agent",
		DelegationEdgeID: "edge",
		Hop:              2,
	})
	summary, ok := sdk.DescribeAuthority(ctx)
	if !ok {
		t.Fatal("DescribeAuthority must return a summary for a bound context")
	}
	if summary.ApplicationID != "app" || summary.AuthoritySessionID != "sid" || summary.AgentRunID != "agent" {
		t.Fatalf("unexpected summary: %#v", summary)
	}
	got := strings.Join(summary.Chain, ">")
	want := "authority:sid>agent-run:agent>delegated-permission:edge"
	if got != want {
		t.Fatalf("chain = %q, want %q", got, want)
	}
}
