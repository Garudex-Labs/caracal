// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Integration tests for human-approval step-up lifecycle and wire-level verification.

package internal

import (
	"context"
	"errors"
	"testing"
	"time"
)

type memoryApprovalDB struct {
	stubDB
	challenges map[string]*StepUpChallengePG
	now        time.Time
}

func newMemoryApprovalDB() *memoryApprovalDB {
	return &memoryApprovalDB{
		challenges: make(map[string]*StepUpChallengePG),
		now:        time.Now(),
	}
}

func (m *memoryApprovalDB) CurrentTime(_ context.Context) (time.Time, error) {
	return m.now, nil
}

func (m *memoryApprovalDB) GetOrCreateApprovalChallenge(_ context.Context, c *StepUpChallengePG) (*StepUpChallengePG, bool, error) {
	if existing, ok := m.challenges[c.ID]; ok {
		return existing, false, nil
	}
	m.challenges[c.ID] = c
	return c, true, nil
}

func (m *memoryApprovalDB) ConsumeApprovalChallenge(_ context.Context, params ConsumeApprovalParams) error {
	c, ok := m.challenges[params.ID]
	if !ok {
		return ErrApprovalInvalid
	}
	if c.ConsumedAt != nil {
		return ErrApprovalAlreadyConsumed
	}
	if c.RejectedAt != nil || c.SatisfiedAt == nil {
		return ErrApprovalInvalid
	}
	if !c.ExpiresAt.After(params.Now) {
		return ErrApprovalInvalid
	}
	if c.ZoneID != params.ZoneID || c.PrincipalID != params.PrincipalID {
		return ErrApprovalInvalid
	}
	now := params.Now
	c.ConsumedAt = &now
	return nil
}

func TestApprovalFlowLifecycleIntegration(t *testing.T) {
	db := newMemoryApprovalDB()
	srv := &Server{db: db}

	ctx := context.Background()
	zoneID := "zone-op-integration"
	sessionID := "sess-op-1"
	principalID := "user-requester"
	resources := []string{"resource://finance/transfer", "resource://audit/logs"}
	scopes := []string{"read", "write"}
	bundle := ZoneBundleInfo{
		PolicySetVersionID:      "psv-1",
		ManifestSHA:             "sha-1",
		DecisionContractVersion: "v1",
		DecisionContractSHA:     "dsha-1",
	}

	resolved := resolvedApproval{
		Tier:     "tier-operator",
		Approver: ApproverClassOperator,
		TTL:      15 * time.Minute,
		Privacy:  PrivacyIdentified,
	}

	// Step 1: ensureApproval creates a new pending step-up challenge
	challenge, created, err := srv.ensureApproval(
		ctx, zoneID, "auth-rec-1", sessionID, "edge-1", principalID, "app-1", "", resolved, bundle, resources, scopes, nil,
	)
	if err != nil {
		t.Fatalf("ensureApproval failed: %v", err)
	}
	if !created {
		t.Fatal("expected new approval challenge to be created")
	}

	// Verify state is Pending
	if got := approvalLifecycleState(challenge, db.now); got != ApprovalStatePending {
		t.Fatalf("expected state %s, got %s", ApprovalStatePending, got)
	}

	// Step 2: Simulate Admin Satisfaction (Approval Path)
	now := db.now
	challenge.SatisfiedAt = &now

	if got := approvalLifecycleState(challenge, db.now); got != ApprovalStateApproved {
		t.Fatalf("expected state %s, got %s", ApprovalStateApproved, got)
	}

	binding := approvalBindingContext{
		PrincipalID:       principalID,
		AuthorityRecordID: "auth-rec-1",
		SessionID:         sessionID,
		DelegationEdgeID:  "edge-1",
		ApplicationID:     "app-1",
		Bundle:            bundle,
	}

	// Step 3: Consume approval
	err = srv.consumeApproval(ctx, zoneID, principalID, challenge.ID, resources, scopes, binding)
	if err != nil {
		t.Fatalf("consumeApproval failed on satisfied challenge: %v", err)
	}

	if got := approvalLifecycleState(challenge, db.now); got != ApprovalStateConsumed {
		t.Fatalf("expected state %s, got %s", ApprovalStateConsumed, got)
	}

	// Step 4: Replay Protection -> second consumption attempt fails with ErrApprovalAlreadyConsumed
	err = srv.consumeApproval(ctx, zoneID, principalID, challenge.ID, resources, scopes, binding)
	if !errors.Is(err, ErrApprovalAlreadyConsumed) {
		t.Fatalf("expected ErrApprovalAlreadyConsumed on replay, got: %v", err)
	}
}

func TestApprovalFlowRejectionLifecycleIntegration(t *testing.T) {
	db := newMemoryApprovalDB()
	srv := &Server{db: db}

	ctx := context.Background()
	zoneID := "zone-op-integration"
	sessionID := "sess-op-2"
	principalID := "user-requester-2"
	resources := []string{"resource://finance/payout"}
	scopes := []string{"write"}
	bundle := ZoneBundleInfo{PolicySetVersionID: "psv-1"}

	resolved := resolvedApproval{
		Tier:     "tier-user",
		Approver: ApproverClassSubject,
		TTL:      15 * time.Minute,
		Privacy:  PrivacyIdentified,
	}

	challenge, _, err := srv.ensureApproval(
		ctx, zoneID, "auth-rec-2", sessionID, "", principalID, "app-1", "user-anchor", resolved, bundle, resources, scopes, nil,
	)
	if err != nil {
		t.Fatalf("ensureApproval failed: %v", err)
	}

	// Simulate Rejection
	now := db.now
	challenge.RejectedAt = &now

	if got := approvalLifecycleState(challenge, db.now); got != ApprovalStateRejected {
		t.Fatalf("expected state %s, got %s", ApprovalStateRejected, got)
	}

	binding := approvalBindingContext{
		PrincipalID:       principalID,
		AuthorityRecordID: "auth-rec-2",
		SessionID:         sessionID,
		ApplicationID:     "app-1",
		Bundle:            bundle,
	}

	// Attempting to consume a rejected challenge fails
	err = srv.consumeApproval(ctx, zoneID, principalID, challenge.ID, resources, scopes, binding)
	if !errors.Is(err, ErrApprovalInvalid) {
		t.Fatalf("expected ErrApprovalInvalid for rejected challenge, got: %v", err)
	}
}

func TestApprovalFlowExpiryLifecycleIntegration(t *testing.T) {
	db := newMemoryApprovalDB()
	srv := &Server{db: db}

	ctx := context.Background()
	zoneID := "zone-op-integration"
	sessionID := "sess-op-3"
	principalID := "user-requester-3"
	resources := []string{"resource://audit"}
	scopes := []string{"read"}
	bundle := ZoneBundleInfo{PolicySetVersionID: "psv-1"}

	resolved := resolvedApproval{
		Tier:     "tier-operator",
		Approver: ApproverClassOperator,
		TTL:      15 * time.Minute,
		Privacy:  PrivacyIdentified,
	}

	challenge, _, err := srv.ensureApproval(
		ctx, zoneID, "auth-rec-3", sessionID, "", principalID, "app-1", "", resolved, bundle, resources, scopes, nil,
	)
	if err != nil {
		t.Fatalf("ensureApproval failed: %v", err)
	}

	// Advance time past expiration window
	futureTime := db.now.Add(30 * time.Minute)

	if got := approvalLifecycleState(challenge, futureTime); got != ApprovalStateExpired {
		t.Fatalf("expected state %s, got %s", ApprovalStateExpired, got)
	}

	// Attempting to consume an expired challenge fails
	db.now = futureTime
	binding := approvalBindingContext{
		PrincipalID:       principalID,
		AuthorityRecordID: "auth-rec-3",
		SessionID:         sessionID,
		ApplicationID:     "app-1",
		Bundle:            bundle,
	}

	err = srv.consumeApproval(ctx, zoneID, principalID, challenge.ID, resources, scopes, binding)
	if !errors.Is(err, ErrApprovalInvalid) {
		t.Fatalf("expected ErrApprovalInvalid for expired challenge, got: %v", err)
	}
}
