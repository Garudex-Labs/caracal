"""Shared tool-registry contract helpers for CLI and TUI flows."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Any, Dict, Iterable, Optional

from caracal.core.authority import AuthorityEvaluator
from caracal.db.models import RegisteredTool
from caracal.exceptions import CaracalError
from caracal.mcp.adapter import MCPAdapter


class _NoopMeteringCollector:
    def collect_event(self, _event) -> None:
        return None


def _normalize_tool_ids(tool_ids: Iterable[str]) -> list[str]:
    normalized: list[str] = []
    for tool_id in tool_ids:
        value = str(tool_id or "").strip()
        if value and value not in normalized:
            normalized.append(value)
    if not normalized:
        raise CaracalError("At least one tool_id is required")
    return normalized


def resolve_issue_scopes_from_tool_ids(
    *,
    db_session,
    tool_ids: Iterable[str],
    providers: Optional[Iterable[str]] = None,
) -> Dict[str, Any]:
    """Resolve canonical provider/action/resource scopes from registered tool IDs."""
    normalized_tool_ids = _normalize_tool_ids(tool_ids)
    provider_filter = {
        str(provider).strip()
        for provider in (providers or [])
        if str(provider).strip()
    }

    adapter = MCPAdapter(
        authority_evaluator=AuthorityEvaluator(db_session),
        metering_collector=_NoopMeteringCollector(),
    )

    mappings: list[Dict[str, Any]] = []
    for tool_id in normalized_tool_ids:
        mapping = adapter._resolve_active_tool_mapping(
            tool_id=tool_id,
            mcp_context=None,
            require_credential=False,
        )
        provider_name = str(mapping["provider_name"])
        if provider_filter and provider_name not in provider_filter:
            allowed = ", ".join(sorted(provider_filter))
            raise CaracalError(
                f"Tool '{tool_id}' maps to provider '{provider_name}' which is outside selected provider filter: {allowed}"
            )
        mappings.append(mapping)

    return {
        "tool_ids": [mapping["tool_id"] for mapping in mappings],
        "providers": sorted({str(mapping["provider_name"]) for mapping in mappings}),
        "resource_scope": sorted({str(mapping["resource_scope"]) for mapping in mappings}),
        "action_scope": sorted({str(mapping["action_scope"]) for mapping in mappings}),
    }


def list_tool_bindings_by_provider(
    *,
    db_session,
    include_inactive: bool = False,
) -> Dict[str, list[str]]:
    """Return provider->tool_id bindings from persisted tool registry records."""
    query = db_session.query(RegisteredTool)
    if not include_inactive:
        query = query.filter_by(active=True)

    bindings: dict[str, list[str]] = defaultdict(list)
    for row in query.order_by(RegisteredTool.tool_id.asc()).all():
        provider_name = str(getattr(row, "provider_name", "") or "").strip()
        tool_id = str(getattr(row, "tool_id", "") or "").strip()
        if not provider_name or not tool_id:
            continue
        bindings[provider_name].append(tool_id)

    return dict(bindings)


def validate_active_tool_mappings(
    *,
    db_session,
    named_server_urls: Optional[Dict[str, str]] = None,
    has_default_forward_target: bool = False,
) -> list[Dict[str, str]]:
    """Validate active registered tools against provider/action/resource and forward routing targets."""
    adapter = MCPAdapter(
        authority_evaluator=AuthorityEvaluator(db_session),
        metering_collector=_NoopMeteringCollector(),
    )

    known_server_names = {
        str(name).strip()
        for name in (named_server_urls or {}).keys()
        if str(name).strip()
    }

    issues: list[Dict[str, str]] = []
    rows = db_session.query(RegisteredTool).filter_by(active=True).order_by(RegisteredTool.tool_id.asc()).all()
    for row in rows:
        tool_id = str(getattr(row, "tool_id", "") or "").strip()
        if not tool_id:
            issues.append(
                {
                    "tool_id": "<unknown>",
                    "check": "tool_id",
                    "message": "Active registered tool is missing tool_id",
                }
            )
            continue

        execution_mode = str(getattr(row, "execution_mode", "mcp_forward") or "mcp_forward").strip().lower()
        if execution_mode not in {"local", "mcp_forward"}:
            issues.append(
                {
                    "tool_id": tool_id,
                    "check": "execution_mode",
                    "message": (
                        f"Tool '{tool_id}' has invalid execution_mode '{execution_mode}' "
                        "(expected 'local' or 'mcp_forward')"
                    ),
                }
            )
            continue

        tool_type = str(getattr(row, "tool_type", "direct_api") or "direct_api").strip().lower()
        if tool_type not in {"direct_api", "logic"}:
            issues.append(
                {
                    "tool_id": tool_id,
                    "check": "tool_type",
                    "message": (
                        f"Tool '{tool_id}' has invalid tool_type '{tool_type}' "
                        "(expected 'direct_api' or 'logic')"
                    ),
                }
            )
            continue

        handler_ref = str(getattr(row, "handler_ref", "") or "").strip() or None
        if tool_type == "direct_api":
            if handler_ref:
                issues.append(
                    {
                        "tool_id": tool_id,
                        "check": "handler_ref",
                        "message": (
                            f"Tool '{tool_id}' is direct_api and cannot set handler_ref"
                        ),
                    }
                )
                continue
            if execution_mode != "mcp_forward":
                issues.append(
                    {
                        "tool_id": tool_id,
                        "check": "contract",
                        "message": (
                            f"Tool '{tool_id}' is direct_api and must use mcp_forward execution_mode"
                        ),
                    }
                )
                continue

        if tool_type == "logic" and execution_mode == "local" and not handler_ref:
            issues.append(
                {
                    "tool_id": tool_id,
                    "check": "handler_ref",
                    "message": (
                        f"Tool '{tool_id}' local logic execution requires handler_ref"
                    ),
                }
            )
            continue

        try:
            mapping = adapter._resolve_active_tool_mapping(
                tool_id=tool_id,
                mcp_context=None,
                require_credential=False,
            )
        except CaracalError as exc:
            issues.append(
                {
                    "tool_id": tool_id,
                    "check": "mapping",
                    "message": str(exc),
                }
            )
            continue

        if execution_mode != "mcp_forward":
            continue

        server_name = str(mapping.get("mcp_server_name") or "").strip()
        if server_name and server_name not in known_server_names:
            issues.append(
                {
                    "tool_id": tool_id,
                    "check": "forward_target",
                    "message": (
                        f"Tool '{tool_id}' targets unknown MCP server '{server_name}'"
                    ),
                }
            )
            continue

        if not server_name and not has_default_forward_target:
            issues.append(
                {
                    "tool_id": tool_id,
                    "check": "forward_target",
                    "message": (
                        f"Tool '{tool_id}' is forward-routed but no default MCP server URL is configured"
                    ),
                }
            )

    return issues


def deactivate_invalid_provider_tools(
    *,
    db_session,
    provider_name: str,
) -> list[Dict[str, str]]:
    """Deactivate active tools mapped to provider entries that became invalid after provider updates."""
    normalized_provider_name = str(provider_name or "").strip()
    if not normalized_provider_name:
        raise CaracalError("provider_name is required")

    adapter = MCPAdapter(
        authority_evaluator=AuthorityEvaluator(db_session),
        metering_collector=_NoopMeteringCollector(),
    )

    impacted: list[Dict[str, str]] = []
    rows = (
        db_session.query(RegisteredTool)
        .filter_by(provider_name=normalized_provider_name, active=True)
        .order_by(RegisteredTool.tool_id.asc())
        .all()
    )
    for row in rows:
        tool_id = str(getattr(row, "tool_id", "") or "").strip()
        resource_scope = str(getattr(row, "resource_scope", "") or "").strip()
        action_scope = str(getattr(row, "action_scope", "") or "").strip()
        provider_definition_id = str(getattr(row, "provider_definition_id", "") or "").strip() or None

        try:
            adapter._validate_tool_mapping(
                session=db_session,
                provider_name=normalized_provider_name,
                resource_scope=resource_scope,
                action_scope=action_scope,
                provider_definition_id=provider_definition_id,
                action_method=None,
                action_path_prefix=None,
                require_provider_enabled=True,
            )
        except CaracalError as exc:
            row.active = False
            row.updated_at = datetime.utcnow()
            impacted.append(
                {
                    "tool_id": tool_id or "<unknown>",
                    "reason": str(exc),
                }
            )

    if impacted:
        db_session.flush()

    return impacted
