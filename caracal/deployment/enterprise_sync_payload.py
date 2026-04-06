"""Explicit enterprise sync payload assembly outside deployment clients."""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from caracal.deployment.enterprise_runtime import _build_client_metadata

logger = logging.getLogger(__name__)


def _load_local_principals() -> List[Dict[str, Any]]:
    """Load principals from the local Caracal workspace (PostgreSQL or JSON)."""
    json_result: List[Dict[str, Any]] = []
    try:
        from caracal.flow.workspace import get_workspace

        ws = get_workspace()
        agents_path = ws.agents_path
        if agents_path.exists():
            data = json.loads(agents_path.read_text())
            if isinstance(data, list):
                json_result = data
            else:
                json_result = data.get("agents", data.get("principals", []))
    except Exception as exc:
        logger.debug("Could not load local principals from JSON: %s", exc)

    if json_result:
        return json_result

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
                valid_from = r[5]
                valid_until = r[6]
                validity_seconds = 3600
                try:
                    if valid_from and valid_until:
                        validity_seconds = int((valid_until - valid_from).total_seconds())
                        if validity_seconds < 0:
                            validity_seconds = 3600
                except Exception:
                    validity_seconds = 3600

                results.append(
                    {
                        "mandate_id": str(r[0]),
                        "issuer_id": str(r[1]),
                        "subject_id": str(r[2]),
                        "resource_scope": r[3] if r[3] else ["*"],
                        "action_scope": r[4] if r[4] else ["*"],
                        "validity_seconds": validity_seconds,
                        "intent": None,
                        "source_mandate_id": str(r[8]) if r[8] else None,
                        "revoked": bool(r[9]) if r[9] is not None else False,
                    }
                )

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
                results.append(
                    {
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
                    }
                )
            return results
    except Exception as exc:
        logger.debug("Could not load delegation edges from DB: %s", exc)

    return []


def build_enterprise_sync_payload(
    *,
    client_instance_id: Optional[str] = None,
    client_metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build the explicit payload sent to the enterprise sync upload endpoint."""
    payload_client_metadata = (
        dict(client_metadata)
        if isinstance(client_metadata, dict)
        else _build_client_metadata()
    )
    return {
        "client_instance_id": client_instance_id,
        "client_metadata": payload_client_metadata,
        "principals": _load_local_principals(),
        "policies": _load_local_policies(),
        "mandates": _load_local_mandates(),
        "ledger_entries": _load_local_ledger(),
        "delegation_edges": _load_local_delegation(),
    }
