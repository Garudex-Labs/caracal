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

	// Approval lifetimes are class-scoped and independent of session lifetimes. A
	// subject decision is an interactive consent moment, so its window defaults to
	// minutes and caps at a day; an operator decision is an administrative review,
	// so its window defaults to hours and caps at a week. A declaration's
	// ttl_seconds tunes the window inside its class bounds; an expired hold never
	// resumes anything, and the requester simply raises a fresh one.
	approvalSubjectDefaultTTL  = 15 * time.Minute
	approvalOperatorDefaultTTL = 4 * time.Hour
	approvalSubjectMaxTTL      = 24 * time.Hour
	approvalOperatorMaxTTL     = 7 * 24 * time.Hour
	approvalMinTTL             = time.Minute

	// approvalReissueWindow bounds how long after consumption the same caller,
	// presenting the same complete binding, may re-issue a bearer for the authority
	// record that consumption created. It exists for exactly one failure: the mint
	// succeeded and the response was lost in transit. The window only needs to
	// outlive client retry backoff.
	approvalReissueWindow = 2 * time.Minute

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

// Approval lifecycle states surfaced on the wire.
const (
	ApprovalStatePending  = "pending"
	ApprovalStateApproved = "approved"
	ApprovalStateRejected = "rejected"
	ApprovalStateExpired  = "expired"
	ApprovalStateConsumed = "consumed"
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

type approvalBindingContext struct {
	PrincipalID       string
	AuthorityRecordID string
	SessionID         string
	DelegationEdgeID  string
	ApplicationID     string
	Bundle            ZoneBundleInfo
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

// resolveApproval merges compatible tier declarations into one hold shape. The tier
// label joins the distinct matched tiers. A specific operator or subject requirement
// narrows any, while combining operator-only and subject-only tiers is rejected because
// one decision cannot satisfy independent approver roles. The TTL is the shortest
// declared window, clamped to the resolved class's floor and ceiling; when no tier
// declares one, the class default applies. A hold decidable by a subject takes the
// subject bounds, the most protective. Privacy resolves to the most protective mode
// declared. Absent values take the platform defaults: operator and identified.
func resolveApproval(decls []tierDeclaration) (resolvedApproval, error) {
	tiers := map[string]struct{}{}
	approver := ""
	privacy := ""
	ttl := time.Duration(0)
	for _, decl := range decls {
		tiers[decl.Tier] = struct{}{}
		var err error
		approver, err = mergeApprover(approver, normalizeApprover(decl.Approver))
		if err != nil {
			return resolvedApproval{}, err
		}
		privacy = strongerPrivacy(privacy, normalizePrivacy(decl.Privacy))
		if decl.TTLSeconds > 0 {
			declTTL := time.Duration(decl.TTLSeconds) * time.Second
			if ttl == 0 || declTTL < ttl {
				ttl = declTTL
			}
		}
	}
	defaultTTL, maxTTL := approvalTTLBounds(approver)
	if ttl == 0 {
		ttl = defaultTTL
	}
	if ttl < approvalMinTTL {
		ttl = approvalMinTTL
	}
	if ttl > maxTTL {
		ttl = maxTTL
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
	}, nil
}

// approvalTTLBounds returns the default and ceiling for a hold's decision window by
// resolved approver class. A hold a subject may decide (subject or any) is an
// interactive consent and takes the short bounds; an operator-only hold is an
// administrative review and takes the long ones.
func approvalTTLBounds(approver string) (time.Duration, time.Duration) {
	if approver == ApproverClassOperator {
		return approvalOperatorDefaultTTL, approvalOperatorMaxTTL
	}
	return approvalSubjectDefaultTTL, approvalSubjectMaxTTL
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

func mergeApprover(a, b string) (string, error) {
	if a == "" {
		return b, nil
	}
	if a == b || b == ApproverClassAny {
		return a, nil
	}
	if a == ApproverClassAny {
		return b, nil
	}
	return "", ErrApprovalClassConflict
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

// approvalState is the in-memory view of an approval hold surfaced on the wire.
type approvalState struct {
	ID                string
	ZoneID            string
	AuthorityRecordID string
	ChallengeType     string
	State             string
	Tier              string
	Binding           []byte
	ExpiresAt         time.Time
}

// approvalLifecycleState derives the wire state from a stored approval row. A
// terminal decision outranks expiry so a consumed or rejected hold reads as what was
// decided, not merely as expired.
func approvalLifecycleState(c *StepUpChallengePG, now time.Time) string {
	switch {
	case c.ConsumedAt != nil:
		return ApprovalStateConsumed
	case c.RejectedAt != nil:
		return ApprovalStateRejected
	case !c.ExpiresAt.After(now):
		return ApprovalStateExpired
	case c.SatisfiedAt != nil:
		return ApprovalStateApproved
	default:
		return ApprovalStatePending
	}
}

// ensureApproval issues the approval hold for one exact authority binding, or converges
// on the live one. Issuance is idempotent: expired unconsumed holds for the binding are
// purged, then a single live row per (zone, principal, session, request hash) is either
// created or returned, so duplicate mints share one challenge, a rejection stays
// authoritative until it expires, and a decided hold is found again by the retry that
// consumes it. Agent lineage rides in the hold's metadata so an approver can trace the
// requesting agent run before deciding. subjectAnchor is the federated Subject the
// gated execution acts for, when one exists; a subject-plane decision on the hold is
// reserved for that exact Subject. The second return reports whether a new hold was
// created.
func (s *Server) ensureApproval(ctx context.Context, zoneID, authorityRecordID, sessionID, delegationEdgeID, principalID, applicationID, subjectAnchor string, approval resolvedApproval, bundle ZoneBundleInfo, resources, scopes, labels []string) (*StepUpChallengePG, bool, error) {
	// The id is an unguessable capability URL segment, so it takes the fully
	// random form rather than a time-ordered one.
	id := uuid.New()
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
	if len(labels) > 0 {
		meta["agent_labels"] = labels
	}
	if delegationEdgeID != "" {
		meta["delegation_edge_id"] = delegationEdgeID
	}
	meta["policy_set_version_id"] = bundle.PolicySetVersionID
	meta["policy_manifest_sha"] = bundle.ManifestSHA
	meta["decision_contract_version"] = bundle.DecisionContractVersion
	meta["decision_contract_sha"] = bundle.DecisionContractSHA
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
		SubjectAnchor:     subjectAnchor,
		ResourceSetHash: hashApprovalBinding(resources, scopes, approvalBindingContext{
			PrincipalID:       principalID,
			AuthorityRecordID: authorityRecordID,
			SessionID:         sessionID,
			DelegationEdgeID:  delegationEdgeID,
			ApplicationID:     applicationID,
			Bundle:            bundle,
		}),
		ExpiresAt:    now.Add(approval.TTL),
		MetadataJSON: metadata,
	})
}

// consumeApproval atomically consumes an approved challenge iff every binding matches:
// zone, principal, the request hash over resources and scopes, an approver decision, no
// rejection, not expired, not yet consumed, and the originating session still active.
// Called as late as possible in the mint so a downstream deny never burns an approval.
func (s *Server) consumeApproval(ctx context.Context, zoneID, principalID, approvalID string, resources, scopes []string, binding approvalBindingContext) error {
	if approvalID == "" {
		return ErrApprovalInvalid
	}
	now, err := s.db.CurrentTime(ctx)
	if err != nil {
		return err
	}
	return s.db.ConsumeApprovalChallenge(ctx, ConsumeApprovalParams{
		ID:              approvalID,
		ZoneID:          zoneID,
		PrincipalID:     principalID,
		ResourceSetHash: hashApprovalBinding(resources, scopes, binding),
		Now:             now,
	})
}

// ErrApprovalInvalid means the supplied approval did not match a live binding.
var ErrApprovalInvalid = errors.New("approval invalid or expired")

// ErrApprovalAlreadyConsumed means the approval was already consumed by another request.
var ErrApprovalAlreadyConsumed = errors.New("approval already consumed")

// ErrApprovalClassConflict means one mint combines scopes that require independent
// operator and subject decisions, which a single-decision hold cannot represent.
var ErrApprovalClassConflict = errors.New("approval requires separate operator and subject decisions")

// hashApprovalBinding binds an approval to the canonical resource and scope sets plus
// the principal, Authority record, governed Session, Delegation, application, active
// policy manifest, and platform decision contract. Every section has a distinct marker
// so equal text in different fields cannot collide.
func hashApprovalBinding(resources, scopes []string, binding approvalBindingContext) []byte {
	canonResources := canonicalApprovalValues(resources, true)
	canonScopes := canonicalApprovalValues(scopes, false)
	value := "resources\x00" + strings.Join(canonResources, "\n") +
		"\x00scopes\x00" + strings.Join(canonScopes, "\n") +
		"\x00principal\x00" + binding.PrincipalID +
		"\x00authority_record\x00" + binding.AuthorityRecordID +
		"\x00session\x00" + binding.SessionID +
		"\x00delegation\x00" + binding.DelegationEdgeID +
		"\x00application\x00" + binding.ApplicationID +
		"\x00policy_set_version\x00" + binding.Bundle.PolicySetVersionID +
		"\x00policy_manifest\x00" + binding.Bundle.ManifestSHA +
		"\x00decision_contract_version\x00" + binding.Bundle.DecisionContractVersion +
		"\x00decision_contract_sha\x00" + binding.Bundle.DecisionContractSHA
	sum := sha256.Sum256([]byte(value))
	return sum[:]
}

func canonicalApprovalValues(values []string, lower bool) []string {
	unique := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if lower {
			value = strings.ToLower(value)
		}
		if value != "" {
			unique[value] = struct{}{}
		}
	}
	canonical := make([]string, 0, len(unique))
	for value := range unique {
		canonical = append(canonical, value)
	}
	sort.Strings(canonical)
	return canonical
}

func sameApprovalPolicy(a, b ZoneBundleInfo) bool {
	return a.PolicySetVersionID == b.PolicySetVersionID &&
		a.ManifestSHA == b.ManifestSHA &&
		a.DecisionContractVersion == b.DecisionContractVersion &&
		a.DecisionContractSHA == b.DecisionContractSHA
}

// approvalSubjectAnchor resolves the federated Subject a gated mint acts for. A
// user-typed subject token names the Subject directly; otherwise the governed
// Session's immutable subject attribution names it when that authority record is a
// user record. A workload or application-only execution has no Subject and yields an
// empty anchor, which leaves the hold decidable by any of the application's
// authenticated end users exactly as an anchor-free hold always was.
func approvalSubjectAnchor(subjectClaims map[string]any, session *Session) string {
	if claimString(subjectClaims, "sub_type") == SubTypeUser {
		return claimString(subjectClaims, "sub")
	}
	if session != nil && session.SubjectAuthorityRecordType == "user" {
		return session.SubjectAuthorityRecordSubject
	}
	return ""
}
