// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator unit test environment defaults for Vitest suites.

process.env.CARACAL_MODE ??= 'dev'
process.env.DATABASE_URL ??= 'postgres://test'
process.env.REDIS_URL ??= 'redis://test'
process.env.STS_URL ??= 'http://sts.test'
process.env.ISSUER_URL ??= 'http://issuer.test'
process.env.AGENT_COORDINATOR_SCOPE ??= 'coordinator.use'
process.env.CARACAL_COORDINATOR_TOKEN ??= 'coordinator-operator-token'
process.env.STREAMS_MAXLEN ??= '12345'
process.env.DELEGATION_RETENTION_DAYS ??= '90'
process.env.OUTBOX_RETENTION_DAYS ??= '7'
process.env.SESSION_RETENTION_DAYS ??= '90'
process.env.RETENTION_CLEANUP_BATCH_SIZE ??= '500'
process.env.IDEMPOTENCY_HMAC_KEY ??= '4c29df78edcce0d243104e86c11844576b433730c5f334c659aa2aad70dcae17'
process.env.IDEMPOTENCY_RETENTION_SECONDS ??= '604800'
