"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Merkle tree implementation for cryptographic ledger integrity.

This module implements a binary Merkle tree with SHA-256 hashing for
creating tamper-evident ledger batches. It supports:
- Tree construction from leaf hashes
- Merkle proof generation for any leaf
- Merkle proof verification
- Parallel tree construction for improved performance (v0.3 optimization)
- Builder pattern for convenient tree construction
"""

import hashlib
import concurrent.futures
from dataclasses import dataclass
from typing import List, Optional

from caracal.logging_config import get_logger

logger = get_logger(__name__)


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


class MerkleTreeBuilder:
    """
    Builder class for constructing Merkle trees from event batches.
    
    This class provides a convenient interface for building Merkle trees
    from authority ledger events or other data batches. It handles event
    serialization and tree construction.
    
    
    Example:
        >>> builder = MerkleTreeBuilder()
        >>> tree = builder.build_tree(event_batch)
        >>> root = builder.get_root()
        >>> proof = builder.get_proof(event_index)
    """
    
    def __init__(self):
        """Initialize the Merkle tree builder."""
        self._tree: Optional[MerkleTree] = None
        self._events: List[bytes] = []
    
    def build_tree(self, events: List[bytes]) -> 'MerkleTreeBuilder':
        """
        Build Merkle tree from event batch.
        
        Args:
            events: List of event data (as bytes)
        
        Returns:
            Self for method chaining
        
        Raises:
            ValueError: If events list is empty
        
        """
        if not events:
            raise ValueError("Cannot build Merkle tree from empty events list")
        
        self._events = events
        self._tree = MerkleTree(events)
        
        logger.debug(f"Built Merkle tree with {len(events)} events")
        
        return self
    
    def get_root(self) -> bytes:
        """
        Get the Merkle root hash.
        
        Returns:
            Root hash of the tree
        
        Raises:
            RuntimeError: If tree has not been built yet
        
        """
        if self._tree is None:
            raise RuntimeError("Tree has not been built yet. Call build_tree() first.")
        
        return self._tree.get_root()
    
    def get_proof(self, event_index: int) -> MerkleProof:
        """
        Generate Merkle proof for event at given index.
        
        Args:
            event_index: Index of the event (0-based)
        
        Returns:
            MerkleProof for the event
        
        Raises:
            RuntimeError: If tree has not been built yet
            ValueError: If event_index is out of range
        
        """
        if self._tree is None:
            raise RuntimeError("Tree has not been built yet. Call build_tree() first.")
        
        return self._tree.generate_proof(event_index)


class MerkleTree:
    """
    Binary Merkle tree implementation using SHA-256 with parallel computation.
    
    The tree is built bottom-up from leaf hashes. Each internal node's hash
    is computed by concatenating and hashing its two children. If there's an
    odd number of nodes at any level, the last node is duplicated.
    
    v0.3 optimizations:
    - Parallel hashing of leaves using ThreadPoolExecutor
    - Parallel tree level computation for large batches
    - Proof caching for frequently verified proofs
    - Target: < 100ms for 1000-event batches, < 5ms verification time
    
    Example:
        >>> leaves = [b"data1", b"data2", b"data3"]
        >>> tree = MerkleTree(leaves)
        >>> root = tree.get_root()
        >>> proof = tree.generate_proof(0)
        >>> assert MerkleTree.verify_proof(leaves[0], proof, root)
    
    """
    
    # Threshold for parallel processing (use parallel for batches larger than this)
    PARALLEL_THRESHOLD = 100
    
    # Proof cache size limit
    MAX_PROOF_CACHE_SIZE = 1000
    
    def __init__(self, leaves: List[bytes], use_parallel: bool = True):
        """
        Build Merkle tree from leaf data.
        
        Args:
            leaves: List of leaf data (will be hashed with SHA-256)
            use_parallel: Enable parallel processing for large batches (default: True)
        
        Raises:
            ValueError: If leaves list is empty
        """
        if not leaves:
            raise ValueError("Cannot create Merkle tree from empty leaves list")
        
        self.use_parallel = use_parallel and len(leaves) >= self.PARALLEL_THRESHOLD
        
        # Hash each leaf using SHA-256 (parallel for large batches)
        if self.use_parallel:
            self.leaves = self._hash_leaves_parallel(leaves)
        else:
            self.leaves = [self._hash(leaf) for leaf in leaves]
        
        self.leaf_count = len(self.leaves)
        
        # Build tree structure (list of levels, bottom to top)
        self.tree = self._build_tree()
        
        # Proof cache for frequently verified proofs (v0.3 optimization)
        self._proof_cache: dict[int, MerkleProof] = {}
        
        # Verification cache for (leaf_hash, root_hash) pairs (v0.3 optimization)
        self._verification_cache: dict[tuple[bytes, bytes], bool] = {}
    
    def _hash(self, data: bytes) -> bytes:
        """
        Hash data using SHA-256.
        
        Args:
            data: Data to hash
        
        Returns:
            SHA-256 hash of data
        """
        return hashlib.sha256(data).digest()
    
    def _hash_leaves_parallel(self, leaves: List[bytes]) -> List[bytes]:
        """
        Hash leaves in parallel using ThreadPoolExecutor.
        
        Args:
            leaves: List of leaf data to hash
        
        Returns:
            List of hashed leaves
            
        """
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            return list(executor.map(self._hash, leaves))
    
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
    
    def _build_tree_level_parallel(self, current_level: List[bytes]) -> List[bytes]:
        """
        Build next tree level in parallel.
        
        Args:
            current_level: Current level of hashes
        
        Returns:
            Next level of hashes
            
        """
        # Create pairs for parallel processing
        pairs = []
        for i in range(0, len(current_level), 2):
            left = current_level[i]
            # If odd number of nodes, duplicate the last one
            if i + 1 < len(current_level):
                right = current_level[i + 1]
            else:
                right = current_level[i]
            pairs.append((left, right))
        
        # Hash pairs in parallel
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            return list(executor.map(lambda p: self._hash_pair(p[0], p[1]), pairs))
    
    def _build_tree(self) -> List[List[bytes]]:
        """
        Build Merkle tree bottom-up by hashing pairs.
        
        The tree is stored as a list of levels, where:
        - tree[0] is the leaf level
        - tree[-1] is the root level (single hash)
        
        If a level has an odd number of nodes, the last node is duplicated
        to create a pair.
        
        Uses parallel processing for large batches (v0.3 optimization).
        
        Returns:
            List of levels, each level is a list of hashes
            
        """
        tree = [self.leaves]
        current_level = self.leaves
        
        # Build tree level by level until we reach the root
        while len(current_level) > 1:
            # Use parallel processing for large levels
            if self.use_parallel and len(current_level) >= self.PARALLEL_THRESHOLD:
                next_level = self._build_tree_level_parallel(current_level)
            else:
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
        
        Uses caching for frequently requested proofs (v0.3 optimization).
        
        Args:
            leaf_index: Index of the leaf (0-based)
        
        Returns:
            MerkleProof containing proof hashes and directions
        
        Raises:
            ValueError: If leaf_index is out of range
            
        """
        if leaf_index < 0 or leaf_index >= self.leaf_count:
            raise ValueError(f"Leaf index {leaf_index} out of range [0, {self.leaf_count})")
        
        # Check cache first (v0.3 optimization)
        if leaf_index in self._proof_cache:
            return self._proof_cache[leaf_index]
        
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
        
        proof = MerkleProof(
            leaf_hash=self.leaves[leaf_index],
            proof_hashes=proof_hashes,
            proof_directions=proof_directions,
            root_hash=self.get_root()
        )
        
        # Cache the proof (v0.3 optimization)
        if len(self._proof_cache) < self.MAX_PROOF_CACHE_SIZE:
            self._proof_cache[leaf_index] = proof
        
        return proof
    
    @staticmethod
    def verify_proof(leaf: bytes, proof: MerkleProof, expected_root: bytes, use_cache: bool = True) -> bool:
        """
        Verify a Merkle proof.
        
        Recomputes the root hash from the leaf and proof, then compares
        with the expected root.
        
        Uses caching for frequently verified (leaf, root) pairs (v0.3 optimization).
        
        Args:
            leaf: Original leaf data (will be hashed)
            proof: Merkle proof to verify
            expected_root: Expected root hash
            use_cache: Enable verification caching (default: True)
        
        Returns:
            True if proof is valid, False otherwise
            
        """
        # Hash the leaf
        current_hash = hashlib.sha256(leaf).digest()
        
        # Verify leaf hash matches proof
        if current_hash != proof.leaf_hash:
            return False
        
        # Check cache first (v0.3 optimization)
        # Note: This is a class-level cache, so we use a global dict
        if use_cache:
            cache_key = (current_hash, expected_root)
            if hasattr(MerkleTree, '_global_verification_cache'):
                if cache_key in MerkleTree._global_verification_cache:
                    return MerkleTree._global_verification_cache[cache_key]
            else:
                MerkleTree._global_verification_cache = {}
        
        # Recompute root by hashing with siblings
        for sibling_hash, direction in zip(proof.proof_hashes, proof.proof_directions):
            if direction == "left":
                # Sibling is on the left
                current_hash = hashlib.sha256(sibling_hash + current_hash).digest()
            else:
                # Sibling is on the right
                current_hash = hashlib.sha256(current_hash + sibling_hash).digest()
        
        # Compare computed root with expected root
        result = current_hash == expected_root
        
        # Cache the result (v0.3 optimization)
        if use_cache and len(MerkleTree._global_verification_cache) < 10000:
            cache_key = (proof.leaf_hash, expected_root)
            MerkleTree._global_verification_cache[cache_key] = result
        
        return result
