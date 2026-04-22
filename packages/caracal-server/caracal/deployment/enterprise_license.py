"""Thin deployment-owned client for Enterprise license validation."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, Optional

from caracal.deployment.enterprise_runtime import (
    _build_client_metadata,
    _get_or_create_client_instance_id,
    _post_json,
    _resolve_api_url,
    clear_enterprise_config,
    load_enterprise_config,
    save_enterprise_config,
)

logger = logging.getLogger(__name__)


@dataclass
class LicenseValidationResult:
    """Result of enterprise license validation."""

    valid: bool
    message: str
    features_available: list[str] = field(default_factory=list)
    expires_at: Optional[datetime] = None
    tier: Optional[str] = None
    sync_api_key: Optional[str] = None
    enterprise_api_url: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "valid": self.valid,
            "message": self.message,
            "features_available": self.features_available,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "tier": self.tier,
            "sync_api_key": self.sync_api_key,
            "enterprise_api_url": self.enterprise_api_url,
        }


class EnterpriseLicenseValidator:
    """Validate enterprise license tokens against the live Enterprise API."""

    def __init__(self, enterprise_api_url: Optional[str] = None):
        self._api_url = _resolve_api_url(enterprise_api_url)
        self._cached_config: Optional[Dict[str, Any]] = None

    @property
    def api_url(self) -> str:
        return self._api_url

    def validate_license(
        self,
        license_token: str,
    ) -> LicenseValidationResult:
        if not license_token or not license_token.strip():
            return LicenseValidationResult(
                valid=False,
                message="No license token provided.",
            )

        license_token = license_token.strip()

        if not self._api_url:
            return LicenseValidationResult(
                valid=False,
                message=(
                    "Enterprise API URL is not configured. "
                    "License validation requires a live Enterprise API in hard-cut mode."
                ),
            )

        try:
            payload: Dict[str, Any] = {
                "license_key": license_token,
                "client_instance_id": _get_or_create_client_instance_id(),
                "client_metadata": _build_client_metadata(),
            }
            url = f"{self._api_url}/api/license/validate"
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

                self._persist_license(
                    license_key=license_token,
                    tier=tier,
                    features=features,
                    feature_names=feature_names,
                    expires_at=expires_at,
                    sync_api_key=sync_api_key,
                    enterprise_api_url=enterprise_api_url,
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

            return LicenseValidationResult(
                valid=False,
                message=resp.get("message", "License validation failed."),
            )

        except ConnectionError as exc:
            logger.warning("Enterprise API unreachable during license validation: %s", exc)
            return LicenseValidationResult(
                valid=False,
                message=(
                    f"Cannot reach the Enterprise API at {self._api_url}. "
                    "License validation requires a live Enterprise API in hard-cut mode."
                ),
            )
        except Exception as exc:
            logger.error("Unexpected error during license validation: %s", exc)
            return LicenseValidationResult(
                valid=False,
                message=(
                    "License validation request failed before the API response could be parsed. "
                    f"Details: {exc}"
                ),
            )

    def get_available_features(self) -> list[str]:
        cfg = self._load_config()
        return cfg.get("feature_names", [])

    def is_feature_available(self, feature: str) -> bool:
        cfg = self._load_config()
        features = cfg.get("features", {})
        return bool(features.get(feature, False))

    def get_license_info(self) -> dict:
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
        cfg = self._load_config()
        return cfg.get("sync_api_key")

    def get_enterprise_api_url(self) -> Optional[str]:
        cfg = self._load_config()
        return cfg.get("enterprise_api_url") or self._api_url or None

    def is_connected(self) -> bool:
        cfg = self._load_config()
        return bool(cfg.get("license_key") and cfg.get("valid", False))

    def disconnect(self) -> None:
        clear_enterprise_config()
        self._cached_config = None

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
    ) -> None:
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
        save_enterprise_config(data)
        self._cached_config = data
