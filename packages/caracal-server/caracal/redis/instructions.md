---
description: Apply when adding, editing, or reviewing Redis client or mandate cache logic.
applyTo: packages/caracal-server/caracal/redis/**
---

## Purpose
Redis client wrapper and mandate cache for high-frequency authority lookups.

## Rules
- `client.py` wraps the Redis connection; all Redis operations go through it.
- `mandate_cache.py` implements mandate read-through caching; no other cache implementations.
- Cache TTL values come from `RedisConfig`; no hardcoded TTLs.
- All cache keys must be namespaced with the workspace ID to prevent cross-workspace leakage.

## Constraints
- Forbidden: storing sensitive data (tokens, private keys) in Redis.
- Forbidden: Redis calls outside `client.py` and `mandate_cache.py`.
- Forbidden: importing from `cli/`, `flow/`, or `deployment/`.
- File names: `client.py` and `mandate_cache.py` only.

## Imports
- Import from `redis`, `caracal.config.settings`, and `caracal.exceptions`.

## Error Handling
- Connection failures raise `RedisUnavailableError`; callers must handle gracefully with fallback to DB.
- Cache misses return `None`; never raise on a cache miss.

## Security
- Cache keys must never include plaintext secret values.
- All cache values must be validated on read before use.
