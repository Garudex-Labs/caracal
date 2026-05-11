---
title: Threat Model
description: Adversaries Caracal defends against and the assumptions it makes.
---

The canonical threat model lives at [Security → Threat Model](/security/threat-model).

This page is the architecture-flavored cross-link: it lists the trust
boundaries and adversary classes, then defers detailed threats and
mitigations to the security page.

## Adversary classes

- **Compromised application:** a tenant app whose process memory is
  exfiltrable. Caracal mitigates via short-lived per-call tokens, revocation,
  and provider-credential isolation in STS+gateway.
- **Network observer:** an on-path attacker between SDK and gateway, or
  gateway and upstream. Caracal requires TLS on every hop and never logs
  plaintext bearers.
- **Hostile caller:** any HTTP client that can reach the gateway. Caracal
  rejects spoofed `X-Caracal-*` headers, replaces `X-Forwarded-*`, and
  verifies bearer signatures before any audit event uses claim values.
- **Compromised resource:** an upstream that wants to harvest tokens or
  credentials. Mitigated by per-call STS exchange (no long-lived bearer at
  upstream), provider-credential substitution, and absence of token caching.

## Trust boundaries

See [System Overview → Planes](/architecture/system) for how the control,
authority, and data planes split, and [Security → Threat Model](/security/threat-model)
for the detailed boundary table and threat-by-threat mitigations.
