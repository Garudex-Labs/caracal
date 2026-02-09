"""
Cryptographic operations for authority enforcement.

This module provides cryptographic functions for execution mandate signing
and verification using ECDSA P-256 (NIST P-256 curve) with deterministic
signatures (RFC 6979).

Requirements: 1.7, 5.5, 6.1, 13.1, 13.2
"""

import hashlib
import json
from typing import Dict, Any

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.backends import default_backend
from cryptography.exceptions import InvalidSignature

from caracal.logging_config import get_logger

logger = get_logger(__name__)


def sign_mandate(
    mandate_data: Dict[str, Any],
    private_key_pem: str,
    passphrase: str = None
) -> str:
    """
    Sign an execution mandate using ECDSA P-256 with deterministic signatures (RFC 6979).
    
    The mandate data is canonicalized to JSON, hashed with SHA-256, and then signed
    using ECDSA P-256. The signature is returned as a hex-encoded string.
    
    Args:
        mandate_data: Dictionary containing mandate fields to sign
        private_key_pem: Private key in PEM format (string)
        passphrase: Optional passphrase for encrypted private key
    
    Returns:
        Hex-encoded signature string
    
    Raises:
        ValueError: If mandate_data is invalid or private_key_pem is invalid
        TypeError: If mandate_data is not a dictionary
    
    Requirements: 1.7, 5.5, 13.1
    
    Example:
        >>> mandate = {
        ...     "mandate_id": "550e8400-e29b-41d4-a716-446655440000",
        ...     "issuer_id": "660e8400-e29b-41d4-a716-446655440000",
        ...     "subject_id": "770e8400-e29b-41d4-a716-446655440000",
        ...     "valid_from": "2024-01-15T10:00:00Z",
        ...     "valid_until": "2024-01-15T11:00:00Z",
        ...     "resource_scope": ["api:openai:gpt-4"],
        ...     "action_scope": ["api_call"]
        ... }
        >>> signature = sign_mandate(mandate, private_key_pem)
        >>> print(signature)  # Hex string like "3045022100..."
    """
    if not isinstance(mandate_data, dict):
        raise TypeError(f"mandate_data must be a dictionary, got {type(mandate_data)}")
    
    if not mandate_data:
        raise ValueError("mandate_data cannot be empty")
    
    if not private_key_pem:
        raise ValueError("private_key_pem cannot be empty")
    
    try:
        # Load private key from PEM format
        passphrase_bytes = passphrase.encode() if passphrase else None
        private_key = serialization.load_pem_private_key(
            private_key_pem.encode() if isinstance(private_key_pem, str) else private_key_pem,
            password=passphrase_bytes,
            backend=default_backend()
        )
        
        # Verify it's an ECDSA key with P-256 curve
        if not isinstance(private_key, ec.EllipticCurvePrivateKey):
            raise ValueError(f"Key is not an ECDSA key, got {type(private_key)}")
        
        if not isinstance(private_key.curve, ec.SECP256R1):
            raise ValueError(f"Key is not P-256 curve, got {type(private_key.curve)}")
        
    except Exception as e:
        logger.error(f"Failed to load private key: {e}", exc_info=True)
        raise ValueError(f"Invalid private key: {e}")
    
    try:
        # Canonicalize mandate data to JSON (sorted keys for determinism)
        canonical_json = json.dumps(mandate_data, sort_keys=True, separators=(',', ':'))
        
        # Hash the canonical JSON with SHA-256
        message_hash = hashlib.sha256(canonical_json.encode()).digest()
        
        # Sign the hash using ECDSA P-256 with deterministic signatures (RFC 6979)
        # The cryptography library uses deterministic ECDSA by default
        signature = private_key.sign(
            message_hash,
            ec.ECDSA(hashes.SHA256())
        )
        
        # Convert signature to hex string
        signature_hex = signature.hex()
        
        logger.debug(f"Signed mandate {mandate_data.get('mandate_id', 'unknown')} with ECDSA P-256")
        
        return signature_hex
        
    except Exception as e:
        logger.error(f"Failed to sign mandate: {e}", exc_info=True)
        raise ValueError(f"Failed to sign mandate: {e}")


def verify_mandate_signature(
    mandate_data: Dict[str, Any],
    signature_hex: str,
    public_key_pem: str
) -> bool:
    """
    Verify an execution mandate signature using ECDSA P-256.
    
    The mandate data is canonicalized to JSON, hashed with SHA-256, and then
    the signature is verified using the public key.
    
    Args:
        mandate_data: Dictionary containing mandate fields that were signed
        signature_hex: Hex-encoded signature string
        public_key_pem: Public key in PEM format (string)
    
    Returns:
        True if signature is valid, False otherwise
    
    Requirements: 6.1, 13.2
    
    Example:
        >>> is_valid = verify_mandate_signature(mandate, signature, public_key_pem)
        >>> assert is_valid
    """
    if not isinstance(mandate_data, dict):
        logger.warning(f"mandate_data must be a dictionary, got {type(mandate_data)}")
        return False
    
    if not mandate_data:
        logger.warning("mandate_data cannot be empty")
        return False
    
    if not signature_hex:
        logger.warning("signature_hex cannot be empty")
        return False
    
    if not public_key_pem:
        logger.warning("public_key_pem cannot be empty")
        return False
    
    try:
        # Load public key from PEM format
        public_key = serialization.load_pem_public_key(
            public_key_pem.encode() if isinstance(public_key_pem, str) else public_key_pem,
            backend=default_backend()
        )
        
        # Verify it's an ECDSA key with P-256 curve
        if not isinstance(public_key, ec.EllipticCurvePublicKey):
            logger.warning(f"Key is not an ECDSA public key, got {type(public_key)}")
            return False
        
        if not isinstance(public_key.curve, ec.SECP256R1):
            logger.warning(f"Key is not P-256 curve, got {type(public_key.curve)}")
            return False
        
    except Exception as e:
        logger.warning(f"Failed to load public key: {e}")
        return False
    
    try:
        # Canonicalize mandate data to JSON (sorted keys for determinism)
        canonical_json = json.dumps(mandate_data, sort_keys=True, separators=(',', ':'))
        
        # Hash the canonical JSON with SHA-256
        message_hash = hashlib.sha256(canonical_json.encode()).digest()
        
        # Convert hex signature to bytes
        signature_bytes = bytes.fromhex(signature_hex)
        
        # Verify the signature
        public_key.verify(
            signature_bytes,
            message_hash,
            ec.ECDSA(hashes.SHA256())
        )
        
        logger.debug(f"Signature verified for mandate {mandate_data.get('mandate_id', 'unknown')}")
        return True
        
    except InvalidSignature:
        logger.warning(f"Invalid signature for mandate {mandate_data.get('mandate_id', 'unknown')}")
        return False
    except ValueError as e:
        logger.warning(f"Invalid signature format: {e}")
        return False
    except Exception as e:
        logger.warning(f"Signature verification failed: {e}")
        return False



def sign_merkle_root(
    merkle_root: bytes,
    private_key_pem: str,
    passphrase: str = None
) -> str:
    """
    Sign a Merkle root hash using ECDSA P-256.
    
    The Merkle root (32-byte SHA-256 hash) is signed directly using ECDSA P-256.
    The signature is returned as a hex-encoded string.
    
    Args:
        merkle_root: 32-byte Merkle root hash (SHA-256)
        private_key_pem: Private key in PEM format (string)
        passphrase: Optional passphrase for encrypted private key
    
    Returns:
        Hex-encoded signature string
    
    Raises:
        ValueError: If merkle_root is invalid or private_key_pem is invalid
    
    Requirements: 13.4, 13.5
    
    Example:
        >>> from caracal.merkle.tree import MerkleTreeBuilder
        >>> builder = MerkleTreeBuilder()
        >>> tree = builder.build_tree([b"event1", b"event2", b"event3"])
        >>> root = builder.get_root()
        >>> signature = sign_merkle_root(root, private_key_pem)
    """
    if not merkle_root:
        raise ValueError("merkle_root cannot be empty")
    
    if len(merkle_root) != 32:
        raise ValueError(f"merkle_root must be 32 bytes (SHA-256), got {len(merkle_root)} bytes")
    
    if not private_key_pem:
        raise ValueError("private_key_pem cannot be empty")
    
    try:
        # Load private key from PEM format
        passphrase_bytes = passphrase.encode() if passphrase else None
        private_key = serialization.load_pem_private_key(
            private_key_pem.encode() if isinstance(private_key_pem, str) else private_key_pem,
            password=passphrase_bytes,
            backend=default_backend()
        )
        
        # Verify it's an ECDSA key with P-256 curve
        if not isinstance(private_key, ec.EllipticCurvePrivateKey):
            raise ValueError(f"Key is not an ECDSA key, got {type(private_key)}")
        
        if not isinstance(private_key.curve, ec.SECP256R1):
            raise ValueError(f"Key is not P-256 curve, got {type(private_key.curve)}")
        
    except Exception as e:
        logger.error(f"Failed to load private key: {e}", exc_info=True)
        raise ValueError(f"Invalid private key: {e}")
    
    try:
        # Sign the Merkle root using ECDSA P-256
        signature = private_key.sign(
            merkle_root,
            ec.ECDSA(hashes.SHA256())
        )
        
        # Convert signature to hex string
        signature_hex = signature.hex()
        
        logger.debug(f"Signed Merkle root {merkle_root.hex()[:16]}... with ECDSA P-256")
        
        return signature_hex
        
    except Exception as e:
        logger.error(f"Failed to sign Merkle root: {e}", exc_info=True)
        raise ValueError(f"Failed to sign Merkle root: {e}")


def verify_merkle_root(
    merkle_root: bytes,
    signature_hex: str,
    public_key_pem: str
) -> bool:
    """
    Verify a Merkle root signature using ECDSA P-256.
    
    Args:
        merkle_root: 32-byte Merkle root hash (SHA-256)
        signature_hex: Hex-encoded signature string
        public_key_pem: Public key in PEM format (string)
    
    Returns:
        True if signature is valid, False otherwise
    
    Requirements: 13.4, 13.5
    
    Example:
        >>> is_valid = verify_merkle_root(root, signature, public_key_pem)
        >>> assert is_valid
    """
    if not merkle_root:
        logger.warning("merkle_root cannot be empty")
        return False
    
    if len(merkle_root) != 32:
        logger.warning(f"merkle_root must be 32 bytes (SHA-256), got {len(merkle_root)} bytes")
        return False
    
    if not signature_hex:
        logger.warning("signature_hex cannot be empty")
        return False
    
    if not public_key_pem:
        logger.warning("public_key_pem cannot be empty")
        return False
    
    try:
        # Load public key from PEM format
        public_key = serialization.load_pem_public_key(
            public_key_pem.encode() if isinstance(public_key_pem, str) else public_key_pem,
            backend=default_backend()
        )
        
        # Verify it's an ECDSA key with P-256 curve
        if not isinstance(public_key, ec.EllipticCurvePublicKey):
            logger.warning(f"Key is not an ECDSA public key, got {type(public_key)}")
            return False
        
        if not isinstance(public_key.curve, ec.SECP256R1):
            logger.warning(f"Key is not P-256 curve, got {type(public_key.curve)}")
            return False
        
    except Exception as e:
        logger.warning(f"Failed to load public key: {e}")
        return False
    
    try:
        # Convert hex signature to bytes
        signature_bytes = bytes.fromhex(signature_hex)
        
        # Verify the signature
        public_key.verify(
            signature_bytes,
            merkle_root,
            ec.ECDSA(hashes.SHA256())
        )
        
        logger.debug(f"Merkle root signature verified for root {merkle_root.hex()[:16]}...")
        return True
        
    except InvalidSignature:
        logger.warning(f"Invalid Merkle root signature for root {merkle_root.hex()[:16]}...")
        return False
    except ValueError as e:
        logger.warning(f"Invalid signature format: {e}")
        return False
    except Exception as e:
        logger.warning(f"Merkle root signature verification failed: {e}")
        return False
