"""
Merkle tree implementation for cryptographic ledger integrity.

This module provides Merkle tree construction, proof generation, and verification
for ensuring tamper-evidence in the Caracal ledger.
"""

from caracal.merkle.tree import MerkleTree, MerkleProof
from caracal.merkle.batcher import MerkleBatcher, MerkleBatch
from caracal.merkle.signer import (
    MerkleSigner,
    SoftwareSigner,
    MerkleRootSignature,
    create_merkle_signer,
)
from caracal.merkle.key_management import KeyManager, generate_merkle_signing_key

__all__ = [
    "MerkleTree",
    "MerkleProof",
    "MerkleBatcher",
    "MerkleBatch",
    "MerkleSigner",
    "SoftwareSigner",
    "MerkleRootSignature",
    "create_merkle_signer",
    "KeyManager",
    "generate_merkle_signing_key",
]

