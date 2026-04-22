"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Gateway Feature Flags & Configuration.

Provides the opt-in mechanism for enterprise gateway enforcement.
OSS default: broker mode (policy check → signed mandate, client routes directly).
Enterprise opt-in: network-level enforcement via gateway proxy.

Feature flags are resolved in priority order:
    1. Centralized edition adapter for enterprise/gateway execution signals
    2. Enterprise runtime metadata for gateway-specific settings
    3. Workspace config file (~/.caracal/config.yaml)
    4. Compile-time defaults (all disabled)
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Optional

from caracal.logging_config import get_logger

logger = get_logger(__name__)

# ── Environment variable names ──────────────────────────────────────────────
_ENV_GATEWAY_ENABLED = "CARACAL_GATEWAY_ENABLED"
_ENV_GATEWAY_API_KEY = "CARACAL_GATEWAY_API_KEY"
_ENV_GATEWAY_ENFORCE_NETWORK = "CARACAL_GATEWAY_ENFORCE_NETWORK"
_ENV_GATEWAY_FAIL_CLOSED = "CARACAL_GATEWAY_FAIL_CLOSED"
_ENV_GATEWAY_MANDATE_CACHE_TTL = "CARACAL_GATEWAY_MANDATE_CACHE_TTL"
_ENV_GATEWAY_REVOCATION_SYNC_INTERVAL = "CARACAL_GATEWAY_REVOCATION_SYNC_INTERVAL"
_ENV_GATEWAY_USE_PROVIDER_REGISTRY = "CARACAL_GATEWAY_USE_PROVIDER_REGISTRY"
_ENV_GATEWAY_DEPLOYMENT_TYPE = "CARACAL_GATEWAY_DEPLOYMENT_TYPE"


def _bool_env(name: str, default: bool = False) -> bool:
    val = os.getenv(name, "").lower()
    if val in ("1", "true", "yes"):
        return True
    if val in ("0", "false", "no"):
        return False
    return default


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


# ── Deployment types ────────────────────────────────────────────────────────
DEPLOYMENT_OSS = "oss"            # Pure broker — OSS default
DEPLOYMENT_MANAGED = "managed"   # Caracal-hosted gateway (Enterprise SaaS)
DEPLOYMENT_ON_PREM = "on_prem"   # Customer self-hosted gateway (Enterprise On-Prem)


@dataclass
class GatewayFeatureFlags:
    """
    Runtime feature flags that govern gateway enforcement behaviour.

    OSS default: all enterprise flags off, broker path active.
    Enterprise: loaded from env / workspace config; flags enabled by cluster setup.
    """

    # ── Core behaviour ──────────────────────────────────────────────────────
    gateway_enabled: bool = False
    """Whether to route mandate validation through the gateway (vs direct broker)."""

    enforce_at_network: bool = False
    """Intercept outbound calls at the network layer (requires gateway sidecar)."""

    fail_closed: bool = True
    """
    Deny the request when the gateway is unreachable.
    Always True for enterprise; OSS broker falls back to local evaluation.
    """

    # ── Connectivity ────────────────────────────────────────────────────────
    gateway_endpoint: Optional[str] = None
    """Base URL of the gateway proxy (e.g. https://gw.example.com)."""

    gateway_api_key: Optional[str] = None
    """API key used to authenticate SDK/CLI calls to the gateway."""

    deployment_type: str = DEPLOYMENT_OSS
    """One of: 'oss', 'managed', 'on_prem'."""

    # ── Mandate cache ───────────────────────────────────────────────────────
    mandate_cache_ttl_seconds: int = 300
    """How long validated mandates are cached locally (0 = disable cache)."""

    revocation_sync_interval_seconds: int = 30
    """How often the local cache checks for revocations from the gateway."""

    # ── Provider registry ───────────────────────────────────────────────────
    use_provider_registry: bool = False
    """
    When True the gateway resolves target URLs from the provider registry;
    client-supplied target URLs are rejected (enterprise enforcement).
    """

    # ── Internal ────────────────────────────────────────────────────────────
    _source: str = field(default="defaults", repr=False, compare=False)

    @property
    def is_enterprise(self) -> bool:
        return self.deployment_type in (DEPLOYMENT_MANAGED, DEPLOYMENT_ON_PREM)

    @property
    def is_managed(self) -> bool:
        return self.deployment_type == DEPLOYMENT_MANAGED

    @property
    def is_on_prem(self) -> bool:
        return self.deployment_type == DEPLOYMENT_ON_PREM

    @property
    def broker_fallback_allowed(self) -> bool:
        """OSS broker path is permissible when gateway is disabled or not enterprise."""
        return not self.gateway_enabled or not self.is_enterprise


def load_gateway_features() -> GatewayFeatureFlags:
    """
    Load gateway feature flags from environment, then workspace config.

    Environment takes precedence over config file.
    """
    flags = GatewayFeatureFlags()

    try:
        from caracal.deployment.edition_adapter import get_deployment_edition_adapter

        edition_adapter = get_deployment_edition_adapter()
        gateway_url = str(edition_adapter.get_gateway_url() or "").strip()
        if gateway_url:
            flags.gateway_endpoint = gateway_url.rstrip("/")
            flags.gateway_enabled = True
            flags._source = "edition-adapter"

        if edition_adapter.uses_gateway_execution():
            flags.deployment_type = DEPLOYMENT_MANAGED
            flags.fail_closed = True
    except Exception as exc:
        logger.debug("Could not resolve gateway base settings from edition adapter: %s", exc)

    # --- Environment layer ---
    env_enabled = _bool_env(_ENV_GATEWAY_ENABLED)
    if env_enabled:
        flags.gateway_enabled = True
        flags._source = "environment"

    api_key = os.getenv(_ENV_GATEWAY_API_KEY)
    if api_key:
        flags.gateway_api_key = api_key

    if os.getenv(_ENV_GATEWAY_ENFORCE_NETWORK):
        flags.enforce_at_network = _bool_env(_ENV_GATEWAY_ENFORCE_NETWORK)

    if os.getenv(_ENV_GATEWAY_FAIL_CLOSED):
        flags.fail_closed = _bool_env(_ENV_GATEWAY_FAIL_CLOSED, default=True)

    if os.getenv(_ENV_GATEWAY_MANDATE_CACHE_TTL):
        flags.mandate_cache_ttl_seconds = _int_env(_ENV_GATEWAY_MANDATE_CACHE_TTL, 300)

    if os.getenv(_ENV_GATEWAY_REVOCATION_SYNC_INTERVAL):
        flags.revocation_sync_interval_seconds = _int_env(
            _ENV_GATEWAY_REVOCATION_SYNC_INTERVAL, 30
        )

    if os.getenv(_ENV_GATEWAY_USE_PROVIDER_REGISTRY):
        flags.use_provider_registry = _bool_env(_ENV_GATEWAY_USE_PROVIDER_REGISTRY)

    deploy_type = os.getenv(_ENV_GATEWAY_DEPLOYMENT_TYPE, "").lower()
    if deploy_type in (DEPLOYMENT_MANAGED, DEPLOYMENT_ON_PREM, DEPLOYMENT_OSS):
        flags.deployment_type = deploy_type

    # --- Workspace config layer (only if not already set from env) ---
    if not flags.gateway_enabled:
        _merge_workspace_config(flags)

    logger.debug(
        "Gateway feature flags loaded (source=%s enabled=%s deployment=%s)",
        flags._source,
        flags.gateway_enabled,
        flags.deployment_type,
    )
    return flags


def _merge_workspace_config(flags: GatewayFeatureFlags) -> None:
    """Read gateway section from workspace config and enterprise runtime metadata."""
    # --- enterprise runtime metadata (written by gateway sync flow) ---
    try:
        from caracal.deployment.edition_adapter import get_deployment_edition_adapter

        edition_adapter = get_deployment_edition_adapter()
        resolve_overrides = getattr(edition_adapter, "resolve_gateway_feature_overrides", None)
        gw = resolve_overrides() if callable(resolve_overrides) else {}

        if isinstance(gw, dict) and gw.get("enabled"):
            flags.gateway_enabled = True
            flags._source = "enterprise-runtime"

            if ep := gw.get("endpoint"):
                flags.gateway_endpoint = ep.rstrip("/")
            if key := gw.get("api_key"):
                flags.gateway_api_key = key
            if "fail_closed" in gw:
                flags.fail_closed = bool(gw["fail_closed"])
            if "use_provider_registry" in gw:
                flags.use_provider_registry = bool(gw["use_provider_registry"])
            if "mandate_cache_ttl_seconds" in gw:
                flags.mandate_cache_ttl_seconds = int(gw["mandate_cache_ttl_seconds"])
            if "revocation_sync_interval_seconds" in gw:
                flags.revocation_sync_interval_seconds = int(gw["revocation_sync_interval_seconds"])
            if dt := gw.get("deployment_type"):
                if dt in (DEPLOYMENT_MANAGED, DEPLOYMENT_ON_PREM, DEPLOYMENT_OSS):
                    flags.deployment_type = dt
    except Exception as exc:
        logger.debug("Could not read gateway section from enterprise runtime metadata: %s", exc)

    # --- config.yaml (lower priority than enterprise runtime metadata) ---
    if flags.gateway_enabled:
        return  # already loaded from enterprise runtime metadata
    try:
        from caracal.config import load_config
        config = load_config()
        gw = getattr(config, "gateway", None)
        if gw is None:
            return

        if getattr(gw, "enabled", False):
            flags.gateway_enabled = True
            flags._source = "config"

        if ep := getattr(gw, "endpoint", None):
            flags.gateway_endpoint = ep.rstrip("/")

        if key := getattr(gw, "api_key", None):
            flags.gateway_api_key = key

        if hasattr(gw, "enforce_at_network"):
            flags.enforce_at_network = bool(gw.enforce_at_network)

        if hasattr(gw, "fail_closed"):
            flags.fail_closed = bool(gw.fail_closed)

        if hasattr(gw, "mandate_cache_ttl_seconds"):
            flags.mandate_cache_ttl_seconds = int(gw.mandate_cache_ttl_seconds)

        if hasattr(gw, "revocation_sync_interval_seconds"):
            flags.revocation_sync_interval_seconds = int(
                gw.revocation_sync_interval_seconds
            )

        if hasattr(gw, "use_provider_registry"):
            flags.use_provider_registry = bool(gw.use_provider_registry)

        if dt := getattr(gw, "deployment_type", None):
            if dt in (DEPLOYMENT_MANAGED, DEPLOYMENT_ON_PREM, DEPLOYMENT_OSS):
                flags.deployment_type = dt

    except Exception as exc:
        logger.debug("Could not read gateway section from workspace config: %s", exc)


# Module-level singleton — refreshed per-process
_flags: Optional[GatewayFeatureFlags] = None


def get_gateway_features(reload: bool = False) -> GatewayFeatureFlags:
    """Return the cached gateway feature flags, loading them if necessary."""
    global _flags
    if _flags is None or reload:
        _flags = load_gateway_features()
    return _flags


def reset_gateway_features() -> None:
    """Reset cached flags (useful in tests)."""
    global _flags
    _flags = None
