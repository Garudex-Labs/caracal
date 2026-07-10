// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for CaracalContext bind/current and envelope projection.

package sdk_test

import (
	"context"
	"runtime"
	"strings"
	"sync"
	"testing"

	sdk "github.com/garudex-labs/caracal/packages/sdk/go"
)

func TestBindCurrentRoundTrip(t *testing.T) {
	c := sdk.CaracalContext{
		SubjectToken:             "tok",
		ZoneID:                   "z1",
		ApplicationID:            "app1",
		SessionID:                "sess",
		DelegationID:             "edge",
		SubjectAuthorityRecordID: "sid",
		Hop:                      2,
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

func TestCaptureReturnsCurrentContext(t *testing.T) {
	want := sdk.CaracalContext{SubjectToken: "tok", ZoneID: "z1", ApplicationID: "app1"}
	got, ok := sdk.Capture(sdk.Bind(context.Background(), want))
	if !ok {
		t.Fatal("Capture must return true after Bind")
	}
	if got.SubjectToken != want.SubjectToken || got.ZoneID != want.ZoneID || got.ApplicationID != want.ApplicationID {
		t.Fatalf("Capture = %#v, want %#v", got, want)
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

func TestBindClonesBaggage(t *testing.T) {
	baggage := map[string]string{"tenant": "piedpiper"}
	ctx := sdk.Bind(context.Background(), sdk.CaracalContext{SubjectToken: "tok", Baggage: baggage})
	baggage["tenant"] = "hooli"

	bound, _ := sdk.Current(ctx)
	if bound.Baggage["tenant"] != "piedpiper" {
		t.Errorf("bound baggage = %q, want isolation from caller mutation", bound.Baggage["tenant"])
	}

	bound.Baggage["tenant"] = "endframe"
	again, _ := sdk.Current(ctx)
	if again.Baggage["tenant"] != "piedpiper" {
		t.Errorf("stored baggage = %q, want isolation from reader mutation", again.Baggage["tenant"])
	}
}

func TestBindIsolatesConcurrentGoroutines(t *testing.T) {
	agents := []string{"agent-a", "agent-b", "agent-c"}
	results := make([]string, len(agents))
	var wg sync.WaitGroup
	for i, agent := range agents {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx := sdk.Bind(context.Background(), sdk.CaracalContext{SubjectToken: "tok", SessionID: agent})
			runtime.Gosched()
			got, _ := sdk.Current(ctx)
			results[i] = got.SessionID
		}()
	}
	wg.Wait()
	for i, agent := range agents {
		if results[i] != agent {
			t.Errorf("goroutine %d saw %q, want %q", i, results[i], agent)
		}
	}
}

func TestFromEnvelopeFullFields(t *testing.T) {
	env := sdk.Envelope{
		SubjectToken:             "tok",
		SessionID:                "sess",
		DelegationID:             "edge",
		ParentDelegationID:       "parent",
		SubjectAuthorityRecordID: "sid",
		TraceID:                  "0123456789abcdef0123456789abcdef",
		Hop:                      4,
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
	if c.SessionID != "sess" {
		t.Errorf("SessionID: %q", c.SessionID)
	}
	if c.SubjectAuthorityRecordID != "sid" {
		t.Errorf("SessionID: %q", c.SubjectAuthorityRecordID)
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
		SubjectToken:             "tok",
		SessionID:                "sess",
		DelegationID:             "edge",
		ParentDelegationID:       "parent",
		SubjectAuthorityRecordID: "sid",
		TraceID:                  "0123456789abcdef0123456789abcdef",
		Hop:                      2,
	}
	env := sdk.ToEnvelope(c)
	if env.SubjectToken != c.SubjectToken {
		t.Errorf("SubjectToken: %q vs %q", env.SubjectToken, c.SubjectToken)
	}
	if env.SessionID != c.SessionID {
		t.Errorf("SessionID: %q vs %q", env.SessionID, c.SessionID)
	}
	if env.TraceID != c.TraceID {
		t.Errorf("TraceID: %q vs %q", env.TraceID, c.TraceID)
	}
	if env.SubjectAuthorityRecordID != c.SubjectAuthorityRecordID {
		t.Errorf("SessionID: %q vs %q", env.SubjectAuthorityRecordID, c.SubjectAuthorityRecordID)
	}
	if env.Hop != c.Hop {
		t.Errorf("Hop: %d vs %d", env.Hop, c.Hop)
	}
}

func TestToEnvelopeFromEnvelopeRoundTrip(t *testing.T) {
	orig := sdk.CaracalContext{
		SubjectToken:             "tok",
		ZoneID:                   "z",
		ApplicationID:            "app",
		SessionID:                "sess",
		DelegationID:             "edge",
		SubjectAuthorityRecordID: "sid",
		Hop:                      1,
	}
	env := sdk.ToEnvelope(orig)
	restored, err := sdk.FromEnvelope(env, orig.ZoneID, orig.ApplicationID)
	if err != nil {
		t.Fatal(err)
	}
	if restored.SubjectToken != orig.SubjectToken {
		t.Errorf("SubjectToken mismatch")
	}
	if restored.SessionID != orig.SessionID {
		t.Errorf("SessionID mismatch")
	}
	if restored.SubjectAuthorityRecordID != orig.SubjectAuthorityRecordID {
		t.Errorf("SessionID mismatch")
	}
}

func TestDescribeAuthorityRedactsSubjectToken(t *testing.T) {
	ctx := sdk.Bind(context.Background(), sdk.CaracalContext{
		SubjectToken:             "tok",
		ZoneID:                   "z",
		ApplicationID:            "app",
		SubjectAuthorityRecordID: "sid",
		SessionID:                "agent",
		DelegationID:             "edge",
		Hop:                      2,
	})
	summary, ok := sdk.DescribeAuthority(ctx)
	if !ok {
		t.Fatal("DescribeAuthority must return a summary for a bound context")
	}
	if summary.ApplicationID != "app" || summary.SubjectAuthorityRecordID != "sid" || summary.SessionID != "agent" {
		t.Fatalf("unexpected summary: %#v", summary)
	}
	got := strings.Join(summary.Chain, ">")
	want := "subject:sid>session:agent>delegation:edge"
	if got != want {
		t.Fatalf("chain = %q, want %q", got, want)
	}
}

func TestDescribeAuthorityIncludesParentDelegationAndFreshContextFalse(t *testing.T) {
	if _, ok := sdk.DescribeAuthority(context.Background()); ok {
		t.Fatal("fresh context should not describe authority")
	}
	summary := sdk.DescribeContext(sdk.CaracalContext{
		SubjectAuthorityRecordID: "sid",
		SessionID:                "agent",
		ParentDelegationID:       "parent-edge",
		DelegationID:             "edge",
	})
	got := strings.Join(summary.Chain, ">")
	want := "subject:sid>session:agent>parent-delegation:parent-edge>delegation:edge"
	if got != want {
		t.Fatalf("chain = %q, want %q", got, want)
	}
}
