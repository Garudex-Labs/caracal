"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Enterprise Sync Client.

Pushes local Caracal Core data (principals, policies, mandates, ledger
entries) to the Caracal Enterprise dashboard.

Authentication is done via a sync API key that is generated during
license validation.  The key is stored in enterprise runtime metadata
and used automatically for subsequent syncs.

Usage::

    from caracal.enterprise.sync import EnterpriseSyncClient

    client = EnterpriseSyncClient()        # uses stored config
    result = client.sync()                 # push all local data
    print(result)

    status = client.get_sync_status()      # check last sync
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional

from caracal.enterprise.license import (
    _build_client_metadata,
    _candidate_api_urls,
    _get_or_create_client_instance_id,
    _get_json,
    _post_json,
    _resolve_api_url,
    load_enterprise_config,
    save_enterprise_config,
)

logger = logging.getLogger(__name__)

_AIS_BASE_URL_ENV = "CARACAL_AIS_BASE_URL"
_AIS_API_PREFIX_ENV = "CARACAL_AIS_API_PREFIX"
_SESSION_KIND_ENV = "CARACAL_SESSION_KIND"


# ---------------------------------------------------------------------------
# Retry helper
# ---------------------------------------------------------------------------

def _get_json_with_retry(
    url: str,
    headers: Optional[Dict[str, str]] = None,
    max_attempts: int = 3,
    backoff_base: float = 1.5,
) -> Dict[str, Any]:
    """Call _get_json with exponential-backoff retry on transient failures.

    Retries on network errors and HTTP 5xx responses.  HTTPError with a
    4xx status is re-raised immediately (no retry — auth/config issue).
    """
    import time

    attempt = 0
    last_exc: Exception = RuntimeError("No attempts made")
    while attempt < max_attempts:
        try:
            return _get_json(url, headers=headers)
        except urllib.error.HTTPError as exc:
            if exc.code < 500:
                raise  # 4xx — auth/config problem, don't retry
            last_exc = exc
        except (urllib.error.URLError, OSError) as exc:
            last_exc = exc

        attempt += 1
        if attempt < max_attempts:
            wait = backoff_base ** attempt
            logger.debug(
                "Gateway sync attempt %d/%d failed (%s), retrying in %.1fs…",
                attempt,
                max_attempts,
                last_exc,
                wait,
            )
            time.sleep(wait)

    raise last_exc

@dataclass
class SyncResult:
    """Result of a sync operation."""

    success: bool
    message: str
    synced_counts: Dict[str, int] = field(default_factory=dict)
    errors: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "success": self.success,
            "message": self.message,
            "synced_counts": self.synced_counts,
            "errors": self.errors,
        }


# ---------------------------------------------------------------------------
# Local data loaders
# ---------------------------------------------------------------------------

def _load_local_principals() -> List[Dict[str, Any]]:
    """Load principals from the local Caracal workspace (PostgreSQL or JSON)."""
    # Try JSON first
    json_result: List[Dict[str, Any]] = []
    try:
        from caracal.flow.workspace import get_workspace
        ws = get_workspace()
        agents_path = ws.agents_path
        if agents_path.exists():
            data = json.loads(agents_path.read_text())
            # agents.json may be a list or {"agents": [...]}
            if isinstance(data, list):
                json_result = data
            else:
                json_result = data.get("agents", data.get("principals", []))
    except Exception as exc:
        logger.debug("Could not load local principals from JSON: %s", exc)

    if json_result:
        return json_result

    # Try PostgreSQL via Caracal's DB layer
    try:
        from caracal.db.connection import DatabaseConnectionManager, DatabaseConfig
        from caracal.flow.workspace import get_workspace
        from sqlalchemy import text
        import yaml

        ws = get_workspace()
        config_path = ws.config_path
        if config_path.exists():
            with open(config_path) as f:
                cfg = yaml.safe_load(f) or {}
            db_cfg = cfg.get("database", {})
            schema = db_cfg.get("schema", cfg.get("schema", f"ws_{ws.root.name}"))
            db_config = DatabaseConfig(
                host=db_cfg.get("host", "localhost"),
                port=int(db_cfg.get("port", 5432)),
                database=db_cfg.get("database", "caracal"),
                user=db_cfg.get("user", "caracal"),
                password=db_cfg.get("password", ""),
            )
            mgr = DatabaseConnectionManager(db_config)
            mgr.initialize()
            with mgr.session_scope() as session:
                rows = session.execute(
                    text(f'SELECT principal_id, name, principal_kind, metadata FROM "{schema}".principals')
                ).fetchall()
            mgr.close()
            return [
                {
                    "principal_id": str(r[0]),
                    "name": r[1],
                    "principal_kind": r[2],
                    "metadata": r[3] if r[3] else {},
                }
                for r in rows
            ]
    except Exception as exc:
        logger.debug("Could not load principals from DB: %s", exc)

    return []


def _load_local_policies() -> List[Dict[str, Any]]:
    """Load policies from the local workspace."""
    # Try JSON first
    json_result: List[Dict[str, Any]] = []
    try:
        from caracal.flow.workspace import get_workspace
        ws = get_workspace()
        policies_path = ws.policies_path
        if policies_path.exists():
            data = json.loads(policies_path.read_text())
            if isinstance(data, list):
                json_result = data
            else:
                json_result = data.get("policies", [])
    except Exception as exc:
        logger.debug("Could not load local policies from JSON: %s", exc)

    if json_result:
        return json_result

    # Try PostgreSQL
    try:
        from caracal.db.connection import DatabaseConnectionManager, DatabaseConfig
        from caracal.flow.workspace import get_workspace
        from sqlalchemy import text
        import yaml

        ws = get_workspace()
        config_path = ws.config_path
        if config_path.exists():
            with open(config_path) as f:
                cfg = yaml.safe_load(f) or {}
            db_cfg = cfg.get("database", {})
            schema = db_cfg.get("schema", cfg.get("schema", f"ws_{ws.root.name}"))
            db_config = DatabaseConfig(
                host=db_cfg.get("host", "localhost"),
                port=int(db_cfg.get("port", 5432)),
                database=db_cfg.get("database", "caracal"),
                user=db_cfg.get("user", "caracal"),
                password=db_cfg.get("password", ""),
            )
            mgr = DatabaseConnectionManager(db_config)
            mgr.initialize()
            with mgr.session_scope() as session:
                rows = session.execute(
                    text(
                        f'SELECT policy_id, principal_id, max_validity_seconds, '
                        f'allowed_resource_patterns, allowed_actions, allow_delegation, '
                        f'max_network_distance FROM "{schema}".authority_policies'
                    )
                ).fetchall()
            mgr.close()
            return [
                {
                    "policy_id": str(r[0]),
                    "principal_id": str(r[1]),
                    "max_validity_seconds": r[2],
                    "allowed_resource_patterns": r[3] if r[3] else ["*"],
                    "allowed_actions": r[4] if r[4] else ["*"],
                    "allow_delegation": r[5] if r[5] is not None else True,
                    "max_network_distance": r[6] if r[6] is not None else 3,
                }
                for r in rows
            ]
    except Exception as exc:
        logger.debug("Could not load policies from DB: %s", exc)

    return []


def _load_local_mandates() -> List[Dict[str, Any]]:
    """Load mandates from the local workspace."""
    try:
        from caracal.db.connection import DatabaseConnectionManager, DatabaseConfig
        from caracal.flow.workspace import get_workspace
        from sqlalchemy import text
        import yaml

        ws = get_workspace()
        config_path = ws.config_path
        if config_path.exists():
            with open(config_path) as f:
                cfg = yaml.safe_load(f) or {}
            db_cfg = cfg.get("database", {})
            schema = db_cfg.get("schema", cfg.get("schema", f"ws_{ws.root.name}"))
            db_config = DatabaseConfig(
                host=db_cfg.get("host", "localhost"),
                port=int(db_cfg.get("port", 5432)),
                database=db_cfg.get("database", "caracal"),
                user=db_cfg.get("user", "caracal"),
                password=db_cfg.get("password", ""),
            )
            mgr = DatabaseConnectionManager(db_config)
            mgr.initialize()
            with mgr.session_scope() as session:
                # Note: schema may not have an `intent` JSON column; newer schema
                # stores only an `intent_hash`. Select existing columns and
                # include `intent_hash` instead of `intent` to remain compatible
                # with both older and newer DB versions.
                rows = session.execute(
                    text(
                        f'SELECT em.mandate_id, em.issuer_id, em.subject_id, '
                        f'COALESCE((SELECT array_agg(mrs.resource_scope ORDER BY mrs.position) '
                        f'          FROM "{schema}".mandate_resource_scopes mrs '
                        f'          WHERE mrs.mandate_id = em.mandate_id), ARRAY[\'*\']) AS resource_scope, '
                        f'COALESCE((SELECT array_agg(mas.action_scope ORDER BY mas.position) '
                        f'          FROM "{schema}".mandate_action_scopes mas '
                        f'          WHERE mas.mandate_id = em.mandate_id), ARRAY[\'*\']) AS action_scope, '
                        f'em.valid_from, em.valid_until, em.intent_hash, em.source_mandate_id, em.revoked '
                        f'FROM "{schema}".execution_mandates em'
                    )
                ).fetchall()
            mgr.close()
            results = []
            for r in rows:
                # r indices based on SELECT above
                # 0: mandate_id, 1: issuer_id, 2: subject_id,
                # 3: resource_scope, 4: action_scope,
                # 5: valid_from, 6: valid_until, 7: intent_hash,
                # 8: source_mandate_id, 9: revoked
                valid_from = r[5]
                valid_until = r[6]
                # Compute validity_seconds if possible
                validity_seconds = 3600
                try:
                    if valid_from and valid_until:
                        validity_seconds = int((valid_until - valid_from).total_seconds())
                        if validity_seconds < 0:
                            validity_seconds = 3600
                except Exception:
                    validity_seconds = 3600

                results.append({
                    "mandate_id": str(r[0]),
                    "issuer_id": str(r[1]),
                    "subject_id": str(r[2]),
                    "resource_scope": r[3] if r[3] else ["*"],
                    "action_scope": r[4] if r[4] else ["*"],
                    "validity_seconds": validity_seconds,
                    # We don't have full intent payload in newer schemas; send None
                    "intent": None,
                    "source_mandate_id": str(r[8]) if r[8] else None,
                    "revoked": bool(r[9]) if r[9] is not None else False,
                })

            return results
    except Exception as exc:
        logger.debug("Could not load mandates from DB: %s", exc)

    return []


def _load_local_ledger() -> List[Dict[str, Any]]:
    """Load ledger entries from PostgreSQL."""
    try:
        from caracal.config import load_config
        from caracal.db.connection import get_db_manager
        from caracal.db.models import LedgerEvent

        db_manager = get_db_manager(load_config())
        try:
            with db_manager.session_scope() as session:
                rows = (
                    session.query(LedgerEvent)
                    .order_by(LedgerEvent.timestamp.asc(), LedgerEvent.event_id.asc())
                    .all()
                )
                entries: List[Dict[str, Any]] = []
                for row in rows:
                    entries.append(
                        {
                            "event_id": int(row.event_id),
                            "principal_id": str(row.principal_id),
                            "timestamp": row.timestamp.isoformat() if row.timestamp else None,
                            "resource_type": row.resource_type,
                            "quantity": float(row.quantity),
                            "metadata": row.event_metadata,
                        }
                    )
                return entries
        finally:
            db_manager.close()
    except Exception as exc:
        logger.debug("Could not load ledger from DB: %s", exc)

    return []


def _load_local_delegation() -> List[Dict[str, Any]]:
    """Load delegation edges from the local workspace."""
    try:
        from caracal.db.connection import DatabaseConnectionManager, DatabaseConfig
        from caracal.flow.workspace import get_workspace
        from sqlalchemy import text
        import yaml

        ws = get_workspace()
        config_path = ws.config_path
        if config_path.exists():
            with open(config_path) as f:
                cfg = yaml.safe_load(f) or {}
            db_cfg = cfg.get("database", {})
            schema = db_cfg.get("schema", cfg.get("schema", f"ws_{ws.root.name}"))
            db_config = DatabaseConfig(
                host=db_cfg.get("host", "localhost"),
                port=int(db_cfg.get("port", 5432)),
                database=db_cfg.get("database", "caracal"),
                user=db_cfg.get("user", "caracal"),
                password=db_cfg.get("password", ""),
            )
            mgr = DatabaseConnectionManager(db_config)
            mgr.initialize()
            with mgr.session_scope() as session:
                rows = session.execute(
                    text(
                        f'SELECT de.edge_id, de.source_mandate_id, de.target_mandate_id, '
                        f'de.source_principal_type, de.target_principal_type, '
                        f'de.delegation_type, '
                        f'COALESCE((SELECT array_agg(det.context_tag ORDER BY det.position) '
                        f'          FROM "{schema}".delegation_edge_tags det '
                        f'          WHERE det.edge_id = de.edge_id), ARRAY[]::text[]) AS context_tags, '
                        f'de.granted_at, de.expires_at, de.revoked, de.metadata '
                        f'FROM "{schema}".delegation_edges de WHERE de.revoked = false'
                    )
                ).fetchall()
            mgr.close()
            results = []
            for r in rows:
                granted_at = r[7]
                expires_at = r[8]
                results.append({
                    "edge_id": str(r[0]),
                    "source_mandate_id": str(r[1]),
                    "target_mandate_id": str(r[2]),
                    "source_principal_type": r[3] or "worker",
                    "target_principal_type": r[4] or "worker",
                    "delegation_type": r[5] or "hierarchical",
                    "context_tags": r[6],
                    "granted_at": granted_at.isoformat() if granted_at else None,
                    "expires_at": expires_at.isoformat() if expires_at else None,
                    "revoked": bool(r[9]) if r[9] is not None else False,
                    "edge_metadata": r[10],
                })
            return results
    except Exception as exc:
        logger.debug("Could not load delegation edges from DB: %s", exc)

    return []


# ---------------------------------------------------------------------------
# Sync Client
# ---------------------------------------------------------------------------

class EnterpriseSyncClient:
    """Client for syncing local Caracal data to Enterprise dashboard.

    Uses the sync API key stored in enterprise runtime metadata (generated
    during license validation) for authentication.

    In addition to pushing local data *up*, the client also pulls the
    gateway configuration *down* from the Enterprise API so that the
    local SDK/CLI can auto-configure the gateway connection without
    manual endpoint/key entry.
    """

    def __init__(
        self,
        api_url: Optional[str] = None,
        sync_api_key: Optional[str] = None,
        license_key: Optional[str] = None,
    ):
        cfg = load_enterprise_config()
        self._api_url = _resolve_api_url(api_url)
        self._sync_api_key = sync_api_key or cfg.get("sync_api_key")
        self._license_key = license_key or cfg.get("license_key")
        self._client_instance_id = cfg.get("client_instance_id") or _get_or_create_client_instance_id()
        self._runtime_session_kind = (os.environ.get(_SESSION_KIND_ENV) or "human").strip().lower() or "human"
        self._ais_base_url = (os.environ.get(_AIS_BASE_URL_ENV) or "").strip().rstrip("/")
        ais_prefix = (os.environ.get(_AIS_API_PREFIX_ENV) or "/v1/ais").strip() or "/v1/ais"
        self._ais_token_path = f"{ais_prefix.rstrip('/')}/token"

    def _build_ais_token_payload(self) -> Optional[Dict[str, Any]]:
        principal_id = (
            os.environ.get("CARACAL_AIS_PRINCIPAL_ID")
            or os.environ.get("CARACAL_PRINCIPAL_ID")
            or ""
        ).strip()
        organization_id = (
            os.environ.get("CARACAL_AIS_ORGANIZATION_ID")
            or os.environ.get("CARACAL_ORGANIZATION_ID")
            or ""
        ).strip()
        tenant_id = (
            os.environ.get("CARACAL_AIS_TENANT_ID")
            or os.environ.get("CARACAL_TENANT_ID")
            or ""
        ).strip()

        if not principal_id or not organization_id or not tenant_id:
            return None

        payload: Dict[str, Any] = {
            "principal_id": principal_id,
            "organization_id": organization_id,
            "tenant_id": tenant_id,
            "session_kind": self._runtime_session_kind or "automation",
            "include_refresh": True,
        }

        workspace_id = (os.environ.get("CARACAL_WORKSPACE_ID") or "").strip()
        if workspace_id:
            payload["workspace_id"] = workspace_id

        directory_scope = (os.environ.get("CARACAL_DIRECTORY_SCOPE") or "").strip()
        if directory_scope:
            payload["directory_scope"] = directory_scope

        return payload

    def _request_ais_access_token(self) -> Optional[str]:
        if not self._ais_base_url:
            return None

        payload = self._build_ais_token_payload()
        if payload is None:
            if self._runtime_session_kind == "human":
                return None
            raise RuntimeError(
                "AIS token sourcing requires principal, organization, and tenant identifiers"
            )

        try:
            response = _post_json(
                f"{self._ais_base_url}{self._ais_token_path}",
                payload,
                timeout=10,
            )
        except Exception as exc:
            if self._runtime_session_kind == "human":
                logger.warning("AIS token request failed; falling back to local auth: %s", exc)
                return None
            raise RuntimeError(f"AIS token request failed: {exc}") from exc

        access_token = str(response.get("access_token") or "").strip()
        if access_token:
            return access_token

        if self._runtime_session_kind == "human":
            return None

        raise RuntimeError("AIS token response did not include access_token")

    def _resolve_enterprise_auth_headers(self) -> Dict[str, str]:
        headers: Dict[str, str] = {
            "X-Caracal-Client-Id": self._client_instance_id,
        }

        ais_access_token = self._request_ais_access_token()
        if ais_access_token:
            headers["Authorization"] = f"Bearer {ais_access_token}"
            return headers

        if self._runtime_session_kind != "human":
            raise RuntimeError(
                "AIS token endpoint is required for non-human enterprise sync sessions"
            )

        if self._sync_api_key:
            headers["X-Sync-Api-Key"] = self._sync_api_key

        return headers

    @property
    def is_configured(self) -> bool:
        """True if we have enough config to attempt a sync."""
        return bool(self._sync_api_key or self._license_key)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def sync(self) -> SyncResult:
        """Push all local data to Enterprise.

        Returns a ``SyncResult`` with counts and any errors.
        """
        if not self.is_configured:
            return SyncResult(
                success=False,
                message=(
                    "Enterprise sync not configured. "
                    "Run 'caracal flow' → Enterprise → Connect License first."
                ),
            )

        if not self._api_url:
            return SyncResult(
                success=False,
                message=(
                    "Enterprise sync URL is not configured. "
                    "Set CARACAL_ENTERPRISE_URL (or CARACAL_ENTERPRISE_DEV_URL in dev mode)."
                ),
            )

        # Load local data
        principals = _load_local_principals()
        policies = _load_local_policies()
        mandates = _load_local_mandates()
        ledger_entries = _load_local_ledger()
        delegation_edges = _load_local_delegation()

        if not any([principals, policies, mandates, ledger_entries, delegation_edges]):
            return SyncResult(
                success=True,
                message="No local data to sync.",
                synced_counts={
                    "principals": 0,
                    "policies": 0,
                    "mandates": 0,
                    "ledger_entries": 0,
                    "delegation_edges": 0,
                },
            )

        payload: Dict[str, Any] = {
            "client_instance_id": self._client_instance_id,
            "client_metadata": _build_client_metadata(),
            "principals": principals,
            "policies": policies,
            "mandates": mandates,
            "ledger_entries": ledger_entries,
            "delegation_edges": delegation_edges,
        }

        # Human sessions can still use persisted local credentials as fallback.
        if self._runtime_session_kind == "human" and self._sync_api_key:
            payload["sync_api_key"] = self._sync_api_key
        elif self._runtime_session_kind == "human" and self._license_key:
            payload["license_key"] = self._license_key

        try:
            data = json.dumps(payload).encode()
            result: Optional[Dict[str, Any]] = None
            resolved_api_url = self._api_url
            last_url_error: Optional[urllib.error.URLError] = None

            for candidate_api_url in _candidate_api_urls(self._api_url):
                url = f"{candidate_api_url}/api/sync/upload"

                # Build the request manually so we can add the sync header.
                headers = self._resolve_enterprise_auth_headers()
                req = urllib.request.Request(
                    url,
                    data=data,
                    headers={"Content-Type": "application/json", **headers},
                    method="POST",
                )

                try:
                    with urllib.request.urlopen(req, timeout=30) as resp:
                        result = json.loads(resp.read().decode())
                    resolved_api_url = candidate_api_url
                    break
                except urllib.error.URLError as exc:
                    last_url_error = exc

            if result is None:
                reason = last_url_error.reason if last_url_error else "unknown"
                return SyncResult(
                    success=False,
                    message=f"Cannot reach Enterprise API at {self._api_url}: {reason}",
                )

            if resolved_api_url != self._api_url:
                logger.info(
                    "Enterprise sync resolved via alternate loopback URL: %s",
                    resolved_api_url,
                )
                self._api_url = resolved_api_url

            # Update last sync in local config
            cfg = load_enterprise_config()
            cfg["enterprise_api_url"] = resolved_api_url
            cfg["last_sync"] = {
                "timestamp": datetime.utcnow().isoformat(),
                "counts": result.get("synced_counts", {}),
            }
            save_enterprise_config(cfg)

            # Pull gateway configuration from Enterprise (auto-setup)
            gw_result = self.pull_gateway_config()
            errors = result.get("errors", [])
            if not gw_result.get("success"):
                errors.append(f"Gateway config pull: {gw_result.get('message', 'unknown')}")

            return SyncResult(
                success=result.get("success", True),
                message=result.get("message", "Sync completed."),
                synced_counts=result.get("synced_counts", {}),
                errors=errors,
            )

        except urllib.error.HTTPError as exc:
            body = exc.read().decode() if exc.fp else ""
            try:
                err = json.loads(body)
                detail = err.get("detail", {})
                if isinstance(detail, dict):
                    msg = detail.get("message", str(detail))
                else:
                    msg = str(detail)
            except json.JSONDecodeError:
                msg = body[:500]
            return SyncResult(success=False, message=f"Sync failed: {msg}")

        except urllib.error.URLError as exc:
            return SyncResult(
                success=False,
                message=f"Cannot reach Enterprise API at {self._api_url}: {exc.reason}",
            )

        except Exception as exc:
            return SyncResult(success=False, message=f"Unexpected sync error: {exc}")

    def pull_gateway_config(self) -> Dict[str, Any]:
        """Pull gateway configuration from the Enterprise API.

        Called automatically during ``sync()`` and available standalone so
        the gateway flow can refresh the local config without a full data
        push.  The Enterprise API's ``/api/gateway/sync-config`` endpoint
        returns the provisioned gateway endpoint, API key, deployment type,
        and enforcement settings for the authenticated organization.

        On success the gateway section of enterprise runtime metadata is updated
        and the gateway feature flags are reloaded.

        Returns:
            Dict with keys ``success``, ``message``, and the full gateway
            config when successful.
        """
        if not self.is_configured:
            return {"success": False, "message": "Enterprise sync not configured."}

        try:
            headers = self._resolve_enterprise_auth_headers()

            result: Optional[Dict[str, Any]] = None
            resolved_api_url = self._api_url
            last_exc: Optional[Exception] = None

            for candidate_api_url in _candidate_api_urls(self._api_url):
                url = f"{candidate_api_url}/api/gateway/sync-config"
                try:
                    result = _get_json_with_retry(url, headers=headers)
                    resolved_api_url = candidate_api_url
                    break
                except Exception as exc:  # pragma: no cover - defensive aggregation
                    last_exc = exc

            if result is None:
                if last_exc:
                    raise last_exc
                raise ConnectionError(
                    f"Cannot reach Enterprise API at {self._api_url}/api/gateway/sync-config"
                )

            if resolved_api_url != self._api_url:
                logger.info(
                    "Gateway sync resolved via alternate loopback URL: %s",
                    resolved_api_url,
                )
                self._api_url = resolved_api_url

            if not result.get("gateway_configured"):
                return {
                    "success": True,
                    "gateway_configured": False,
                    "message": result.get("message", "No gateway provisioned."),
                }

            # Persist to enterprise runtime metadata gateway section
            cfg = load_enterprise_config()
            cfg["gateway"] = {
                "enabled": True,
                "deployment_type": result.get("deployment_type", "managed"),
                "endpoint": result.get("gateway_endpoint", ""),
                "api_key": result.get("gateway_api_key", ""),
                "fail_closed": result.get("fail_closed", True),
                "use_provider_registry": result.get("use_provider_registry", True),
            }
            cfg["enterprise_api_url"] = resolved_api_url
            cfg["tier"] = result.get("tier", cfg.get("tier", "starter"))
            save_enterprise_config(cfg)

            # Reload gateway feature flags so the SDK picks up the new config
            try:
                from caracal.core.gateway_features import reset_gateway_features
                reset_gateway_features()
            except ImportError:
                pass

            logger.info(
                "Gateway config synced from Enterprise: %s endpoint=%s",
                result.get("deployment_type"),
                result.get("gateway_endpoint"),
            )

            return {
                "success": True,
                "gateway_configured": True,
                "message": "Gateway configuration synced from Enterprise.",
                **result,
            }

        except Exception as exc:
            logger.warning("Failed to pull gateway config: %s", exc)
            return {
                "success": False,
                "message": f"Failed to pull gateway config: {exc}",
            }

    def get_sync_status(self) -> Dict[str, Any]:
        """Fetch the sync status from the Enterprise API."""
        if not self.is_configured:
            return {"error": "Enterprise sync not configured."}

        try:
            url = f"{self._api_url}/api/sync/status"
            headers = self._resolve_enterprise_auth_headers()

            if "Authorization" in headers or "X-Sync-Api-Key" in headers:
                return _get_json(url, headers=headers)
            elif self._runtime_session_kind == "human" and self._license_key:
                url += f"?license_key={self._license_key}"
                return _get_json(url)
            else:
                return {"error": "No API key or license key available."}

        except Exception as exc:
            # Fall back to local cache
            cfg = load_enterprise_config()
            last_sync = cfg.get("last_sync")
            if last_sync:
                return {
                    "success": True,
                    "source": "cache",
                    "last_sync": last_sync,
                }
            return {"error": f"Cannot fetch sync status: {exc}"}

    def test_connection(self) -> bool:
        """Quick connectivity check to the Enterprise API."""
        for candidate_api_url in _candidate_api_urls(self._api_url):
            for probe_path in ("/health", "/api/health"):
                url = f"{candidate_api_url}{probe_path}"
                req = urllib.request.Request(
                    url,
                    headers=self._resolve_enterprise_auth_headers(),
                    method="GET",
                )

                try:
                    # Any HTTP response means the API is network-reachable.
                    with urllib.request.urlopen(req, timeout=5):
                        pass
                    if candidate_api_url != self._api_url:
                        self._api_url = candidate_api_url
                        cfg = load_enterprise_config()
                        cfg["enterprise_api_url"] = candidate_api_url
                        save_enterprise_config(cfg)
                    return True
                except urllib.error.HTTPError:
                    if candidate_api_url != self._api_url:
                        self._api_url = candidate_api_url
                        cfg = load_enterprise_config()
                        cfg["enterprise_api_url"] = candidate_api_url
                        save_enterprise_config(cfg)
                    return True
                except Exception:
                    continue

        return False
