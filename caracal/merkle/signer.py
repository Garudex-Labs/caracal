"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Merkle root signing with pluggable backend support.

This module provides cryptographic signing of Merkle roots using ECDSA P-256.
It supports pluggable signing backends:
- SoftwareSigner: Default implementation using local key files (OSS)
- HSMSigner: Enterprise implementation using PKCS#11 HSM (Enterprise module)

The signing backend is configured via merkle.signing_backend setting.
"""

import os
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional
from uuid import UUID

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.backends import default_backend

from caracal.logging_config import get_logger

logger = get_logger(__name__)


@dataclass
class MerkleRootSignature:
    """
    Signed Merkle root with metadata.
    
    Attributes:
        root_id: Unique identifier for this root
        merkle_root: The Merkle root hash
        signature: ECDSA P-256 signature of the root
        batch_id: Batch identifier
        event_count: Number of events in the batch
        first_event_id: First event ID in the batch
        last_event_id: Last event ID in the batch
        signed_at: Timestamp when root was signed
        signing_backend: Backend used for signing ("software" or "hsm")
    """
    root_id: UUID
    merkle_root: bytes
    signature: bytes
    batch_id: UUID
    event_count: int
    first_event_id: int
    last_event_id: int
    signed_at: datetime
    signing_backend: str


class MerkleSigner(ABC):
    """
    Abstract base class for Merkle root signing.
    
    Implementations:
    - SoftwareSigner: Default implementation using local key files (OSS)
    - HSMSigner: Enterprise implementation using PKCS#11 HSM (Enterprise module)
    
    The signing backend is configured via merkle.signing_backend setting.
    """
    
    @abstractmethod
    async def sign_root(self, merkle_root: bytes, batch) -> MerkleRootSignature:
        """
        Sign Merkle root.
        
        Args:
            merkle_root: Merkle root hash to sign
            batch: MerkleBatch metadata
        
        Returns:
            MerkleRootSignature with signature and metadata
        
        Raises:
            SigningError: If signing fails
        """
        pass
    
    @abstractmethod
    async def verify_signature(self, root: bytes, signature: bytes) -> bool:
        """
        Verify signature.
        
        Args:
            root: Merkle root hash
            signature: ECDSA P-256 signature
        
        Returns:
            True if signature is valid, False otherwise
        """
        pass
    
    @abstractmethod
    def get_public_key_pem(self) -> bytes:
        """
        Get public key in PEM format.
        
        Returns:
            Public key in PEM format
        """
        pass


class SoftwareSigner(MerkleSigner):
    """
    Default software-based Merkle signer using encrypted key files.
    
    This is the OSS implementation that stores private keys in encrypted
    files on disk. Suitable for development and small deployments.
    
    The private key is loaded from a PEM file and can be encrypted with
    a passphrase. The passphrase is read from the environment variable
    MERKLE_KEY_PASSPHRASE.
    
    Example:
        >>> from caracal.merkle.signer import SoftwareSigner
        >>> 
        >>> signer = SoftwareSigner("/path/to/key.pem")
        >>> signature = await signer.sign_root(merkle_root, batch)
        >>> is_valid = await signer.verify_signature(merkle_root, signature.signature)
    """
    
    def __init__(self, private_key_path: str, db_session=None):
        """
        Initialize signer with private key.
        
        Args:
            private_key_path: Path to ECDSA P-256 private key in PEM format
            db_session: Optional database session for storing signatures
        
        Raises:
            FileNotFoundError: If private key file not found
            ValueError: If private key is invalid or not ECDSA P-256
        """
        self.private_key_path = private_key_path
        self.db_session = db_session
        
        # Load private key
        try:
            self._private_key = self._load_private_key()
            self._public_key = self._private_key.public_key()
            logger.info(f"Loaded ECDSA P-256 private key from {private_key_path}")
        except Exception as e:
            logger.error(f"Failed to load private key from {private_key_path}: {e}", exc_info=True)
            raise
    
    def _load_private_key(self) -> ec.EllipticCurvePrivateKey:
        """
        Load ECDSA P-256 private key from PEM file.
        
        Returns:
            ECDSA P-256 private key
        
        Raises:
            FileNotFoundError: If key file not found
            ValueError: If key is invalid or not ECDSA P-256
        """
        key_path = Path(self.private_key_path).expanduser()
        
        if not key_path.exists():
            raise FileNotFoundError(f"Private key file not found: {key_path}")
        
        # Read key file
        with open(key_path, 'rb') as f:
            key_data = f.read()
        
        # Get passphrase from environment variable
        passphrase = os.environ.get('MERKLE_KEY_PASSPHRASE')
        passphrase_bytes = passphrase.encode() if passphrase else None
        
        # Load private key
        try:
            private_key = serialization.load_pem_private_key(
                key_data,
                password=passphrase_bytes,
                backend=default_backend()
            )
        except Exception as e:
            raise ValueError(f"Failed to load private key: {e}")
        
        # Verify it's an ECDSA key with P-256 curve
        if not isinstance(private_key, ec.EllipticCurvePrivateKey):
            raise ValueError(f"Key is not an ECDSA key, got {type(private_key)}")
        
        if not isinstance(private_key.curve, ec.SECP256R1):
            raise ValueError(f"Key is not P-256 curve, got {type(private_key.curve)}")
        
        return private_key
    
    async def sign_root(self, merkle_root: bytes, batch) -> MerkleRootSignature:
        """
        Sign Merkle root using software key.
        
        Args:
            merkle_root: Merkle root hash to sign
            batch: MerkleBatch metadata
        
        Returns:
            MerkleRootSignature with signature and metadata
        
        Raises:
            ValueError: If merkle_root is invalid
        """
        if not merkle_root or len(merkle_root) != 32:
            raise ValueError(f"merkle_root must be 32 bytes (SHA-256), got {len(merkle_root) if merkle_root else 0} bytes")
        
        # Sign the root using ECDSA with SHA-256
        try:
            signature = self._private_key.sign(
                merkle_root,
                ec.ECDSA(hashes.SHA256())
            )
            logger.debug(f"Signed Merkle root {merkle_root.hex()} for batch {batch.batch_id}")
        except Exception as e:
            logger.error(f"Failed to sign Merkle root: {e}", exc_info=True)
            raise
        
        # Create signature record
        from uuid import uuid4
        signature_record = MerkleRootSignature(
            root_id=uuid4(),
            merkle_root=merkle_root,
            signature=signature,
            batch_id=batch.batch_id,
            event_count=batch.event_count,
            first_event_id=batch.event_ids[0],
            last_event_id=batch.event_ids[-1],
            signed_at=datetime.utcnow(),
            signing_backend="software",
        )
        
        # Store signature in database if session provided
        if self.db_session:
            await self._store_signature(signature_record)
        
        # Log signing operation
        logger.info(
            f"Signed Merkle root {merkle_root.hex()[:16]}... for batch {batch.batch_id} "
            f"with {batch.event_count} events (IDs: {batch.event_ids[0]} to {batch.event_ids[-1]})"
        )
        
        return signature_record
    
    async def _store_signature(self, signature_record: MerkleRootSignature):
        """
        Store signature in merkle_roots table.
        
        Args:
            signature_record: Signature record to store
        """
        try:
            # Import here to avoid circular dependency
            from caracal.db.models import Base
            from sqlalchemy import Column, DateTime, Integer, LargeBinary, String
            from sqlalchemy.dialects.postgresql import UUID as PG_UUID
            
            # Check if MerkleRoot model exists, if not create it
            if not hasattr(Base.metadata.tables, 'merkle_roots'):
                # Model will be created by migration, just log for now
                logger.warning("merkle_roots table not found, signature not stored in database")
                return
            
            # Create MerkleRoot record
            # Note: This assumes the MerkleRoot model exists in db.models
            # For now, we'll just log since the table might not exist yet
            logger.debug(f"Storing signature for root {signature_record.root_id} in database")
            
            # TODO: Implement database storage once MerkleRoot model is added
            # merkle_root = MerkleRoot(
            #     root_id=signature_record.root_id,
            #     batch_id=signature_record.batch_id,
            #     merkle_root=signature_record.merkle_root,
            #     signature=signature_record.signature,
            #     event_count=signature_record.event_count,
            #     first_event_id=signature_record.first_event_id,
            #     last_event_id=signature_record.last_event_id,
            #     created_at=signature_record.signed_at,
            # )
            # self.db_session.add(merkle_root)
            # await self.db_session.commit()
            
        except Exception as e:
            logger.error(f"Failed to store signature in database: {e}", exc_info=True)
            # Don't raise - signature is still valid even if storage fails
    
    async def verify_signature(self, root: bytes, signature: bytes) -> bool:
        """
        Verify signature using software key.
        
        Args:
            root: Merkle root hash
            signature: ECDSA P-256 signature
        
        Returns:
            True if signature is valid, False otherwise
        """
        if not root or len(root) != 32:
            logger.warning(f"Invalid root length: {len(root) if root else 0} bytes")
            return False
        
        if not signature:
            logger.warning("Empty signature")
            return False
        
        try:
            self._public_key.verify(
                signature,
                root,
                ec.ECDSA(hashes.SHA256())
            )
            logger.debug(f"Signature verified for root {root.hex()[:16]}...")
            return True
        except Exception as e:
            logger.warning(f"Signature verification failed: {e}")
            return False
    
    def get_public_key_pem(self) -> bytes:
        """
        Get public key in PEM format.
        
        Returns:
            Public key in PEM format
        """
        return self._public_key.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo
        )


def create_merkle_signer(config, db_session=None) -> MerkleSigner:
    """
    Factory function to create appropriate signer based on configuration.
    
    Args:
        config: Merkle configuration with signing_backend setting
        db_session: Optional database session for storing signatures
    
    Returns:
        MerkleSigner implementation (SoftwareSigner or HSMSigner)
    
    Raises:
        ValueError: If signing_backend is invalid
    """
    signing_backend = getattr(config, 'signing_backend', 'software')
    
    if signing_backend == "software":
        private_key_path = getattr(config, 'private_key_path', None)
        if not private_key_path:
            raise ValueError("private_key_path is required for software signing backend")
        return SoftwareSigner(private_key_path, db_session)
    
    elif signing_backend == "hsm":
        # HSMSigner is provided by Enterprise module
        # Import will fail if Enterprise not installed
        try:
            from caracal_enterprise.hsm import HSMSigner
            hsm_config = getattr(config, 'hsm_config', None)
            if not hsm_config:
                raise ValueError("hsm_config is required for HSM signing backend")
            return HSMSigner(hsm_config, db_session)
        except ImportError:
            raise ValueError(
                "HSM signing backend requires Enterprise Caracal. "
                "Install caracal-enterprise or use signing_backend: software"
            )
    
    else:
        raise ValueError(f"Invalid signing_backend: {signing_backend}")
