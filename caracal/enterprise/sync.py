"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Enterprise Sync Client.

Pushes local Caracal Core data (principals, policies, mandates, ledger
entries) to the Caracal Enterprise dashboard.

Authentication is done via a sync API key that is generated during
license validation.  The key is stored in ``enterprise.json`` inside
the active workspace and used automatically for subsequent syncs.

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
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional

from caracal.enterprise.license import (
    _get_json,
    _post_json,
    load_enterprise_config,
    save_enterprise_config,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

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
                    text(f'SELECT principal_id, name, principal_type, metadata FROM "{schema}".principals')
                ).fetchall()
            mgr.close()
            return [
                {
                    "principal_id": str(r[0]),
                    "name": r[1],
                    "principal_type": r[2],
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
                        f'max_delegation_depth FROM "{schema}".authority_policies'
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
                    "max_delegation_depth": r[6] if r[6] is not None else 3,
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
                rows = session.execute(
                    text(
                        f'SELECT mandate_id, issuer_id, subject_id, resource_scope, '
                        f'action_scope, valid_until, intent FROM "{schema}".execution_mandates'
                    )
                ).fetchall()
            mgr.close()
            return [
                {
                    "mandate_id": str(r[0]),
                    "issuer_id": str(r[1]),
                    "subject_id": str(r[2]),
                    "resource_scope": r[3] if r[3] else ["*"],
                    "action_scope": r[4] if r[4] else ["*"],
                    "validity_seconds": 3600,  # default
                    "intent": r[6] if r[6] else None,
                }
                for r in rows
            ]
    except Exception as exc:
        logger.debug("Could not load mandates from DB: %s", exc)

    return []


def _load_local_ledger() -> List[Dict[str, Any]]:
    """Load ledger entries from the local workspace."""
    try:
        from caracal.flow.workspace import get_workspace
        ws = get_workspace()
        ledger_path = ws.ledger_path
        if ledger_path.exists():
            entries = []
            with open(ledger_path) as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            entries.append(json.loads(line))
                        except json.JSONDecodeError:
                            continue
            return entries
    except Exception as exc:
        logger.debug("Could not load ledger from file: %s", exc)

    return []


# ---------------------------------------------------------------------------
# Sync Client
# ---------------------------------------------------------------------------

class EnterpriseSyncClient:
    """Client for syncing local Caracal data to Enterprise dashboard.

    Uses the sync API key stored in ``enterprise.json`` (generated during
    license validation) for authentication.
    """

    def __init__(
        self,
        api_url: Optional[str] = None,
        sync_api_key: Optional[str] = None,
        license_key: Optional[str] = None,
    ):
        cfg = load_enterprise_config()
        self._api_url = (api_url or cfg.get("enterprise_api_url", "http://localhost:8000")).rstrip("/")
        self._sync_api_key = sync_api_key or cfg.get("sync_api_key")
        self._license_key = license_key or cfg.get("license_key")

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
                    "Run 'caracal-flow' → Enterprise → Connect License first."
                ),
            )

        # Load local data
        principals = _load_local_principals()
        policies = _load_local_policies()
        mandates = _load_local_mandates()
        ledger_entries = _load_local_ledger()

        if not any([principals, policies, mandates, ledger_entries]):
            return SyncResult(
                success=True,
                message="No local data to sync.",
                synced_counts={
                    "principals": 0,
                    "policies": 0,
                    "mandates": 0,
                    "ledger_entries": 0,
                },
            )

        payload: Dict[str, Any] = {
            "principals": principals,
            "policies": policies,
            "mandates": mandates,
            "ledger_entries": ledger_entries,
        }

        # Prefer API key auth; fall back to license key
        if self._sync_api_key:
            payload["sync_api_key"] = self._sync_api_key
        elif self._license_key:
            payload["license_key"] = self._license_key

        try:
            url = f"{self._api_url}/api/sync/upload"

            # Build the request manually so we can add the header
            data = json.dumps(payload).encode()
            req = urllib.request.Request(
                url,
                data=data,
                headers={
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            if self._sync_api_key:
                req.add_header("X-Sync-Api-Key", self._sync_api_key)

            with urllib.request.urlopen(req, timeout=30) as resp:
                result = json.loads(resp.read().decode())

            # Update last sync in local config
            cfg = load_enterprise_config()
            cfg["last_sync"] = {
                "timestamp": datetime.utcnow().isoformat(),
                "counts": result.get("synced_counts", {}),
            }
            save_enterprise_config(cfg)

            return SyncResult(
                success=result.get("success", True),
                message=result.get("message", "Sync completed."),
                synced_counts=result.get("synced_counts", {}),
                errors=result.get("errors", []),
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

    def get_sync_status(self) -> Dict[str, Any]:
        """Fetch the sync status from the Enterprise API."""
        if not self.is_configured:
            return {"error": "Enterprise sync not configured."}

        try:
            url = f"{self._api_url}/api/sync/status"
            headers: Dict[str, str] = {}
            
            if self._sync_api_key:
                headers["X-Sync-Api-Key"] = self._sync_api_key
                return _get_json(url, headers=headers)
            elif self._license_key:
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
        try:
            resp = _get_json(f"{self._api_url}/health")
            return resp.get("status") == "healthy"
        except Exception:
            return False
