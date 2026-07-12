// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// STS approval hold issuance and lifecycle state tests.

package internal

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

type approvalStoreDB struct {
	stubDB
	stored  *StepUpChallengePG
	created bool
	err     error
}

func (db *approvalStoreDB) GetOrCreateApprovalChallenge(_ context.Context, c *StepUpChallengePG) (*StepUpChallengePG, bool, error) {
	if db.err != nil {
		return nil, false, db.err
	}
	if db.stored != nil {
		return db.stored, false, nil
	}
	db.stored = c
	db.created = true
	return c, true, nil
}

func TestEnsureApprovalPersistsResolvedHold(t *testing.T) {
	db := &approvalStoreDB{}
	server := &Server{db: db}
	approval := resolvedApproval{Tier: "money", Approver: ApproverClassSubject, TTL: 10 * time.Minute, Privacy: PrivacyAnonymous}
	bundle := ZoneBundleInfo{PolicySetVersionID: "policy-v1", ManifestSHA: "manifest-v1", DecisionContractVersion: "contract-v1", DecisionContractSHA: "contract-sha-v1"}
	before := time.Now()
	hold, created, err := server.ensureApproval(context.Background(), "zone-1", "session-1", "agent-session-1", "edge-1", "principal-1", "app-1", approval, bundle, []string{" Resource://B ", "resource://a"}, []string{"nucleus:pay"}, []string{"case:CASE-1", "payout-execution"})
	if err != nil {
		t.Fatalf("ensure approval: %v", err)
	}
	if !created || db.stored == nil {
		t.Fatal("hold was not persisted")
	}
	if hold.ID == "" || hold.ZoneID != "zone-1" || hold.AuthorityRecordID != "session-1" || hold.PrincipalID != "principal-1" || hold.ApplicationID != "app-1" {
		t.Fatalf("unexpected hold: %+v", hold)
	}
	if hold.ChallengeType != humanApprovalChallengeType || hold.Tier != "money" || hold.ApproverClass != ApproverClassSubject || hold.PrivacyMode != PrivacyAnonymous {
		t.Fatalf("resolved declaration not carried: %+v", hold)
	}
	want := hashApprovalBinding([]string{"resource://a", "resource://b"}, []string{"nucleus:pay"}, approvalBindingContext{
		PrincipalID:       "principal-1",
		AuthorityRecordID: "session-1",
		SessionID:         "agent-session-1",
		DelegationEdgeID:  "edge-1",
		ApplicationID:     "app-1",
		Bundle:            bundle,
	})
	if string(hold.ResourceSetHash) != string(want) {
		t.Fatal("hold must bind the canonical resource and scope set")
	}
	if hold.ExpiresAt.Before(before.Add(10*time.Minute-time.Second)) || hold.ExpiresAt.After(time.Now().Add(10*time.Minute+time.Second)) {
		t.Fatalf("unexpected hold expiry: %s", hold.ExpiresAt)
	}
	var meta map[string]any
	if err := json.Unmarshal(hold.MetadataJSON, &meta); err != nil {
		t.Fatalf("hold metadata: %v", err)
	}
	if meta["agent_session_id"] != "agent-session-1" || meta["delegation_edge_id"] != "edge-1" {
		t.Fatalf("agent lineage not carried in hold metadata: %v", meta)
	}
	if labels, ok := meta["agent_labels"].([]any); !ok || len(labels) != 2 || labels[0] != "case:CASE-1" || labels[1] != "payout-execution" {
		t.Fatalf("requesting session labels not carried in hold metadata: %v", meta)
	}
	if meta["policy_manifest_sha"] != "manifest-v1" || meta["decision_contract_sha"] != "contract-sha-v1" {
		t.Fatalf("policy provenance not carried in hold metadata: %v", meta)
	}
}

func TestEnsureApprovalConvergesOnLiveHold(t *testing.T) {
	live := &StepUpChallengePG{ID: "existing", ZoneID: "zone-1", ChallengeType: humanApprovalChallengeType}
	db := &approvalStoreDB{stored: live}
	hold, created, err := (&Server{db: db}).ensureApproval(context.Background(), "zone-1", "session-1", "", "", "principal-1", "app-1", resolvedApproval{Tier: "money", Approver: ApproverClassOperator, TTL: time.Minute, Privacy: PrivacyIdentified}, ZoneBundleInfo{}, []string{"resource://a"}, nil, nil)
	if err != nil {
		t.Fatalf("ensure approval: %v", err)
	}
	if created || hold.ID != "existing" {
		t.Fatalf("duplicate mint must converge on the live hold, got created=%v hold=%+v", created, hold)
	}
}

func TestEnsureApprovalReturnsStoreErrors(t *testing.T) {
	want := errors.New("database unavailable")
	_, _, err := (&Server{db: &approvalStoreDB{err: want}}).ensureApproval(context.Background(), "zone-1", "session-1", "", "", "principal-1", "app-1", resolvedApproval{Tier: "money", Approver: ApproverClassOperator, TTL: time.Minute, Privacy: PrivacyIdentified}, ZoneBundleInfo{}, nil, nil, nil)
	if !errors.Is(err, want) {
		t.Fatalf("want store error, got %v", err)
	}
}

func TestChallengeLifecycleState(t *testing.T) {
	now := time.Now()
	live := now.Add(time.Minute)
	past := now.Add(-time.Minute)
	cases := []struct {
		name      string
		challenge StepUpChallengePG
		want      string
	}{
		{"pending", StepUpChallengePG{ExpiresAt: live}, ChallengeStatePending},
		{"approved", StepUpChallengePG{ExpiresAt: live, SatisfiedAt: &now}, ChallengeStateApproved},
		{"rejected", StepUpChallengePG{ExpiresAt: live, RejectedAt: &now}, ChallengeStateRejected},
		{"expired", StepUpChallengePG{ExpiresAt: past}, ChallengeStateExpired},
		{"expired approval reads expired", StepUpChallengePG{ExpiresAt: past, SatisfiedAt: &now}, ChallengeStateExpired},
		{"consumed outranks expiry", StepUpChallengePG{ExpiresAt: past, SatisfiedAt: &now, ConsumedAt: &now}, ChallengeStateConsumed},
		{"rejected outranks expiry", StepUpChallengePG{ExpiresAt: past, RejectedAt: &now}, ChallengeStateRejected},
	}
	for _, tc := range cases {
		if got := challengeLifecycleState(&tc.challenge, now); got != tc.want {
			t.Errorf("%s: want %q, got %q", tc.name, tc.want, got)
		}
	}
}
