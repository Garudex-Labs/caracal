// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The builtin Secret Store read path: CSS1 envelopes in the secret_store table, opened with the master KEK.

package internal

import (
	"context"
	"errors"
	"time"

	"github.com/garudex-labs/caracal/packages/core/go/secretstore"
	"github.com/jackc/pgx/v5"
)

const externalSecretCacheTTL = 60 * time.Second

type builtinSecretBackend struct {
	db  DBQuerier
	kek []byte
}

func (b *builtinSecretBackend) Kind() string { return secretstore.KindBuiltin }

func (b *builtinSecretBackend) Get(ctx context.Context, ref string) ([]byte, bool, error) {
	envelope, err := b.db.GetSecretStoreEnvelope(ctx, ref)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, nil
		}
		return nil, false, err
	}
	value, err := secretstore.Open(b.kek, envelope, ref)
	if err != nil {
		return nil, false, err
	}
	return value, true, nil
}

// newSecretBackend wires the configured backend for the data plane. The builtin
// backend reads this database directly; external backends are wrapped in a short
// TTL cache so token exchange does not pay a network round trip per mint.
func newSecretBackend(kind string, db DBQuerier, kek []byte) (secretstore.Backend, error) {
	if kind == secretstore.KindBuiltin {
		return &builtinSecretBackend{db: db, kek: kek}, nil
	}
	backend, err := secretstore.FromEnv(kind)
	if err != nil {
		return nil, err
	}
	return secretstore.NewCached(backend, externalSecretCacheTTL), nil
}
