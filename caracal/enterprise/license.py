"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Enterprise license validation.

This module provides license validation for Caracal Enterprise features.
It calls the Caracal Enterprise API to validate license tokens and
manage sync configuration.  When the API is unreachable — or no
enterprise URL is configured — it falls back to cached license data
stored in the workspace config.
"""

import json
import logging
import os
import platform
import socket
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional
from uuid import uuid4

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Enterprise config file helpers
# ---------------------------------------------------------------------------

_ENTERPRISE_CONFIG_NAME = "enterprise.json"


def _get_enterprise_config_path() -> Path:
    """Return path to the enterprise config in the active workspace."""
    try:
        from caracal.flow.workspace import get_workspace
        ws = get_workspace()
        return ws.root / _ENTERPRISE_CONFIG_NAME
    except Exception:
        return Path.home() / ".caracal" / _ENTERPRISE_CONFIG_NAME


def load_enterprise_config() -> Dict[str, Any]:
    """Load persisted enterprise config (license, sync key, API URL, etc.)."""
    path = _get_enterprise_config_path()
    if path.exists():
        try:
            return json.loads(path.read_text())
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Failed to read enterprise config %s: %s", path, exc)
    return {}


def save_enterprise_config(data: Dict[str, Any]) -> None:
    """Persist enterprise config to the workspace."""
    path = _get_enterprise_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, default=str))
    logger.debug("Enterprise config saved to %s", path)


def clear_enterprise_config() -> None:
    """Remove enterprise config from the workspace."""
    path = _get_enterprise_config_path()
    if path.exists():
        path.unlink()


def _get_or_create_client_instance_id() -> str:
    """Return a stable CLI client instance id stored in enterprise config."""
    cfg = load_enterprise_config()
    client_instance_id = cfg.get("client_instance_id")
    if isinstance(client_instance_id, str) and client_instance_id.strip():
        return client_instance_id.strip()

    client_instance_id = f"ccli-{uuid4()}"
    cfg["client_instance_id"] = client_instance_id
    save_enterprise_config(cfg)
    return client_instance_id


def _build_client_metadata() -> Dict[str, str]:
    """Build lightweight runtime metadata for enterprise-side traceability."""
    return {
        "source": "caracal-cli",
        "hostname": socket.gethostname(),
        "platform": platform.system().lower(),
        "platform_release": platform.release(),
        "python_version": platform.python_version(),
        "env_mode": (os.environ.get("CARACAL_ENV_MODE") or "dev").strip().lower(),
    }


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class LicenseValidationResult:
    """
    Result of enterprise license validation.
    
    Attributes:
        valid: Whether the license is valid
        message: Message explaining the validation result
        features_available: List of enterprise features available with this license
        expires_at: License expiration timestamp (None if invalid or no expiration)
        tier: License tier (starter, professional, enterprise)
        sync_api_key: API key for CLI-to-Enterprise sync (returned on first validation)
        enterprise_api_url: URL of the Enterprise API (for sync)
    """
    
    valid: bool
    message: str
    features_available: list[str] = field(default_factory=list)
    expires_at: Optional[datetime] = None
    tier: Optional[str] = None
    sync_api_key: Optional[str] = None
    enterprise_api_url: Optional[str] = None
    
    def to_dict(self) -> dict:
        """
        Convert result to dictionary format.
        
        Returns:
            Dictionary representation of the validation result
        """
        return {
            "valid": self.valid,
            "message": self.message,
            "features_available": self.features_available,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "tier": self.tier,
            "sync_api_key": self.sync_api_key,
            "enterprise_api_url": self.enterprise_api_url,
        }


# ---------------------------------------------------------------------------
# HTTP helpers (lightweight — no extra dependencies)
# ---------------------------------------------------------------------------

def _post_json(url: str, payload: dict, timeout: int = 15) -> dict:
    """POST JSON to *url* and return the parsed response body.

    Uses :mod:`urllib.request` so we don't add a ``requests`` dependency
    to the open-source CLI.  Raises on HTTP errors or connection failures.
    """
    import urllib.request
    import urllib.error

    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode() if exc.fp else ""
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            raise ConnectionError(f"HTTP {exc.code}: {body[:500]}") from exc
    except urllib.error.URLError as exc:
        raise ConnectionError(f"Cannot reach Enterprise API at {url}: {exc.reason}") from exc


def _get_json(url: str, headers: Optional[dict] = None, timeout: int = 15) -> dict:
    """GET JSON from *url*."""
    import urllib.request
    import urllib.error

    req = urllib.request.Request(url, headers=headers or {}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode() if exc.fp else ""
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            raise ConnectionError(f"HTTP {exc.code}: {body[:500]}") from exc
    except urllib.error.URLError as exc:
        raise ConnectionError(f"Cannot reach Enterprise API at {url}: {exc.reason}") from exc


def _resolve_api_url(override: Optional[str] = None) -> str:
    """Return the Enterprise API base URL.

    Priority: *override* → persisted config → env var.

    In development mode only, ``CARACAL_ENTERPRISE_DEV_URL`` can be used
    as a convenience override. No localhost fallback is hardcoded.
    """
    if override:
        return override.rstrip("/")

    cfg = load_enterprise_config()
    if cfg.get("enterprise_api_url"):
        return cfg["enterprise_api_url"].rstrip("/")

    # Primary remote URL contract.
    enterprise_url = os.environ.get("CARACAL_ENTERPRISE_URL")
    if enterprise_url:
        return enterprise_url.rstrip("/")

    # Dev-only local override for integration work.
    env_mode = (os.environ.get("CARACAL_ENV_MODE") or "dev").strip().lower()
    if env_mode == "dev":
        dev_url = os.environ.get("CARACAL_ENTERPRISE_DEV_URL")
        if dev_url:
            return dev_url.rstrip("/")

    # Backward-compat aliases.
    legacy_url = os.environ.get("CARACAL_ENTERPRISE_API_URL") or os.environ.get("CARACAL_GATEWAY_URL")
    if legacy_url:
        return legacy_url.rstrip("/")

    return ""


# ---------------------------------------------------------------------------
# Validator
# ---------------------------------------------------------------------------

class EnterpriseLicenseValidator:
    """
    Validates enterprise license tokens against the Caracal Enterprise API.
    
    The validator calls the Enterprise API's ``/api/license/validate`` endpoint.
    On successful validation, it:
    - Persists the license key, tier, features, expiry, and sync API key
      to the workspace's ``enterprise.json`` so subsequent runs auto-connect.
    - Returns a ``LicenseValidationResult`` with full details.
    
    When the Enterprise API is unreachable, the validator checks for cached
    license data.  If the cached license has not expired it returns a valid
    result with the cached information.
    
    Enterprise License Token Format:
        Tokens are generated by the Enterprise API and typically look like:
        ``ent-<random>`` or ``CARACAL-ENT-<UUID>`` (legacy).

    Usage:
        >>> validator = EnterpriseLicenseValidator()
        >>> result = validator.validate_license("ent-abcdef...")
        >>> if result.valid:
        ...     print("Enterprise features enabled")
        ... else:
        ...     print(result.message)
    """
    
    def __init__(self, enterprise_api_url: Optional[str] = None):
        """
        Initialize the validator.
        
        Args:
            enterprise_api_url: Override URL for the Enterprise API.
                Defaults to persisted config, ``CARACAL_ENTERPRISE_URL``,
                or (dev mode only) ``CARACAL_ENTERPRISE_DEV_URL``.
        """
        self._api_url = _resolve_api_url(enterprise_api_url)
        self._cached_config: Optional[Dict[str, Any]] = None
    
    @property
    def api_url(self) -> str:
        return self._api_url

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def validate_license(
        self,
        license_token: str,
        password: Optional[str] = None,
    ) -> LicenseValidationResult:
        """
        Validate an enterprise license token via the Enterprise API.
        
        Args:
            license_token: The enterprise license token to validate.
            password: Optional password for password-protected licenses.
        
        Returns:
            LicenseValidationResult with validation outcome and details.
        """
        if not license_token or not license_token.strip():
            return LicenseValidationResult(
                valid=False,
                message="No license token provided.",
            )

        license_token = license_token.strip()

        if not self._api_url:
            logger.info("No enterprise URL configured; falling back to cached license")
            return self._validate_from_cache(license_token)

        # --- Try Enterprise API ---
        try:
            url = f"{self._api_url}/api/license/validate"
            payload: Dict[str, Any] = {
                "license_key": license_token,
                "client_instance_id": _get_or_create_client_instance_id(),
                "client_metadata": _build_client_metadata(),
            }
            if password:
                payload["password"] = password

            resp = _post_json(url, payload)

            if resp.get("valid"):
                features = resp.get("features") or {}
                feature_names = [k for k, v in features.items() if v]
                expires_at = None
                if resp.get("valid_until"):
                    try:
                        expires_at = datetime.fromisoformat(resp["valid_until"])
                    except (ValueError, TypeError):
                        pass

                tier = resp.get("tier")
                sync_api_key = resp.get("sync_api_key")
                enterprise_api_url = resp.get("enterprise_api_url") or self._api_url

                # Persist to workspace config for auto-sync
                self._persist_license(
                    license_key=license_token,
                    tier=tier,
                    features=features,
                    feature_names=feature_names,
                    expires_at=expires_at,
                    sync_api_key=sync_api_key,
                    enterprise_api_url=enterprise_api_url,
                    password=password,
                )

                return LicenseValidationResult(
                    valid=True,
                    message=resp.get("message", "License is valid."),
                    features_available=feature_names,
                    expires_at=expires_at,
                    tier=tier,
                    sync_api_key=sync_api_key,
                    enterprise_api_url=enterprise_api_url,
                )
            else:
                return LicenseValidationResult(
                    valid=False,
                    message=resp.get("message", "License validation failed."),
                )

        except ConnectionError as exc:
            logger.warning("Enterprise API unreachable: %s — trying cached license", exc)
            return self._validate_from_cache(license_token)
        except Exception as exc:
            logger.error("Unexpected error during license validation: %s", exc)
            return self._validate_from_cache(license_token)

    def get_available_features(self) -> list[str]:
        """
        Get list of available enterprise features.
        
        Returns feature list from cached license config, or empty list.
        """
        cfg = self._load_config()
        return cfg.get("feature_names", [])
    
    def is_feature_available(self, feature: str) -> bool:
        """
        Check if a specific enterprise feature is available.
        
        Args:
            feature: Name of the feature to check (e.g., "sso", "analytics")
        
        Returns:
            True if the feature is available in the current license
        """
        cfg = self._load_config()
        features = cfg.get("features", {})
        return bool(features.get(feature, False))
    
    def get_license_info(self) -> dict:
        """
        Get information about the current license.
        
        Returns:
            Dictionary with license information (from cache or defaults)
        """
        cfg = self._load_config()
        if cfg.get("license_key"):
            return {
                "edition": "enterprise",
                "license_active": True,
                "license_key": cfg["license_key"],
                "tier": cfg.get("tier", "unknown"),
                "features_available": cfg.get("feature_names", []),
                "expires_at": cfg.get("expires_at"),
                "sync_api_key": cfg.get("sync_api_key"),
                "enterprise_api_url": cfg.get("enterprise_api_url"),
                "upgrade_url": "https://garudexlabs.com",
                "contact_email": "support@garudexlabs.com",
            }
        return {
            "edition": "open_source",
            "license_active": False,
            "features_available": [],
            "upgrade_url": "https://garudexlabs.com",
            "contact_email": "support@garudexlabs.com",
        }

    def get_sync_api_key(self) -> Optional[str]:
        """Return the stored sync API key, if any."""
        cfg = self._load_config()
        return cfg.get("sync_api_key")

    def get_enterprise_api_url(self) -> Optional[str]:
        """Return the stored Enterprise API URL, if any."""
        cfg = self._load_config()
        return cfg.get("enterprise_api_url") or self._api_url or None

    def is_connected(self) -> bool:
        """Return True if a valid license is persisted."""
        cfg = self._load_config()
        return bool(cfg.get("license_key") and cfg.get("valid", False))

    def disconnect(self) -> None:
        """Clear persisted license data."""
        clear_enterprise_config()
        self._cached_config = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _load_config(self) -> Dict[str, Any]:
        if self._cached_config is None:
            self._cached_config = load_enterprise_config()
        return self._cached_config

    def _persist_license(
        self,
        license_key: str,
        tier: Optional[str],
        features: dict,
        feature_names: list[str],
        expires_at: Optional[datetime],
        sync_api_key: Optional[str],
        enterprise_api_url: Optional[str],
        password: Optional[str] = None,
    ) -> None:
        """Save license data to workspace config for offline use and auto-sync."""
        data: Dict[str, Any] = {
            "license_key": license_key,
            "tier": tier,
            "features": features,
            "feature_names": feature_names,
            "expires_at": expires_at.isoformat() if expires_at else None,
            "sync_api_key": sync_api_key,
            "enterprise_api_url": enterprise_api_url,
            "valid": True,
            "validated_at": datetime.utcnow().isoformat(),
            "client_instance_id": _get_or_create_client_instance_id(),
        }
        # Never persist plaintext password — only a flag that one was used
        if password:
            data["password_protected"] = True
        
        save_enterprise_config(data)
        self._cached_config = data

    def _validate_from_cache(self, license_token: str) -> LicenseValidationResult:
        """Attempt to validate from cached license data when API is unreachable."""
        cfg = self._load_config()
        
        if not cfg.get("license_key"):
            return LicenseValidationResult(
                valid=False,
                message=(
                    "Cannot reach the Enterprise API and no cached license found. "
                    "Ensure the Enterprise API is running or check your network connection. "
                    "Visit https://garudexlabs.com for more information."
                ),
            )
        
        # Check that the token matches the cached one
        if cfg["license_key"] != license_token:
            return LicenseValidationResult(
                valid=False,
                message=(
                    "License token does not match the cached license. "
                    "Cannot validate offline with a different token."
                ),
            )
        
        # Check expiry
        expires_at = None
        if cfg.get("expires_at"):
            try:
                expires_at = datetime.fromisoformat(cfg["expires_at"])
                if expires_at < datetime.utcnow():
                    return LicenseValidationResult(
                        valid=False,
                        message="Cached license has expired. Connect to the Enterprise API to renew.",
                    )
            except (ValueError, TypeError):
                pass
        
        return LicenseValidationResult(
            valid=True,
            message="License validated from cache (Enterprise API unreachable).",
            features_available=cfg.get("feature_names", []),
            expires_at=expires_at,
            tier=cfg.get("tier"),
            sync_api_key=cfg.get("sync_api_key"),
            enterprise_api_url=cfg.get("enterprise_api_url"),
        )
