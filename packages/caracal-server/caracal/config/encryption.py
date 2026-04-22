"""Configuration encryption utilities backed by CaracalVault references."""

from __future__ import annotations

import os
from uuid import uuid4
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from caracal.logging_config import get_logger
from caracal.storage.key_audit import append_key_audit_event
from caracal.storage.layout import CaracalLayout, get_caracal_layout

logger = get_logger(__name__)


class MasterKeyError(RuntimeError):
    """Raised when vault-backed config secret operations fail."""


@dataclass
class RotationSummary:
    """Result from requesting master-key rotation through vault service."""

    rewrapped_deks: int
    rotated_at: str


class ConfigEncryption:
    """Encrypt/decrypt config values using vault-stored opaque references."""

    ENCRYPTED_PREFIX = "ENC[v4:"
    ENCRYPTED_SUFFIX = "]"

    def __init__(
        self,
        layout: Optional[CaracalLayout] = None,
        dek_name: str = "config.default",
        actor: str = "system",
    ):
        self.layout = layout or get_caracal_layout()
        self.actor = actor
        self.dek_name = dek_name
        self.workspace_id = os.getenv("CARACAL_VAULT_WORKSPACE_ID") or os.getenv("CARACAL_WORKSPACE_ID") or "default"
        self.env_id = os.getenv("CARACAL_VAULT_ENVIRONMENT") or os.getenv("CARACAL_ENV_ID") or "dev"

    def _get_vault(self):
        try:
            from caracal.core.vault import get_vault

            return get_vault()
        except Exception as exc:
            raise MasterKeyError(f"Vault is not available for config encryption: {exc}") from exc

    def _secret_name(self) -> str:
        return f"config/{self.dek_name}/{uuid4().hex}"

    def encrypt(self, plaintext: str) -> str:
        """Store plaintext in vault and return an opaque encrypted envelope."""
        vault = self._get_vault()
        secret_name = self._secret_name()
        try:
            from caracal.core.vault import vault_access_context

            with vault_access_context():
                vault.put(
                    workspace_id=self.workspace_id,
                    env_id=self.env_id,
                    name=secret_name,
                    plaintext=plaintext,
                    actor=self.actor,
                )
        except Exception as exc:
            raise MasterKeyError(f"Failed to store config secret in vault: {exc}") from exc

        # Envelope stores only an opaque vault reference, never key material.
        return f"{self.ENCRYPTED_PREFIX}vault://{self.workspace_id}/{self.env_id}/{secret_name}{self.ENCRYPTED_SUFFIX}"

    def decrypt(self, encrypted: str) -> str:
        """Resolve an ENC[v4:...] vault reference envelope."""
        if not self.is_encrypted(encrypted):
            raise ValueError("Value is not an ENC[...] encrypted payload")

        if not encrypted.startswith(self.ENCRYPTED_PREFIX):
            raise MasterKeyError("Unsupported encrypted payload version; only ENC[v4:...] is allowed")

        ref = encrypted[len(self.ENCRYPTED_PREFIX):-len(self.ENCRYPTED_SUFFIX)]
        prefix = f"vault://{self.workspace_id}/{self.env_id}/"
        if not ref.startswith(prefix):
            raise ValueError("Encrypted payload reference is malformed")
        secret_name = ref[len(prefix):]
        if not secret_name:
            raise ValueError("Encrypted payload is missing vault secret name")

        vault = self._get_vault()
        try:
            from caracal.core.vault import vault_access_context

            with vault_access_context():
                return vault.get(
                    workspace_id=self.workspace_id,
                    env_id=self.env_id,
                    name=secret_name,
                    actor=self.actor,
                )
        except Exception as exc:
            raise MasterKeyError(f"Failed to resolve config secret from vault: {exc}") from exc

    @classmethod
    def is_encrypted(cls, value: str) -> bool:
        return isinstance(value, str) and value.startswith("ENC[v") and value.endswith(cls.ENCRYPTED_SUFFIX)

    def decrypt_config(self, config_dict: dict[str, Any]) -> dict[str, Any]:
        """Recursively decrypt encrypted values in a configuration dictionary."""
        result: dict[str, Any] = {}
        for key, value in config_dict.items():
            if isinstance(value, str) and self.is_encrypted(value):
                result[key] = self.decrypt(value)
            elif isinstance(value, dict):
                result[key] = self.decrypt_config(value)
            elif isinstance(value, list):
                items = []
                for item in value:
                    if isinstance(item, str) and self.is_encrypted(item):
                        items.append(self.decrypt(item))
                    elif isinstance(item, dict):
                        items.append(self.decrypt_config(item))
                    else:
                        items.append(item)
                result[key] = items
            else:
                result[key] = value
        return result


def encrypt_value(value: str) -> str:
    """Encrypt a value by storing it as a vault-referenced config secret."""
    encryptor = ConfigEncryption(actor="cli")
    return encryptor.encrypt(value)


def decrypt_value(encrypted: str) -> str:
    """Decrypt a value by resolving the vault reference envelope."""
    encryptor = ConfigEncryption(actor="cli")
    return encryptor.decrypt(encrypted)


def rotate_master_key(actor: str = "cli") -> RotationSummary:
    """Request rotation at the vault service and record an audit event."""
    now = datetime.now(timezone.utc).isoformat()
    layout = get_caracal_layout()
    rewrapped = 0

    try:
        from caracal.core.vault import get_vault, vault_access_context

        workspace_id = os.getenv("CARACAL_VAULT_WORKSPACE_ID") or os.getenv("CARACAL_WORKSPACE_ID") or "default"
        env_id = os.getenv("CARACAL_VAULT_ENVIRONMENT") or os.getenv("CARACAL_ENV_ID") or "dev"
        with vault_access_context():
            result = get_vault().rotate_master_key(workspace_id=workspace_id, env_id=env_id, actor=actor)
            rewrapped = result.secrets_rotated
    except Exception:
        # Rotation endpoint can be unavailable in some environments; audit event is still recorded.
        rewrapped = 0

    append_key_audit_event(
        layout,
        event_type="master_key_rotation_requested",
        actor=actor,
        operation="rotate",
        metadata={"backend": "vault"},
    )
    return RotationSummary(rewrapped_deks=rewrapped, rotated_at=now)


def get_key_status() -> dict[str, Any]:
    """Return current key status for CLI diagnostics."""
    vault_url = os.getenv("CARACAL_VAULT_URL")
    workspace = os.getenv("CARACAL_VAULT_WORKSPACE_ID") or os.getenv("CARACAL_WORKSPACE_ID")
    environment = os.getenv("CARACAL_VAULT_ENVIRONMENT") or os.getenv("CARACAL_ENV_ID")
    return {
        "backend": "vault",
        "vault_url": vault_url,
        "vault_workspace": workspace,
        "vault_environment": environment,
        "configured": bool(vault_url),
        "local_master_key_supported": False,
    }
