// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Human-approval step-up: tier declaration resolution, idempotent challenge issuance, and binding hashes.

package internal

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	// humanApprovalChallengeType is the only step-up type the decision contract emits:
	// a durable hold satisfied out-of-band by an authenticated approver.
	humanApprovalChallengeType = "human_approval"

	approvalDefaultTTL = 30 * time.Minute
	approvalMinTTL     = time.Minute
	approvalMaxTTL     = 7 * 24 * time.Hour

	// Approver classes: who may decide a hold. operator is a control-plane approver
	// holding an approve-capable admin credential; subject is an authenticated end user
	// of the requesting application deciding through the STS decision endpoint; any
	// admits either plane.
	ApproverClassOperator = "operator"
	ApproverClassSubject  = "subject"
	ApproverClassAny      = "any"

	// Privacy modes: how much approver identity the decision record retains. identified
	// stores the approver subject verbatim, pseudonymous stores a stable zone-scoped
	// pseudonym, anonymous stores a redaction marker; the approver's authority record id is
	// always retained as the forensic and revocation anchor.
	PrivacyIdentified   = "identified"
	PrivacyPseudonymous = "pseudonymous"
	PrivacyAnonymous    = "anonymous"
)

// Challenge lifecycle states surfaced on the wire.
const (
	ChallengeStatePending  = "pending"
	ChallengeStateApproved = "approved"
	ChallengeStateRejected = "rejected"
	ChallengeStateExpired  = "expired"
	ChallengeStateConsumed = "consumed"
)

// tierDeclaration is one approval gate declaration matched by the decision contract:
// the adopter's opaque tier name plus the optional hold shape.
type tierDeclaration struct {
	Tier       string
	Approver   string
	TTLSeconds int
	Privacy    string
}

// resolvedApproval is the merged hold shape when one mint matches several gated tiers.
type resolvedApproval struct {
	Tier     string
	Approver string
	TTL      time.Duration
	Privacy  string
}

// parseTierDeclarations decodes the step_up_required diagnostic emitted by the decision
// contract into tier declarations. The diagnostic value is an object naming the
// challenge type and the matched declarations. A malformed entry is skipped rather than
// guessed at: the contract already fails the mint closed when approval data is
// malformed, so nothing reachable here depends on repairing bad data.
func parseTierDeclarations(result *OPAResult) []tierDeclaration {
	var decls []tierDeclaration
	for _, d := range result.Diagnostics {
		gate, ok := d["step_up_required"].(map[string]any)
		if !ok {
			continue
		}
		tiers, ok := gate["tiers"].([]any)
		if !ok {
			continue
		}
		for _, raw := range tiers {
			entry, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			tier, _ := entry["tier"].(string)
			if tier == "" {
				continue
			}
			decl := tierDeclaration{Tier: tier}
			decl.Approver, _ = entry["approver"].(string)
			decl.Privacy, _ = entry["privacy"].(string)
			switch ttl := entry["ttl_seconds"].(type) {
			case json.Number:
				if v, err := ttl.Int64(); err == nil {
					decl.TTLSeconds = int(v)
				}
			case float64:
				decl.TTLSeconds = int(ttl)
			}
			decls = append(decls, decl)
		}
	}
	return decls
}

// resolveApproval merges every matched tier declaration into one hold shape. The tier
// label joins the distinct matched tiers. The approver class resolves to the most
// trusted class any declaration demands, operator over subject over any, so a scope
// gated on operator review can never be released by a subject decision another scope's
// tier would admit. The TTL is the shortest declared window, clamped to the platform
// floor and ceiling. Privacy resolves to the most protective mode declared, so a tier
// promising approver anonymity keeps that promise even when merged with an identified
// tier. Absent or invalid values take the platform defaults: operator, thirty minutes,
// identified.
func resolveApproval(decls []tierDeclaration) resolvedApproval {
	tiers := map[string]struct{}{}
	approver := ""
	privacy := ""
	ttl := time.Duration(0)
	for _, decl := range decls {
		tiers[decl.Tier] = struct{}{}
		approver = strongerApprover(approver, normalizeApprover(decl.Approver))
		privacy = strongerPrivacy(privacy, normalizePrivacy(decl.Privacy))
		declTTL := approvalDefaultTTL
		if decl.TTLSeconds > 0 {
			declTTL = time.Duration(decl.TTLSeconds) * time.Second
		}
		if ttl == 0 || declTTL < ttl {
			ttl = declTTL
		}
	}
	if ttl == 0 {
		ttl = approvalDefaultTTL
	}
	if ttl < approvalMinTTL {
		ttl = approvalMinTTL
	}
	if ttl > approvalMaxTTL {
		ttl = approvalMaxTTL
	}
	names := make([]string, 0, len(tiers))
	for name := range tiers {
		names = append(names, name)
	}
	sort.Strings(names)
	return resolvedApproval{
		Tier:     strings.Join(names, ","),
		Approver: approver,
		TTL:      ttl,
		Privacy:  privacy,
	}
}

func normalizeApprover(value string) string {
	switch value {
	case ApproverClassOperator, ApproverClassSubject, ApproverClassAny:
		return value
	}
	return ApproverClassOperator
}

func normalizePrivacy(value string) string {
	switch value {
	case PrivacyIdentified, PrivacyPseudonymous, PrivacyAnonymous:
		return value
	}
	return PrivacyIdentified
}

var approverRank = map[string]int{ApproverClassAny: 0, ApproverClassSubject: 1, ApproverClassOperator: 2}

func strongerApprover(a, b string) string {
	if a == "" {
		return b
	}
	if approverRank[b] > approverRank[a] {
		return b
	}
	return a
}

var privacyRank = map[string]int{PrivacyIdentified: 0, PrivacyPseudonymous: 1, PrivacyAnonymous: 2}

func strongerPrivacy(a, b string) string {
	if a == "" {
		return b
	}
	if privacyRank[b] > privacyRank[a] {
		return b
	}
	return a
}

// challengeState is the in-memory view of a step-up challenge surfaced on the wire.
type challengeState struct {
	ID                string
	ZoneID            string
	AuthorityRecordID string
	ChallengeType     string
	State             string
	Tier              string
	Binding           []byte
	ExpiresAt         time.Time
}

// challengeLifecycleState derives the wire state from a stored challenge row. A
// terminal decision outranks expiry so a consumed or rejected hold reads as what was
// decided, not merely as expired.
func challengeLifecycleState(c *StepUpChallengePG, now time.Time) string {
	switch {
	case c.ConsumedAt != nil:
		return ChallengeStateConsumed
	case c.RejectedAt != nil:
		return ChallengeStateRejected
	case !c.ExpiresAt.After(now):
		return ChallengeStateExpired
	case c.SatisfiedAt != nil:
		return ChallengeStateApproved
	default:
		return ChallengeStatePending
	}
}

// ensureApproval issues the approval hold for one exact authority binding, or converges
// on the live one. Issuance is idempotent: expired unconsumed holds for the binding are
// purged, then a single live row per (zone, principal, session, request hash) is either
// created or returned, so duplicate mints share one challenge, a rejection stays
// authoritative until it expires, and a decided hold is found again by the retry that
// consumes it. Agent lineage rides in the hold's metadata so an approver can trace the
// requesting agent run before deciding. The second return reports whether a new hold was
// created.
func (s *Server) ensureApproval(ctx context.Context, zoneID, authorityRecordID, sessionID, delegationEdgeID, principalID, applicationID string, approval resolvedApproval, resources, scopes []string) (*StepUpChallengePG, bool, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, false, err
	}
	now, err := s.db.CurrentTime(ctx)
	if err != nil {
		return nil, false, err
	}
	meta := map[string]any{
		"requested_scopes": scopes,
		"resources":        resources,
	}
	if sessionID != "" {
		meta["agent_session_id"] = sessionID
	}
	if delegationEdgeID != "" {
		meta["delegation_edge_id"] = delegationEdgeID
	}
	metadata, _ := json.Marshal(meta)
	return s.db.GetOrCreateApprovalChallenge(ctx, &StepUpChallengePG{
		ID:                id.String(),
		ZoneID:            zoneID,
		AuthorityRecordID: authorityRecordID,
		ChallengeType:     humanApprovalChallengeType,
		PrincipalID:       principalID,
		ApplicationID:     applicationID,
		Tier:              approval.Tier,
		ApproverClass:     approval.Approver,
		PrivacyMode:       approval.Privacy,
		ResourceSetHash:   hashApprovalBinding(resources, scopes),
		ExpiresAt:         now.Add(approval.TTL),
		MetadataJSON:      metadata,
	})
}

// consumeApproval atomically consumes an approved challenge iff every binding matches:
// zone, principal, the request hash over resources and scopes, an approver decision, no
// rejection, not expired, not yet consumed, and the originating session still active.
// Called as late as possible in the mint so a downstream deny never burns an approval.
func (s *Server) consumeApproval(ctx context.Context, zoneID, principalID, challengeID string, resources, scopes []string) error {
	if challengeID == "" {
		return ErrChallengeInvalid
	}
	now, err := s.db.CurrentTime(ctx)
	if err != nil {
		return err
	}
	return s.db.ConsumeApprovalChallenge(ctx, ConsumeApprovalParams{
		ID:              challengeID,
		ZoneID:          zoneID,
		PrincipalID:     principalID,
		ResourceSetHash: hashApprovalBinding(resources, scopes),
		Now:             now,
	})
}

// ErrChallengeInvalid means the supplied challenge did not match a live binding.
var ErrChallengeInvalid = errors.New("step-up challenge invalid or expired")

// ErrChallengeAlreadyConsumed means the challenge was already consumed by another request.
var ErrChallengeAlreadyConsumed = errors.New("step-up challenge already consumed")

// hashApprovalBinding binds an approval to both the resource set and the requested
// scope set. Binding the scopes is what stops an approval granted for one scope from
// being replayed to mint a mandate carrying a different, more powerful scope on the
// same resources. The two canonical lists are joined under disjoint section markers so
// a resource and a scope of the same text cannot collide.
func hashApprovalBinding(resources, scopes []string) []byte {
	canonResources := make([]string, 0, len(resources))
	for _, r := range resources {
		canonResources = append(canonResources, strings.ToLower(strings.TrimSpace(r)))
	}
	sort.Strings(canonResources)
	canonScopes := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		canonScopes = append(canonScopes, strings.TrimSpace(scope))
	}
	sort.Strings(canonScopes)
	sum := sha256.Sum256([]byte("resources\x00" + strings.Join(canonResources, "\n") + "\x00scopes\x00" + strings.Join(canonScopes, "\n")))
	return sum[:]
}
