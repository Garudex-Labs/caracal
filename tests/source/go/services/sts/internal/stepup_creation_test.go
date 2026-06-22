// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// STS step-up challenge creation tests.

package internal

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"
)

type challengeInsertDB struct {
	stubDB
	challenge *StepUpChallengePG
	err       error
}

func (db *challengeInsertDB) InsertStepUpChallenge(_ context.Context, challenge *StepUpChallengePG) error {
	if db.err != nil {
		return db.err
	}
	db.challenge = challenge
	return nil
}

func TestCreateChallengePersistsBoundHashedSecret(t *testing.T) {
	db := &challengeInsertDB{}
	server := &Server{db: db}
	before := time.Now()
	challenge, err := server.createChallenge(context.Background(), "zone-1", "session-1", "principal-1", "webauthn", []string{" Resource://B ", "resource://a"}, nil)
	if err != nil {
		t.Fatalf("create challenge: %v", err)
	}
	if challenge.ID == "" || challenge.ZoneID != "zone-1" || challenge.SessionID != "session-1" || challenge.ChallengeType != "webauthn" || challenge.Secret == "" {
		t.Fatalf("unexpected challenge: %+v", challenge)
	}
	if db.challenge == nil {
		t.Fatal("challenge was not persisted")
	}
	if db.challenge.ID != challenge.ID || db.challenge.ZoneID != "zone-1" || db.challenge.SessionID != "session-1" || db.challenge.PrincipalID != "principal-1" {
		t.Fatalf("unexpected persisted challenge: %+v", db.challenge)
	}
	secretHash := sha256.Sum256([]byte(challenge.Secret))
	if string(db.challenge.ChallengeSecretHash) != string(secretHash[:]) {
		t.Fatal("persisted challenge should store only the secret hash")
	}
	wantResourceHash := hashResourceSet([]string{"resource://a", "resource://b"})
	if string(db.challenge.ResourceSetHash) != string(wantResourceHash) {
		t.Fatal("persisted challenge should bind the canonical resource set")
	}
	if db.challenge.ExpiresAt.Before(before.Add(challengeTTL-time.Second)) || db.challenge.ExpiresAt.After(time.Now().Add(challengeTTL+time.Second)) {
		t.Fatalf("unexpected challenge expiry: %s", db.challenge.ExpiresAt)
	}
}

func TestCreateChallengeReturnsStoreErrors(t *testing.T) {
	want := errors.New("database unavailable")
	_, err := (&Server{db: &challengeInsertDB{err: want}}).createChallenge(context.Background(), "zone-1", "session-1", "principal-1", "webauthn", nil, nil)
	if !errors.Is(err, want) {
		t.Fatalf("want store error, got %v", err)
	}
}
