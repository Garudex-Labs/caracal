"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Configuration management for Caracal deployment architecture.

Handles system-level configuration with encryption and workspace management.
"""

import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

import structlog
import toml
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from caracal.deployment.exceptions import (
    ConfigurationCorruptedError,
    ConfigurationError,
    ConfigurationValidationError,
    DecryptionError,
    EncryptionError,
    InvalidWorkspaceNameError,
    SecretNotFoundError,
    WorkspaceAlreadyExistsError,
    WorkspaceNotFoundError,
    WorkspaceOperationError,
)
from caracal.config.encryption import decrypt_value, encrypt_value
from caracal.runtime.environment import debug_logs_enabled
from caracal.runtime.host_io import in_container_runtime, normalize_optional_text
from caracal.storage.layout import resolve_caracal_home

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
    CONFIG_DIR = resolve_caracal_home()
    CONFIG_FILE = CONFIG_DIR / "config.toml"
    WORKSPACES_DIR = CONFIG_DIR / "workspaces"
    
    # Workspace name validation pattern
    WORKSPACE_NAME_PATTERN = re.compile(r'^[a-zA-Z0-9_-]{1,64}$')
    RESERVED_WORKSPACE_NAMES = {"primary", "_deleted_backups"}
    
    # Workspace templates
    TEMPLATES = {
        "enterprise": {
            "metadata": {"template": "enterprise"}
        },
        "local-dev": {
            "metadata": {"template": "local-dev"}
        }
    }

    # Locked export envelope format
    ARCHIVE_LOCK_MAGIC = b"CRCLWSX1"
    ARCHIVE_LOCK_VERSION = 1
    ARCHIVE_LOCK_KDF_ITERATIONS = 390000
    ARCHIVE_LOCK_SALT_BYTES = 16
    ARCHIVE_LOCK_NONCE_BYTES = 12
    ARCHIVE_LOCK_AAD = b"caracal.workspace.export.v1"
    
    def __init__(self):
        """Initialize the configuration manager."""
        self._ensure_config_dir()
    
    def _ensure_config_dir(self) -> None:
        """Ensure configuration directory exists with proper permissions."""
        try:
            self.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            self.CONFIG_DIR.chmod(0o700)
            
            self.WORKSPACES_DIR.mkdir(exist_ok=True)
            # Runtime artifacts (cache, logs) live under each workspace directory.

            if debug_logs_enabled():
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
        if name in self.RESERVED_WORKSPACE_NAMES:
            raise InvalidWorkspaceNameError(
                f"Invalid workspace name: {name}. "
                "This name is reserved for internal Caracal use."
            )

    def _is_workspace_discoverable(self, name: str) -> bool:
        """Return whether a directory name should be treated as a user workspace."""
        return (
            bool(self.WORKSPACE_NAME_PATTERN.match(name))
            and name not in self.RESERVED_WORKSPACE_NAMES
        )
    
    def _get_workspace_dir(self, workspace: str) -> Path:
        """Get workspace directory path."""
        return self.WORKSPACES_DIR / workspace
    
    def _get_workspace_config_file(self, workspace: str) -> Path:
        """Get workspace configuration file path."""
        return self._get_workspace_dir(workspace) / "workspace.toml"

    def _legacy_secret_store_path(self, workspace: str) -> Path:
        """Return the old local secret-store path for one-way cleanup."""
        return self._get_workspace_dir(workspace) / ("secrets" + ".vault")

    def _load_secret_refs(self, workspace: str) -> Dict[str, str]:
        """Load opaque secret references stored in workspace metadata."""
        config = self._load_workspace_toml(workspace)
        metadata = config.get("metadata", {})
        if not isinstance(metadata, dict):
            return {}
        secret_refs = metadata.get("secret_refs", {})
        if not isinstance(secret_refs, dict):
            return {}
        return {
            str(key): str(value)
            for key, value in secret_refs.items()
            if isinstance(key, str) and isinstance(value, str) and value
        }

    def _load_secret_refs_or_empty(self, workspace: str) -> Dict[str, str]:
        """Load secret refs, or return {} when the workspace is missing (best-effort)."""
        try:
            return self._load_secret_refs(workspace)
        except WorkspaceNotFoundError:
            return {}

    def _save_secret_refs(self, workspace: str, secret_refs: Dict[str, str]) -> None:
        """Persist opaque secret references in workspace metadata."""
        try:
            config = self._load_workspace_toml(workspace)
            metadata = config.get("metadata", {})
            if not isinstance(metadata, dict):
                metadata = {}
            metadata["secret_refs"] = dict(sorted(secret_refs.items()))
            config["metadata"] = metadata
            self._save_workspace_toml(workspace, config)

            legacy_secret_store = self._legacy_secret_store_path(workspace)
            if legacy_secret_store.exists():
                try:
                    legacy_secret_store.unlink()
                except OSError:
                    logger.debug(
                        "legacy_secret_store_cleanup_skipped",
                        workspace=workspace,
                        path=str(legacy_secret_store),
                    )

            logger.debug(
                "secret_refs_saved",
                workspace=workspace,
                secret_count=len(secret_refs),
            )
        except WorkspaceOperationError:
            raise
        except Exception as e:
            logger.error(
                "secret_refs_save_failed",
                workspace=workspace,
                error=str(e),
            )
            raise WorkspaceOperationError(
                f"Failed to save secret refs: {e}"
            ) from e

    def _load_workspace_runtime_config(self, workspace_dir: Path) -> Dict[str, Any]:
        """Load workspace runtime config.yaml when available."""
        config_path = workspace_dir / "config.yaml"
        if not config_path.exists():
            return {}

        try:
            import yaml

            with open(config_path, "r") as f:
                loaded = yaml.safe_load(f) or {}
            if isinstance(loaded, dict):
                return loaded
        except Exception:
            pass
        return {}

    def _extract_workspace_db_config(self, workspace_dir: Path) -> Optional[Dict[str, Any]]:
        """Extract PostgreSQL connection settings for workspace schema transfer."""
        cfg = self._load_workspace_runtime_config(workspace_dir)
        db_cfg = cfg.get("database", {}) if isinstance(cfg, dict) else {}
        if not isinstance(db_cfg, dict):
            return None

        schema = str(db_cfg.get("schema", "")).strip()
        if not schema:
            return None

        try:
            port = int(db_cfg.get("port", 5432))
        except Exception:
            port = 5432

        return {
            "host": db_cfg.get("host", "localhost"),
            "port": port,
            "database": db_cfg.get("database", "caracal"),
            "user": db_cfg.get("user", "caracal"),
            "password": db_cfg.get("password", ""),
            "schema": schema,
        }

    def _pg_env(self, password: str) -> Dict[str, str]:
        """Build subprocess environment for PostgreSQL CLI tools."""
        env = os.environ.copy()
        if password:
            env["PGPASSWORD"] = str(password)
        return env

    def _extract_unsupported_pg_settings(self, restore_output: str) -> List[str]:
        """Extract unsupported PostgreSQL setting names from pg_restore output."""
        matches = re.findall(
            r'unrecognized configuration parameter "([^"]+)"',
            restore_output,
            flags=re.IGNORECASE,
        )
        # Preserve order while de-duplicating.
        seen = set()
        ordered: List[str] = []
        for value in matches:
            normalized = value.strip().lower()
            if normalized and normalized not in seen:
                seen.add(normalized)
                ordered.append(normalized)
        return ordered

    def _restore_workspace_db_dump_via_sql_fallback(
        self,
        workspace: str,
        db_cfg: Dict[str, Any],
        dump_path: Path,
        unsupported_settings: List[str],
    ) -> None:
        """Fallback restore path that strips unsupported SET statements from SQL."""
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            raw_sql_path = temp_path / "workspace_restore_raw.sql"
            sanitized_sql_path = temp_path / "workspace_restore_sanitized.sql"

            render_cmd = [
                "pg_restore",
                "--clean",
                "--if-exists",
                "--no-owner",
                "--no-privileges",
                "--file",
                str(raw_sql_path),
                str(dump_path),
            ]

            try:
                render_result = subprocess.run(
                    render_cmd,
                    env=self._pg_env(str(db_cfg.get("password", ""))),
                    capture_output=True,
                    text=True,
                )
            except FileNotFoundError as e:
                raise WorkspaceOperationError(
                    "Workspace archive contains PostgreSQL dump, but 'pg_restore' is not available. "
                    "Install PostgreSQL client tools and retry import. "
                    "If using Caracal runtime containers, rebuild/runtime-restart with latest image."
                ) from e

            if render_result.returncode != 0:
                details = (
                    render_result.stderr.strip()
                    or render_result.stdout.strip()
                    or "unknown error"
                )
                raise WorkspaceOperationError(
                    f"Failed to render SQL fallback from workspace dump: {details}"
                )

            set_patterns = [
                re.compile(rf"^\s*SET\s+{re.escape(setting)}\s*=", re.IGNORECASE)
                for setting in unsupported_settings
            ]
            select_patterns = [
                re.compile(
                    rf"^\s*SELECT\s+pg_catalog\.set_config\(\s*'{re.escape(setting)}'",
                    re.IGNORECASE,
                )
                for setting in unsupported_settings
            ]

            removed_lines = 0
            with open(raw_sql_path, "r", encoding="utf-8") as source, open(
                sanitized_sql_path, "w", encoding="utf-8"
            ) as target:
                for line in source:
                    stripped = line.strip()
                    if any(pattern.search(stripped) for pattern in set_patterns) or any(
                        pattern.search(stripped) for pattern in select_patterns
                    ):
                        removed_lines += 1
                        continue
                    target.write(line)

            logger.warning(
                "workspace_db_restore_compatibility_fallback",
                workspace=workspace,
                schema=str(db_cfg["schema"]),
                removed_lines=removed_lines,
                unsupported_settings=unsupported_settings,
            )

            apply_cmd = [
                "psql",
                "-h",
                str(db_cfg["host"]),
                "-p",
                str(db_cfg["port"]),
                "-U",
                str(db_cfg["user"]),
                "-d",
                str(db_cfg["database"]),
                "-v",
                "ON_ERROR_STOP=1",
                "-f",
                str(sanitized_sql_path),
            ]

            try:
                apply_result = subprocess.run(
                    apply_cmd,
                    env=self._pg_env(str(db_cfg.get("password", ""))),
                    capture_output=True,
                    text=True,
                )
            except FileNotFoundError as e:
                raise WorkspaceOperationError(
                    "Workspace archive restore fallback requires 'psql', but it is not available. "
                    "Install PostgreSQL client tools and retry import. "
                    "If using Caracal runtime containers, rebuild/runtime-restart with latest image."
                ) from e

            if apply_result.returncode != 0:
                details = (
                    apply_result.stderr.strip() or apply_result.stdout.strip() or "unknown error"
                )
                raise WorkspaceOperationError(
                    f"Failed to import workspace database schema '{db_cfg['schema']}' via SQL fallback: {details}"
                )

    def _normalize_lock_key(self, lock_key: Optional[str]) -> Optional[str]:
        """Normalize optional lock key input."""
        return normalize_optional_text(lock_key)

    def _validate_lock_key(self, lock_key: str) -> None:
        """Validate archive lock key quality constraints."""
        if len(lock_key) < 12:
            raise WorkspaceOperationError(
                "Archive lock key must be at least 12 characters."
            )

    def _derive_archive_key(self, lock_key: str, salt: bytes, iterations: int) -> bytes:
        """Derive AES-256 key from user-provided lock key."""
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=iterations,
        )
        return kdf.derive(lock_key.encode("utf-8"))

    def _encrypt_archive_payload(self, archive_bytes: bytes, lock_key: str) -> bytes:
        """Encrypt archive bytes into locked envelope format."""
        self._validate_lock_key(lock_key)

        salt = secrets.token_bytes(self.ARCHIVE_LOCK_SALT_BYTES)
        nonce = secrets.token_bytes(self.ARCHIVE_LOCK_NONCE_BYTES)
        iterations = self.ARCHIVE_LOCK_KDF_ITERATIONS

        key = self._derive_archive_key(lock_key, salt, iterations)
        ciphertext = AESGCM(key).encrypt(nonce, archive_bytes, self.ARCHIVE_LOCK_AAD)

        header = {
            "version": self.ARCHIVE_LOCK_VERSION,
            "kdf": "pbkdf2-sha256",
            "iterations": iterations,
            "salt": base64.urlsafe_b64encode(salt).decode("ascii"),
            "nonce": base64.urlsafe_b64encode(nonce).decode("ascii"),
        }
        header_bytes = json.dumps(header, separators=(",", ":")).encode("utf-8")
        header_len = len(header_bytes).to_bytes(4, "big")

        return self.ARCHIVE_LOCK_MAGIC + header_len + header_bytes + ciphertext

    def _prepare_import_archive(self, source_path: Path, lock_key: Optional[str], temp_dir: Path) -> Path:
        """Return a tar.gz path ready for extraction, decrypting if needed."""
        with open(source_path, "rb") as f:
            magic = f.read(len(self.ARCHIVE_LOCK_MAGIC))

            if magic != self.ARCHIVE_LOCK_MAGIC:
                return source_path

            header_len_bytes = f.read(4)
            if len(header_len_bytes) != 4:
                raise WorkspaceOperationError("Locked workspace archive header is corrupted.")

            header_len = int.from_bytes(header_len_bytes, "big")
            if header_len <= 0 or header_len > 8192:
                raise WorkspaceOperationError("Locked workspace archive header is invalid.")

            header_bytes = f.read(header_len)
            if len(header_bytes) != header_len:
                raise WorkspaceOperationError("Locked workspace archive header is truncated.")

            try:
                header = json.loads(header_bytes.decode("utf-8"))
            except Exception as e:
                raise WorkspaceOperationError("Locked workspace archive header is unreadable.") from e

            if int(header.get("version", 0)) != self.ARCHIVE_LOCK_VERSION:
                raise WorkspaceOperationError(
                    f"Unsupported locked archive version: {header.get('version')}"
                )

            normalized_key = self._normalize_lock_key(lock_key)
            if not normalized_key:
                raise WorkspaceOperationError(
                    "This workspace archive is locked. Provide lock key to import."
                )

            try:
                salt = base64.urlsafe_b64decode(header["salt"].encode("ascii"))
                nonce = base64.urlsafe_b64decode(header["nonce"].encode("ascii"))
                iterations = int(header["iterations"])
            except Exception as e:
                raise WorkspaceOperationError("Locked workspace archive metadata is invalid.") from e

            ciphertext = f.read()
            try:
                key = self._derive_archive_key(normalized_key, salt, iterations)
                plaintext = AESGCM(key).decrypt(nonce, ciphertext, self.ARCHIVE_LOCK_AAD)
            except InvalidTag as e:
                raise WorkspaceOperationError(
                    "Failed to unlock workspace archive: invalid key or corrupted file."
                ) from e
            except Exception as e:
                raise WorkspaceOperationError(
                    f"Failed to unlock workspace archive: {e}"
                ) from e

        decrypted_path = temp_dir / "workspace_import.tar.gz"
        with open(decrypted_path, "wb") as out:
            out.write(plaintext)
        return decrypted_path

    def _export_workspace_db_dump(self, workspace: str, workspace_dir: Path, dump_path: Path) -> bool:
        """Export workspace PostgreSQL schema to a pg_dump archive if configured."""
        db_cfg = self._extract_workspace_db_config(workspace_dir)
        if not db_cfg:
            return False

        cmd = [
            "pg_dump",
            "-h", str(db_cfg["host"]),
            "-p", str(db_cfg["port"]),
            "-U", str(db_cfg["user"]),
            "-d", str(db_cfg["database"]),
            "-F", "c",
            "-Z", "9",
            "-f", str(dump_path),
            "--no-owner",
            "--no-privileges",
            "-n", str(db_cfg["schema"]),
        ]

        try:
            result = subprocess.run(
                cmd,
                env=self._pg_env(str(db_cfg.get("password", ""))),
                capture_output=True,
                text=True,
            )
        except FileNotFoundError as e:
            raise WorkspaceOperationError(
                "Workspace has PostgreSQL schema data, but 'pg_dump' is not available. "
                "Install PostgreSQL client tools and retry export. "
                "If using Caracal runtime containers, rebuild/runtime-restart with latest image."
            ) from e

        if result.returncode != 0:
            details = result.stderr.strip() or result.stdout.strip() or "unknown error"
            raise WorkspaceOperationError(
                f"Failed to export workspace database schema '{db_cfg['schema']}': {details}"
            )

        return True

    def _import_workspace_db_dump(self, workspace: str, workspace_dir: Path, dump_path: Path) -> bool:
        """Import workspace PostgreSQL schema from a pg_dump archive if present."""
        if not dump_path.exists():
            return False

        db_cfg = self._extract_workspace_db_config(workspace_dir)
        if not db_cfg:
            raise WorkspaceOperationError(
                "Workspace archive contains database dump, but imported workspace config.yaml "
                "does not define database.schema."
            )

        # Ensure target schema is clean before restore.
        try:
            from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager

            manager = DatabaseConnectionManager(
                DatabaseConfig(
                    host=str(db_cfg["host"]),
                    port=int(db_cfg["port"]),
                    database=str(db_cfg["database"]),
                    user=str(db_cfg["user"]),
                    password=str(db_cfg.get("password", "")),
                )
            )
            manager.initialize()
            manager.drop_schema(schema_name=str(db_cfg["schema"]))
            manager.close()
        except Exception as e:
            logger.warning(
                "workspace_schema_pre_restore_cleanup_failed",
                workspace=workspace,
                schema=str(db_cfg["schema"]),
                error=str(e),
            )

        cmd = [
            "pg_restore",
            "-h", str(db_cfg["host"]),
            "-p", str(db_cfg["port"]),
            "-U", str(db_cfg["user"]),
            "-d", str(db_cfg["database"]),
            "--clean",
            "--if-exists",
            "--no-owner",
            "--no-privileges",
            str(dump_path),
        ]

        try:
            result = subprocess.run(
                cmd,
                env=self._pg_env(str(db_cfg.get("password", ""))),
                capture_output=True,
                text=True,
            )
        except FileNotFoundError as e:
            raise WorkspaceOperationError(
                "Workspace archive contains PostgreSQL dump, but 'pg_restore' is not available. "
                "Install PostgreSQL client tools and retry import. "
                "If using Caracal runtime containers, rebuild/runtime-restart with latest image."
            ) from e

        if result.returncode != 0:
            details = result.stderr.strip() or result.stdout.strip() or "unknown error"
            unsupported_settings = self._extract_unsupported_pg_settings(details)
            if unsupported_settings:
                try:
                    self._restore_workspace_db_dump_via_sql_fallback(
                        workspace,
                        db_cfg,
                        dump_path,
                        unsupported_settings,
                    )
                    return True
                except WorkspaceOperationError as fallback_error:
                    raise WorkspaceOperationError(
                        f"Failed to import workspace database schema '{db_cfg['schema']}': {details} "
                        f"(compatibility fallback also failed: {fallback_error})"
                    ) from fallback_error

            raise WorkspaceOperationError(
                f"Failed to import workspace database schema '{db_cfg['schema']}': {details}"
            )

        return True
    
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
    
    def _normalize_workspace_ownership(self, workspace_dir: Path) -> None:
        """Best-effort ownership normalization for container runtime.

        When workspace files are created as root inside the runtime container,
        later operations run as the unprivileged `caracal` user can fail with
        permission errors. Normalize ownership to `caracal` when possible.
        """
        if not in_container_runtime():
            return

        if not hasattr(os, "geteuid") or os.geteuid() != 0:
            return

        if not hasattr(os, "chown"):
            return

        try:
            import pwd

            pw = pwd.getpwnam("caracal")
            uid, gid = pw.pw_uid, pw.pw_gid
        except Exception:
            return

        try:
            for root, dirs, files in os.walk(workspace_dir):
                os.chown(root, uid, gid)
                for name in dirs:
                    os.chown(os.path.join(root, name), uid, gid)
                for name in files:
                    os.chown(os.path.join(root, name), uid, gid)
        except Exception:
            # Ownership normalization is best-effort and should not block operations.
            return
    
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
        
        created_at = datetime.fromisoformat(config_dict["created_at"])
        updated_at = datetime.fromisoformat(config_dict["updated_at"])
        
        return WorkspaceConfig(
            name=config_dict["name"],
            created_at=created_at,
            updated_at=updated_at,
            is_default=config_dict.get("is_default", False),
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
        
        config.updated_at = datetime.now()
        
        config_dict = {
            "name": config.name,
            "created_at": config.created_at.isoformat(),
            "updated_at": config.updated_at.isoformat(),
            "is_default": config.is_default,
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
        
        secret_refs = self._load_secret_refs_or_empty(workspace)

        try:
            encrypted_value = encrypt_value(value)
        except Exception as e:
            logger.error("secret_encrypt_failed", workspace=workspace, key=key, error=str(e))
            raise EncryptionError(f"Failed to store secret in vault: {e}") from e

        secret_refs[key] = encrypted_value
        self._save_secret_refs(workspace, secret_refs)
        
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
        
        secret_refs = self._load_secret_refs_or_empty(workspace)
        
        if key not in secret_refs:
            raise SecretNotFoundError(f"Secret not found: {key} in workspace {workspace}")
        
        encrypted_value = secret_refs[key]
        try:
            decrypted_value = decrypt_value(encrypted_value)
        except Exception as e:
            logger.error("secret_decrypt_failed", workspace=workspace, key=key, error=str(e))
            raise DecryptionError(f"Failed to resolve secret from vault: {e}") from e
        
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

        workspaces = set()

        # Discover canonical workspace directories first.
        for item in self.WORKSPACES_DIR.iterdir():
            if not item.is_dir():
                continue
            if not self._is_workspace_discoverable(item.name):
                continue

            if (item / "workspace.toml").exists() or (item / "config.yaml").exists():
                workspaces.add(item.name)

        # Include names present in the Flow registry only when they resolve to
        # the canonical workspace directory for that workspace name.
        try:
            from caracal.flow.workspace import WorkspaceManager

            for ws in WorkspaceManager.list_workspaces():
                if not isinstance(ws, dict):
                    continue
                name = str(ws.get("name") or "").strip()
                path = str(ws.get("path") or "").strip()
                if not name or not path:
                    continue
                if not self._is_workspace_discoverable(name):
                    continue

                canonical_dir = self._get_workspace_dir(name)
                try:
                    if Path(path).expanduser().resolve() != canonical_dir.resolve():
                        continue
                except Exception:
                    continue

                if canonical_dir.exists():
                    workspaces.add(name)
        except Exception:
            pass

        names = sorted(workspaces)
        self._ensure_workspace_metadata(names)
        return names

    def _ensure_workspace_metadata(self, workspace_names: List[str]) -> None:
        """Create missing ``workspace.toml`` files for discovered workspaces."""
        has_default = False

        for name in workspace_names:
            config_file = self._get_workspace_config_file(name)
            if not config_file.exists():
                continue
            try:
                if self.get_workspace_config(name).is_default:
                    has_default = True
                    break
            except Exception:
                continue

        now = datetime.now()
        for name in workspace_names:
            config_file = self._get_workspace_config_file(name)
            if config_file.exists():
                continue

            try:
                cfg = WorkspaceConfig(
                    name=name,
                    created_at=now,
                    updated_at=now,
                    is_default=not has_default,
                    metadata={"source": "workspace_discovery"},
                )
                self.set_workspace_config(name, cfg)
                if cfg.is_default:
                    has_default = True
            except Exception:
                # Best-effort metadata bootstrap; listing should never fail.
                continue

    def get_workspace_path(self, name: str) -> Path:
        """Return absolute path for a workspace directory.

        Raises:
            WorkspaceNotFoundError: If the workspace does not exist.
        """
        self._validate_workspace_name(name)
        workspace_dir = self._get_workspace_dir(name)
        if not workspace_dir.exists():
            raise WorkspaceNotFoundError(f"Workspace not found: {name}")
        return workspace_dir

    def get_default_workspace_name(self) -> Optional[str]:
        """Return the configured default workspace name.

        If no workspace is explicitly marked default, returns the first
        available workspace name (sorted), or None when no workspaces exist.
        """
        workspaces = self.list_workspaces()
        if not workspaces:
            return None

        for workspace in workspaces:
            try:
                cfg = self.get_workspace_config(workspace)
                if cfg.is_default:
                    return workspace
            except Exception:
                continue

        return workspaces[0]

    def set_default_workspace(self, name: str) -> None:
        """Mark exactly one workspace as default.

        Args:
            name: Workspace name to set as default.

        Raises:
            WorkspaceNotFoundError: If target workspace does not exist.
            WorkspaceOperationError: If persisting updates fails.
        """
        self._validate_workspace_name(name)
        workspaces = self.list_workspaces()
        if name not in workspaces:
            raise WorkspaceNotFoundError(f"Workspace not found: {name}")

        try:
            for workspace in workspaces:
                cfg = self.get_workspace_config(workspace)
                should_be_default = workspace == name
                if cfg.is_default != should_be_default:
                    cfg.is_default = should_be_default
                    self.set_workspace_config(workspace, cfg)
        except Exception as e:
            raise WorkspaceOperationError(f"Failed to set default workspace: {e}") from e
    
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
            workspace_dir.mkdir(parents=True)
            workspace_dir.chmod(0o700)
            (workspace_dir / "backups").mkdir(exist_ok=True)
            (workspace_dir / "logs").mkdir(exist_ok=True)
            (workspace_dir / "cache").mkdir(exist_ok=True)
            (workspace_dir / "keys").mkdir(exist_ok=True)
            
            template_config = {}
            if template and template in self.TEMPLATES:
                template_config = self.TEMPLATES[template].copy()
            
            now = datetime.now()
            config = WorkspaceConfig(
                name=name,
                created_at=now,
                updated_at=now,
                is_default=len(self.list_workspaces()) == 0,  # First workspace is default
                metadata=template_config.get("metadata", {})
            )
            
            # Save configuration
            self.set_workspace_config(name, config)

            # Ensure operational directories are private to workspace owner.
            for subdir in ("backups", "logs", "cache", "keys"):
                try:
                    (workspace_dir / subdir).chmod(0o700)
                except Exception:
                    pass
            
            self._save_secret_refs(name, {})

            # Ensure root-created workspaces in container runtime remain accessible
            # when commands later run as the unprivileged runtime user.
            self._normalize_workspace_ownership(workspace_dir)
            
            logger.info(
                "workspace_created",
                workspace=name,
                template=template,
                is_default=config.is_default
            )

            # Keep Flow registry synchronized with deployment workspace metadata.
            try:
                from caracal.flow.workspace import WorkspaceManager

                WorkspaceManager.register_workspace(
                    name,
                    workspace_dir,
                    is_default=config.is_default,
                )
            except Exception:
                # Best-effort sync; workspace creation should still succeed.
                logger.debug("workspace_registry_sync_skipped", workspace=name)
            
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
            # Attempt schema cleanup before deleting workspace files.
            db_cfg = self._extract_workspace_db_config(workspace_dir) or {}
            schema_name = db_cfg.get("schema")

            if schema_name:
                try:
                    from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager

                    db_config = DatabaseConfig(
                        host=str(db_cfg.get("host", "localhost")),
                        port=int(db_cfg.get("port", 5432)),
                        database=str(db_cfg.get("database", "caracal")),
                        user=str(db_cfg.get("user", "caracal")),
                        password=str(db_cfg.get("password", "")),
                    )
                    mgr = DatabaseConnectionManager(db_config)
                    mgr.initialize()
                    mgr.drop_schema(schema_name=schema_name)
                    mgr.close()
                    logger.info("workspace_schema_dropped", workspace=name, schema=schema_name)
                except Exception as e:
                    logger.warning("workspace_schema_drop_failed", workspace=name, schema=schema_name, error=str(e))

            if backup:
                backup_dir = self.WORKSPACES_DIR / "_deleted_backups"
                backup_dir.mkdir(parents=True, exist_ok=True)
                
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

            try:
                from caracal.flow.workspace import clear_workspace_cache
                clear_workspace_cache()
            except Exception:
                logger.debug("workspace_cache_clear_skipped", workspace=name)

            # Keep Flow registry synchronized with deletion.
            try:
                from caracal.flow.workspace import WorkspaceManager

                WorkspaceManager.delete_workspace(workspace_dir, delete_directory=False)
            except Exception:
                logger.debug("workspace_registry_delete_sync_skipped", workspace=name)
            
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
    
    def export_workspace(
        self,
        name: str,
        path: Path,
        include_secrets: bool = False,
        lock_key: Optional[str] = None,
    ) -> None:
        """
        Exports workspace configuration for backup or migration.
        
        Args:
            name: Workspace name
            path: Export path
            include_secrets: Whether to include encrypted secrets
            lock_key: Optional key to lock the archive (required when include_secrets=True)
            
        Raises:
            WorkspaceNotFoundError: If workspace doesn't exist
            WorkspaceOperationError: If export fails
        """
        self._validate_workspace_name(name)
        
        workspace_dir = self._get_workspace_dir(name)
        normalized_lock_key = self._normalize_lock_key(lock_key)

        if include_secrets and not normalized_lock_key:
            raise WorkspaceOperationError(
                "Including secrets in workspace export requires a lock key."
            )
        
        if not workspace_dir.exists():
            raise WorkspaceNotFoundError(f"Workspace not found: {name}")
        
        try:
            import tarfile

            with tempfile.TemporaryDirectory() as temp_dir:
                stage_root = Path(temp_dir)
                staged_workspace_dir = stage_root / name
                shutil.copytree(workspace_dir, staged_workspace_dir)

                if not include_secrets:
                    staged_config_file = staged_workspace_dir / "workspace.toml"
                    if staged_config_file.exists():
                        staged_config = toml.load(staged_config_file)
                        staged_metadata = staged_config.get("metadata", {})
                        if isinstance(staged_metadata, dict) and "secret_refs" in staged_metadata:
                            staged_metadata = dict(staged_metadata)
                            staged_metadata["secret_refs"] = {}
                            staged_config["metadata"] = staged_metadata
                            with open(staged_config_file, "w") as staged_out:
                                toml.dump(staged_config, staged_out)

                db_dump_path = staged_workspace_dir / "workspace_schema.dump"
                db_dump_included = self._export_workspace_db_dump(
                    name,
                    workspace_dir,
                    db_dump_path,
                )

                manifest = {
                    "format_version": 2,
                    "workspace": name,
                    "exported_at": datetime.now().isoformat(),
                    "archive": {
                        "locked": bool(normalized_lock_key),
                        "lock_format": "caracal-workspace-lock-v1" if normalized_lock_key else None,
                    },
                    "includes": {
                        "workspace_files": True,
                        "secrets": include_secrets and bool(self._load_secret_refs_or_empty(name)),
                        "database_dump": db_dump_included,
                    },
                }
                # Manifest contains only boolean flags and metadata — no secret values.
                # The "secrets" key is a boolean indicating presence, not the secret itself.
                (staged_workspace_dir / "export_manifest.json").write_text(  # lgtm[py/clear-text-storage-of-sensitive-data]
                    json.dumps(manifest, indent=2)
                )

                staged_archive_path = stage_root / "workspace_export.tar.gz"
                with tarfile.open(staged_archive_path, "w:gz") as tar:
                    tar.add(staged_workspace_dir, arcname=name)

                if normalized_lock_key:
                    archive_bytes = staged_archive_path.read_bytes()
                    locked_bytes = self._encrypt_archive_payload(archive_bytes, normalized_lock_key)
                    with open(path, "wb") as locked_out:
                        locked_out.write(locked_bytes)
                else:
                    shutil.copy2(staged_archive_path, path)
            
            logger.info(
                "workspace_exported",
                workspace=name,
                export_path=str(path),
                include_secrets=include_secrets
            )
        except PermissionError as e:
            if in_container_runtime():
                raise WorkspaceOperationError(
                    "Failed to export workspace due to ownership mismatch on workspace files. "
                    "Run 'caracal down && caracal up' to repair permissions, then retry export. "
                    f"Original error: {e}"
                ) from e
            raise WorkspaceOperationError(f"Failed to export workspace: {e}") from e
            
        except Exception as e:
            logger.error(
                "workspace_export_failed",
                workspace=name,
                error=str(e)
            )
            raise WorkspaceOperationError(f"Failed to export workspace: {e}") from e
    
    def import_workspace(
        self,
        path: Path,
        name: Optional[str] = None,
        lock_key: Optional[str] = None,
    ) -> None:
        """
        Imports workspace from backup or migration.
        
        Args:
            path: Import path
            name: Optional workspace name (uses name from export if not provided)
            lock_key: Optional key for locked archive imports
            
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

                archive_to_extract = self._prepare_import_archive(path, lock_key, temp_path)

                with tarfile.open(archive_to_extract, "r:gz") as tar:
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

                self._normalize_workspace_ownership(target_dir)
                
                if name and name != source_dir.name:
                    config = self.get_workspace_config(workspace_name)
                    config.name = workspace_name
                    config.updated_at = datetime.now()
                    self.set_workspace_config(workspace_name, config)

                db_dump_path = target_dir / "workspace_schema.dump"
                if db_dump_path.exists():
                    self._import_workspace_db_dump(workspace_name, target_dir, db_dump_path)
                    db_dump_path.unlink(missing_ok=True)

                manifest_path = target_dir / "export_manifest.json"
                if manifest_path.exists():
                    manifest_path.unlink(missing_ok=True)
                
                logger.info(
                    "workspace_imported",
                    workspace=workspace_name,
                    import_path=str(path)
                )

                # Keep Flow registry synchronized with imported workspace.
                try:
                    from caracal.flow.workspace import WorkspaceManager

                    WorkspaceManager.register_workspace(workspace_name, target_dir)
                except Exception:
                    logger.debug("workspace_registry_import_sync_skipped", workspace=workspace_name)
                
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
            main_config = {}
            if self.CONFIG_FILE.exists():
                try:
                    main_config = toml.load(self.CONFIG_FILE)
                except toml.TomlDecodeError:
                    logger.warning("config_file_corrupted", action="creating_new")
                    main_config = {}
            
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

            # Resolve password from env first (container runtime), then workspace vaults.
            password = os.getenv("CCL_DB_PASSWORD", "") or ""
            if not password:
                workspace_candidates: List[str] = []

                default_workspace = self.get_default_workspace_name()
                if default_workspace:
                    workspace_candidates.append(default_workspace)

                for workspace in self.list_workspaces():
                    if workspace not in workspace_candidates:
                        workspace_candidates.append(workspace)

                for workspace in workspace_candidates:
                    try:
                        password = self.get_secret(config.password_ref, workspace)
                        if password:
                            break
                    except (SecretNotFoundError, WorkspaceNotFoundError, DecryptionError):
                        continue

            if not password:
                logger.debug("postgres_password_not_found", password_ref=config.password_ref)
            
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
