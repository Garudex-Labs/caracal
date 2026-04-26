"""Central adapter for deployment edition behavior resolution."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional, Union

from caracal.deployment.edition import Edition, EditionManager
from caracal.deployment.exceptions import EditionConfigurationError


class DeploymentEditionAdapter:
    """Single adapter surface for edition-aware behavior in runtime and UI flows."""

    def __init__(self, edition_manager: Optional[EditionManager] = None) -> None:
        self._edition_manager = edition_manager or EditionManager()

    def get_edition(self) -> Edition:
        return self._edition_manager.get_edition()

    def set_edition(
        self,
        edition: Edition,
        gateway_url: Optional[str] = None,
        gateway_token: Optional[str] = None,
    ) -> None:
        self._edition_manager.set_edition(
            edition,
            gateway_url=gateway_url,
            gateway_token=gateway_token,
        )

    def is_enterprise(self) -> bool:
        return self.get_edition() == Edition.ENTERPRISE

    def is_opensource(self) -> bool:
        return self.get_edition() == Edition.OPENSOURCE

    def display_name(self) -> str:
        return "Enterprise" if self.is_enterprise() else "Open Source"

    def uses_gateway_execution(self) -> bool:
        return self.is_enterprise()

    def allows_local_provider_management(self) -> bool:
        return not self.uses_gateway_execution()

    def get_gateway_url(self) -> Optional[str]:
        return self._edition_manager.get_gateway_url()

    def get_gateway_token(self) -> Optional[str]:
        return self._edition_manager.get_gateway_token()

    def require_gateway_url(self) -> str:
        gateway_url = str(self.get_gateway_url() or "").strip()
        if gateway_url:
            return gateway_url

        raise EditionConfigurationError(
            "Enterprise execution requires a gateway URL "
            "(CCLE_API_URL)."
        )

    def resolve_revocation_publisher_mode(self, *, explicit_mode: Optional[str] = None) -> str:
        normalized_mode = str(explicit_mode or "").strip().lower()
        if normalized_mode:
            if normalized_mode in {"redis", "enterprise_webhook"}:
                return normalized_mode
            raise EditionConfigurationError(
                "CCL_REVOKE_PUB_MODE must be one of: redis, enterprise_webhook"
            )

        return "enterprise_webhook" if self.is_enterprise() else "redis"

    def resolve_enterprise_revocation_target(
        self,
        *,
        webhook_url_override: Optional[str] = None,
        sync_api_key_override: Optional[str] = None,
    ) -> tuple[str, str]:
        if not self.is_enterprise():
            raise EditionConfigurationError(
                "Enterprise revocation target resolution is only valid in enterprise mode."
            )

        from caracal.deployment.enterprise_runtime import resolve_revocation_webhook_target

        normalized_webhook_override = str(webhook_url_override or "").strip() or None
        normalized_sync_override = str(sync_api_key_override or "").strip() or None
        webhook_url, sync_api_key = resolve_revocation_webhook_target(
            webhook_url_override=normalized_webhook_override,
        )

        if not webhook_url:
            gateway_url = self.require_gateway_url()
            webhook_url = f"{gateway_url.rstrip('/')}/api/sync/revocation-events"

        resolved_sync_api_key = normalized_sync_override or sync_api_key
        if not resolved_sync_api_key:
            raise EditionConfigurationError(
                "Enterprise revocation webhook publishing requires a sync API key "
                f"({sync_api_key_override!r} override or persisted runtime sync key)."
            )

        return webhook_url, resolved_sync_api_key

    def resolve_gateway_feature_overrides(self) -> dict[str, Any]:
        """Return enterprise runtime gateway overrides for adapter consumers.

        This keeps enterprise config loading isolated behind the adapter so core
        modules do not import enterprise license modules directly.
        """
        if not self.is_enterprise():
            return {}

        from caracal.deployment.enterprise_runtime import load_enterprise_config

        raw_config = load_enterprise_config()
        if not isinstance(raw_config, dict):
            return {}

        gateway = raw_config.get("gateway")
        if not isinstance(gateway, dict):
            return {}

        normalized: dict[str, Any] = {
            "enabled": bool(gateway.get("enabled", False)),
        }

        endpoint = str(gateway.get("endpoint") or "").strip()
        if endpoint:
            normalized["endpoint"] = endpoint.rstrip("/")

        api_key = str(gateway.get("api_key") or "").strip()
        if api_key:
            normalized["api_key"] = api_key

        if "fail_closed" in gateway:
            normalized["fail_closed"] = bool(gateway["fail_closed"])
        if "use_provider_registry" in gateway:
            normalized["use_provider_registry"] = bool(gateway["use_provider_registry"])
        if "mandate_cache_ttl_seconds" in gateway:
            normalized["mandate_cache_ttl_seconds"] = int(gateway["mandate_cache_ttl_seconds"])
        if "revocation_sync_interval_seconds" in gateway:
            normalized["revocation_sync_interval_seconds"] = int(
                gateway["revocation_sync_interval_seconds"]
            )

        deployment_type = str(gateway.get("deployment_type") or "").strip().lower()
        if deployment_type in {"managed", "on_prem", "oss"}:
            normalized["deployment_type"] = deployment_type

        return normalized

    def get_provider_client(self) -> Union["Broker", "GatewayClient"]:
        from caracal.deployment.broker import Broker
        from caracal.deployment.gateway_client import GatewayClient

        if self.is_enterprise():
            return GatewayClient(gateway_url=self.require_gateway_url())
        return Broker()

    def clear_cache(self) -> None:
        self._edition_manager.clear_cache()

    def assert_enterprise_license_valid(self) -> None:
        """Fail closed when enterprise mode is active but license state is invalid."""
        if not self.is_enterprise():
            return

        try:
            from caracal.deployment.enterprise_runtime import load_enterprise_config

            cfg = load_enterprise_config()
        except Exception as exc:
            raise EditionConfigurationError(
                "Enterprise startup requires a readable persisted enterprise license configuration."
            ) from exc

        if not isinstance(cfg, dict):
            raise EditionConfigurationError(
                "Enterprise startup requires a valid persisted enterprise license configuration."
            )

        if not bool(cfg.get("valid", False)):
            raise EditionConfigurationError(
                "Enterprise startup requires a valid enterprise license."
            )

        license_key = str(cfg.get("license_key") or "").strip()
        if not license_key:
            raise EditionConfigurationError(
                "Enterprise startup requires a persisted enterprise license key."
            )

        expires_at_raw = str(cfg.get("expires_at") or "").strip()
        if expires_at_raw:
            try:
                normalized = expires_at_raw.replace("Z", "+00:00")
                expires_at = datetime.fromisoformat(normalized)
                if expires_at.tzinfo is None:
                    expires_at = expires_at.replace(tzinfo=timezone.utc)
                else:
                    expires_at = expires_at.astimezone(timezone.utc)
            except ValueError as exc:
                raise EditionConfigurationError(
                    "Enterprise startup requires a parseable license expiry timestamp."
                ) from exc

            if expires_at <= datetime.now(timezone.utc):
                raise EditionConfigurationError(
                    "Enterprise startup requires a non-expired enterprise license."
                )


def get_deployment_edition_adapter(
    *,
    edition_manager: Optional[EditionManager] = None,
    enforce_startup_license_validation: bool = False,
) -> DeploymentEditionAdapter:
    adapter = DeploymentEditionAdapter(edition_manager=edition_manager)
    if enforce_startup_license_validation:
        adapter.assert_enterprise_license_valid()
    return adapter
