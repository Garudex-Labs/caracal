"""
Merkle tree implementation for cryptographic ledger integrity.

This module provides Merkle tree construction, proof generation, and verification
for ensuring tamper-evidence in the Caracal ledger.
"""

from caracal.merkle.tree import MerkleTree, MerkleProof

__all__ = ["MerkleTree", "MerkleProof"]
