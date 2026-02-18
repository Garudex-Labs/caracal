"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for Merkle batcher and signer.

Tests the MerkleBatcher, MerkleSigner, and KeyManager implementations.
"""

import asyncio
import hashlib
import os
import tempfile
from pathlib import Path

import pytest

from caracal.merkle import (
    MerkleBatcher,
    MerkleBatch,
    SoftwareSigner,
    KeyManager,
    generate_merkle_signing_key,
)


class TestKeyManager:
    """Test key management functionality."""
    
    def test_generate_key_pair(self):
        """Test generating a new key pair."""
        with tempfile.TemporaryDirectory() as tmpdir:
            private_key_path = os.path.join(tmpdir, "private.pem")
            public_key_path = os.path.join(tmpdir, "public.pem")
            
            key_manager = KeyManager()
            key_manager.generate_key_pair(
                private_key_path,
                public_key_path,
                passphrase="test_passphrase"
            )
            
            # Verify files were created
            assert Path(private_key_path).exists()
            assert Path(public_key_path).exists()
            
            # Verify key is valid
            assert key_manager.verify_key(private_key_path, passphrase="test_passphrase")
    
    def test_generate_key_pair_without_passphrase(self):
        """Test generating a key pair without passphrase."""
        with tempfile.TemporaryDirectory() as tmpdir:
            private_key_path = os.path.join(tmpdir, "private.pem")
            public_key_path = os.path.join(tmpdir, "public.pem")
            
            key_manager = KeyManager()
            key_manager.generate_key_pair(
                private_key_path,
                public_key_path,
                passphrase=None
            )
            
            # Verify files were created
            assert Path(private_key_path).exists()
            assert Path(public_key_path).exists()
            
            # Verify key is valid
            assert key_manager.verify_key(private_key_path, passphrase=None)
    
    def test_export_public_key(self):
        """Test exporting public key from private key."""
        with tempfile.TemporaryDirectory() as tmpdir:
            private_key_path = os.path.join(tmpdir, "private.pem")
            public_key_path = os.path.join(tmpdir, "public.pem")
            exported_public_key_path = os.path.join(tmpdir, "exported_public.pem")
            
            key_manager = KeyManager()
            key_manager.generate_key_pair(
                private_key_path,
                public_key_path,
                passphrase="test_passphrase"
            )
            
            # Export public key
            key_manager.export_public_key(
                private_key_path,
                exported_public_key_path,
                passphrase="test_passphrase"
            )
            
            # Verify exported key exists
            assert Path(exported_public_key_path).exists()
            
            # Verify both public keys are identical
            with open(public_key_path, 'rb') as f1, open(exported_public_key_path, 'rb') as f2:
                assert f1.read() == f2.read()


class TestSoftwareSigner:
    """Test software-based Merkle signing."""
    
    @pytest.fixture
    def key_pair(self):
        """Create a temporary key pair for testing."""
        with tempfile.TemporaryDirectory() as tmpdir:
            private_key_path = os.path.join(tmpdir, "private.pem")
            public_key_path = os.path.join(tmpdir, "public.pem")
            
            key_manager = KeyManager()
            key_manager.generate_key_pair(
                private_key_path,
                public_key_path,
                passphrase=None  # No passphrase for testing
            )
            
            yield private_key_path, public_key_path
    
    @pytest.mark.asyncio
    async def test_sign_and_verify(self, key_pair):
        """Test signing and verifying a Merkle root."""
        private_key_path, _ = key_pair
        
        # Create signer
        signer = SoftwareSigner(private_key_path)
        
        # Create a test Merkle root
        merkle_root = hashlib.sha256(b"test_data").digest()
        
        # Create a mock batch
        from caracal.merkle.batcher import MerkleBatch
        from uuid import uuid4
        from datetime import datetime
        
        batch = MerkleBatch(
            batch_id=uuid4(),
            event_ids=[1, 2, 3],
            event_count=3,
            merkle_root=merkle_root,
            created_at=datetime.utcnow()
        )
        
        # Sign the root
        signature_record = await signer.sign_root(merkle_root, batch)
        
        # Verify signature
        assert signature_record.merkle_root == merkle_root
        assert signature_record.batch_id == batch.batch_id
        assert signature_record.event_count == 3
        assert signature_record.signing_backend == "software"
        
        # Verify signature is valid
        is_valid = await signer.verify_signature(merkle_root, signature_record.signature)
        assert is_valid
    
    @pytest.mark.asyncio
    async def test_verify_invalid_signature(self, key_pair):
        """Test verifying an invalid signature."""
        private_key_path, _ = key_pair
        
        # Create signer
        signer = SoftwareSigner(private_key_path)
        
        # Create a test Merkle root
        merkle_root = hashlib.sha256(b"test_data").digest()
        
        # Create an invalid signature
        invalid_signature = b"invalid_signature"
        
        # Verify signature is invalid
        is_valid = await signer.verify_signature(merkle_root, invalid_signature)
        assert not is_valid


class TestMerkleBatcher:
    """Test Merkle batching functionality."""
    
    @pytest.fixture
    def signer(self):
        """Create a temporary signer for testing."""
        with tempfile.TemporaryDirectory() as tmpdir:
            private_key_path = os.path.join(tmpdir, "private.pem")
            public_key_path = os.path.join(tmpdir, "public.pem")
            
            key_manager = KeyManager()
            key_manager.generate_key_pair(
                private_key_path,
                public_key_path,
                passphrase=None
            )
            
            yield SoftwareSigner(private_key_path)
    
    @pytest.mark.asyncio
    async def test_batch_size_threshold(self, signer):
        """Test batch closes when size threshold is reached."""
        batcher = MerkleBatcher(
            merkle_signer=signer,
            batch_size_limit=3,
            batch_timeout_seconds=300
        )
        
        # Add events
        event1_hash = hashlib.sha256(b"event1").digest()
        event2_hash = hashlib.sha256(b"event2").digest()
        event3_hash = hashlib.sha256(b"event3").digest()
        
        # First two events should not close batch
        batch = await batcher.add_event(1, event1_hash)
        assert batch is None
        assert batcher.get_current_batch_size() == 1
        
        batch = await batcher.add_event(2, event2_hash)
        assert batch is None
        assert batcher.get_current_batch_size() == 2
        
        # Third event should close batch
        batch = await batcher.add_event(3, event3_hash)
        assert batch is not None
        assert batch.event_count == 3
        assert batch.event_ids == [1, 2, 3]
        assert batcher.get_current_batch_size() == 0
    
    @pytest.mark.asyncio
    async def test_batch_timeout_threshold(self, signer):
        """Test batch closes when timeout threshold is reached."""
        batcher = MerkleBatcher(
            merkle_signer=signer,
            batch_size_limit=100,
            batch_timeout_seconds=1  # 1 second timeout
        )
        
        # Add one event
        event_hash = hashlib.sha256(b"event1").digest()
        batch = await batcher.add_event(1, event_hash)
        assert batch is None
        assert batcher.get_current_batch_size() == 1
        
        # Wait for timeout
        await asyncio.sleep(1.5)
        
        # Batch should be closed by timeout
        assert batcher.get_current_batch_size() == 0
    
    @pytest.mark.asyncio
    async def test_manual_batch_close(self, signer):
        """Test manually closing a batch."""
        batcher = MerkleBatcher(
            merkle_signer=signer,
            batch_size_limit=100,
            batch_timeout_seconds=300
        )
        
        # Add events
        event1_hash = hashlib.sha256(b"event1").digest()
        event2_hash = hashlib.sha256(b"event2").digest()
        
        await batcher.add_event(1, event1_hash)
        await batcher.add_event(2, event2_hash)
        
        assert batcher.get_current_batch_size() == 2
        
        # Manually close batch
        batch = await batcher.close_batch()
        assert batch is not None
        assert batch.event_count == 2
        assert batch.event_ids == [1, 2]
        assert batcher.get_current_batch_size() == 0
    
    @pytest.mark.asyncio
    async def test_shutdown_closes_pending_batch(self, signer):
        """Test shutdown closes any pending batch."""
        batcher = MerkleBatcher(
            merkle_signer=signer,
            batch_size_limit=100,
            batch_timeout_seconds=300
        )
        
        # Add events
        event_hash = hashlib.sha256(b"event1").digest()
        await batcher.add_event(1, event_hash)
        
        assert batcher.get_current_batch_size() == 1
        
        # Shutdown should close pending batch
        await batcher.shutdown()
        assert batcher.get_current_batch_size() == 0
    
    @pytest.mark.asyncio
    async def test_invalid_event_id(self, signer):
        """Test adding event with invalid ID raises error."""
        batcher = MerkleBatcher(
            merkle_signer=signer,
            batch_size_limit=100,
            batch_timeout_seconds=300
        )
        
        event_hash = hashlib.sha256(b"event1").digest()
        
        with pytest.raises(ValueError, match="event_id must be non-negative"):
            await batcher.add_event(-1, event_hash)
    
    @pytest.mark.asyncio
    async def test_invalid_event_hash(self, signer):
        """Test adding event with invalid hash raises error."""
        batcher = MerkleBatcher(
            merkle_signer=signer,
            batch_size_limit=100,
            batch_timeout_seconds=300
        )
        
        with pytest.raises(ValueError, match="event_hash must be 32 bytes"):
            await batcher.add_event(1, b"invalid_hash")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
