// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Step-up challenge creation, secret binding, and atomic single-use consumption.

package internal

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	challengeTTL          = 5 * time.Minute
	challengeSecretBytes  = 32
	resourceSetHashLength = 32
)

// challengeState is the in-memory representation of an active step-up challenge.
type challengeState struct {
	ID            string
	ZoneID        string
	SessionID     string
	ChallengeType string
	Secret        string
	ExpiresAt     time.Time
}

// createChallenge persists a new step-up challenge bound to (zone, principal, resource set).
// The plaintext secret is returned to the caller exactly once; only its SHA-256 is stored.
func (s *Server) createChallenge(ctx context.Context, zoneID, sessionID, principalID, challengeType string, resources []string) (*challengeState, error) {
	id, _ := uuid.NewV7()
	secretBytes := make([]byte, challengeSecretBytes)
	if _, err := rand.Read(secretBytes); err != nil {
		return nil, err
	}
	secret := base64.RawURLEncoding.EncodeToString(secretBytes)
	hash := sha256.Sum256([]byte(secret))
	resHash := hashResourceSet(resources)
	now, err := s.db.CurrentTime(ctx)
	if err != nil {
		return nil, err
	}
	expiresAt := now.Add(challengeTTL)

	c := &challengeState{
		ID:            id.String(),
		ZoneID:        zoneID,
		SessionID:     sessionID,
		ChallengeType: challengeType,
		Secret:        secret,
		ExpiresAt:     expiresAt,
	}

	if err := s.db.InsertStepUpChallenge(ctx, &StepUpChallengePG{
		ID:                  c.ID,
		ZoneID:              zoneID,
		SessionID:           sessionID,
		ChallengeType:       challengeType,
		ChallengeSecretHash: hash[:],
		PrincipalID:         principalID,
		ResourceSetHash:     resHash,
		ExpiresAt:           expiresAt,
	}); err != nil {
		return nil, err
	}

	return c, nil
}

// verifyAndConsumeChallenge atomically marks a challenge as consumed iff every binding
// matches: secret hash, zone, principal, resource set, satisfied, not expired, not yet consumed.
// Returns ErrChallengeInvalid for any binding mismatch and ErrChallengeAlreadyConsumed when
// an already consumed challenge is replayed.
func (s *Server) verifyAndConsumeChallenge(ctx context.Context, zoneID, principalID, challengeID, secret string, resources []string) error {
	if challengeID == "" || secret == "" {
		return ErrChallengeInvalid
	}
	hash := sha256.Sum256([]byte(secret))
	resHash := hashResourceSet(resources)
	now, err := s.db.CurrentTime(ctx)
	if err != nil {
		return err
	}
	return s.db.ConsumeStepUpChallenge(ctx, ConsumeStepUpParams{
		ID:                  challengeID,
		ZoneID:              zoneID,
		PrincipalID:         principalID,
		ChallengeSecretHash: hash[:],
		ResourceSetHash:     resHash,
		Now:                 now,
	})
}

// ErrChallengeInvalid means the supplied challenge response did not match a live binding.
var ErrChallengeInvalid = errors.New("step-up challenge invalid or expired")

// ErrChallengeAlreadyConsumed means the challenge was already consumed by another request.
var ErrChallengeAlreadyConsumed = errors.New("step-up challenge already consumed")

// hashResourceSet returns a deterministic SHA-256 over the canonical (sorted, lowercase,
// trimmed) form of a resource list. Used to bind a challenge to the exact resource set
// requested when the challenge was created.
func hashResourceSet(resources []string) []byte {
	canon := make([]string, 0, len(resources))
	for _, r := range resources {
		canon = append(canon, strings.ToLower(strings.TrimSpace(r)))
	}
	sort.Strings(canon)
	sum := sha256.Sum256([]byte(strings.Join(canon, "\n")))
	return sum[:]
}
