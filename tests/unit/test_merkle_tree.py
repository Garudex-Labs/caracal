"""
Unit tests for Merkle tree implementation.

Tests cover:
- Tree construction from leaf hashes
- Root computation
- Proof generation
- Proof verification
- Edge cases (single leaf, power of 2, odd number of leaves)
"""

import pytest
from caracal.merkle.tree import MerkleTree, MerkleProof


class TestMerkleTreeConstruction:
    """Test Merkle tree construction."""
    
    def test_single_leaf(self):
        """Test tree with single leaf."""
        leaves = [b"single_leaf"]
        tree = MerkleTree(leaves)
        
        # Root should be hash of the single leaf
        root = tree.get_root()
        assert root is not None
        assert len(root) == 32  # SHA-256 produces 32 bytes
    
    def test_two_leaves(self):
        """Test tree with two leaves (perfect binary tree)."""
        leaves = [b"leaf1", b"leaf2"]
        tree = MerkleTree(leaves)
        
        root = tree.get_root()
        assert root is not None
        assert len(root) == 32
    
    def test_three_leaves(self):
        """Test tree with three leaves (odd number)."""
        leaves = [b"leaf1", b"leaf2", b"leaf3"]
        tree = MerkleTree(leaves)
        
        root = tree.get_root()
        assert root is not None
        assert len(root) == 32
    
    def test_four_leaves(self):
        """Test tree with four leaves (perfect binary tree)."""
        leaves = [b"leaf1", b"leaf2", b"leaf3", b"leaf4"]
        tree = MerkleTree(leaves)
        
        root = tree.get_root()
        assert root is not None
        assert len(root) == 32
    
    def test_many_leaves(self):
        """Test tree with many leaves."""
        leaves = [f"leaf{i}".encode() for i in range(100)]
        tree = MerkleTree(leaves)
        
        root = tree.get_root()
        assert root is not None
        assert len(root) == 32
    
    def test_empty_leaves_raises_error(self):
        """Test that empty leaves list raises ValueError."""
        with pytest.raises(ValueError, match="Cannot create Merkle tree from empty leaves list"):
            MerkleTree([])
    
    def test_deterministic_root(self):
        """Test that same leaves produce same root."""
        leaves = [b"leaf1", b"leaf2", b"leaf3"]
        
        tree1 = MerkleTree(leaves)
        tree2 = MerkleTree(leaves)
        
        assert tree1.get_root() == tree2.get_root()
    
    def test_different_leaves_different_root(self):
        """Test that different leaves produce different roots."""
        leaves1 = [b"leaf1", b"leaf2", b"leaf3"]
        leaves2 = [b"leaf1", b"leaf2", b"leaf4"]
        
        tree1 = MerkleTree(leaves1)
        tree2 = MerkleTree(leaves2)
        
        assert tree1.get_root() != tree2.get_root()
    
    def test_order_matters(self):
        """Test that leaf order affects root."""
        leaves1 = [b"leaf1", b"leaf2", b"leaf3"]
        leaves2 = [b"leaf3", b"leaf2", b"leaf1"]
        
        tree1 = MerkleTree(leaves1)
        tree2 = MerkleTree(leaves2)
        
        assert tree1.get_root() != tree2.get_root()


class TestMerkleProofGeneration:
    """Test Merkle proof generation."""
    
    def test_generate_proof_single_leaf(self):
        """Test proof generation for single leaf tree."""
        leaves = [b"single_leaf"]
        tree = MerkleTree(leaves)
        
        proof = tree.generate_proof(0)
        
        assert proof.leaf_hash == tree.leaves[0]
        assert proof.root_hash == tree.get_root()
        assert len(proof.proof_hashes) == 0  # No siblings for single leaf
        assert len(proof.proof_directions) == 0
    
    def test_generate_proof_two_leaves(self):
        """Test proof generation for two leaf tree."""
        leaves = [b"leaf1", b"leaf2"]
        tree = MerkleTree(leaves)
        
        # Proof for first leaf
        proof0 = tree.generate_proof(0)
        assert proof0.leaf_hash == tree.leaves[0]
        assert len(proof0.proof_hashes) == 1
        assert proof0.proof_directions[0] == "right"
        
        # Proof for second leaf
        proof1 = tree.generate_proof(1)
        assert proof1.leaf_hash == tree.leaves[1]
        assert len(proof1.proof_hashes) == 1
        assert proof1.proof_directions[0] == "left"
    
    def test_generate_proof_four_leaves(self):
        """Test proof generation for four leaf tree."""
        leaves = [b"leaf1", b"leaf2", b"leaf3", b"leaf4"]
        tree = MerkleTree(leaves)
        
        # Each proof should have 2 siblings (log2(4) = 2)
        for i in range(4):
            proof = tree.generate_proof(i)
            assert proof.leaf_hash == tree.leaves[i]
            assert len(proof.proof_hashes) == 2
            assert len(proof.proof_directions) == 2
            assert proof.root_hash == tree.get_root()
    
    def test_generate_proof_invalid_index(self):
        """Test that invalid index raises ValueError."""
        leaves = [b"leaf1", b"leaf2", b"leaf3"]
        tree = MerkleTree(leaves)
        
        with pytest.raises(ValueError, match="Leaf index .* out of range"):
            tree.generate_proof(-1)
        
        with pytest.raises(ValueError, match="Leaf index .* out of range"):
            tree.generate_proof(3)
    
    def test_generate_proof_all_leaves(self):
        """Test proof generation for all leaves in a tree."""
        leaves = [f"leaf{i}".encode() for i in range(10)]
        tree = MerkleTree(leaves)
        
        # Generate proof for each leaf
        for i in range(len(leaves)):
            proof = tree.generate_proof(i)
            assert proof.leaf_hash == tree.leaves[i]
            assert proof.root_hash == tree.get_root()


class TestMerkleProofVerification:
    """Test Merkle proof verification."""
    
    def test_verify_valid_proof_single_leaf(self):
        """Test verification of valid proof for single leaf."""
        leaves = [b"single_leaf"]
        tree = MerkleTree(leaves)
        
        proof = tree.generate_proof(0)
        assert MerkleTree.verify_proof(leaves[0], proof, tree.get_root())
    
    def test_verify_valid_proof_two_leaves(self):
        """Test verification of valid proofs for two leaves."""
        leaves = [b"leaf1", b"leaf2"]
        tree = MerkleTree(leaves)
        
        proof0 = tree.generate_proof(0)
        assert MerkleTree.verify_proof(leaves[0], proof0, tree.get_root())
        
        proof1 = tree.generate_proof(1)
        assert MerkleTree.verify_proof(leaves[1], proof1, tree.get_root())
    
    def test_verify_valid_proof_four_leaves(self):
        """Test verification of valid proofs for four leaves."""
        leaves = [b"leaf1", b"leaf2", b"leaf3", b"leaf4"]
        tree = MerkleTree(leaves)
        
        for i in range(4):
            proof = tree.generate_proof(i)
            assert MerkleTree.verify_proof(leaves[i], proof, tree.get_root())
    
    def test_verify_valid_proof_many_leaves(self):
        """Test verification of valid proofs for many leaves."""
        leaves = [f"leaf{i}".encode() for i in range(100)]
        tree = MerkleTree(leaves)
        
        # Verify proofs for a sample of leaves
        for i in [0, 10, 50, 99]:
            proof = tree.generate_proof(i)
            assert MerkleTree.verify_proof(leaves[i], proof, tree.get_root())
    
    def test_verify_invalid_proof_wrong_leaf(self):
        """Test that proof fails with wrong leaf data."""
        leaves = [b"leaf1", b"leaf2", b"leaf3"]
        tree = MerkleTree(leaves)
        
        proof = tree.generate_proof(0)
        
        # Try to verify with wrong leaf data
        assert not MerkleTree.verify_proof(b"wrong_leaf", proof, tree.get_root())
    
    def test_verify_invalid_proof_wrong_root(self):
        """Test that proof fails with wrong root."""
        leaves = [b"leaf1", b"leaf2", b"leaf3"]
        tree = MerkleTree(leaves)
        
        proof = tree.generate_proof(0)
        
        # Try to verify with wrong root
        wrong_root = b"0" * 32
        assert not MerkleTree.verify_proof(leaves[0], proof, wrong_root)
    
    def test_verify_invalid_proof_tampered_sibling(self):
        """Test that proof fails with tampered sibling hash."""
        leaves = [b"leaf1", b"leaf2", b"leaf3", b"leaf4"]
        tree = MerkleTree(leaves)
        
        proof = tree.generate_proof(0)
        
        # Tamper with a sibling hash
        if proof.proof_hashes:
            tampered_proof = MerkleProof(
                leaf_hash=proof.leaf_hash,
                proof_hashes=[b"0" * 32] + proof.proof_hashes[1:],
                proof_directions=proof.proof_directions,
                root_hash=proof.root_hash
            )
            
            assert not MerkleTree.verify_proof(leaves[0], tampered_proof, tree.get_root())


class TestMerkleTreeRoundTrip:
    """Test round-trip: generate proof and verify."""
    
    def test_round_trip_all_leaves(self):
        """Test that all leaves can be proven and verified."""
        leaves = [f"leaf{i}".encode() for i in range(20)]
        tree = MerkleTree(leaves)
        root = tree.get_root()
        
        # For each leaf, generate proof and verify
        for i in range(len(leaves)):
            proof = tree.generate_proof(i)
            assert MerkleTree.verify_proof(leaves[i], proof, root)
    
    def test_round_trip_odd_number_leaves(self):
        """Test round-trip with odd number of leaves."""
        leaves = [b"leaf1", b"leaf2", b"leaf3", b"leaf4", b"leaf5"]
        tree = MerkleTree(leaves)
        root = tree.get_root()
        
        for i in range(len(leaves)):
            proof = tree.generate_proof(i)
            assert MerkleTree.verify_proof(leaves[i], proof, root)
    
    def test_round_trip_power_of_two_leaves(self):
        """Test round-trip with power of 2 leaves."""
        leaves = [f"leaf{i}".encode() for i in range(16)]
        tree = MerkleTree(leaves)
        root = tree.get_root()
        
        for i in range(len(leaves)):
            proof = tree.generate_proof(i)
            assert MerkleTree.verify_proof(leaves[i], proof, root)


class TestMerkleTreeTamperDetection:
    """Test that Merkle tree detects tampering."""
    
    def test_detect_leaf_modification(self):
        """Test that modifying a leaf changes the root."""
        leaves = [b"leaf1", b"leaf2", b"leaf3", b"leaf4"]
        tree1 = MerkleTree(leaves)
        root1 = tree1.get_root()
        
        # Modify one leaf
        modified_leaves = [b"leaf1", b"MODIFIED", b"leaf3", b"leaf4"]
        tree2 = MerkleTree(modified_leaves)
        root2 = tree2.get_root()
        
        # Roots should be different
        assert root1 != root2
    
    def test_detect_leaf_addition(self):
        """Test that adding a leaf changes the root."""
        leaves1 = [b"leaf1", b"leaf2", b"leaf3"]
        tree1 = MerkleTree(leaves1)
        root1 = tree1.get_root()
        
        # Add a leaf
        leaves2 = [b"leaf1", b"leaf2", b"leaf3", b"leaf4"]
        tree2 = MerkleTree(leaves2)
        root2 = tree2.get_root()
        
        # Roots should be different
        assert root1 != root2
    
    def test_detect_leaf_removal(self):
        """Test that removing a leaf changes the root."""
        leaves1 = [b"leaf1", b"leaf2", b"leaf3", b"leaf4"]
        tree1 = MerkleTree(leaves1)
        root1 = tree1.get_root()
        
        # Remove a leaf
        leaves2 = [b"leaf1", b"leaf2", b"leaf3"]
        tree2 = MerkleTree(leaves2)
        root2 = tree2.get_root()
        
        # Roots should be different
        assert root1 != root2
    
    def test_proof_fails_after_tampering(self):
        """Test that proof verification fails after tampering."""
        leaves = [b"leaf1", b"leaf2", b"leaf3", b"leaf4"]
        tree = MerkleTree(leaves)
        
        # Generate proof for leaf 0
        proof = tree.generate_proof(0)
        
        # Verify proof works with original tree
        assert MerkleTree.verify_proof(leaves[0], proof, tree.get_root())
        
        # Create tampered tree
        tampered_leaves = [b"leaf1", b"TAMPERED", b"leaf3", b"leaf4"]
        tampered_tree = MerkleTree(tampered_leaves)
        
        # Proof should fail with tampered tree's root
        assert not MerkleTree.verify_proof(leaves[0], proof, tampered_tree.get_root())
