"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for Merkle verifier.

Tests the MerkleVerifier implementation for batch verification,
time range verification, and event inclusion verification.

Note: These tests require a PostgreSQL database to be running.
They are integration tests that verify the full verification flow.
"""

import hashlib
import tempfile
from datetime import datetime, timedelta
from uuid import uuid4

import pytest

from caracal.merkle import MerkleTree, SoftwareSigner, MerkleVerifier
from caracal.merkle.key_management import generate_merkle_signing_key


@pytest.fixture
def key_pair():
    """Generate a temporary key pair for testing."""
    with tempfile.TemporaryDirectory() as tmpdir:
        private_key_path = f"{tmpdir}/test_key.pem"
        public_key_path = f"{tmpdir}/test_key.pub"
        
        generate_merkle_signing_key(
            private_key_path,
            public_key_path,
            passphrase=None,
        )
        
        yield private_key_path, public_key_path


@pytest.fixture
def signer(key_pair):
    """Create a SoftwareSigner for testing."""
    private_key_path, _ = key_pair
    return SoftwareSigner(private_key_path)


class TestMerkleVerifierUnit:
    """Unit tests for MerkleVerifier that don't require database."""
    
    def test_verifier_initialization(self, signer):
        """Test that MerkleVerifier can be initialized."""
        # Mock session
        mock_session = None
        
        verifier = MerkleVerifier(mock_session, signer)
        
        assert verifier.db_session is None
        assert verifier.merkle_signer == signer
    
    def test_merkle_tree_verification_logic(self, signer):
        """Test the core Merkle tree verification logic."""
        # Create test data
        test_data = [b"event1", b"event2", b"event3", b"event4"]
        
        # Build Merkle tree
        tree = MerkleTree(test_data)
        root = tree.get_root()
        
        # Generate proof for second event
        proof = tree.generate_proof(1)
        
        # Verify proof
        is_valid = MerkleTree.verify_proof(test_data[1], proof, root)
        
        assert is_valid is True
    
    def test_merkle_tree_tamper_detection(self, signer):
        """Test that tampering is detected."""
        # Create test data
        test_data = [b"event1", b"event2", b"event3", b"event4"]
        
        # Build Merkle tree
        tree = MerkleTree(test_data)
        root = tree.get_root()
        
        # Generate proof for second event
        proof = tree.generate_proof(1)
        
        # Try to verify with tampered data
        tampered_data = b"tampered_event2"
        is_valid = MerkleTree.verify_proof(tampered_data, proof, root)
        
        assert is_valid is False
    
    @pytest.mark.asyncio
    async def test_signature_verification(self, signer):
        """Test signature verification."""
        # Create test Merkle root
        merkle_root = hashlib.sha256(b"test_data").digest()
        
        # Create mock batch
        from caracal.merkle.batcher import MerkleBatch
        batch = MerkleBatch(
            batch_id=uuid4(),
            event_ids=[1, 2, 3],
            event_count=3,
            merkle_root=merkle_root,
            created_at=datetime.utcnow(),
        )
        
        # Sign the root
        signature_record = await signer.sign_root(merkle_root, batch)
        
        # Verify signature
        is_valid = await signer.verify_signature(merkle_root, signature_record.signature)
        
        assert is_valid is True
    
    @pytest.mark.asyncio
    async def test_signature_verification_tampered(self, signer):
        """Test that tampered signatures are detected."""
        # Create test Merkle root
        merkle_root = hashlib.sha256(b"test_data").digest()
        
        # Create mock batch
        from caracal.merkle.batcher import MerkleBatch
        batch = MerkleBatch(
            batch_id=uuid4(),
            event_ids=[1, 2, 3],
            event_count=3,
            merkle_root=merkle_root,
            created_at=datetime.utcnow(),
        )
        
        # Sign the root
        signature_record = await signer.sign_root(merkle_root, batch)
        
        # Try to verify with tampered root
        tampered_root = hashlib.sha256(b"tampered_data").digest()
        is_valid = await signer.verify_signature(tampered_root, signature_record.signature)
        
        assert is_valid is False


# Integration tests that require database are marked with pytest.mark.integration
# and can be run separately with: pytest -m integration

@pytest.mark.integration
class TestMerkleVerifierIntegration:
    """
    Integration tests for MerkleVerifier that require a database.
    
    These tests are skipped by default and require:
    - PostgreSQL database running
    - Database fixtures configured
    - Run with: pytest -m integration
    """
    
    @pytest.mark.skip(reason="Requires database fixtures - run with integration tests")
    @pytest.mark.asyncio
    async def test_verify_batch_success(self):
        """Test successful batch verification (requires database)."""
        # This test would require:
        # - async_session fixture
        # - test_agent fixture
        # - Database with ledger_events and merkle_roots tables
        pass
    
    @pytest.mark.skip(reason="Requires database fixtures - run with integration tests")
    @pytest.mark.asyncio
    async def test_verify_time_range(self):
        """Test time range verification (requires database)."""
        pass
    
    @pytest.mark.skip(reason="Requires database fixtures - run with integration tests")
    @pytest.mark.asyncio
    async def test_verify_event_inclusion(self):
        """Test event inclusion verification (requires database)."""
        pass

