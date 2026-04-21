"""
Unit tests for caracal/merkle/tree.py

Tests Merkle tree construction, updates, proof generation, and verification.
"""
import hashlib
import pytest
from caracal.merkle.tree import MerkleTree, MerkleProof, MerkleTreeBuilder


@pytest.mark.unit
class TestMerkleTree:
    """Test Merkle tree construction and operations."""
    
    def test_tree_construction_single_leaf(self):
        """Test Merkle tree construction with a single leaf."""
        leaves = [b"data1"]
        tree = MerkleTree(leaves)
        
        assert tree.leaf_count == 1
        assert tree.get_root() is not None
        assert len(tree.tree) == 1  # Only root level
    
    def test_tree_construction_two_leaves(self):
        """Test Merkle tree construction with two leaves."""
        leaves = [b"data1", b"data2"]
        tree = MerkleTree(leaves)
        
        assert tree.leaf_count == 2
        assert tree.get_root() is not None
        assert len(tree.tree) == 2  # Leaf level + root level
    
    def test_tree_construction_multiple_leaves(self):
        """Test Merkle tree construction with multiple leaves."""
        leaves = [b"data1", b"data2", b"data3", b"data4"]
        tree = MerkleTree(leaves)
        
        assert tree.leaf_count == 4
        assert tree.get_root() is not None
        assert len(tree.tree) == 3  # Leaf level + 2 internal levels
    
    def test_tree_construction_odd_leaves(self):
        """Test Merkle tree construction with odd number of leaves."""
        leaves = [b"data1", b"data2", b"data3"]
        tree = MerkleTree(leaves)
        
        assert tree.leaf_count == 3
        assert tree.get_root() is not None
        # Should handle odd number by duplicating last node
    
    def test_tree_construction_empty_raises_error(self):
        """Test that empty leaves list raises ValueError."""
        with pytest.raises(ValueError, match="Cannot create Merkle tree from empty leaves list"):
            MerkleTree([])
    
    def test_tree_root_deterministic(self):
        """Test that same leaves produce same root."""
        leaves = [b"data1", b"data2", b"data3"]
        tree1 = MerkleTree(leaves)
        tree2 = MerkleTree(leaves)
        
        assert tree1.get_root() == tree2.get_root()
    
    def test_tree_root_changes_with_data(self):
        """Test that different leaves produce different roots."""
        leaves1 = [b"data1", b"data2", b"data3"]
        leaves2 = [b"data1", b"data2", b"data4"]
        
        tree1 = MerkleTree(leaves1)
        tree2 = MerkleTree(leaves2)
        
        assert tree1.get_root() != tree2.get_root()
    
    def test_tree_parallel_processing_disabled(self):
        """Test tree construction with parallel processing disabled."""
        leaves = [b"data1", b"data2", b"data3"]
        tree = MerkleTree(leaves, use_parallel=False)
        
        assert tree.leaf_count == 3
        assert tree.get_root() is not None
        assert tree.use_parallel is False
    
    def test_tree_parallel_processing_small_batch(self):
        """Test that small batches don't use parallel processing."""
        # Create batch smaller than PARALLEL_THRESHOLD
        leaves = [f"data{i}".encode() for i in range(50)]
        tree = MerkleTree(leaves, use_parallel=True)
        
        # Should not use parallel for small batch
        assert tree.use_parallel is False
    
    def test_tree_parallel_processing_large_batch(self):
        """Test that large batches use parallel processing."""
        # Create batch larger than PARALLEL_THRESHOLD (100)
        leaves = [f"data{i}".encode() for i in range(150)]
        tree = MerkleTree(leaves, use_parallel=True)
        
        # Should use parallel for large batch
        assert tree.use_parallel is True


@pytest.mark.unit
class TestMerkleProofGeneration:
    """Test Merkle proof generation."""
    
    def test_generate_proof_first_leaf(self):
        """Test proof generation for first leaf."""
        leaves = [b"data1", b"data2", b"data3", b"data4"]
        tree = MerkleTree(leaves)
        
        proof = tree.generate_proof(0)
        
        assert proof.leaf_hash == hashlib.sha256(b"data1").digest()
        assert proof.root_hash == tree.get_root()
        assert len(proof.proof_hashes) > 0
        assert len(proof.proof_directions) == len(proof.proof_hashes)
    
    def test_generate_proof_last_leaf(self):
        """Test proof generation for last leaf."""
        leaves = [b"data1", b"data2", b"data3", b"data4"]
        tree = MerkleTree(leaves)
        
        proof = tree.generate_proof(3)
        
        assert proof.leaf_hash == hashlib.sha256(b"data4").digest()
        assert proof.root_hash == tree.get_root()
        assert len(proof.proof_hashes) > 0
    
    def test_generate_proof_middle_leaf(self):
        """Test proof generation for middle leaf."""
        leaves = [b"data1", b"data2", b"data3", b"data4"]
        tree = MerkleTree(leaves)
        
        proof = tree.generate_proof(1)
        
        assert proof.leaf_hash == hashlib.sha256(b"data2").digest()
        assert proof.root_hash == tree.get_root()
    
    def test_generate_proof_invalid_index_negative(self):
        """Test that negative index raises ValueError."""
        leaves = [b"data1", b"data2"]
        tree = MerkleTree(leaves)
        
        with pytest.raises(ValueError, match="Leaf index -1 out of range"):
            tree.generate_proof(-1)
    
    def test_generate_proof_invalid_index_too_large(self):
        """Test that index >= leaf_count raises ValueError."""
        leaves = [b"data1", b"data2"]
        tree = MerkleTree(leaves)
        
        with pytest.raises(ValueError, match="Leaf index 2 out of range"):
            tree.generate_proof(2)
    
    def test_generate_proof_single_leaf(self):
        """Test proof generation for single leaf tree."""
        leaves = [b"data1"]
        tree = MerkleTree(leaves)
        
        proof = tree.generate_proof(0)
        
        assert proof.leaf_hash == hashlib.sha256(b"data1").digest()
        assert proof.root_hash == tree.get_root()
        # Single leaf tree has no siblings
        assert len(proof.proof_hashes) == 0
    
    def test_proof_caching(self):
        """Test that proofs are cached for repeated requests."""
        leaves = [b"data1", b"data2", b"data3"]
        tree = MerkleTree(leaves)
        
        # Generate proof twice
        proof1 = tree.generate_proof(0)
        proof2 = tree.generate_proof(0)
        
        # Should return same proof object (cached)
        assert proof1 is proof2
    
    def test_proof_directions_correct(self):
        """Test that proof directions are correct."""
        leaves = [b"data1", b"data2", b"data3", b"data4"]
        tree = MerkleTree(leaves)
        
        proof = tree.generate_proof(0)
        
        # All directions should be either "left" or "right"
        for direction in proof.proof_directions:
            assert direction in ["left", "right"]


@pytest.mark.unit
class TestMerkleProofVerification:
    """Test Merkle proof verification."""
    
    def test_verify_proof_valid(self):
        """Test verification of valid proof."""
        leaves = [b"data1", b"data2", b"data3", b"data4"]
        tree = MerkleTree(leaves)
        
        proof = tree.generate_proof(0)
        root = tree.get_root()
        
        assert MerkleTree.verify_proof(b"data1", proof, root) is True
    
    def test_verify_proof_all_leaves(self):
        """Test verification of proofs for all leaves."""
        leaves = [b"data1", b"data2", b"data3", b"data4"]
        tree = MerkleTree(leaves)
        root = tree.get_root()
        
        for i, leaf in enumerate(leaves):
            proof = tree.generate_proof(i)
            assert MerkleTree.verify_proof(leaf, proof, root) is True
    
    def test_verify_proof_wrong_leaf(self):
        """Test that proof fails with wrong leaf data."""
        leaves = [b"data1", b"data2", b"data3"]
        tree = MerkleTree(leaves)
        
        proof = tree.generate_proof(0)
        root = tree.get_root()
        
        # Try to verify with wrong leaf data
        assert MerkleTree.verify_proof(b"wrong_data", proof, root) is False
    
    def test_verify_proof_wrong_root(self):
        """Test that proof fails with wrong root."""
        leaves = [b"data1", b"data2", b"data3"]
        tree = MerkleTree(leaves)
        
        proof = tree.generate_proof(0)
        wrong_root = hashlib.sha256(b"wrong_root").digest()
        
        assert MerkleTree.verify_proof(b"data1", proof, wrong_root) is False
    
    def test_verify_proof_single_leaf(self):
        """Test verification for single leaf tree."""
        leaves = [b"data1"]
        tree = MerkleTree(leaves)
        
        proof = tree.generate_proof(0)
        root = tree.get_root()
        
        assert MerkleTree.verify_proof(b"data1", proof, root) is True
    
    def test_verify_proof_tampered_proof(self):
        """Test that tampered proof fails verification."""
        leaves = [b"data1", b"data2", b"data3", b"data4"]
        tree = MerkleTree(leaves)
        
        proof = tree.generate_proof(0)
        root = tree.get_root()
        
        # Tamper with proof by modifying a hash
        if proof.proof_hashes:
            tampered_proof = MerkleProof(
                leaf_hash=proof.leaf_hash,
                proof_hashes=[hashlib.sha256(b"tampered").digest()] + proof.proof_hashes[1:],
                proof_directions=proof.proof_directions,
                root_hash=proof.root_hash
            )
            
            assert MerkleTree.verify_proof(b"data1", tampered_proof, root, use_cache=False) is False
    
    def test_verify_proof_caching(self):
        """Test that verification results are cached."""
        leaves = [b"data1", b"data2", b"data3"]
        tree = MerkleTree(leaves)
        
        proof = tree.generate_proof(0)
        root = tree.get_root()
        
        # Verify twice - second should use cache
        result1 = MerkleTree.verify_proof(b"data1", proof, root, use_cache=True)
        result2 = MerkleTree.verify_proof(b"data1", proof, root, use_cache=True)
        
        assert result1 is True
        assert result2 is True
    
    def test_verify_proof_without_caching(self):
        """Test verification without caching."""
        leaves = [b"data1", b"data2", b"data3"]
        tree = MerkleTree(leaves)
        
        proof = tree.generate_proof(0)
        root = tree.get_root()
        
        assert MerkleTree.verify_proof(b"data1", proof, root, use_cache=False) is True


@pytest.mark.unit
class TestMerkleTreeBuilder:
    """Test Merkle tree builder pattern."""
    
    def test_builder_basic_usage(self):
        """Test basic builder usage."""
        builder = MerkleTreeBuilder()
        events = [b"event1", b"event2", b"event3"]
        
        builder.build_tree(events)
        root = builder.get_root()
        
        assert root is not None
        assert len(root) == 32  # SHA-256 produces 32 bytes
    
    def test_builder_method_chaining(self):
        """Test builder method chaining."""
        builder = MerkleTreeBuilder()
        events = [b"event1", b"event2", b"event3"]
        
        root = builder.build_tree(events).get_root()
        
        assert root is not None
    
    def test_builder_get_proof(self):
        """Test getting proof from builder."""
        builder = MerkleTreeBuilder()
        events = [b"event1", b"event2", b"event3"]
        
        builder.build_tree(events)
        proof = builder.get_proof(0)
        
        assert proof.leaf_hash == hashlib.sha256(b"event1").digest()
        assert proof.root_hash == builder.get_root()
    
    def test_builder_empty_events_raises_error(self):
        """Test that empty events list raises ValueError."""
        builder = MerkleTreeBuilder()
        
        with pytest.raises(ValueError, match="Cannot build Merkle tree from empty events list"):
            builder.build_tree([])
    
    def test_builder_get_root_before_build_raises_error(self):
        """Test that getting root before building raises RuntimeError."""
        builder = MerkleTreeBuilder()
        
        with pytest.raises(RuntimeError, match="Tree has not been built yet"):
            builder.get_root()
    
    def test_builder_get_proof_before_build_raises_error(self):
        """Test that getting proof before building raises RuntimeError."""
        builder = MerkleTreeBuilder()
        
        with pytest.raises(RuntimeError, match="Tree has not been built yet"):
            builder.get_proof(0)
    
    def test_builder_get_proof_invalid_index(self):
        """Test that invalid index raises ValueError."""
        builder = MerkleTreeBuilder()
        events = [b"event1", b"event2"]
        
        builder.build_tree(events)
        
        with pytest.raises(ValueError, match="out of range"):
            builder.get_proof(5)
    
    def test_builder_rebuild_tree(self):
        """Test rebuilding tree with new events."""
        builder = MerkleTreeBuilder()
        
        # Build first tree
        events1 = [b"event1", b"event2"]
        builder.build_tree(events1)
        root1 = builder.get_root()
        
        # Rebuild with different events
        events2 = [b"event3", b"event4"]
        builder.build_tree(events2)
        root2 = builder.get_root()
        
        # Roots should be different
        assert root1 != root2


@pytest.mark.unit
class TestMerkleTreeUpdates:
    """Test Merkle tree behavior with updates."""
    
    def test_tree_root_changes_on_leaf_modification(self):
        """Test that modifying leaves changes the root."""
        leaves1 = [b"data1", b"data2", b"data3"]
        leaves2 = [b"data1", b"data2_modified", b"data3"]
        
        tree1 = MerkleTree(leaves1)
        tree2 = MerkleTree(leaves2)
        
        assert tree1.get_root() != tree2.get_root()
    
    def test_tree_root_changes_on_leaf_addition(self):
        """Test that adding leaves changes the root."""
        leaves1 = [b"data1", b"data2"]
        leaves2 = [b"data1", b"data2", b"data3"]
        
        tree1 = MerkleTree(leaves1)
        tree2 = MerkleTree(leaves2)
        
        assert tree1.get_root() != tree2.get_root()
    
    def test_tree_root_changes_on_leaf_removal(self):
        """Test that removing leaves changes the root."""
        leaves1 = [b"data1", b"data2", b"data3"]
        leaves2 = [b"data1", b"data2"]
        
        tree1 = MerkleTree(leaves1)
        tree2 = MerkleTree(leaves2)
        
        assert tree1.get_root() != tree2.get_root()
    
    def test_tree_order_matters(self):
        """Test that leaf order affects the root."""
        leaves1 = [b"data1", b"data2", b"data3"]
        leaves2 = [b"data3", b"data2", b"data1"]
        
        tree1 = MerkleTree(leaves1)
        tree2 = MerkleTree(leaves2)
        
        assert tree1.get_root() != tree2.get_root()


@pytest.mark.unit
class TestMerkleTreeEdgeCases:
    """Test edge cases and boundary conditions."""
    
    def test_tree_with_large_batch(self):
        """Test tree construction with large batch."""
        # Create 1000 leaves
        leaves = [f"data{i}".encode() for i in range(1000)]
        tree = MerkleTree(leaves)
        
        assert tree.leaf_count == 1000
        assert tree.get_root() is not None
    
    def test_tree_with_identical_leaves(self):
        """Test tree with all identical leaves."""
        leaves = [b"same_data"] * 10
        tree = MerkleTree(leaves)
        
        assert tree.leaf_count == 10
        assert tree.get_root() is not None
    
    def test_tree_with_empty_leaf_data(self):
        """Test tree with empty byte strings as leaves."""
        leaves = [b"", b"", b""]
        tree = MerkleTree(leaves)
        
        assert tree.leaf_count == 3
        assert tree.get_root() is not None
    
    def test_proof_for_power_of_two_leaves(self):
        """Test proof generation for power of 2 leaves."""
        # 8 leaves (power of 2)
        leaves = [f"data{i}".encode() for i in range(8)]
        tree = MerkleTree(leaves)
        
        for i in range(8):
            proof = tree.generate_proof(i)
            assert MerkleTree.verify_proof(leaves[i], proof, tree.get_root())
    
    def test_proof_for_non_power_of_two_leaves(self):
        """Test proof generation for non-power of 2 leaves."""
        # 7 leaves (not power of 2)
        leaves = [f"data{i}".encode() for i in range(7)]
        tree = MerkleTree(leaves)
        
        for i in range(7):
            proof = tree.generate_proof(i)
            assert MerkleTree.verify_proof(leaves[i], proof, tree.get_root())
