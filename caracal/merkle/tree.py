"""
Merkle tree implementation for cryptographic ledger integrity.

This module implements a binary Merkle tree with SHA-256 hashing for
creating tamper-evident ledger batches. It supports:
- Tree construction from leaf hashes
- Merkle proof generation for any leaf
- Merkle proof verification
"""

import hashlib
from dataclasses import dataclass
from typing import List, Optional


@dataclass
class MerkleProof:
    """
    Proof that a leaf is included in a Merkle tree.
    
    Attributes:
        leaf_hash: Hash of the leaf being proven
        proof_hashes: List of sibling hashes from leaf to root
        proof_directions: List of directions ("left" or "right") for each sibling
        root_hash: Expected root hash for verification
    """
    leaf_hash: bytes
    proof_hashes: List[bytes]
    proof_directions: List[str]  # "left" or "right"
    root_hash: bytes


class MerkleTree:
    """
    Binary Merkle tree implementation using SHA-256.
    
    The tree is built bottom-up from leaf hashes. Each internal node's hash
    is computed by concatenating and hashing its two children. If there's an
    odd number of nodes at any level, the last node is duplicated.
    
    Example:
        >>> leaves = [b"data1", b"data2", b"data3"]
        >>> tree = MerkleTree(leaves)
        >>> root = tree.get_root()
        >>> proof = tree.generate_proof(0)
        >>> assert MerkleTree.verify_proof(leaves[0], proof, root)
    """
    
    def __init__(self, leaves: List[bytes]):
        """
        Build Merkle tree from leaf data.
        
        Args:
            leaves: List of leaf data (will be hashed with SHA-256)
        
        Raises:
            ValueError: If leaves list is empty
        """
        if not leaves:
            raise ValueError("Cannot create Merkle tree from empty leaves list")
        
        # Hash each leaf using SHA-256
        self.leaves = [self._hash(leaf) for leaf in leaves]
        self.leaf_count = len(self.leaves)
        
        # Build tree structure (list of levels, bottom to top)
        self.tree = self._build_tree()
    
    def _hash(self, data: bytes) -> bytes:
        """
        Hash data using SHA-256.
        
        Args:
            data: Data to hash
        
        Returns:
            SHA-256 hash of data
        """
        return hashlib.sha256(data).digest()
    
    def _hash_pair(self, left: bytes, right: bytes) -> bytes:
        """
        Hash a pair of nodes by concatenating and hashing.
        
        Args:
            left: Left child hash
            right: Right child hash
        
        Returns:
            SHA-256 hash of concatenated children
        """
        return self._hash(left + right)
    
    def _build_tree(self) -> List[List[bytes]]:
        """
        Build Merkle tree bottom-up by hashing pairs.
        
        The tree is stored as a list of levels, where:
        - tree[0] is the leaf level
        - tree[-1] is the root level (single hash)
        
        If a level has an odd number of nodes, the last node is duplicated
        to create a pair.
        
        Returns:
            List of levels, each level is a list of hashes
        """
        tree = [self.leaves]
        current_level = self.leaves
        
        # Build tree level by level until we reach the root
        while len(current_level) > 1:
            next_level = []
            
            # Process pairs of nodes
            for i in range(0, len(current_level), 2):
                left = current_level[i]
                
                # If odd number of nodes, duplicate the last one
                if i + 1 < len(current_level):
                    right = current_level[i + 1]
                else:
                    right = current_level[i]
                
                # Hash the pair and add to next level
                parent_hash = self._hash_pair(left, right)
                next_level.append(parent_hash)
            
            tree.append(next_level)
            current_level = next_level
        
        return tree
    
    def get_root(self) -> bytes:
        """
        Get the Merkle root hash.
        
        Returns:
            Root hash of the tree
        """
        return self.tree[-1][0]
    
    def generate_proof(self, leaf_index: int) -> MerkleProof:
        """
        Generate Merkle proof for a leaf at the given index.
        
        The proof consists of sibling hashes along the path from leaf to root,
        along with directions indicating whether each sibling is on the left
        or right.
        
        Args:
            leaf_index: Index of the leaf (0-based)
        
        Returns:
            MerkleProof containing proof hashes and directions
        
        Raises:
            ValueError: If leaf_index is out of range
        """
        if leaf_index < 0 or leaf_index >= self.leaf_count:
            raise ValueError(f"Leaf index {leaf_index} out of range [0, {self.leaf_count})")
        
        proof_hashes = []
        proof_directions = []
        current_index = leaf_index
        
        # Traverse from leaf to root, collecting sibling hashes
        for level in range(len(self.tree) - 1):  # Exclude root level
            current_level = self.tree[level]
            
            # Determine sibling index
            if current_index % 2 == 0:
                # Current node is left child, sibling is right
                sibling_index = current_index + 1
                direction = "right"
            else:
                # Current node is right child, sibling is left
                sibling_index = current_index - 1
                direction = "left"
            
            # Handle case where sibling doesn't exist (odd number of nodes)
            if sibling_index < len(current_level):
                sibling_hash = current_level[sibling_index]
            else:
                # Duplicate current node (same as build logic)
                sibling_hash = current_level[current_index]
            
            proof_hashes.append(sibling_hash)
            proof_directions.append(direction)
            
            # Move to parent index for next level
            current_index = current_index // 2
        
        return MerkleProof(
            leaf_hash=self.leaves[leaf_index],
            proof_hashes=proof_hashes,
            proof_directions=proof_directions,
            root_hash=self.get_root()
        )
    
    @staticmethod
    def verify_proof(leaf: bytes, proof: MerkleProof, expected_root: bytes) -> bool:
        """
        Verify a Merkle proof.
        
        Recomputes the root hash from the leaf and proof, then compares
        with the expected root.
        
        Args:
            leaf: Original leaf data (will be hashed)
            proof: Merkle proof to verify
            expected_root: Expected root hash
        
        Returns:
            True if proof is valid, False otherwise
        """
        # Hash the leaf
        current_hash = hashlib.sha256(leaf).digest()
        
        # Verify leaf hash matches proof
        if current_hash != proof.leaf_hash:
            return False
        
        # Recompute root by hashing with siblings
        for sibling_hash, direction in zip(proof.proof_hashes, proof.proof_directions):
            if direction == "left":
                # Sibling is on the left
                current_hash = hashlib.sha256(sibling_hash + current_hash).digest()
            else:
                # Sibling is on the right
                current_hash = hashlib.sha256(current_hash + sibling_hash).digest()
        
        # Compare computed root with expected root
        return current_hash == expected_root
