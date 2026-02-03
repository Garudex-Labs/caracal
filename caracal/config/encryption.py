"""
Configuration encryption utilities for Caracal Core.

Provides utilities for:
- Encrypting sensitive configuration values
- Decrypting encrypted configuration values
- Managing encryption keys
- Secure key storage

All encryption uses AES-256-GCM for authenticated encryption.
"""

import base64
import os
from pathlib import Path
from typing import Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2
from cryptography.hazmat.backends import default_backend

from caracal.logging_config import get_logger

logger = get_logger(__name__)


class ConfigEncryption:
    """
    Handles encryption and decryption of configuration values.
    
    Uses AES-256-GCM for authenticated encryption with a key derived
    from a master password using PBKDF2.
    
    Example:
        >>> from caracal.config.encryption import ConfigEncryption
        >>> 
        >>> # Encrypt a value
        >>> encryptor = ConfigEncryption("master_password")
        >>> encrypted = encryptor.encrypt("sensitive_value")
        >>> print(encrypted)  # ENC[base64_encoded_ciphertext]
        >>> 
        >>> # Decrypt a value
        >>> decrypted = encryptor.decrypt(encrypted)
        >>> print(decrypted)  # sensitive_value
    """
    
    # Prefix for encrypted values in configuration
    ENCRYPTED_PREFIX = "ENC["
    ENCRYPTED_SUFFIX = "]"
    
    # Salt for key derivation (should be stored securely in production)
    # In production, this should be unique per installation
    DEFAULT_SALT = b"caracal_config_encryption_salt_v1"
    
    def __init__(
        self,
        master_password: Optional[str] = None,
        salt: Optional[bytes] = None,
    ):
        """
        Initialize configuration encryption.
        
        Args:
            master_password: Master password for encryption (from env var if not provided)
            salt: Salt for key derivation (uses default if not provided)
        """
        # Get master password from environment if not provided
        if master_password is None:
            master_password = os.environ.get("CARACAL_MASTER_PASSWORD")
            if not master_password:
                raise ValueError(
                    "Master password not provided. Set CARACAL_MASTER_PASSWORD "
                    "environment variable or pass master_password parameter."
                )
        
        self.master_password = master_password
        self.salt = salt or self.DEFAULT_SALT
        
        # Derive encryption key from master password
        self.key = self._derive_key(master_password, self.salt)
        self.cipher = AESGCM(self.key)
        
        logger.debug("Configuration encryption initialized")
    
    def _derive_key(self, password: str, salt: bytes) -> bytes:
        """
        Derive encryption key from password using PBKDF2.
        
        Args:
            password: Master password
            salt: Salt for key derivation
        
        Returns:
            32-byte encryption key
        """
        kdf = PBKDF2(
            algorithm=hashes.SHA256(),
            length=32,  # 256 bits for AES-256
            salt=salt,
            iterations=100000,  # OWASP recommended minimum
            backend=default_backend()
        )
        return kdf.derive(password.encode())
    
    def encrypt(self, plaintext: str) -> str:
        """
        Encrypt a plaintext value.
        
        Args:
            plaintext: Value to encrypt
        
        Returns:
            Encrypted value in format: ENC[base64_encoded_ciphertext]
        """
        # Generate random nonce (12 bytes for GCM)
        nonce = os.urandom(12)
        
        # Encrypt plaintext
        ciphertext = self.cipher.encrypt(nonce, plaintext.encode(), None)
        
        # Combine nonce and ciphertext
        encrypted_data = nonce + ciphertext
        
        # Encode as base64
        encoded = base64.b64encode(encrypted_data).decode('ascii')
        
        # Return with prefix/suffix
        return f"{self.ENCRYPTED_PREFIX}{encoded}{self.ENCRYPTED_SUFFIX}"
    
    def decrypt(self, encrypted: str) -> str:
        """
        Decrypt an encrypted value.
        
        Args:
            encrypted: Encrypted value in format: ENC[base64_encoded_ciphertext]
        
        Returns:
            Decrypted plaintext value
        
        Raises:
            ValueError: If encrypted value is invalid or decryption fails
        """
        # Check if value is encrypted
        if not self.is_encrypted(encrypted):
            raise ValueError(
                f"Value is not encrypted (must start with {self.ENCRYPTED_PREFIX} "
                f"and end with {self.ENCRYPTED_SUFFIX})"
            )
        
        # Extract base64-encoded ciphertext
        encoded = encrypted[len(self.ENCRYPTED_PREFIX):-len(self.ENCRYPTED_SUFFIX)]
        
        try:
            # Decode from base64
            encrypted_data = base64.b64decode(encoded)
            
            # Extract nonce and ciphertext
            nonce = encrypted_data[:12]
            ciphertext = encrypted_data[12:]
            
            # Decrypt
            plaintext = self.cipher.decrypt(nonce, ciphertext, None)
            
            return plaintext.decode('utf-8')
            
        except Exception as e:
            logger.error(f"Failed to decrypt value: {e}")
            raise ValueError(f"Failed to decrypt value: {e}") from e
    
    @classmethod
    def is_encrypted(cls, value: str) -> bool:
        """
        Check if a value is encrypted.
        
        Args:
            value: Value to check
        
        Returns:
            True if value is encrypted, False otherwise
        """
        return (
            isinstance(value, str) and
            value.startswith(cls.ENCRYPTED_PREFIX) and
            value.endswith(cls.ENCRYPTED_SUFFIX)
        )
    
    def decrypt_config(self, config_dict: dict) -> dict:
        """
        Recursively decrypt all encrypted values in a configuration dictionary.
        
        Args:
            config_dict: Configuration dictionary
        
        Returns:
            Configuration dictionary with decrypted values
        """
        result = {}
        
        for key, value in config_dict.items():
            if isinstance(value, str) and self.is_encrypted(value):
                # Decrypt encrypted value
                try:
                    result[key] = self.decrypt(value)
                    logger.debug(f"Decrypted configuration value: {key}")
                except Exception as e:
                    logger.error(f"Failed to decrypt configuration value {key}: {e}")
                    raise
            elif isinstance(value, dict):
                # Recursively decrypt nested dictionaries
                result[key] = self.decrypt_config(value)
            elif isinstance(value, list):
                # Decrypt list items
                result[key] = [
                    self.decrypt(item) if isinstance(item, str) and self.is_encrypted(item)
                    else item
                    for item in value
                ]
            else:
                # Keep non-encrypted values as-is
                result[key] = value
        
        return result


def encrypt_value(value: str, master_password: Optional[str] = None) -> str:
    """
    Convenience function to encrypt a single value.
    
    Args:
        value: Value to encrypt
        master_password: Master password (from env var if not provided)
    
    Returns:
        Encrypted value in format: ENC[base64_encoded_ciphertext]
    
    Example:
        >>> from caracal.config.encryption import encrypt_value
        >>> 
        >>> encrypted = encrypt_value("my_secret_password")
        >>> print(encrypted)  # ENC[...]
    """
    encryptor = ConfigEncryption(master_password=master_password)
    return encryptor.encrypt(value)


def decrypt_value(encrypted: str, master_password: Optional[str] = None) -> str:
    """
    Convenience function to decrypt a single value.
    
    Args:
        encrypted: Encrypted value in format: ENC[base64_encoded_ciphertext]
        master_password: Master password (from env var if not provided)
    
    Returns:
        Decrypted plaintext value
    
    Example:
        >>> from caracal.config.encryption import decrypt_value
        >>> 
        >>> decrypted = decrypt_value("ENC[...]")
        >>> print(decrypted)  # my_secret_password
    """
    encryptor = ConfigEncryption(master_password=master_password)
    return encryptor.decrypt(encrypted)


def generate_master_password() -> str:
    """
    Generate a secure random master password.
    
    Returns:
        Base64-encoded random password (32 bytes)
    
    Example:
        >>> from caracal.config.encryption import generate_master_password
        >>> 
        >>> password = generate_master_password()
        >>> print(password)  # Random base64 string
    """
    random_bytes = os.urandom(32)
    return base64.b64encode(random_bytes).decode('ascii')


def save_master_password(password: str, path: str) -> None:
    """
    Save master password to a file with restricted permissions.
    
    Args:
        password: Master password to save
        path: Path to save password file
    
    Example:
        >>> from caracal.config.encryption import generate_master_password, save_master_password
        >>> 
        >>> password = generate_master_password()
        >>> save_master_password(password, "~/.caracal/master_password")
    """
    password_path = Path(path).expanduser()
    
    # Ensure directory exists
    password_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Write password
    password_path.write_text(password)
    
    # Set restrictive permissions (read/write for owner only)
    os.chmod(password_path, 0o600)
    
    logger.info(f"Master password saved to {password_path}")


def load_master_password(path: str) -> str:
    """
    Load master password from a file.
    
    Args:
        path: Path to password file
    
    Returns:
        Master password
    
    Raises:
        FileNotFoundError: If password file doesn't exist
    
    Example:
        >>> from caracal.config.encryption import load_master_password
        >>> 
        >>> password = load_master_password("~/.caracal/master_password")
    """
    password_path = Path(path).expanduser()
    
    if not password_path.exists():
        raise FileNotFoundError(f"Master password file not found: {password_path}")
    
    password = password_path.read_text().strip()
    
    logger.debug(f"Master password loaded from {password_path}")
    
    return password
