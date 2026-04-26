---
description: Apply when adding, editing, or reviewing Merkle tree construction, signing, or verification.
applyTo: packages/caracal-server/caracal/merkle/**
---

## Purpose
Merkle tree construction, batch signing, root storage, and cryptographic verification.

## Rules
- Tree construction and batch logic live in `tree.py`; verification lives in `verifier.py`.
- All Merkle signing must use the backend specified in `MerkleConfig.signing_backend`; no hardcoded backend.
- Vault-backed signing requires `vault_key_ref` and `vault_public_key_ref`; both must be non-empty strings.
- Batch IDs must be unique across all stored Merkle roots.

## Constraints
- Forbidden: signing with symmetric algorithms (e.g., HS256); only asymmetric algorithms (ES256, RS256, EdDSA).
- Forbidden: key material in Merkle module; delegate entirely to `caracal.core.vault` or `caracal.core.crypto`.
- Forbidden: importing from `cli/`, `flow/`, or `runtime/`.
- File names: `tree.py` and `verifier.py`; additional files only for new top-level concerns.

## Imports
- Import from `caracal.core.vault`, `caracal.core.crypto`, `caracal.db`, and `caracal.exceptions`.

## Error Handling
- Invalid algorithm raises `InvalidSigningAlgorithmError`.
- Missing vault refs raise `InvalidConfigurationError` with the specific missing field named.
- Verification failures raise `MerkleVerificationError`; never return a boolean silently.

## Security
- Verify signatures before trusting any stored Merkle root.
- All leaf data must be canonicalized before hashing.
