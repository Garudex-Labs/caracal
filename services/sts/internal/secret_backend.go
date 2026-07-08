// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The Secret Store read path for the data plane: raw envelope fetch from the secret_store table behind the Opened crypto boundary.

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
	db DBQuerier
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
	return envelope, true, nil
}

// meteredSecretBackend counts reads and failures for the metrics surface, so
// operators can see backend outages and unusual credential access volumes.
type meteredSecretBackend struct {
	inner   secretstore.Backend
	metrics *STSMetrics
}

func (m *meteredSecretBackend) Kind() string { return m.inner.Kind() }

func (m *meteredSecretBackend) Get(ctx context.Context, ref string) ([]byte, bool, error) {
	m.metrics.SecretBackendReads.Add(1)
	value, found, err := m.inner.Get(ctx, ref)
	if err != nil {
		m.metrics.SecretBackendErrors.Add(1)
	}
	return value, found, err
}

// newSecretBackend wires the configured backend for the data plane behind the
// Opened crypto boundary, so every stored value is a sealed envelope wherever it
// lives. The builtin backend reads this database directly; external backends are
// wrapped in a short TTL cache - holding ciphertext, beneath the boundary - so
// token exchange does not pay a network round trip per mint.
func newSecretBackend(kind string, db DBQuerier, keyring *secretstore.Keyring, metrics *STSMetrics) (secretstore.Backend, error) {
	if kind == secretstore.KindBuiltin {
		return &meteredSecretBackend{inner: secretstore.Opened(&builtinSecretBackend{db: db}, keyring), metrics: metrics}, nil
	}
	backend, err := secretstore.FromEnv(kind)
	if err != nil {
		return nil, err
	}
	return &meteredSecretBackend{
		inner:   secretstore.Opened(secretstore.NewCached(backend, externalSecretCacheTTL), keyring),
		metrics: metrics,
	}, nil
}
