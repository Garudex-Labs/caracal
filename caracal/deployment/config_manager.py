"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Configuration management for Caracal deployment architecture.

Handles system-level configuration with encryption and workspace management.
"""

import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import tempfile
from dataclasses import asdict, dataclass
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

import keyring
import structlog
import toml
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2

from caracal.deployment.exceptions import (
    ConfigurationCorruptedError,
    ConfigurationError,
    ConfigurationNotFoundError,
    ConfigurationValidationError,
    DecryptionError,
    EncryptionError,
    EncryptionKeyError,
    InvalidWorkspaceNameError,
    KeyringError,
    SecretNotFoundError,
    WorkspaceAlreadyExistsError,
    WorkspaceNotFoundError,
    WorkspaceOperationError,
)

logger = structlog.get_logger(__name__)


class SyncDirection(str, Enum):
    """Sync direction enumeration."""
    PUSH = "push"
    PULL = "pull"
    BIDIRECTIONAL = "bidirectional"


class ConflictStrategy(str, Enum):
    """Conflict resolution strategy enumeration."""
    OPERATIONAL_TRANSFORM = "operational_transform"
    LAST_WRITE_WINS = "last_write_wins"
    REMOTE_WINS = "remote_wins"
    LOCAL_WINS = "local_wins"
    MANUAL = "manual"


@dataclass
class WorkspaceConfig:
    """Workspace configuration data model."""
    name: str
    created_at: datetime
    updated_at: datetime
    is_default: bool
    sync_enabled: bool
    sync_url: Optional[str]
    sync_direction: SyncDirection
    auto_sync_interval: Optional[int]  # seconds
    last_sync: Optional[datetime]
    conflict_strategy: ConflictStrategy
    metadata: Dict[str, Any]


@dataclass
class PostgresConfig:
    """PostgreSQL configuration data model."""
    host: str
    port: int
    database: str
    user: str
    password_ref: str  # Reference to encrypted password in vault
    ssl_mode: str  # require, verify-ca, verify-full
    pool_size: int
    max_overflow: int
    pool_timeout: int


class ConfigManager:
    """
    Manages system-level configuration and credentials.
    
    Provides methods for workspace management, credential encryption,
    and configuration persistence using TOML files and age encryption.
    """
    
    # Configuration directory and file paths
    CONFIG_DIR = Path.home() / ".caracal"
    CONFIG_FILE = CONFIG_DIR / "config.toml"
    WORKSPACES_DIR = CONFIG_DIR / "workspaces"
    CACHE_DIR = CONFIG_DIR / "cache"
    LOGS_DIR = CONFIG_DIR / "logs"
    
    # Keyring service name for encryption keys
    KEYRING_SERVICE = "caracal"
    KEYRING_USERNAME = "encryption_key"
    
    # Workspace name validation pattern
    WORKSPACE_NAME_PATTERN = re.compile(r'^[a-zA-Z0-9_-]{1,64}$')
    
    # Workspace templates
    TEMPLATES = {
        "enterprise": {
            "sync_enabled": True,
            "sync_direction": SyncDirection.BIDIRECTIONAL,
            "auto_sync_interval": 300,
            "conflict_strategy": ConflictStrategy.OPERATIONAL_TRANSFORM,
            "metadata": {"template": "enterprise"}
        },
        "local-dev": {
            "sync_enabled": False,
            "sync_direction": SyncDirection.BIDIRECTIONAL,
            "auto_sync_interval": None,
            "conflict_strategy": ConflictStrategy.LAST_WRITE_WINS,
            "metadata": {"template": "local-dev"}
        }
    }
    
    def __init__(self):
        """Initialize the configuration manager."""
        self._ensure_config_dir()
        self._encryption_key: Optional[bytes] = None
    
    def _ensure_config_dir(self) -> None:
        """Ensure configuration directory exists with proper permissions."""
        try:
            # Create main config directory
            self.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            self.CONFIG_DIR.chmod(0o700)
            
            # Create subdirectories
            self.WORKSPACES_DIR.mkdir(exist_ok=True)
            self.CACHE_DIR.mkdir(exist_ok=True)
            self.LOGS_DIR.mkdir(exist_ok=True)
            
            logger.debug(
                "config_dir_ensured",
                config_dir=str(self.CONFIG_DIR)
            )
        except OSError as e:
            logger.error(
                "config_dir_creation_failed",
                config_dir=str(self.CONFIG_DIR),
                error=str(e)
            )
            raise ConfigurationError(f"Failed to create configuration directory: {e}") from e
    
    def _validate_workspace_name(self, name: str) -> None:
        """
        Validate workspace name.
        
        Args:
            name: Workspace name to validate
            
        Raises:
            InvalidWorkspaceNameError: If name is invalid
        """
        if not self.WORKSPACE_NAME_PATTERN.match(name):
            raise InvalidWorkspaceNameError(
                f"Invalid workspace name: {name}. "
                "Must be alphanumeric with hyphens/underscores, max 64 chars"
            )
    
    def _get_encryption_key(self) -> bytes:
        """
        Get or create encryption key for secrets.
        
        Uses system keyring for secure storage, falls back to PBKDF2
        key derivation if keyring is unavailable.
        
        Returns:
            Encryption key bytes (32 bytes for Fernet)
            
        Raises:
            EncryptionKeyError: If key retrieval/generation fails
        """
        if self._encryption_key is not None:
            return self._encryption_key
        
        try:
            # Try to get key from system keyring
            key_str = keyring.get_password(self.KEYRING_SERVICE, self.KEYRING_USERNAME)
            
            if key_str:
                # Decode hex string to bytes
                self._encryption_key = bytes.fromhex(key_str)
                logger.debug("encryption_key_retrieved_from_keyring")
                return self._encryption_key
            
            # Generate new key if not found
            key = Fernet.generate_key()
            
            # Try to store in keyring
            try:
                keyring.set_password(
                    self.KEYRING_SERVICE,
                    self.KEYRING_USERNAME,
                    key.hex()
                )
                logger.info("encryption_key_stored_in_keyring")
            except Exception as e:
                logger.warning(
                    "keyring_storage_failed",
                    error=str(e),
                    fallback="using_pbkdf2"
                )
                # Fallback: derive key from system information
                key = self._derive_key_pbkdf2()
            
            self._encryption_key = key
            return self._encryption_key
            
        except Exception as e:
            logger.error(
                "encryption_key_retrieval_failed",
                error=str(e)
            )
            raise EncryptionKeyError(f"Failed to retrieve encryption key: {e}") from e
    
    def _derive_key_pbkdf2(self) -> bytes:
        """
        Derive encryption key using PBKDF2 from system information.
        
        This is a fallback when system keyring is unavailable.
        
        Returns:
            Derived key bytes (32 bytes for Fernet compatibility)
        """
        # Use system-specific information as salt
        import platform
        salt_data = f"{platform.node()}{os.getuid() if hasattr(os, 'getuid') else 'windows'}"
        salt = hashlib.sha256(salt_data.encode()).digest()
        
        # Derive key using PBKDF2
        kdf = PBKDF2(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=100000,
        )
        
        # Use a fixed password combined with user home directory
        password = f"caracal-{Path.home()}".encode()
        key = kdf.derive(password)
        
        # Fernet requires base64-encoded 32-byte key
        key = base64.urlsafe_b64encode(key)
        
        logger.debug("encryption_key_derived_pbkdf2")
        return key
    
    def _encrypt_value(self, value: str) -> str:
        """
        Encrypt a value using Fernet (symmetric encryption).
        
        Args:
            value: Value to encrypt
            
        Returns:
            Encrypted value (base64 encoded)
            
        Raises:
            EncryptionError: If encryption fails
        """
        try:
            key = self._get_encryption_key()
            fernet = Fernet(key)
            encrypted = fernet.encrypt(value.encode('utf-8'))
            return encrypted.decode('utf-8')
        except Exception as e:
            logger.error(
                "encryption_failed",
                error=str(e)
            )
            raise EncryptionError(f"Failed to encrypt value: {e}") from e
    
    def _decrypt_value(self, encrypted_value: str) -> str:
        """
        Decrypt a value using Fernet (symmetric encryption).
        
        Args:
            encrypted_value: Encrypted value (base64 encoded)
            
        Returns:
            Decrypted value
            
        Raises:
            DecryptionError: If decryption fails
        """
        try:
            key = self._get_encryption_key()
            fernet = Fernet(key)
            decrypted = fernet.decrypt(encrypted_value.encode('utf-8'))
            return decrypted.decode('utf-8')
        except Exception as e:
            logger.error(
                "decryption_failed",
                error=str(e)
            )
            raise DecryptionError(f"Failed to decrypt value: {e}") from e
    
    def _get_workspace_dir(self, workspace: str) -> Path:
        """Get workspace directory path."""
        return self.WORKSPACES_DIR / workspace
    
    def _get_workspace_config_file(self, workspace: str) -> Path:
        """Get workspace configuration file path."""
        return self._get_workspace_dir(workspace) / "workspace.toml"
    
    def _get_workspace_vault_file(self, workspace: str) -> Path:
        """Get workspace secrets vault file path."""
        return self._get_workspace_dir(workspace) / "secrets.vault"
    
    def _load_workspace_toml(self, workspace: str) -> Dict[str, Any]:
        """
        Load workspace TOML configuration.
        
        Args:
            workspace: Workspace name
            
        Returns:
            Configuration dictionary
            
        Raises:
            WorkspaceNotFoundError: If workspace doesn't exist
            ConfigurationCorruptedError: If configuration is corrupted
        """
        config_file = self._get_workspace_config_file(workspace)
        
        if not config_file.exists():
            raise WorkspaceNotFoundError(f"Workspace not found: {workspace}")
        
        try:
            return toml.load(config_file)
        except toml.TomlDecodeError as e:
            logger.error(
                "workspace_config_corrupted",
                workspace=workspace,
                config_file=str(config_file),
                error=str(e)
            )
            raise ConfigurationCorruptedError(
                f"Workspace configuration corrupted: {workspace}"
            ) from e
    
    def _save_workspace_toml(self, workspace: str, config: Dict[str, Any]) -> None:
        """
        Save workspace TOML configuration atomically.
        
        Args:
            workspace: Workspace name
            config: Configuration dictionary
            
        Raises:
            WorkspaceOperationError: If save fails
        """
        config_file = self._get_workspace_config_file(workspace)
        temp_file = config_file.with_suffix(".tmp")
        
        try:
            with open(temp_file, "w") as f:
                toml.dump(config, f)
            
            temp_file.chmod(0o600)
            temp_file.replace(config_file)
            
            logger.debug(
                "workspace_config_saved",
                workspace=workspace,
                config_file=str(config_file)
            )
        except Exception as e:
            if temp_file.exists():
                temp_file.unlink()
            logger.error(
                "workspace_config_save_failed",
                workspace=workspace,
                error=str(e)
            )
            raise WorkspaceOperationError(
                f"Failed to save workspace configuration: {e}"
            ) from e
    
    def _load_vault(self, workspace: str) -> Dict[str, str]:
        """
        Load secrets vault for workspace.
        
        Args:
            workspace: Workspace name
            
        Returns:
            Dictionary of encrypted secrets
        """
        vault_file = self._get_workspace_vault_file(workspace)
        
        if not vault_file.exists():
            return {}
        
        try:
            with open(vault_file, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(
                "vault_load_failed",
                workspace=workspace,
                vault_file=str(vault_file),
                error=str(e)
            )
            return {}
    
    def _save_vault(self, workspace: str, vault: Dict[str, str]) -> None:
        """
        Save secrets vault for workspace atomically.
        
        Args:
            workspace: Workspace name
            vault: Dictionary of encrypted secrets
            
        Raises:
            WorkspaceOperationError: If save fails
        """
        vault_file = self._get_workspace_vault_file(workspace)
        temp_file = vault_file.with_suffix(".tmp")
        
        try:
            with open(temp_file, "w") as f:
                json.dump(vault, f, indent=2)
            
            temp_file.chmod(0o600)
            temp_file.replace(vault_file)
            
            logger.debug(
                "vault_saved",
                workspace=workspace,
                vault_file=str(vault_file),
                secret_count=len(vault)
            )
        except Exception as e:
            if temp_file.exists():
                temp_file.unlink()
            logger.error(
                "vault_save_failed",
                workspace=workspace,
                error=str(e)
            )
            raise WorkspaceOperationError(
                f"Failed to save secrets vault: {e}"
            ) from e
    
    def get_workspace_config(self, workspace: str) -> WorkspaceConfig:
        """
        Returns configuration for specified workspace.
        
        Args:
            workspace: Workspace name
            
        Returns:
            Workspace configuration
            
        Raises:
            WorkspaceNotFoundError: If workspace doesn't exist
            ConfigurationCorruptedError: If configuration is corrupted
        """
        self._validate_workspace_name(workspace)
        config_dict = self._load_workspace_toml(workspace)
        
        # Parse dates
        created_at = datetime.fromisoformat(config_dict["created_at"])
        updated_at = datetime.fromisoformat(config_dict["updated_at"])
        last_sync = None
        if config_dict.get("last_sync"):
            last_sync = datetime.fromisoformat(config_dict["last_sync"])
        
        return WorkspaceConfig(
            name=config_dict["name"],
            created_at=created_at,
            updated_at=updated_at,
            is_default=config_dict.get("is_default", False),
            sync_enabled=config_dict.get("sync_enabled", False),
            sync_url=config_dict.get("sync_url"),
            sync_direction=SyncDirection(config_dict.get("sync_direction", "bidirectional")),
            auto_sync_interval=config_dict.get("auto_sync_interval"),
            last_sync=last_sync,
            conflict_strategy=ConflictStrategy(
                config_dict.get("conflict_strategy", "last_write_wins")
            ),
            metadata=config_dict.get("metadata", {})
        )
    
    def set_workspace_config(self, workspace: str, config: WorkspaceConfig) -> None:
        """
        Updates workspace configuration.
        
        Args:
            workspace: Workspace name
            config: Workspace configuration
            
        Raises:
            WorkspaceNotFoundError: If workspace doesn't exist
            WorkspaceOperationError: If update fails
        """
        self._validate_workspace_name(workspace)
        
        # Update timestamp
        config.updated_at = datetime.now()
        
        # Convert to dictionary
        config_dict = {
            "name": config.name,
            "created_at": config.created_at.isoformat(),
            "updated_at": config.updated_at.isoformat(),
            "is_default": config.is_default,
            "sync_enabled": config.sync_enabled,
            "sync_url": config.sync_url,
            "sync_direction": config.sync_direction.value,
            "auto_sync_interval": config.auto_sync_interval,
            "last_sync": config.last_sync.isoformat() if config.last_sync else None,
            "conflict_strategy": config.conflict_strategy.value,
            "metadata": config.metadata
        }
        
        self._save_workspace_toml(workspace, config_dict)
        
        logger.info(
            "workspace_config_updated",
            workspace=workspace
        )
    
    def store_secret(self, key: str, value: str, workspace: str) -> None:
        """
        Encrypts and stores secret in vault.
        
        Args:
            key: Secret key
            value: Secret value
            workspace: Workspace name
            
        Raises:
            WorkspaceNotFoundError: If workspace doesn't exist
            EncryptionError: If encryption fails
            WorkspaceOperationError: If storage fails
        """
        self._validate_workspace_name(workspace)
        
        # Ensure workspace exists
        if not self._get_workspace_dir(workspace).exists():
            raise WorkspaceNotFoundError(f"Workspace not found: {workspace}")
        
        # Load vault
        vault = self._load_vault(workspace)
        
        # Encrypt and store
        encrypted_value = self._encrypt_value(value)
        vault[key] = encrypted_value
        
        # Save vault
        self._save_vault(workspace, vault)
        
        logger.info(
            "secret_stored",
            workspace=workspace,
            key=key
        )
    
    def get_secret(self, key: str, workspace: str) -> str:
        """
        Retrieves and decrypts secret from vault.
        
        Args:
            key: Secret key
            workspace: Workspace name
            
        Returns:
            Decrypted secret value
            
        Raises:
            WorkspaceNotFoundError: If workspace doesn't exist
            SecretNotFoundError: If secret doesn't exist
            DecryptionError: If decryption fails
        """
        self._validate_workspace_name(workspace)
        
        # Load vault
        vault = self._load_vault(workspace)
        
        if key not in vault:
            raise SecretNotFoundError(f"Secret not found: {key} in workspace {workspace}")
        
        # Decrypt and return
        encrypted_value = vault[key]
        decrypted_value = self._decrypt_value(encrypted_value)
        
        logger.debug(
            "secret_retrieved",
            workspace=workspace,
            key=key
        )
        
        return decrypted_value
    
    def list_workspaces(self) -> List[str]:
        """
        Returns list of all workspaces.
        
        Returns:
            List of workspace names
        """
        if not self.WORKSPACES_DIR.exists():
            return []
        
        workspaces = []
        for item in self.WORKSPACES_DIR.iterdir():
            if item.is_dir() and (item / "workspace.toml").exists():
                workspaces.append(item.name)
        
        return sorted(workspaces)
    
    def create_workspace(self, name: str, template: Optional[str] = None) -> None:
        """
        Creates new workspace from optional template.
        
        Args:
            name: Workspace name
            template: Optional template name ("enterprise" or "local-dev")
            
        Raises:
            InvalidWorkspaceNameError: If name is invalid
            WorkspaceAlreadyExistsError: If workspace already exists
            WorkspaceOperationError: If creation fails
        """
        self._validate_workspace_name(name)
        
        workspace_dir = self._get_workspace_dir(name)
        
        if workspace_dir.exists():
            raise WorkspaceAlreadyExistsError(f"Workspace already exists: {name}")
        
        try:
            # Create workspace directory
            workspace_dir.mkdir(parents=True)
            workspace_dir.chmod(0o700)
            
            # Get template configuration
            template_config = {}
            if template and template in self.TEMPLATES:
                template_config = self.TEMPLATES[template].copy()
            
            # Create workspace configuration
            now = datetime.now()
            config = WorkspaceConfig(
                name=name,
                created_at=now,
                updated_at=now,
                is_default=len(self.list_workspaces()) == 0,  # First workspace is default
                sync_enabled=template_config.get("sync_enabled", False),
                sync_url=None,
                sync_direction=template_config.get("sync_direction", SyncDirection.BIDIRECTIONAL),
                auto_sync_interval=template_config.get("auto_sync_interval"),
                last_sync=None,
                conflict_strategy=template_config.get(
                    "conflict_strategy",
                    ConflictStrategy.LAST_WRITE_WINS
                ),
                metadata=template_config.get("metadata", {})
            )
            
            # Save configuration
            self.set_workspace_config(name, config)
            
            # Create empty vault
            self._save_vault(name, {})
            
            logger.info(
                "workspace_created",
                workspace=name,
                template=template,
                is_default=config.is_default
            )
            
        except Exception as e:
            # Clean up on failure
            if workspace_dir.exists():
                shutil.rmtree(workspace_dir, ignore_errors=True)
            
            if isinstance(e, (InvalidWorkspaceNameError, WorkspaceAlreadyExistsError)):
                raise
            
            logger.error(
                "workspace_creation_failed",
                workspace=name,
                error=str(e)
            )
            raise WorkspaceOperationError(f"Failed to create workspace: {e}") from e
    
    def delete_workspace(self, name: str, backup: bool = True) -> None:
        """
        Deletes workspace with optional backup.
        
        Args:
            name: Workspace name
            backup: Whether to create backup before deletion
            
        Raises:
            WorkspaceNotFoundError: If workspace doesn't exist
            WorkspaceOperationError: If deletion fails
        """
        self._validate_workspace_name(name)
        
        workspace_dir = self._get_workspace_dir(name)
        
        if not workspace_dir.exists():
            raise WorkspaceNotFoundError(f"Workspace not found: {name}")
        
        try:
            # Create backup if requested
            if backup:
                backup_dir = self.CONFIG_DIR / "backups"
                backup_dir.mkdir(exist_ok=True)
                
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                backup_path = backup_dir / f"{name}_{timestamp}.tar.gz"
                
                import tarfile
                with tarfile.open(backup_path, "w:gz") as tar:
                    tar.add(workspace_dir, arcname=name)
                
                logger.info(
                    "workspace_backed_up",
                    workspace=name,
                    backup_path=str(backup_path)
                )
            
            # Delete workspace directory
            shutil.rmtree(workspace_dir)
            
            logger.info(
                "workspace_deleted",
                workspace=name,
                backup_created=backup
            )
            
        except Exception as e:
            logger.error(
                "workspace_deletion_failed",
                workspace=name,
                error=str(e)
            )
            raise WorkspaceOperationError(f"Failed to delete workspace: {e}") from e
    
    def export_workspace(self, name: str, path: Path, include_secrets: bool = False) -> None:
        """
        Exports workspace configuration for backup or migration.
        
        Args:
            name: Workspace name
            path: Export path
            include_secrets: Whether to include encrypted secrets
            
        Raises:
            WorkspaceNotFoundError: If workspace doesn't exist
            WorkspaceOperationError: If export fails
        """
        self._validate_workspace_name(name)
        
        workspace_dir = self._get_workspace_dir(name)
        
        if not workspace_dir.exists():
            raise WorkspaceNotFoundError(f"Workspace not found: {name}")
        
        try:
            import tarfile
            
            with tarfile.open(path, "w:gz") as tar:
                # Always include workspace.toml
                tar.add(
                    self._get_workspace_config_file(name),
                    arcname=f"{name}/workspace.toml"
                )
                
                # Optionally include secrets.vault
                if include_secrets:
                    vault_file = self._get_workspace_vault_file(name)
                    if vault_file.exists():
                        tar.add(vault_file, arcname=f"{name}/secrets.vault")
            
            logger.info(
                "workspace_exported",
                workspace=name,
                export_path=str(path),
                include_secrets=include_secrets
            )
            
        except Exception as e:
            logger.error(
                "workspace_export_failed",
                workspace=name,
                error=str(e)
            )
            raise WorkspaceOperationError(f"Failed to export workspace: {e}") from e
    
    def import_workspace(self, path: Path, name: Optional[str] = None) -> None:
        """
        Imports workspace from backup or migration.
        
        Args:
            path: Import path
            name: Optional workspace name (uses name from export if not provided)
            
        Raises:
            WorkspaceAlreadyExistsError: If workspace already exists
            WorkspaceOperationError: If import fails
        """
        if not path.exists():
            raise WorkspaceOperationError(f"Import file not found: {path}")
        
        try:
            import tarfile
            
            # Extract to temporary directory first
            with tempfile.TemporaryDirectory() as temp_dir:
                temp_path = Path(temp_dir)
                
                with tarfile.open(path, "r:gz") as tar:
                    tar.extractall(temp_path)
                
                # Find workspace directory in archive
                workspace_dirs = [d for d in temp_path.iterdir() if d.is_dir()]
                if not workspace_dirs:
                    raise WorkspaceOperationError("No workspace found in archive")
                
                source_dir = workspace_dirs[0]
                workspace_name = name or source_dir.name
                
                self._validate_workspace_name(workspace_name)
                
                target_dir = self._get_workspace_dir(workspace_name)
                
                if target_dir.exists():
                    raise WorkspaceAlreadyExistsError(
                        f"Workspace already exists: {workspace_name}"
                    )
                
                # Copy workspace directory
                shutil.copytree(source_dir, target_dir)
                target_dir.chmod(0o700)
                
                # Update workspace name in configuration if renamed
                if name and name != source_dir.name:
                    config = self.get_workspace_config(workspace_name)
                    config.name = workspace_name
                    config.updated_at = datetime.now()
                    self.set_workspace_config(workspace_name, config)
                
                logger.info(
                    "workspace_imported",
                    workspace=workspace_name,
                    import_path=str(path)
                )
                
        except Exception as e:
            if isinstance(e, (WorkspaceAlreadyExistsError, InvalidWorkspaceNameError)):
                raise
            
            logger.error(
                "workspace_import_failed",
                import_path=str(path),
                error=str(e)
            )
            raise WorkspaceOperationError(f"Failed to import workspace: {e}") from e
    
    def get_postgres_config(self) -> Optional[PostgresConfig]:
        """
        Returns PostgreSQL connection configuration.
        
        Returns:
            PostgreSQL configuration or None if not configured
        """
        if not self.CONFIG_FILE.exists():
            return None
        
        try:
            config = toml.load(self.CONFIG_FILE)
            postgres_config = config.get("postgres")
            
            if not postgres_config:
                return None
            
            return PostgresConfig(
                host=postgres_config.get("host", "localhost"),
                port=postgres_config.get("port", 5432),
                database=postgres_config.get("database", "caracal"),
                user=postgres_config.get("user", "caracal"),
                password_ref=postgres_config.get("password_ref", "postgres_password"),
                ssl_mode=postgres_config.get("ssl_mode", "require"),
                pool_size=postgres_config.get("pool_size", 10),
                max_overflow=postgres_config.get("max_overflow", 5),
                pool_timeout=postgres_config.get("pool_timeout", 30)
            )
        except (toml.TomlDecodeError, OSError) as e:
            logger.warning(
                "postgres_config_load_failed",
                error=str(e)
            )
            return None
    
    def set_postgres_config(self, config: PostgresConfig) -> None:
        """
        Updates PostgreSQL connection configuration.
        
        Args:
            config: PostgreSQL configuration
            
        Raises:
            ConfigurationError: If update fails
            ConfigurationValidationError: If connectivity validation fails
        """
        try:
            # Load existing configuration
            main_config = {}
            if self.CONFIG_FILE.exists():
                try:
                    main_config = toml.load(self.CONFIG_FILE)
                except toml.TomlDecodeError:
                    logger.warning("config_file_corrupted", action="creating_new")
                    main_config = {}
            
            # Update PostgreSQL configuration
            main_config["postgres"] = {
                "host": config.host,
                "port": config.port,
                "database": config.database,
                "user": config.user,
                "password_ref": config.password_ref,
                "ssl_mode": config.ssl_mode,
                "pool_size": config.pool_size,
                "max_overflow": config.max_overflow,
                "pool_timeout": config.pool_timeout
            }
            
            # Validate connectivity (basic check)
            self._validate_postgres_connectivity(config)
            
            # Save configuration atomically
            temp_file = self.CONFIG_FILE.with_suffix(".tmp")
            try:
                with open(temp_file, "w") as f:
                    toml.dump(main_config, f)
                
                temp_file.chmod(0o600)
                temp_file.replace(self.CONFIG_FILE)
                
                logger.info(
                    "postgres_config_updated",
                    host=config.host,
                    port=config.port,
                    database=config.database
                )
            finally:
                if temp_file.exists():
                    temp_file.unlink()
                    
        except Exception as e:
            if isinstance(e, ConfigurationValidationError):
                raise
            
            logger.error(
                "postgres_config_update_failed",
                error=str(e)
            )
            raise ConfigurationError(f"Failed to update PostgreSQL configuration: {e}") from e
    
    def _validate_postgres_connectivity(self, config: PostgresConfig) -> None:
        """
        Validate PostgreSQL connectivity.
        
        Args:
            config: PostgreSQL configuration
            
        Raises:
            ConfigurationValidationError: If connectivity check fails
        """
        try:
            from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
            
            # Get password from vault (use default workspace or system)
            password = ""
            try:
                # Try to get from default workspace
                workspaces = self.list_workspaces()
                if workspaces:
                    password = self.get_secret(config.password_ref, workspaces[0])
            except (SecretNotFoundError, WorkspaceNotFoundError):
                # Password not set yet, validation will fail but that's expected
                logger.debug("postgres_password_not_found", password_ref=config.password_ref)
            
            # Create database config
            db_config = DatabaseConfig(
                host=config.host,
                port=config.port,
                database=config.database,
                user=config.user,
                password=password,
                pool_size=config.pool_size,
                max_overflow=config.max_overflow,
                pool_timeout=config.pool_timeout
            )
            
            # Test connection
            manager = DatabaseConnectionManager(db_config)
            manager.initialize()
            
            if not manager.health_check():
                raise ConfigurationValidationError(
                    "PostgreSQL connectivity check failed"
                )
            
            manager.close()
            
            logger.info("postgres_connectivity_validated")
            
        except ImportError:
            # Database module not available, skip validation
            logger.warning("postgres_validation_skipped", reason="db_module_not_available")
        except Exception as e:
            logger.error(
                "postgres_connectivity_validation_failed",
                error=str(e)
            )
            raise ConfigurationValidationError(
                f"PostgreSQL connectivity validation failed: {e}"
            ) from e
