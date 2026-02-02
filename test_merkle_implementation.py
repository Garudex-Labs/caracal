#!/usr/bin/env python3
"""
Simple validation script for Merkle batcher and signer implementation.
"""

import asyncio
import hashlib
import os
import sys
import tempfile
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent))

from caracal.merkle import (
    MerkleBatcher,
    SoftwareSigner,
    KeyManager,
    MerkleTree,
)


async def test_key_generation():
    """Test key generation."""
    print("Testing key generation...")
    
    with tempfile.TemporaryDirectory() as tmpdir:
        private_key_path = os.path.join(tmpdir, "private.pem")
        public_key_path = os.path.join(tmpdir, "public.pem")
        
        key_manager = KeyManager()
        key_manager.generate_key_pair(
            private_key_path,
            public_key_path,
            passphrase=None
        )
        
        assert Path(private_key_path).exists(), "Private key not created"
        assert Path(public_key_path).exists(), "Public key not created"
        assert key_manager.verify_key(private_key_path, passphrase=None), "Key verification failed"
        
        print("✓ Key generation successful")
        return private_key_path


async def test_signing():
    """Test Merkle root signing."""
    print("\nTesting Merkle root signing...")
    
    with tempfile.TemporaryDirectory() as tmpdir:
        private_key_path = os.path.join(tmpdir, "private.pem")
        public_key_path = os.path.join(tmpdir, "public.pem")
        
        # Generate key
        key_manager = KeyManager()
        key_manager.generate_key_pair(
            private_key_path,
            public_key_path,
            passphrase=None
        )
        
        # Create signer
        signer = SoftwareSigner(private_key_path)
        
        # Create test Merkle root
        merkle_root = hashlib.sha256(b"test_data").digest()
        
        # Create mock batch
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
        
        # Sign root
        signature_record = await signer.sign_root(merkle_root, batch)
        
        assert signature_record.merkle_root == merkle_root, "Merkle root mismatch"
        assert signature_record.event_count == 3, "Event count mismatch"
        assert signature_record.signing_backend == "software", "Signing backend mismatch"
        
        # Verify signature
        is_valid = await signer.verify_signature(merkle_root, signature_record.signature)
        assert is_valid, "Signature verification failed"
        
        print("✓ Signing and verification successful")


async def test_batching():
    """Test Merkle batching."""
    print("\nTesting Merkle batching...")
    
    with tempfile.TemporaryDirectory() as tmpdir:
        private_key_path = os.path.join(tmpdir, "private.pem")
        public_key_path = os.path.join(tmpdir, "public.pem")
        
        # Generate key
        key_manager = KeyManager()
        key_manager.generate_key_pair(
            private_key_path,
            public_key_path,
            passphrase=None
        )
        
        # Create signer
        signer = SoftwareSigner(private_key_path)
        
        # Create batcher
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
        assert batch is None, "Batch closed prematurely"
        assert batcher.get_current_batch_size() == 1, "Batch size incorrect"
        
        batch = await batcher.add_event(2, event2_hash)
        assert batch is None, "Batch closed prematurely"
        assert batcher.get_current_batch_size() == 2, "Batch size incorrect"
        
        # Third event should close batch
        batch = await batcher.add_event(3, event3_hash)
        assert batch is not None, "Batch not closed"
        assert batch.event_count == 3, "Event count incorrect"
        assert batch.event_ids == [1, 2, 3], "Event IDs incorrect"
        assert batcher.get_current_batch_size() == 0, "Batch not cleared"
        
        print("✓ Batching successful")


async def test_integration():
    """Test full integration."""
    print("\nTesting full integration...")
    
    with tempfile.TemporaryDirectory() as tmpdir:
        private_key_path = os.path.join(tmpdir, "private.pem")
        public_key_path = os.path.join(tmpdir, "public.pem")
        
        # Generate key
        key_manager = KeyManager()
        key_manager.generate_key_pair(
            private_key_path,
            public_key_path,
            passphrase=None
        )
        
        # Create signer
        signer = SoftwareSigner(private_key_path)
        
        # Create batcher
        batcher = MerkleBatcher(
            merkle_signer=signer,
            batch_size_limit=5,
            batch_timeout_seconds=300
        )
        
        # Add multiple events
        for i in range(5):
            event_hash = hashlib.sha256(f"event{i}".encode()).digest()
            batch = await batcher.add_event(i, event_hash)
            
            if i < 4:
                assert batch is None, f"Batch closed at event {i}"
            else:
                assert batch is not None, "Batch not closed at threshold"
                assert batch.event_count == 5, "Event count incorrect"
        
        # Verify Merkle tree can be reconstructed
        event_hashes = [hashlib.sha256(f"event{i}".encode()).digest() for i in range(5)]
        merkle_tree = MerkleTree(event_hashes)
        computed_root = merkle_tree.get_root()
        
        assert computed_root == batch.merkle_root, "Merkle root mismatch"
        
        print("✓ Full integration successful")


async def main():
    """Run all tests."""
    print("=" * 60)
    print("Merkle Batcher and Signer Implementation Validation")
    print("=" * 60)
    
    try:
        await test_key_generation()
        await test_signing()
        await test_batching()
        await test_integration()
        
        print("\n" + "=" * 60)
        print("✓ All tests passed!")
        print("=" * 60)
        return 0
    
    except Exception as e:
        print(f"\n✗ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
