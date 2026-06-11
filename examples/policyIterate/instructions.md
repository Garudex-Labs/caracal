# policyIterate

## Scope
- Covers the audit-driven policy iteration loop: diagnose a denied request,
  simulate a candidate policy-set version, regression-check expected decisions,
  and gate activation on the evidence.

## Architecture Design
- `iterate.mjs` holds pure orchestration (diagnose, simulate, regress, decide,
  activate) that takes an injected transport.
- `run.mjs` wires the Caracal Admin API explain, simulate, activate, and
  activation-status endpoints and narrates each phase on stderr.
- `regressions.example.json` documents the expected-decision case format.

## Required
- Must use only the public Admin API surface and the Node standard library.
- Must keep orchestration pure and tested offline with an injected transport.
- Must default to a dry run; activation requires both an explicit opt-in and a
  verdict with no blockers.
- Must treat a non-denied request as a no-op with a non-zero exit.

## Forbidden
- Must not import Caracal repository internals or call live services from tests.
- Must not embed admin tokens, secrets, or real endpoints.
- Must not activate a candidate version when any verdict gate is blocked.

## Validation
- Run `node --test` from this directory.
