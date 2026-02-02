"""
Key management for Merkle signing.

This module provides utilities for:
- Generating ECDSA P-256 key pairs
- Storing private keys in encrypted storage
- Key rotation support
- Audit logging of key usage

All key operations are logged for audit purposes.
"""

import os
from datetime import datetime
from pathlib import Path
from typing import Optional

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.backends import default_backend

from caracal.logging_config import get_logger

logger = get_logger(__name__)


class KeyManager:
    """
    Manages cryptographic keys for Merkle signing.
    
    Provides utilities for key generation, storage, rotation, and audit logging.
    All key operations are logged for compliance and security auditing.
    
    Example:
        >>> from caracal.merkle.key_management import KeyManager
        >>> 
        >>> # Generate new key pair
        >>> key_manager = KeyManager()
        >>> key_manager.generate_key_pair(
        ...     "/path/to/private_key.pem",
        ...     "/path/to/public_key.pem",
        ...     passphrase="secure_passphrase"
        ... )
        >>> 
        >>> # Rotate keys
        >>> key_manager.rotate_key(
        ...     "/path/to/old_key.pem",
        ...     "/path/to/new_key.pem",
        ...     passphrase="secure_passphrase"
        ... )
    """
    
    def __init__(self, audit_log_path: Optional[str] = None):
        """
        Initialize key manager.
        
        Args:
            audit_log_path: Optional path to audit log file for key operations
        """
        self.audit_log_path = audit_log_path
        if audit_log_path:
            # Ensure audit log directory exists
            Path(audit_log_path).parent.mkdir(parents=True, exist_ok=True)
            logger.info(f"Key operations will be logged to {audit_log_path}")
    
    def generate_key_pair(
        self,
        private_key_path: str,
        public_key_path: str,
        passphrase: Optional[str] = None,
    ) -> None:
        """
        Generate new ECDSA P-256 key pair.
        
        Generates a new key pair and stores it in PEM format. The private key
        can be encrypted with a passphrase for additional security.
        
        Args:
            private_key_path: Path to store private key
            public_key_path: Path to store public key
            passphrase: Optional passphrase to encrypt private key
        
        Raises:
            FileExistsError: If key files already exist
            OSError: If unable to write key files
        """
        private_path = Path(private_key_path).expanduser()
        public_path = Path(public_key_path).expanduser()
        
        # Check if keys already exist
        if private_path.exists():
            raise FileExistsError(f"Private key already exists: {private_path}")
        if public_path.exists():
            raise FileExistsError(f"Public key already exists: {public_path}")
        
        # Ensure directories exist
        private_path.parent.mkdir(parents=True, exist_ok=True)
        public_path.parent.mkdir(parents=True, exist_ok=True)
        
        logger.info(f"Generating new ECDSA P-256 key pair")
        
        # Generate private key
        private_key = ec.generate_private_key(
            ec.SECP256R1(),  # P-256 curve
            default_backend()
        )
        
        # Get public key
        public_key = private_key.public_key()
        
        # Serialize private key
        encryption_algorithm = (
            serialization.BestAvailableEncryption(passphrase.encode())
            if passphrase
            else serialization.NoEncryption()
        )
        
        private_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=encryption_algorithm
        )
        
        # Serialize public key
        public_pem = public_key.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo
        )
        
        # Write private key with restricted permissions
        with open(private_path, 'wb') as f:
            f.write(private_pem)
        os.chmod(private_path, 0o600)  # Read/write for owner only
        
        # Write public key
        with open(public_path, 'wb') as f:
            f.write(public_pem)
        os.chmod(public_path, 0o644)  # Read for all, write for owner
        
        logger.info(f"Generated key pair: private={private_path}, public={public_path}")
        
        # Log key generation
        self._log_key_operation(
            operation="generate",
            key_path=str(private_path),
            details=f"Generated new ECDSA P-256 key pair (encrypted: {passphrase is not None})"
        )
    
    def rotate_key(
        self,
        old_key_path: str,
        new_key_path: str,
        new_public_key_path: str,
        passphrase: Optional[str] = None,
        backup_old_key: bool = True,
    ) -> None:
        """
        Rotate Merkle signing key.
        
        Generates a new key pair and optionally backs up the old key.
        The old key is renamed with a timestamp suffix for backup.
        
        Args:
            old_key_path: Path to current private key
            new_key_path: Path to store new private key
            new_public_key_path: Path to store new public key
            passphrase: Optional passphrase to encrypt new private key
            backup_old_key: Whether to backup old key (default True)
        
        Raises:
            FileNotFoundError: If old key doesn't exist
            FileExistsError: If new key already exists
        """
        old_path = Path(old_key_path).expanduser()
        new_path = Path(new_key_path).expanduser()
        new_public_path = Path(new_public_key_path).expanduser()
        
        # Verify old key exists
        if not old_path.exists():
            raise FileNotFoundError(f"Old key not found: {old_path}")
        
        # Check if new key already exists
        if new_path.exists():
            raise FileExistsError(f"New key already exists: {new_path}")
        
        logger.info(f"Rotating key from {old_path} to {new_path}")
        
        # Generate new key pair
        self.generate_key_pair(
            str(new_path),
            str(new_public_path),
            passphrase=passphrase
        )
        
        # Backup old key if requested
        if backup_old_key:
            timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
            backup_path = old_path.parent / f"{old_path.stem}.backup_{timestamp}{old_path.suffix}"
            
            logger.info(f"Backing up old key to {backup_path}")
            old_path.rename(backup_path)
            
            # Log backup
            self._log_key_operation(
                operation="backup",
                key_path=str(old_path),
                details=f"Backed up old key to {backup_path}"
            )
        else:
            # Delete old key
            logger.warning(f"Deleting old key {old_path} (no backup)")
            old_path.unlink()
            
            # Log deletion
            self._log_key_operation(
                operation="delete",
                key_path=str(old_path),
                details="Deleted old key without backup"
            )
        
        # Log rotation
        self._log_key_operation(
            operation="rotate",
            key_path=str(new_path),
            details=f"Rotated key from {old_path} to {new_path}"
        )
    
    def verify_key(self, private_key_path: str, passphrase: Optional[str] = None) -> bool:
        """
        Verify that a private key is valid and can be loaded.
        
        Args:
            private_key_path: Path to private key
            passphrase: Optional passphrase if key is encrypted
        
        Returns:
            True if key is valid, False otherwise
        """
        key_path = Path(private_key_path).expanduser()
        
        if not key_path.exists():
            logger.error(f"Key file not found: {key_path}")
            return False
        
        try:
            # Try to load the key
            with open(key_path, 'rb') as f:
                key_data = f.read()
            
            passphrase_bytes = passphrase.encode() if passphrase else None
            
            private_key = serialization.load_pem_private_key(
                key_data,
                password=passphrase_bytes,
                backend=default_backend()
            )
            
            # Verify it's an ECDSA key with P-256 curve
            if not isinstance(private_key, ec.EllipticCurvePrivateKey):
                logger.error(f"Key is not an ECDSA key: {type(private_key)}")
                return False
            
            if not isinstance(private_key.curve, ec.SECP256R1):
                logger.error(f"Key is not P-256 curve: {type(private_key.curve)}")
                return False
            
            logger.info(f"Key verified successfully: {key_path}")
            
            # Log verification
            self._log_key_operation(
                operation="verify",
                key_path=str(key_path),
                details="Key verified successfully"
            )
            
            return True
            
        except Exception as e:
            logger.error(f"Failed to verify key {key_path}: {e}", exc_info=True)
            
            # Log verification failure
            self._log_key_operation(
                operation="verify",
                key_path=str(key_path),
                details=f"Key verification failed: {e}"
            )
            
            return False
    
    def export_public_key(
        self,
        private_key_path: str,
        public_key_path: str,
        passphrase: Optional[str] = None,
    ) -> None:
        """
        Export public key from private key.
        
        Args:
            private_key_path: Path to private key
            public_key_path: Path to store public key
            passphrase: Optional passphrase if private key is encrypted
        
        Raises:
            FileNotFoundError: If private key doesn't exist
            ValueError: If private key is invalid
        """
        private_path = Path(private_key_path).expanduser()
        public_path = Path(public_key_path).expanduser()
        
        if not private_path.exists():
            raise FileNotFoundError(f"Private key not found: {private_path}")
        
        logger.info(f"Exporting public key from {private_path} to {public_path}")
        
        # Load private key
        with open(private_path, 'rb') as f:
            key_data = f.read()
        
        passphrase_bytes = passphrase.encode() if passphrase else None
        
        private_key = serialization.load_pem_private_key(
            key_data,
            password=passphrase_bytes,
            backend=default_backend()
        )
        
        # Get public key
        public_key = private_key.public_key()
        
        # Serialize public key
        public_pem = public_key.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo
        )
        
        # Ensure directory exists
        public_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Write public key
        with open(public_path, 'wb') as f:
            f.write(public_pem)
        os.chmod(public_path, 0o644)  # Read for all, write for owner
        
        logger.info(f"Exported public key to {public_path}")
        
        # Log export
        self._log_key_operation(
            operation="export",
            key_path=str(public_path),
            details=f"Exported public key from {private_path}"
        )
    
    def _log_key_operation(self, operation: str, key_path: str, details: str) -> None:
        """
        Log key operation to audit log.
        
        Args:
            operation: Operation type (generate, rotate, backup, delete, verify, export)
            key_path: Path to key file
            details: Additional details about the operation
        """
        timestamp = datetime.utcnow().isoformat()
        log_entry = f"{timestamp} | {operation.upper()} | {key_path} | {details}\n"
        
        # Log to application logger
        logger.info(f"Key operation: {operation} | {key_path} | {details}")
        
        # Log to audit file if configured
        if self.audit_log_path:
            try:
                with open(self.audit_log_path, 'a') as f:
                    f.write(log_entry)
            except Exception as e:
                logger.error(f"Failed to write to audit log {self.audit_log_path}: {e}", exc_info=True)


def generate_merkle_signing_key(
    private_key_path: str,
    public_key_path: str,
    passphrase: Optional[str] = None,
    audit_log_path: Optional[str] = None,
) -> None:
    """
    Convenience function to generate Merkle signing key pair.
    
    Args:
        private_key_path: Path to store private key
        public_key_path: Path to store public key
        passphrase: Optional passphrase to encrypt private key
        audit_log_path: Optional path to audit log file
    
    Example:
        >>> from caracal.merkle.key_management import generate_merkle_signing_key
        >>> 
        >>> generate_merkle_signing_key(
        ...     "/etc/caracal/keys/merkle-signing-key.pem",
        ...     "/etc/caracal/keys/merkle-signing-key.pub",
        ...     passphrase="secure_passphrase",
        ...     audit_log_path="/var/log/caracal/key_operations.log"
        ... )
    """
    key_manager = KeyManager(audit_log_path=audit_log_path)
    key_manager.generate_key_pair(
        private_key_path,
        public_key_path,
        passphrase=passphrase
    )
