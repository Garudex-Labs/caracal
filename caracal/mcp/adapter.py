"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

MCP Adapter for Caracal Core.

This module provides the MCPAdapter service that intercepts MCP tool calls
and resource reads, enforces authority policies, and emits metering events.
"""

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from contextvars import ContextVar
import importlib
import os
from typing import Any, Dict, Optional

import httpx
from sqlalchemy.exc import IntegrityError
from uuid import UUID

from caracal.core.metering import MeteringEvent, MeteringCollector
from caracal.core.authority import AuthorityEvaluator
from caracal.db.models import AuthorityLedgerEvent, GatewayProvider, RegisteredTool
from caracal.deployment.exceptions import SecretNotFoundError
from caracal.core.error_handling import (
    get_error_handler,
    handle_error_with_denial,
    ErrorCategory,
    ErrorSeverity
)
from caracal.exceptions import (
    CaracalError,
    MCPProviderMissingError,
    MCPToolBindingError,
    MCPToolMappingMismatchError,
    MCPToolTypeMismatchError,
    MCPUnknownToolError,
)
from caracal.logging_config import get_logger
from caracal.provider.credential_store import resolve_workspace_provider_credential
from caracal.provider.definitions import (
    ScopeParseError,
    parse_provider_scope,
    provider_definition_from_mapping,
)

logger = get_logger(__name__)


@dataclass
class MCPContext:
    """
    Context information for an MCP request.
    
    Attributes:
        principal_id: ID of the principal making the request
        metadata: Additional metadata from the MCP request
    """
    principal_id: str
    metadata: Dict[str, Any]
    
    def get(self, key: str, default: Any = None) -> Any:
        """Get a value from metadata."""
        return self.metadata.get(key, default)


@dataclass
class MCPResource:
    """
    Represents an MCP resource.
    
    Attributes:
        uri: Resource URI
        content: Resource content
        mime_type: MIME type of the resource
        size: Size in bytes
    """
    uri: str
    content: Any
    mime_type: str
    size: int


@dataclass
class MCPResult:
    """
    Result of an MCP operation.
    
    Attributes:
        success: Whether the operation succeeded
        result: The operation result (tool output, resource content, etc.)
        error: Error message if operation failed
        metadata: Additional metadata about the operation
    """
    success: bool
    result: Any
    error: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class MCPAdapter:
    """
    Adapter for integrating Caracal authority enforcement with MCP protocol.
    
    This adapter intercepts MCP tool calls and resource reads, performs
    mandate validations, forwards requests to MCP servers, and emits metering events.
    
    """

    def __init__(
        self,
        authority_evaluator: AuthorityEvaluator,
        metering_collector: MeteringCollector,
        mcp_server_url: Optional[str] = None,
        mcp_server_urls: Optional[Dict[str, str]] = None,
        request_timeout_seconds: int = 30,
        caveat_mode: Optional[str] = None,
        caveat_hmac_key: Optional[str] = None,
    ):
        """
        Initialize MCPAdapter.
        
        Args:
            authority_evaluator: AuthorityEvaluator for mandate checks
            metering_collector: MeteringCollector for emitting events
            mcp_server_url: Base URL of the upstream MCP server (e.g. "http://localhost:3001")
            request_timeout_seconds: Timeout for upstream HTTP requests (default: 30)
        """
        self.authority_evaluator = authority_evaluator
        self.metering_collector = metering_collector
        self.mcp_server_url = mcp_server_url.rstrip("/") if mcp_server_url else None
        self._mcp_server_urls: Dict[str, str] = {
            str(name): str(url).rstrip("/")
            for name, url in (mcp_server_urls or {}).items()
            if str(name).strip() and str(url).strip()
        }
        self.request_timeout_seconds = request_timeout_seconds
        self._caveat_mode = self._resolve_caveat_mode(
            caveat_mode or os.environ.get("CARACAL_SESSION_CAVEAT_MODE") or "jwt"
        )
        self._caveat_hmac_key = str(
            caveat_hmac_key
            or os.environ.get("CARACAL_SESSION_CAVEAT_HMAC_KEY")
            or ""
        ).strip()
        self._decorator_bindings: dict[str, Any] = {}
        self._decorator_bindings_by_contract: dict[tuple[str, str, str, str, str], Any] = {}
        self._tool_binding_contract_keys: dict[str, tuple[str, str, str, str, str]] = {}
        self._handler_ref_bindings: dict[str, Any] = {}
        self._active_logic_execution: ContextVar[Optional[Dict[str, Any]]] = ContextVar(
            "caracal_active_logic_execution",
            default=None,
        )
        self._http_client: Optional[httpx.AsyncClient] = None
        logger.info(
            "MCPAdapter initialized "
            f"(upstream={'configured: ' + self.mcp_server_url if self.mcp_server_url else 'none'}, "
            f"caveat_mode={self._caveat_mode})"
        )

    def _normalize_tool_id(self, tool_id: str) -> str:
        normalized = str(tool_id or "").strip()
        if not normalized:
            raise CaracalError("tool_id is required")
        return normalized

    def _normalize_execution_target(
        self,
        *,
        execution_mode: Optional[str],
        mcp_server_name: Optional[str],
    ) -> Dict[str, Optional[str]]:
        mode = str(execution_mode or "mcp_forward").strip().lower()
        if mode not in {"local", "mcp_forward"}:
            raise CaracalError("execution_mode must be 'local' or 'mcp_forward'")

        server_name = str(mcp_server_name or "").strip() or None
        if mode == "local":
            server_name = None
        elif server_name and server_name not in self._mcp_server_urls:
            raise CaracalError(
                f"Unknown mcp_server_name '{server_name}' for forward execution"
            )

        return {
            "execution_mode": mode,
            "mcp_server_name": server_name,
        }

    @staticmethod
    def _normalize_workspace_name(workspace_name: Optional[str]) -> Optional[str]:
        normalized = str(workspace_name or "").strip()
        return normalized or None

    @staticmethod
    def _normalize_tool_type(tool_type: Optional[str]) -> str:
        normalized = str(tool_type or "direct_api").strip().lower()
        if normalized not in {"direct_api", "logic"}:
            raise MCPToolTypeMismatchError(
                "tool_type must be 'direct_api' or 'logic'"
            )
        return normalized

    @staticmethod
    def _normalize_handler_ref(handler_ref: Optional[str]) -> Optional[str]:
        normalized = str(handler_ref or "").strip()
        return normalized or None

    @staticmethod
    def _normalize_allowed_downstream_scopes(
        allowed_downstream_scopes: Optional[list[str]],
    ) -> list[str]:
        normalized: list[str] = []
        for scope in allowed_downstream_scopes or []:
            value = str(scope or "").strip()
            if not value or value in normalized:
                continue
            normalized.append(value)
        return normalized

    @staticmethod
    def _validate_tool_binding_contract(
        *,
        tool_id: str,
        execution_mode: str,
        tool_type: str,
        handler_ref: Optional[str],
    ) -> None:
        if tool_type == "direct_api":
            if handler_ref:
                raise MCPToolTypeMismatchError(
                    f"Tool '{tool_id}' is direct_api and cannot set handler_ref"
                )
            if execution_mode != "mcp_forward":
                raise MCPToolTypeMismatchError(
                    f"Tool '{tool_id}' is direct_api and must use mcp_forward execution_mode"
                )
            return

        if execution_mode == "local" and not handler_ref:
            raise MCPToolBindingError(
                f"Tool '{tool_id}' local logic execution requires handler_ref"
            )

    def _get_registry_session(self):
        session = getattr(self.authority_evaluator, "db_session", None)
        if session is None:
            raise CaracalError("MCP adapter requires an authority evaluator DB session")
        return session

    def _record_tool_transition_event(
        self,
        *,
        session,
        actor_principal_id: str,
        tool_id: str,
        transition: str,
        active: bool,
    ) -> None:
        try:
            actor_uuid = UUID(str(actor_principal_id))
        except ValueError as exc:
            raise CaracalError("actor_principal_id must be a valid UUID") from exc

        session.add(
            AuthorityLedgerEvent(
                event_type=transition,
                timestamp=datetime.utcnow(),
                principal_id=actor_uuid,
                mandate_id=None,
                decision="allowed",
                denial_reason=None,
                requested_action=f"tool_registry:{transition}",
                requested_resource=f"mcp:tool:{tool_id}",
                event_metadata={
                    "tool_id": tool_id,
                    "active": bool(active),
                    "transition": transition,
                },
            )
        )

    @staticmethod
    def _extract_integrity_error_details(exc: IntegrityError) -> tuple[Optional[str], Optional[str], str]:
        """Extract SQLSTATE, constraint name, and normalized message from IntegrityError."""
        original = getattr(exc, "orig", None)
        sqlstate = str(
            getattr(original, "pgcode", None)
            or getattr(original, "sqlstate", None)
            or ""
        ).strip() or None
        diag = getattr(original, "diag", None)
        constraint = str(getattr(diag, "constraint_name", "") or "").strip() or None
        message = str(original or exc)
        return sqlstate, constraint, message

    @staticmethod
    def _is_tool_id_uniqueness_violation(
        *,
        sqlstate: Optional[str],
        constraint: Optional[str],
        message: str,
    ) -> bool:
        if sqlstate != "23505":
            return False

        normalized_constraint = str(constraint or "").strip().lower()
        if normalized_constraint in {
            "uq_registered_tools_active_workspace_tool_id",
            "uq_registered_tools_tool_id",
        }:
            return True

        normalized_message = str(message or "").lower()
        if "uq_registered_tools_active_workspace_tool_id" in normalized_message:
            return True
        if "uq_registered_tools_tool_id" in normalized_message:
            return True
        if "duplicate key value" in normalized_message and "(workspace_name, tool_id)" in normalized_message:
            return True
        return False

    @staticmethod
    def _is_binding_uniqueness_violation(
        *,
        sqlstate: Optional[str],
        constraint: Optional[str],
        message: str,
    ) -> bool:
        if sqlstate != "23505":
            return False

        normalized_constraint = str(constraint or "").strip().lower()
        if normalized_constraint == "uq_registered_tools_active_workspace_binding":
            return True

        normalized_message = str(message or "").lower()
        if "uq_registered_tools_active_workspace_binding" in normalized_message:
            return True
        if (
            "duplicate key value" in normalized_message
            and "(workspace_name, provider_name, resource_scope, action_scope, tool_type)" in normalized_message
        ):
            return True
        return False

    def _raise_register_tool_integrity_error(
        self,
        *,
        exc: IntegrityError,
        tool_id: str,
        workspace_name: str,
        actor_principal_id: str,
    ) -> None:
        sqlstate, constraint, message = self._extract_integrity_error_details(exc)
        normalized_message = message.lower()
        normalized_constraint = str(constraint or "").strip().lower()

        if self._is_tool_id_uniqueness_violation(
            sqlstate=sqlstate,
            constraint=constraint,
            message=message,
        ):
            raise CaracalError(f"Tool already registered: {tool_id}") from exc

        if self._is_binding_uniqueness_violation(
            sqlstate=sqlstate,
            constraint=constraint,
            message=message,
        ):
            raise CaracalError(
                "Active tool binding already exists for workspace "
                f"'{workspace_name}' (provider/resource/action/tool_type)"
            ) from exc

        if sqlstate == "23503":
            if (
                normalized_constraint == "authority_ledger_events_principal_id_fkey"
                or (
                    "authority_ledger_events" in normalized_message
                    and "principal" in normalized_message
                    and "foreign key" in normalized_message
                )
            ):
                raise CaracalError(
                    "Invalid actor_principal_id for tool registry transition: "
                    f"{actor_principal_id}"
                ) from exc
            raise CaracalError(
                "Tool registration failed due foreign key constraint violation"
            ) from exc

        if sqlstate:
            raise CaracalError(
                "Tool registration failed due integrity constraint violation "
                f"(sqlstate={sqlstate}, constraint={constraint or 'unknown'})"
            ) from exc

        raise CaracalError(
            "Tool registration failed due integrity constraint violation"
        ) from exc

    @staticmethod
    def _callable_handler_ref(func: Any) -> str:
        module_name = str(getattr(func, "__module__", "") or "").strip()
        function_name = str(getattr(func, "__name__", "") or "").strip()
        if not module_name or not function_name:
            return ""
        return f"{module_name}:{function_name}"

    @staticmethod
    def _binding_contract_key(
        *,
        workspace_name: Optional[str],
        provider_name: Optional[str],
        resource_scope: Optional[str],
        action_scope: Optional[str],
        tool_type: Optional[str],
    ) -> Optional[tuple[str, str, str, str, str]]:
        normalized_provider = str(provider_name or "").strip()
        normalized_resource_scope = str(resource_scope or "").strip()
        normalized_action_scope = str(action_scope or "").strip()
        if not normalized_provider or not normalized_resource_scope or not normalized_action_scope:
            return None

        normalized_workspace = str(workspace_name or "").strip() or "default"
        normalized_tool_type = str(tool_type or "direct_api").strip().lower() or "direct_api"
        return (
            normalized_workspace,
            normalized_provider,
            normalized_resource_scope,
            normalized_action_scope,
            normalized_tool_type,
        )

    def _clear_local_binding_cache(self, tool_id: str) -> None:
        normalized_tool_id = self._normalize_tool_id(tool_id)
        self._decorator_bindings.pop(normalized_tool_id, None)
        contract_key = self._tool_binding_contract_keys.pop(normalized_tool_id, None)
        if contract_key is not None:
            self._decorator_bindings_by_contract.pop(contract_key, None)

    def _resolve_callable_from_handler_ref(self, handler_ref: str) -> Any:
        normalized_handler_ref = self._normalize_handler_ref(handler_ref)
        if not normalized_handler_ref:
            raise CaracalError("handler_ref is required for local logic execution")

        cached = self._handler_ref_bindings.get(normalized_handler_ref)
        if cached is not None:
            return cached

        module_name, separator, function_name = normalized_handler_ref.partition(":")
        if not separator or not module_name.strip() or not function_name.strip():
            raise CaracalError(
                f"Invalid handler_ref '{normalized_handler_ref}'; expected format module:function"
            )

        try:
            module = importlib.import_module(module_name)
        except Exception as exc:
            raise CaracalError(
                f"Failed to import handler module '{module_name}' for handler_ref '{normalized_handler_ref}': {exc}"
            ) from exc

        try:
            handler = getattr(module, function_name)
        except AttributeError as exc:
            raise CaracalError(
                f"Handler function '{function_name}' not found in module '{module_name}'"
            ) from exc

        if not callable(handler):
            raise CaracalError(
                f"Handler '{normalized_handler_ref}' is not callable"
            )

        self._handler_ref_bindings[normalized_handler_ref] = handler
        return handler

    def _resolve_local_callable_binding(
        self,
        *,
        tool_id: str,
        handler_ref: Optional[str],
        workspace_name: Optional[str],
        provider_name: Optional[str],
        resource_scope: Optional[str],
        action_scope: Optional[str],
        tool_type: Optional[str],
    ) -> Any:
        contract_key = self._binding_contract_key(
            workspace_name=workspace_name,
            provider_name=provider_name,
            resource_scope=resource_scope,
            action_scope=action_scope,
            tool_type=tool_type,
        )

        bound_func = None
        if contract_key is not None:
            bound_func = self._decorator_bindings_by_contract.get(contract_key)
        if bound_func is None:
            bound_func = self._decorator_bindings.get(tool_id)

        expected_handler_ref = self._normalize_handler_ref(handler_ref)
        if bound_func is not None:
            runtime_handler_ref = self._callable_handler_ref(bound_func)
            if expected_handler_ref and runtime_handler_ref != expected_handler_ref:
                raise CaracalError(
                    f"Local handler mismatch for tool '{tool_id}': expected {expected_handler_ref}, got {runtime_handler_ref or '<unknown>'}"
                )
            return bound_func

        if expected_handler_ref:
            return self._resolve_callable_from_handler_ref(expected_handler_ref)

        raise CaracalError(
            f"No local function binding found for tool '{tool_id}'"
        )

    def _enforce_logic_downstream_scope(
        self,
        *,
        parent_context: Dict[str, Any],
        requested_mapping: Dict[str, Any],
    ) -> None:
        allowed_scopes = {
            str(scope).strip()
            for scope in (parent_context.get("allowed_downstream_scopes") or [])
            if str(scope).strip()
        }
        parent_tool_id = str(parent_context.get("tool_id") or "").strip() or "<logic-tool>"
        if not allowed_scopes:
            raise CaracalError(
                f"Logic tool '{parent_tool_id}' has no allowed_downstream_scopes; downstream provider/tool calls are denied"
            )

        requested_resource_scope = str(requested_mapping.get("resource_scope") or "").strip()
        requested_action_scope = str(requested_mapping.get("action_scope") or "").strip()
        if requested_resource_scope in allowed_scopes or requested_action_scope in allowed_scopes:
            return

        raise CaracalError(
            f"Downstream scope denied for logic tool '{parent_tool_id}': "
            f"resource_scope='{requested_resource_scope}', action_scope='{requested_action_scope}'"
        )

    def register_tool(
        self,
        *,
        tool_id: str,
        active: bool = True,
        actor_principal_id: str,
        provider_name: str,
        resource_scope: str,
        action_scope: str,
        provider_definition_id: Optional[str] = None,
        action_method: Optional[str] = None,
        action_path_prefix: Optional[str] = None,
        execution_mode: Optional[str] = "mcp_forward",
        mcp_server_name: Optional[str] = None,
        workspace_name: Optional[str] = None,
        tool_type: Optional[str] = "direct_api",
        handler_ref: Optional[str] = None,
        mapping_version: Optional[str] = None,
        allowed_downstream_scopes: Optional[list[str]] = None,
    ) -> RegisteredTool:
        """Create or update a persisted tool registration record."""
        normalized_tool_id = self._normalize_tool_id(tool_id)
        session = self._get_registry_session()
        mapping = self._validate_tool_mapping(
            session=session,
            provider_name=provider_name,
            resource_scope=resource_scope,
            action_scope=action_scope,
            provider_definition_id=provider_definition_id,
            action_method=action_method,
            action_path_prefix=action_path_prefix,
        )
        execution_target = self._normalize_execution_target(
            execution_mode=execution_mode,
            mcp_server_name=mcp_server_name,
        )
        normalized_workspace_name = (
            self._normalize_workspace_name(workspace_name)
            or self._normalize_workspace_name(self._resolve_workspace_name(None))
            or "default"
        )
        normalized_tool_type = self._normalize_tool_type(tool_type)
        normalized_handler_ref = self._normalize_handler_ref(handler_ref)
        normalized_mapping_version = str(mapping_version or "").strip() or None
        normalized_allowed_downstream_scopes = self._normalize_allowed_downstream_scopes(
            allowed_downstream_scopes
        )
        self._validate_tool_binding_contract(
            tool_id=normalized_tool_id,
            execution_mode=execution_target["execution_mode"] or "mcp_forward",
            tool_type=normalized_tool_type,
            handler_ref=normalized_handler_ref,
        )

        existing = self.get_registered_tool(
            tool_id=normalized_tool_id,
            workspace_name=normalized_workspace_name,
            require_active=False,
        )
        if existing:
            was_active = bool(existing.active)
            previous_handler_ref = self._normalize_handler_ref(getattr(existing, "handler_ref", None))
            previous_execution_mode = str(getattr(existing, "execution_mode", "") or "").strip().lower()
            previous_workspace_name = self._normalize_workspace_name(getattr(existing, "workspace_name", None)) or "default"
            previous_provider_name = str(getattr(existing, "provider_name", "") or "").strip()
            previous_resource_scope = str(getattr(existing, "resource_scope", "") or "").strip()
            previous_action_scope = str(getattr(existing, "action_scope", "") or "").strip()
            previous_tool_type = str(getattr(existing, "tool_type", "direct_api") or "direct_api").strip().lower()
            existing.active = bool(active)
            existing.provider_name = mapping["provider_name"]
            existing.resource_scope = mapping["resource_scope"]
            existing.action_scope = mapping["action_scope"]
            existing.provider_definition_id = mapping["provider_definition_id"]
            existing.execution_mode = execution_target["execution_mode"]
            existing.mcp_server_name = execution_target["mcp_server_name"]
            existing.workspace_name = normalized_workspace_name
            existing.tool_type = normalized_tool_type
            existing.handler_ref = normalized_handler_ref
            existing.mapping_version = normalized_mapping_version
            existing.allowed_downstream_scopes = normalized_allowed_downstream_scopes
            existing.updated_at = datetime.utcnow()
            if (
                previous_handler_ref != normalized_handler_ref
                or previous_execution_mode != execution_target["execution_mode"]
                or previous_workspace_name != normalized_workspace_name
                or previous_provider_name != mapping["provider_name"]
                or previous_resource_scope != mapping["resource_scope"]
                or previous_action_scope != mapping["action_scope"]
                or previous_tool_type != normalized_tool_type
                or not bool(active)
            ):
                self._clear_local_binding_cache(normalized_tool_id)
            if was_active != bool(active):
                transition = "tool_reactivated" if bool(active) else "tool_deactivated"
                self._record_tool_transition_event(
                    session=session,
                    actor_principal_id=actor_principal_id,
                    tool_id=normalized_tool_id,
                    transition=transition,
                    active=bool(active),
                )
            session.flush()
            session.commit()
            return existing

        row = RegisteredTool(
            tool_id=normalized_tool_id,
            active=bool(active),
            provider_name=mapping["provider_name"],
            resource_scope=mapping["resource_scope"],
            action_scope=mapping["action_scope"],
            provider_definition_id=mapping["provider_definition_id"],
            execution_mode=execution_target["execution_mode"],
            mcp_server_name=execution_target["mcp_server_name"],
            workspace_name=normalized_workspace_name,
            tool_type=normalized_tool_type,
            handler_ref=normalized_handler_ref,
            mapping_version=normalized_mapping_version,
            allowed_downstream_scopes=normalized_allowed_downstream_scopes,
        )
        session.add(row)
        try:
            self._record_tool_transition_event(
                session=session,
                actor_principal_id=actor_principal_id,
                tool_id=normalized_tool_id,
                transition="tool_registered",
                active=bool(active),
            )
            session.flush()
            session.commit()
        except IntegrityError as exc:
            session.rollback()
            self._raise_register_tool_integrity_error(
                exc=exc,
                tool_id=normalized_tool_id,
                workspace_name=normalized_workspace_name,
                actor_principal_id=actor_principal_id,
            )

        return row

    def _validate_tool_mapping(
        self,
        *,
        session,
        provider_name: str,
        resource_scope: str,
        action_scope: str,
        provider_definition_id: Optional[str],
        action_method: Optional[str],
        action_path_prefix: Optional[str],
        require_provider_enabled: bool = False,
    ) -> Dict[str, str]:
        normalized_provider = str(provider_name or "").strip()
        if not normalized_provider:
            raise CaracalError("provider_name is required")

        provider_row = (
            session.query(GatewayProvider)
            .filter_by(provider_id=normalized_provider)
            .first()
        )
        if provider_row is None:
            raise MCPProviderMissingError(
                f"Provider '{normalized_provider}' is not registered in workspace provider registry"
            )
        if require_provider_enabled and not bool(getattr(provider_row, "enabled", True)):
            raise MCPProviderMissingError(
                f"Provider '{normalized_provider}' is inactive in workspace provider registry"
            )

        definition_payload = dict(getattr(provider_row, "definition", {}) or {})
        if not definition_payload:
            raise MCPToolMappingMismatchError(
                f"Provider '{normalized_provider}' has no structured definition for tool mapping"
            )

        resolved_definition_id = str(
            provider_definition_id
            or getattr(provider_row, "provider_definition", None)
            or normalized_provider
        ).strip()

        definition = provider_definition_from_mapping(
            definition_payload,
            default_definition_id=resolved_definition_id,
            default_service_type=str(getattr(provider_row, "service_type", "api") or "api"),
            default_display_name=str(getattr(provider_row, "name", normalized_provider) or normalized_provider),
            default_auth_scheme=str(getattr(provider_row, "auth_scheme", "api_key") or "api_key"),
            default_base_url=getattr(provider_row, "base_url", None),
        )

        normalized_resource_scope = str(resource_scope or "").strip()
        normalized_action_scope = str(action_scope or "").strip()

        try:
            parsed_resource = parse_provider_scope(normalized_resource_scope)
            parsed_action = parse_provider_scope(normalized_action_scope)
        except ScopeParseError as exc:
            raise MCPToolMappingMismatchError(str(exc)) from exc

        if parsed_resource["kind"] != "resource":
            raise MCPToolMappingMismatchError(
                f"Expected resource scope, got: {normalized_resource_scope}"
            )
        if parsed_action["kind"] != "action":
            raise MCPToolMappingMismatchError(
                f"Expected action scope, got: {normalized_action_scope}"
            )

        if parsed_resource["provider_name"] != normalized_provider:
            raise MCPToolMappingMismatchError(
                f"Resource scope provider '{parsed_resource['provider_name']}' does not match provider_name '{normalized_provider}'"
            )
        if parsed_action["provider_name"] != normalized_provider:
            raise MCPToolMappingMismatchError(
                f"Action scope provider '{parsed_action['provider_name']}' does not match provider_name '{normalized_provider}'"
            )

        resource_id = parsed_resource["identifier"]
        action_id = parsed_action["identifier"]

        resource_definition = definition.resources.get(resource_id)
        if resource_definition is None:
            raise MCPToolMappingMismatchError(
                f"Resource scope '{normalized_resource_scope}' is not present in provider definition '{definition.definition_id}'"
            )

        action_definition = resource_definition.actions.get(action_id)
        if action_definition is None:
            raise MCPToolMappingMismatchError(
                f"Action scope '{normalized_action_scope}' is not present in provider definition '{definition.definition_id}' for resource '{resource_id}'"
            )

        if action_method and action_definition.method.upper() != str(action_method).upper():
            raise MCPToolMappingMismatchError(
                f"Action method mismatch for '{normalized_action_scope}': expected {action_definition.method}, got {action_method}"
            )

        if action_path_prefix and action_definition.path_prefix != str(action_path_prefix):
            raise MCPToolMappingMismatchError(
                f"Action path mismatch for '{normalized_action_scope}': expected {action_definition.path_prefix}, got {action_path_prefix}"
            )

        return {
            "provider_name": normalized_provider,
            "resource_scope": normalized_resource_scope,
            "action_scope": normalized_action_scope,
            "provider_definition_id": definition.definition_id,
        }

    @staticmethod
    def _normalized_row_workspace_name(row: RegisteredTool) -> str:
        workspace_name = str(getattr(row, "workspace_name", "") or "").strip()
        return workspace_name or "default"

    def list_registered_tools(
        self,
        *,
        include_inactive: bool = True,
        workspace_name: Optional[str] = None,
    ) -> list[RegisteredTool]:
        """List persisted tool registrations."""
        session = self._get_registry_session()
        query = session.query(RegisteredTool)
        if not include_inactive:
            query = query.filter_by(active=True)
        rows = query.order_by(RegisteredTool.created_at.asc()).all()

        normalized_workspace_name = self._normalize_workspace_name(workspace_name)
        if not normalized_workspace_name:
            return rows

        return [
            row
            for row in rows
            if self._normalized_row_workspace_name(row) == normalized_workspace_name
        ]

    def get_registered_tool(
        self,
        *,
        tool_id: str,
        require_active: bool = False,
        workspace_name: Optional[str] = None,
    ) -> Optional[RegisteredTool]:
        """Fetch a persisted tool registration by tool_id and optional workspace."""
        normalized_tool_id = self._normalize_tool_id(tool_id)
        session = self._get_registry_session()

        rows = (
            session.query(RegisteredTool)
            .filter_by(tool_id=normalized_tool_id)
            .order_by(RegisteredTool.updated_at.desc(), RegisteredTool.created_at.desc())
            .all()
        )
        if not rows:
            return None

        normalized_workspace_name = self._normalize_workspace_name(workspace_name)
        if not normalized_workspace_name:
            normalized_workspace_name = self._normalize_workspace_name(
                self._resolve_workspace_name(None)
            )

        if normalized_workspace_name:
            scoped_rows = [
                row
                for row in rows
                if self._normalized_row_workspace_name(row) == normalized_workspace_name
            ]
            if scoped_rows:
                rows = scoped_rows
            else:
                # Allow globally registered tools to be reused from a scoped SDK context
                # when no workspace-specific override exists for the requested tool_id.
                default_rows = [
                    row
                    for row in rows
                    if self._normalized_row_workspace_name(row) == "default"
                ]
                if not default_rows:
                    return None
                rows = default_rows
        else:
            distinct_workspaces = {
                self._normalized_row_workspace_name(row)
                for row in rows
            }
            if len(distinct_workspaces) > 1:
                sorted_workspaces = ", ".join(sorted(distinct_workspaces))
                raise CaracalError(
                    "Ambiguous tool_id "
                    f"'{normalized_tool_id}' across workspaces ({sorted_workspaces}). "
                    "Pass workspace_name explicitly."
                )

        if require_active:
            rows = [row for row in rows if bool(getattr(row, "active", False))]
            if not rows:
                return None

        return rows[0]

    def deactivate_tool(
        self,
        *,
        tool_id: str,
        actor_principal_id: str,
        workspace_name: Optional[str] = None,
    ) -> RegisteredTool:
        """Deactivate an existing tool registration."""
        normalized_tool_id = self._normalize_tool_id(tool_id)
        session = self._get_registry_session()

        row = self.get_registered_tool(
            tool_id=normalized_tool_id,
            workspace_name=workspace_name,
            require_active=False,
        )
        if not row:
            raise MCPUnknownToolError(f"Unknown tool_id: {normalized_tool_id}")

        if not row.active:
            return row

        row.active = False
        row.updated_at = datetime.utcnow()
        self._clear_local_binding_cache(normalized_tool_id)
        self._record_tool_transition_event(
            session=session,
            actor_principal_id=actor_principal_id,
            tool_id=normalized_tool_id,
            transition="tool_deactivated",
            active=False,
        )
        session.flush()
        session.commit()
        return row

    def reactivate_tool(
        self,
        *,
        tool_id: str,
        actor_principal_id: str,
        workspace_name: Optional[str] = None,
    ) -> RegisteredTool:
        """Reactivate an existing tool registration."""
        normalized_tool_id = self._normalize_tool_id(tool_id)
        session = self._get_registry_session()

        row = self.get_registered_tool(
            tool_id=normalized_tool_id,
            workspace_name=workspace_name,
            require_active=False,
        )
        if not row:
            raise MCPUnknownToolError(f"Unknown tool_id: {normalized_tool_id}")

        if row.active:
            return row

        row.active = True
        row.updated_at = datetime.utcnow()
        self._clear_local_binding_cache(normalized_tool_id)
        self._record_tool_transition_event(
            session=session,
            actor_principal_id=actor_principal_id,
            tool_id=normalized_tool_id,
            transition="tool_reactivated",
            active=True,
        )
        session.flush()
        session.commit()
        return row

    async def intercept_tool_call(
        self,
        tool_name: str,
        tool_args: Dict[str, Any],
        mcp_context: MCPContext
    ) -> MCPResult:
        """
        Intercept MCP tool invocation.
        
        This method:
        1. Extracts principal ID from MCP context
        2. Resolves applicable mandate(s) for the authenticated principal
        3. Validates authority via Authority Evaluator
        4. If allowed, forwards to MCP server
        5. Emits metering event
        6. Returns result
        
        Args:
            tool_name: Name of the MCP tool being invoked
            tool_args: Arguments passed to the tool
            mcp_context: MCP context containing principal ID and metadata
            
        Returns:
            MCPResult with success status and result/error
            
        Raises:
            CaracalError: If operation fails critically
            
        """
        try:
            # 1. Extract principal ID from MCP context
            principal_id = self._extract_principal_id(mcp_context)
            logger.debug(
                f"Intercepting MCP tool call: tool={tool_name}, principal={principal_id}"
            )

            try:
                resolved_workspace_name = self._resolve_workspace_name(mcp_context)
                require_credential = self._requires_local_credential_for_execution(
                    tool_id=tool_name,
                    workspace_name=resolved_workspace_name,
                )
                tool_mapping = self._resolve_active_tool_mapping(
                    tool_id=tool_name,
                    mcp_context=mcp_context,
                    require_credential=require_credential,
                )
            except CaracalError as exc:
                logger.warning(
                    f"Mapped tool/provider validation failed for tool {tool_name}: {exc}"
                )
                return MCPResult(
                    success=False,
                    result=None,
                    error=f"Authority denied: {exc}",
                    metadata={
                        "error_type": "caracal_error",
                        "error_class": exc.__class__.__name__,
                    },
                )

            logic_execution_context = self._active_logic_execution.get()
            if (
                logic_execution_context
                and str(tool_mapping.get("tool_id") or "").strip()
                != str(logic_execution_context.get("tool_id") or "").strip()
            ):
                try:
                    self._enforce_logic_downstream_scope(
                        parent_context=logic_execution_context,
                        requested_mapping=tool_mapping,
                    )
                except CaracalError as exc:
                    logger.warning(
                        f"Downstream scope denied for tool {tool_name}: {exc}"
                    )
                    return MCPResult(
                        success=False,
                        result=None,
                        error=f"Authority denied: {exc}",
                        metadata={
                            "error_type": "caracal_error",
                            "error_class": exc.__class__.__name__,
                        },
                    )

            caveat_kwargs = self._extract_caveat_authority_kwargs(mcp_context)
            mandate, denial_reason, denial_error_class = self._authorize_principal_request(
                requested_action=tool_mapping["action_scope"],
                requested_resource=tool_mapping["resource_scope"],
                principal_id=principal_id,
                caveat_kwargs=caveat_kwargs,
            )
            if not mandate:
                logger.warning(f"Authority denied for principal {principal_id}: {denial_reason}")
                return MCPResult(
                    success=False,
                    result=None,
                    error=f"Authority denied: {denial_reason}",
                    metadata={
                        "error_type": "caracal_error",
                        "error_class": denial_error_class or "AuthorityDenied",
                    },
                )
            
            logger.info(
                "Authority granted for principal "
                f"{principal_id}, tool {tool_name}"
            )

            execution_mode = tool_mapping["execution_mode"]
            try:
                if execution_mode == "local":
                    tool_result = await self._execute_local_tool(
                        tool_id=tool_mapping["tool_id"],
                        principal_id=principal_id,
                        tool_args=tool_args,
                        handler_ref=tool_mapping.get("handler_ref"),
                        workspace_name=tool_mapping.get("workspace_name"),
                        provider_name=tool_mapping.get("provider_name"),
                        resource_scope=tool_mapping.get("resource_scope"),
                        action_scope=tool_mapping.get("action_scope"),
                        tool_type=tool_mapping.get("tool_type"),
                        allowed_downstream_scopes=tool_mapping.get("allowed_downstream_scopes"),
                    )
                else:
                    forward_server_url = self._resolve_forward_server_url(
                        tool_mapping.get("mcp_server_name")
                    )
                    tool_result = await self._forward_to_mcp_server(
                        tool_name,
                        tool_args,
                        server_url=forward_server_url,
                        mapped_provider_name=tool_mapping["provider_name"],
                        mapped_resource_scope=tool_mapping["resource_scope"],
                        mapped_action_scope=tool_mapping["action_scope"],
                    )
            except CaracalError as exc:
                logger.warning(
                    f"Execution routing failed for tool {tool_name}: {exc}"
                )
                return MCPResult(
                    success=False,
                    result=None,
                    error=f"Authority denied: {exc}",
                    metadata={
                        "error_type": "caracal_error",
                        "error_class": exc.__class__.__name__,
                    },
                )
            
            # 6. Emit metering event (usage tracking only) with enhanced features
            # Generate correlation_id for tracing
            import uuid
            correlation_id = str(uuid.uuid4())
            
            # Extract source_event_id from context if present
            source_event_id = mcp_context.get("source_event_id")
            
            # Create tags for categorization
            tags = ["mcp", "tool", tool_name]
            
            metering_event = MeteringEvent(
                principal_id=principal_id,
                resource_type=f"mcp.tool.{tool_name}",
                quantity=Decimal("1"),  # One tool invocation
                timestamp=datetime.utcnow(),
                metadata={
                    "tool_id": tool_mapping.get("tool_id"),
                    "tool_name": tool_name,
                    "tool_type": tool_mapping.get("tool_type"),
                    "provider_name": tool_mapping.get("provider_name"),
                    "resource_scope": tool_mapping.get("resource_scope"),
                    "action_scope": tool_mapping.get("action_scope"),
                    "mcp_server_name": tool_mapping.get("mcp_server_name"),
                    "tool_args": tool_args,
                    "execution_mode": execution_mode,
                    "mcp_context": mcp_context.metadata,
                },
                correlation_id=correlation_id,
                source_event_id=source_event_id,
                tags=tags
            )
            
            self._collect_metering_event(
                metering_event,
                operation="intercept_tool_call",
                principal_id=principal_id,
                resource_identifier=tool_name,
            )
            
            logger.info(
                f"MCP tool call completed: tool={tool_name}, principal={principal_id}"
            )
            
            return MCPResult(
                success=True,
                result=tool_result,
                metadata={
                    "execution_mode": execution_mode,
                    "tool_id": tool_mapping["tool_id"],
                    "tool_type": tool_mapping.get("tool_type"),
                    "provider_name": tool_mapping["provider_name"],
                    "resource_scope": tool_mapping["resource_scope"],
                    "action_scope": tool_mapping["action_scope"],
                    "mcp_server_name": tool_mapping.get("mcp_server_name"),
                }
            )
            
        except Exception as e:
            # Fail closed: deny on error (Requirement 23.3)
            error_handler = get_error_handler("mcp-adapter")
            context = error_handler.handle_error(
                error=e,
                category=ErrorCategory.UNKNOWN,
                operation="intercept_tool_call",
                principal_id=mcp_context.principal_id,
                metadata={
                    "tool_name": tool_name,
                    "tool_args": tool_args
                },
                severity=ErrorSeverity.HIGH
            )
            
            error_response = error_handler.create_error_response(context, include_details=False)
            
            logger.error(
                f"Failed to intercept MCP tool call '{tool_name}' for principal {mcp_context.principal_id} (fail-closed): {e}",
                exc_info=True
            )
            
            return MCPResult(
                success=False,
                result=None,
                error=error_response.message,
                metadata={
                    "error_type": "internal_error",
                    "error_class": e.__class__.__name__,
                },
            )

    async def intercept_resource_read(
        self,
        resource_uri: str,
        mcp_context: MCPContext
    ) -> MCPResult:
        """
        Intercept MCP resource read.
        
        This method:
        1. Extracts principal ID from MCP context
        2. Resolves applicable mandate(s) for the authenticated principal
        3. Validates authority via Authority Evaluator
        4. If allowed, forwards to MCP server
        5. Emits metering event
        6. Returns resource
        
        Args:
            resource_uri: URI of the resource to read
            mcp_context: MCP context containing principal ID and metadata
            
        Returns:
            MCPResult with success status and resource/error
            
        Raises:
            CaracalError: If operation fails critically
            
        """
        try:
            # 1. Extract principal ID from MCP context
            principal_id = self._extract_principal_id(mcp_context)
            logger.debug(
                f"Intercepting MCP resource read: uri={resource_uri}, principal={principal_id}"
            )

            caveat_kwargs = self._extract_caveat_authority_kwargs(mcp_context)
            mandate, denial_reason, denial_error_class = self._authorize_principal_request(
                requested_action="read",
                requested_resource=resource_uri,
                principal_id=principal_id,
                caveat_kwargs=caveat_kwargs,
            )
            if not mandate:
                logger.warning(f"Authority denied for principal {principal_id}: {denial_reason}")
                return MCPResult(
                    success=False,
                    result=None,
                    error=f"Authority denied: {denial_reason}",
                    metadata={
                        "error_type": "caracal_error",
                        "error_class": denial_error_class or "AuthorityDenied",
                    },
                )
            
            logger.info(
                "Authority granted for principal "
                f"{principal_id}, resource {resource_uri}"
            )
            
            # 5. Fetch resource from MCP server
            server_name = str(mcp_context.get("mcp_server_name") or "").strip() or None
            resource = await self._fetch_resource(
                resource_uri,
                mcp_server_name=server_name,
            )
            
            # 6. Emit metering event (usage tracking only) with enhanced features
            # Generate correlation_id for tracing
            import uuid
            correlation_id = str(uuid.uuid4())
            
            # Extract source_event_id from context if present
            source_event_id = mcp_context.get("source_event_id")
            
            # Create tags for categorization
            resource_type_tag = self._get_resource_type(resource_uri)
            tags = ["mcp", "resource", resource_type_tag]
            
            metering_event = MeteringEvent(
                principal_id=principal_id,
                resource_type=f"mcp.resource.{resource_type_tag}",
                quantity=Decimal(str(resource.size)),  # Size in bytes
                timestamp=datetime.utcnow(),
                metadata={
                    "resource_uri": resource_uri,
                    "mime_type": resource.mime_type,
                    "size_bytes": resource.size,
                    "mcp_context": mcp_context.metadata,
                },
                correlation_id=correlation_id,
                source_event_id=source_event_id,
                tags=tags
            )
            
            self._collect_metering_event(
                metering_event,
                operation="intercept_resource_read",
                principal_id=principal_id,
                resource_identifier=resource_uri,
            )
            
            logger.info(
                f"MCP resource read completed: uri={resource_uri}, principal={principal_id}, "
                f"size={resource.size} bytes"
            )
            
            return MCPResult(
                success=True,
                result=resource,
                metadata={
                    "resource_size": resource.size,
                    "mcp_server_name": server_name,
                }
            )
            
        except Exception as e:
            # Fail closed: deny on error (Requirement 23.3)
            error_handler = get_error_handler("mcp-adapter")
            context = error_handler.handle_error(
                error=e,
                category=ErrorCategory.UNKNOWN,
                operation="intercept_resource_read",
                principal_id=mcp_context.principal_id,
                metadata={
                    "resource_uri": resource_uri
                },
                severity=ErrorSeverity.HIGH
            )
            
            error_response = error_handler.create_error_response(context, include_details=False)
            
            logger.error(
                f"Failed to intercept MCP resource read '{resource_uri}' for principal {mcp_context.principal_id} (fail-closed): {e}",
                exc_info=True
            )
            
            return MCPResult(
                success=False,
                result=None,
                error=error_response.message,
                metadata={
                    "error_type": "internal_error",
                    "error_class": e.__class__.__name__,
                },
            )

    def _extract_principal_id(self, mcp_context: MCPContext) -> str:
        """
        Extract principal ID from MCP context.
        
        Args:
            mcp_context: MCP context
            
        Returns:
            Principal ID as string
            
        Raises:
            CaracalError: If principal ID not found in context (fail-closed)
        """
        principal_id = mcp_context.principal_id
            
        if not principal_id:
            # Fail closed: deny operation if principal ID cannot be determined (Requirement 23.3)
            error_handler = get_error_handler("mcp-adapter")
            error = CaracalError("Principal ID not found in MCP context")
            error_handler.handle_error(
                error=error,
                category=ErrorCategory.VALIDATION,
                operation="_extract_principal_id",
                metadata={"mcp_context_metadata": mcp_context.metadata},
                severity=ErrorSeverity.CRITICAL
            )
            
            logger.error("Principal ID not found in MCP context (fail-closed)")
            raise error
        
        return principal_id

    @staticmethod
    def _normalize_principal_id(raw_principal_id: Any) -> str:
        normalized = str(raw_principal_id or "").strip()
        if not normalized:
            return ""
        try:
            return str(UUID(normalized))
        except Exception:
            return normalized

    def _resolve_workspace_name(self, mcp_context: Optional[MCPContext]) -> Optional[str]:
        if mcp_context is not None:
            for key in ("workspace", "workspace_name"):
                value = str(mcp_context.get(key) or "").strip()
                if value:
                    return value

        for env_key in (
            "CARACAL_WORKSPACE",
            "CARACAL_WORKSPACE_NAME",
            "CARACAL_WORKSPACE_ID",
        ):
            env_value = str(os.environ.get(env_key) or "").strip()
            if env_value:
                return env_value

        try:
            from caracal.deployment.config_manager import ConfigManager

            return ConfigManager().get_default_workspace_name()
        except Exception:
            return None

    def _resolve_active_tool_mapping(
        self,
        *,
        tool_id: str,
        mcp_context: Optional[MCPContext],
        require_credential: bool,
    ) -> Dict[str, Any]:
        tool_id = self._normalize_tool_id(tool_id)
        workspace_name = self._resolve_workspace_name(mcp_context)

        tool_row = self.get_registered_tool(
            tool_id=tool_id,
            require_active=True,
            workspace_name=workspace_name,
        )
        if tool_row is None:
            any_state_row = self.get_registered_tool(
                tool_id=tool_id,
                require_active=False,
                workspace_name=workspace_name,
            )
            if any_state_row is None:
                raise MCPUnknownToolError(f"Unknown tool_id: {tool_id}")

            provider_name = str(getattr(any_state_row, "provider_name", "") or "").strip()
            resource_scope = str(getattr(any_state_row, "resource_scope", "") or "").strip()
            action_scope = str(getattr(any_state_row, "action_scope", "") or "").strip()
            provider_definition_id = str(
                getattr(any_state_row, "provider_definition_id", "") or ""
            ).strip() or None

            if provider_name and resource_scope and action_scope:
                session = self._get_registry_session()
                try:
                    self._validate_tool_mapping(
                        session=session,
                        provider_name=provider_name,
                        resource_scope=resource_scope,
                        action_scope=action_scope,
                        provider_definition_id=provider_definition_id,
                        action_method=None,
                        action_path_prefix=None,
                        require_provider_enabled=True,
                    )
                except CaracalError as drift_error:
                    raise CaracalError(
                        f"Tool '{tool_id}' is inactive due provider drift: {drift_error}"
                    ) from drift_error

            raise CaracalError(f"Tool '{tool_id}' is inactive")

        provider_name = str(getattr(tool_row, "provider_name", "") or "").strip()
        resource_scope = str(getattr(tool_row, "resource_scope", "") or "").strip()
        action_scope = str(getattr(tool_row, "action_scope", "") or "").strip()
        provider_definition_id = str(getattr(tool_row, "provider_definition_id", "") or "").strip() or None
        workspace_name = self._normalize_workspace_name(
            getattr(tool_row, "workspace_name", None)
        )
        if not workspace_name:
            workspace_name = self._normalize_workspace_name(
                self._resolve_workspace_name(mcp_context)
            )
        tool_type = self._normalize_tool_type(
            getattr(tool_row, "tool_type", None)
        )
        handler_ref = self._normalize_handler_ref(
            getattr(tool_row, "handler_ref", None)
        )
        mapping_version = str(getattr(tool_row, "mapping_version", "") or "").strip() or None
        allowed_downstream_scopes = self._normalize_allowed_downstream_scopes(
            getattr(tool_row, "allowed_downstream_scopes", None)
        )
        execution_target = self._normalize_execution_target(
            execution_mode=getattr(tool_row, "execution_mode", None),
            mcp_server_name=getattr(tool_row, "mcp_server_name", None),
        )
        self._validate_tool_binding_contract(
            tool_id=tool_id,
            execution_mode=execution_target["execution_mode"] or "mcp_forward",
            tool_type=tool_type,
            handler_ref=handler_ref,
        )

        if not provider_name or not resource_scope or not action_scope:
            raise MCPToolMappingMismatchError(
                f"Tool '{tool_id}' is missing provider/resource/action mapping"
            )

        session = self._get_registry_session()
        provider_row = session.query(GatewayProvider).filter_by(provider_id=provider_name).first()
        if provider_row is None:
            raise MCPProviderMissingError(
                f"Mapped provider '{provider_name}' for tool '{tool_id}' was removed"
            )
        if not bool(getattr(provider_row, "enabled", True)):
            raise MCPProviderMissingError(
                f"Mapped provider '{provider_name}' for tool '{tool_id}' is inactive"
            )

        mapping = self._validate_tool_mapping(
            session=session,
            provider_name=provider_name,
            resource_scope=resource_scope,
            action_scope=action_scope,
            provider_definition_id=provider_definition_id,
            action_method=None,
            action_path_prefix=None,
            require_provider_enabled=True,
        )

        auth_scheme = str(getattr(provider_row, "auth_scheme", "api_key") or "api_key")
        auth_scheme = auth_scheme.replace("-", "_").strip().lower()
        if require_credential and auth_scheme != "none":
            credential_ref = str(getattr(provider_row, "credential_ref", "") or "").strip()
            if not credential_ref:
                raise CaracalError(
                    f"Mapped provider '{provider_name}' for tool '{tool_id}' has no credential_ref"
                )

            if not workspace_name:
                raise CaracalError(
                    f"Mapped provider '{provider_name}' credentials cannot be resolved without an active workspace"
                )

            try:
                resolve_workspace_provider_credential(workspace_name, credential_ref)
            except SecretNotFoundError as exc:
                raise CaracalError(
                    f"Credential not found for mapped provider '{provider_name}': {credential_ref}"
                ) from exc

        return {
            "tool_id": tool_id,
            **mapping,
            "workspace_name": workspace_name,
            "tool_type": tool_type,
            "handler_ref": handler_ref,
            "mapping_version": mapping_version,
            "allowed_downstream_scopes": allowed_downstream_scopes,
            **execution_target,
        }

    def _requires_local_credential_for_execution(
        self,
        *,
        tool_id: str,
        workspace_name: Optional[str] = None,
    ) -> bool:
        """Only local execution requires local credential resolution."""
        try:
            row = self.get_registered_tool(
                tool_id=tool_id,
                require_active=True,
                workspace_name=workspace_name,
            )
        except CaracalError:
            return False
        if row is None:
            return False

        execution_target = self._normalize_execution_target(
            execution_mode=getattr(row, "execution_mode", None),
            mcp_server_name=getattr(row, "mcp_server_name", None),
        )
        return execution_target["execution_mode"] == "local"

    @staticmethod
    def _extract_forward_selector_value(response_payload: Any, selector_key: str) -> Optional[str]:
        if not isinstance(response_payload, dict):
            return None

        values: list[str] = []
        direct = str(response_payload.get(selector_key) or "").strip()
        if direct:
            values.append(direct)

        metadata = response_payload.get("metadata")
        if isinstance(metadata, dict):
            meta_value = str(metadata.get(selector_key) or "").strip()
            if meta_value:
                values.append(meta_value)

        unique_values = list(dict.fromkeys(values))
        if len(unique_values) > 1:
            raise CaracalError(
                f"Upstream forward response has conflicting '{selector_key}' selector values"
            )

        return unique_values[0] if unique_values else None

    @staticmethod
    def _resolve_caveat_mode(raw_mode: str) -> str:
        mode = str(raw_mode or "jwt").strip().lower()
        if mode in {"jwt", "caveat_chain"}:
            return mode
        raise CaracalError(
            f"Invalid caveat mode {raw_mode!r}. Use 'jwt' or 'caveat_chain'."
        )

    def _extract_caveat_authority_kwargs(self, mcp_context: MCPContext) -> Dict[str, Any]:
        """Extract optional caveat-chain inputs for AuthorityEvaluator."""
        if self._caveat_mode != "caveat_chain":
            return {}

        task_claims = mcp_context.get("task_token_claims")
        if not isinstance(task_claims, dict):
            task_claims = {}

        # If validated task claims are present, trust claims first over top-level metadata.
        raw_chain = task_claims.get("task_caveat_chain") or task_claims.get("caveat_chain")
        if raw_chain is None:
            raw_chain = mcp_context.get("task_caveat_chain") or mcp_context.get("caveat_chain")
        if raw_chain is None:
            return {}
        if not isinstance(raw_chain, list):
            raise CaracalError("task_caveat_chain metadata must be a list")

        raw_hmac_key = (
            task_claims.get("task_caveat_hmac_key")
            or task_claims.get("caveat_hmac_key")
            or mcp_context.get("task_caveat_hmac_key")
            or mcp_context.get("caveat_hmac_key")
            or self._caveat_hmac_key
            or ""
        )
        caveat_hmac_key = str(raw_hmac_key).strip()
        if not caveat_hmac_key:
            raise CaracalError(
                "Caveat-chain enforcement requires a caveat HMAC key when task_caveat_chain is provided"
            )

        task_id = (
            task_claims.get("task_id")
            or task_claims.get("caveat_task_id")
            or mcp_context.get("task_id")
            or mcp_context.get("caveat_task_id")
        )
        task_id = str(task_id).strip() if task_id is not None else None

        return {
            "caveat_chain": raw_chain,
            "caveat_hmac_key": caveat_hmac_key,
            "caveat_task_id": task_id,
        }

    def _resolve_applicable_mandates(
        self,
        *,
        requested_action: str,
        requested_resource: str,
        principal_id: str,
        caveat_kwargs: Dict[str, Any],
    ) -> list[Any]:
        resolver = getattr(self.authority_evaluator, "resolve_applicable_mandates_for_principal", None)
        if callable(resolver):
            resolved = resolver(
                requested_action=requested_action,
                requested_resource=requested_resource,
                caller_principal_id=principal_id,
                **caveat_kwargs,
            )
            if resolved is None:
                return []
            if isinstance(resolved, list):
                return [mandate for mandate in resolved if mandate is not None]
            try:
                return [mandate for mandate in list(resolved) if mandate is not None]
            except TypeError:
                return [resolved] if resolved is not None else []

        mandate = self.authority_evaluator.resolve_mandate_for_principal(
            requested_action=requested_action,
            requested_resource=requested_resource,
            caller_principal_id=principal_id,
            **caveat_kwargs,
        )
        return [mandate] if mandate else []

    def _authorize_principal_request(
        self,
        *,
        requested_action: str,
        requested_resource: str,
        principal_id: str,
        caveat_kwargs: Dict[str, Any],
    ) -> tuple[Optional[Any], Optional[str], Optional[str]]:
        applicable_mandates = self._resolve_applicable_mandates(
            requested_action=requested_action,
            requested_resource=requested_resource,
            principal_id=principal_id,
            caveat_kwargs=caveat_kwargs,
        )

        if not applicable_mandates:
            return (
                None,
                "No applicable mandate found for principal",
                "MCPNoApplicableMandateError",
            )

        deny_reason: Optional[str] = None
        for mandate in applicable_mandates:
            decision = self.authority_evaluator.validate_mandate(
                mandate=mandate,
                requested_action=requested_action,
                requested_resource=requested_resource,
                caller_principal_id=principal_id,
                **caveat_kwargs,
            )
            if decision.allowed:
                return mandate, None, None
            deny_reason = decision.reason

        return (
            None,
            deny_reason or "No applicable mandate grants requested action/resource for principal",
            "AuthorityDenied",
        )

    async def _get_http_client(self) -> httpx.AsyncClient:
        """Lazily create and return a shared httpx.AsyncClient."""
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(
                timeout=httpx.Timeout(self.request_timeout_seconds),
                follow_redirects=True,
            )
        return self._http_client

    def _collect_metering_event(
        self,
        metering_event: MeteringEvent,
        *,
        operation: str,
        principal_id: str,
        resource_identifier: str,
    ) -> None:
        """Collect metering data without turning successful execution into failure."""
        try:
            self.metering_collector.collect_event(metering_event)
        except Exception as exc:
            logger.warning(
                "Metering collection failed after successful operation",
                extra={
                    "operation": operation,
                    "principal_id": principal_id,
                    "resource_identifier": resource_identifier,
                    "error": str(exc),
                },
                exc_info=True,
            )

    def _resolve_forward_server_url(self, mcp_server_name: Optional[str]) -> str:
        normalized_name = str(mcp_server_name or "").strip()
        if normalized_name:
            resolved = self._mcp_server_urls.get(normalized_name)
            if not resolved:
                raise CaracalError(
                    f"Unknown mcp_server_name '{normalized_name}' for forward execution"
                )
            return resolved

        if self.mcp_server_url:
            return self.mcp_server_url

        if len(self._mcp_server_urls) == 1:
            return next(iter(self._mcp_server_urls.values()))

        if len(self._mcp_server_urls) > 1:
            raise CaracalError(
                "Forward execution requires mcp_server_name when multiple MCP servers are configured"
            )

        raise CaracalError("No upstream MCP server URL configured for forward execution")

    async def _execute_local_tool(
        self,
        *,
        tool_id: str,
        principal_id: str,
        tool_args: Dict[str, Any],
        handler_ref: Optional[str] = None,
        workspace_name: Optional[str] = None,
        provider_name: Optional[str] = None,
        resource_scope: Optional[str] = None,
        action_scope: Optional[str] = None,
        tool_type: Optional[str] = None,
        allowed_downstream_scopes: Optional[list[str]] = None,
    ) -> Any:
        bound_func = self._resolve_local_callable_binding(
            tool_id=tool_id,
            handler_ref=handler_ref,
            workspace_name=workspace_name,
            provider_name=provider_name,
            resource_scope=resource_scope,
            action_scope=action_scope,
            tool_type=tool_type,
        )

        call_kwargs = dict(tool_args or {})
        call_kwargs.pop("principal_id", None)
        call_kwargs.pop("mandate_id", None)
        call_kwargs.pop("resolved_mandate_id", None)
        call_kwargs.pop("policy_id", None)
        call_kwargs["principal_id"] = principal_id

        import inspect

        logic_context_token = None
        if str(tool_type or "").strip().lower() == "logic":
            logic_context = {
                "tool_id": tool_id,
                "workspace_name": workspace_name,
                "provider_name": provider_name,
                "resource_scope": resource_scope,
                "action_scope": action_scope,
                "allowed_downstream_scopes": self._normalize_allowed_downstream_scopes(
                    allowed_downstream_scopes
                ),
            }
            logic_context_token = self._active_logic_execution.set(logic_context)

        try:
            if inspect.iscoroutinefunction(bound_func):
                return await bound_func(**call_kwargs)
            return bound_func(**call_kwargs)
        finally:
            if logic_context_token is not None:
                self._active_logic_execution.reset(logic_context_token)

    async def _forward_to_mcp_server(
        self,
        tool_name: str,
        tool_args: Dict[str, Any],
        *,
        server_url: Optional[str] = None,
        mapped_provider_name: Optional[str] = None,
        mapped_resource_scope: Optional[str] = None,
        mapped_action_scope: Optional[str] = None,
    ) -> Any:
        """
        Forward tool invocation to the upstream MCP server via HTTP POST.

        Sends a JSON-RPC-style request to ``{mcp_server_url}/tool/call`` and
        returns the parsed response body.  Handles connection timeouts,
        non-200 status codes, and JSON parsing errors.

        Args:
            tool_name: Name of the tool
            tool_args: Tool arguments

        Returns:
            Parsed upstream response dict

        Raises:
            CaracalError: On connection, timeout, HTTP, or parse failures
        """
        resolved_server_url = str(server_url or self.mcp_server_url or "").strip().rstrip("/")
        if not resolved_server_url:
            raise CaracalError("MCP server URL not configured — cannot forward tool call")

        url = f"{resolved_server_url}/tool/call"
        payload = {
            "tool_name": tool_name,
            "tool_args": tool_args,
            "provider_name": mapped_provider_name,
            "resource_scope": mapped_resource_scope,
            "action_scope": mapped_action_scope,
        }
        headers: Dict[str, str] = {}
        if mapped_provider_name:
            headers["X-Caracal-Provider-ID"] = mapped_provider_name
        if mapped_resource_scope:
            headers["X-Caracal-Provider-Resource"] = mapped_resource_scope
        if mapped_action_scope:
            headers["X-Caracal-Provider-Action"] = mapped_action_scope

        logger.debug(
            f"Forwarding MCP tool call to upstream: url={url}, tool={tool_name}"
        )

        try:
            client = await self._get_http_client()
            response = await client.post(url, json=payload, headers=headers)

            if response.status_code != 200:
                error_body = response.text[:500]
                logger.error(
                    f"Upstream MCP server returned HTTP {response.status_code} "
                    f"for tool {tool_name}: {error_body}"
                )
                raise CaracalError(
                    f"Upstream MCP server error (HTTP {response.status_code}): {error_body}"
                )

            try:
                result = response.json()
            except Exception as parse_err:
                logger.error(
                    f"Failed to parse upstream JSON for tool {tool_name}: {parse_err}"
                )
                raise CaracalError(
                    f"Invalid JSON from upstream MCP server: {parse_err}"
                )

            expected_selectors = {
                "provider_name": str(mapped_provider_name or "").strip() or None,
                "resource_scope": str(mapped_resource_scope or "").strip() or None,
                "action_scope": str(mapped_action_scope or "").strip() or None,
            }
            for selector_key, expected_value in expected_selectors.items():
                if not expected_value:
                    continue
                actual_value = self._extract_forward_selector_value(result, selector_key)
                if not actual_value:
                    raise CaracalError(
                        f"Upstream forward response missing required '{selector_key}' selector"
                    )
                if actual_value and actual_value != expected_value:
                    raise CaracalError(
                        f"Upstream forward response mismatch for {selector_key}: "
                        f"expected '{expected_value}', got '{actual_value}'"
                    )

            if isinstance(result, dict):
                metadata = result.get("metadata")
                if not isinstance(metadata, dict):
                    metadata = {}
                    result["metadata"] = metadata
                for selector_key, expected_value in expected_selectors.items():
                    if expected_value:
                        metadata[selector_key] = expected_value

            logger.debug(
                f"Upstream MCP tool call succeeded: tool={tool_name}"
            )
            return result

        except httpx.TimeoutException as exc:
            logger.error(f"Timeout forwarding tool {tool_name} to {url}: {exc}")
            raise CaracalError(
                f"Upstream MCP server timed out after {self.request_timeout_seconds}s"
            )
        except httpx.ConnectError as exc:
            logger.error(f"Connection failed for tool {tool_name} to {url}: {exc}")
            raise CaracalError(
                f"Cannot connect to upstream MCP server at {resolved_server_url}: {exc}"
            )
        except CaracalError:
            raise
        except Exception as exc:
            logger.error(
                f"Unexpected error forwarding tool {tool_name}: {exc}",
                exc_info=True,
            )
            raise CaracalError(f"Failed to forward tool call: {exc}")

    async def _fetch_resource(
        self,
        resource_uri: str,
        *,
        mcp_server_name: Optional[str] = None,
    ) -> MCPResource:
        """
        Fetch a resource from the upstream MCP server via HTTP POST.

        Sends a request to ``{mcp_server_url}/resource/read`` and maps the
        upstream JSON into an ``MCPResource``.

        Args:
            resource_uri: URI of the resource

        Returns:
            MCPResource populated from the upstream response

        Raises:
            CaracalError: On connection, timeout, HTTP, or parse failures
        """
        normalized_server_name = str(mcp_server_name or "").strip() or None
        if not normalized_server_name and len(self._mcp_server_urls) > 1:
            raise CaracalError(
                "Resource read requires mcp_server_name when multiple MCP servers are configured"
            )

        resolved_server_url = self._resolve_forward_server_url(normalized_server_name)

        url = f"{resolved_server_url}/resource/read"
        payload = {"resource_uri": resource_uri}

        logger.debug(
            f"Forwarding MCP resource read to upstream: url={url}, uri={resource_uri}"
        )

        try:
            client = await self._get_http_client()
            response = await client.post(url, json=payload)

            if response.status_code != 200:
                error_body = response.text[:500]
                logger.error(
                    f"Upstream MCP server returned HTTP {response.status_code} "
                    f"for resource {resource_uri}: {error_body}"
                )
                raise CaracalError(
                    f"Upstream MCP server error (HTTP {response.status_code}): {error_body}"
                )

            try:
                data = response.json()
            except Exception as parse_err:
                logger.error(
                    f"Failed to parse upstream JSON for resource {resource_uri}: {parse_err}"
                )
                raise CaracalError(
                    f"Invalid JSON from upstream MCP server: {parse_err}"
                )

            # Map upstream response into MCPResource
            content = data.get("content", "")
            content_bytes = content.encode("utf-8") if isinstance(content, str) else str(content).encode("utf-8")

            resource = MCPResource(
                uri=data.get("uri", resource_uri),
                content=content,
                mime_type=data.get("mime_type", "application/octet-stream"),
                size=data.get("size", len(content_bytes)),
            )

            logger.debug(
                f"Upstream MCP resource read succeeded: uri={resource_uri}, "
                f"size={resource.size} bytes"
            )
            return resource

        except httpx.TimeoutException as exc:
            logger.error(f"Timeout fetching resource {resource_uri} from {url}: {exc}")
            raise CaracalError(
                f"Upstream MCP server timed out after {self.request_timeout_seconds}s"
            )
        except httpx.ConnectError as exc:
            logger.error(f"Connection failed for resource {resource_uri} to {url}: {exc}")
            raise CaracalError(
                f"Cannot connect to upstream MCP server at {resolved_server_url}: {exc}"
            )
        except CaracalError:
            raise
        except Exception as exc:
            logger.error(
                f"Unexpected error fetching resource {resource_uri}: {exc}",
                exc_info=True,
            )
            raise CaracalError(f"Failed to fetch resource: {exc}")

    def _get_resource_type(self, resource_uri: str) -> str:
        """
        Extract resource type from URI scheme.
        
        Args:
            resource_uri: Resource URI
            
        Returns:
            Resource type string
        """
        # Map URI schemes to resource types
        if resource_uri.startswith("file://"):
            return "file"
        elif resource_uri.startswith("http://") or resource_uri.startswith("https://"):
            return "http"
        elif resource_uri.startswith("db://"):
            return "database"
        elif resource_uri.startswith("s3://"):
            return "s3"
        else:
            return "unknown"

    def as_decorator(self, *, tool_id: str):
        """
        Return Python decorator for in-process integration.
        
        This decorator wraps MCP tool functions to automatically handle:
        - Principal-based mandate resolution and authority validation before execution
        - Metering events after execution
        - Error handling and logging
        
        Usage:
            @mcp_adapter.as_decorator(tool_id="provider:endframe:resource:deployments")
            async def my_mcp_tool(principal_id: str, **kwargs):
                # Tool implementation
                return result
        
        The decorated function must accept principal_id as an argument.
        
        Returns:
            Decorator function that wraps MCP tool functions
            
        """
        tool_id = str(tool_id or "").strip()
        if not tool_id:
            raise CaracalError("tool_id is required for MCP decorator registration")

        tool_row = self.get_registered_tool(
            tool_id=tool_id,
            workspace_name=self._resolve_workspace_name(None),
        )
        if tool_row is None:
            raise CaracalError(
                f"tool_id '{tool_id}' is not registered in persisted tool registry"
            )
        if not bool(getattr(tool_row, "active", False)):
            raise CaracalError(
                f"tool_id '{tool_id}' is inactive and cannot be bound"
            )

        # Fail import-time binding if provider/action/resource mapping drifted.
        tool_mapping = self._resolve_active_tool_mapping(
            tool_id=tool_id,
            mcp_context=None,
            require_credential=False,
        )
        contract_key = self._binding_contract_key(
            workspace_name=tool_mapping.get("workspace_name"),
            provider_name=tool_mapping.get("provider_name"),
            resource_scope=tool_mapping.get("resource_scope"),
            action_scope=tool_mapping.get("action_scope"),
            tool_type=tool_mapping.get("tool_type"),
        )
        expected_handler_ref = self._normalize_handler_ref(tool_mapping.get("handler_ref"))

        def decorator(func):
            """
            Decorator that wraps an MCP tool function.
            
            Args:
                func: The MCP tool function to wrap
                
            Returns:
                Wrapped function with authority enforcement
            """
            existing = self._decorator_bindings.get(tool_id)
            if existing is not None and existing is not func:
                raise CaracalError(
                    f"tool_id '{tool_id}' is already bound to another local function"
                )

            runtime_handler_ref = self._callable_handler_ref(func)
            if expected_handler_ref and runtime_handler_ref != expected_handler_ref:
                raise CaracalError(
                    f"Local handler mismatch for tool '{tool_id}': expected {expected_handler_ref}, got {runtime_handler_ref or '<unknown>'}"
                )

            self._decorator_bindings[tool_id] = func
            if contract_key is not None:
                existing_contract_binding = self._decorator_bindings_by_contract.get(contract_key)
                if existing_contract_binding is not None and existing_contract_binding is not func:
                    raise CaracalError(
                        f"Binding contract for tool '{tool_id}' is already bound to another local function"
                    )
                self._decorator_bindings_by_contract[contract_key] = func
                self._tool_binding_contract_keys[tool_id] = contract_key

            if runtime_handler_ref:
                self._handler_ref_bindings[runtime_handler_ref] = func

            import functools
            import inspect
            
            @functools.wraps(func)
            async def wrapper(*args, **kwargs):
                """
                Wrapper that handles authority checks and metering.
                
                Args:
                    *args: Positional arguments for the tool
                    **kwargs: Keyword arguments for the tool
                    
                Returns:
                    Tool execution result
                    
                Raises:
                    CaracalError: If validation fails
                """
                # Extract principal_id from arguments
                principal_id = None
                
                # Get function signature to understand parameters
                sig = inspect.signature(func)
                param_names = list(sig.parameters.keys())
                
                # Copy kwargs to modify
                call_kwargs = kwargs.copy()
                
                # Extract principal_id
                if 'principal_id' in call_kwargs:
                    principal_id = call_kwargs.pop('principal_id')
                elif len(args) > 0 and len(param_names) > 0 and param_names[0] == 'principal_id':
                    principal_id = args[0]
                
                if not principal_id:
                    logger.error(
                        f"principal_id not provided to decorated MCP tool '{func.__name__}'"
                    )
                    raise CaracalError(
                        f"principal_id is required for MCP tool '{func.__name__}'."
                    )
                
                tool_name = tool_id
                
                # Create MCP context
                metadata: Dict[str, Any] = {
                    "tool_name": tool_name,
                    "tool_id": tool_name,
                    "decorator_mode": True,
                }
                task_caveat_chain = call_kwargs.get("task_caveat_chain") or call_kwargs.get("caveat_chain")
                if task_caveat_chain is not None:
                    metadata["task_caveat_chain"] = task_caveat_chain

                task_caveat_hmac_key = call_kwargs.get("task_caveat_hmac_key") or call_kwargs.get("caveat_hmac_key")
                if task_caveat_hmac_key is not None:
                    metadata["task_caveat_hmac_key"] = task_caveat_hmac_key

                task_id = call_kwargs.get("task_id") or call_kwargs.get("caveat_task_id")
                if task_id is not None:
                    metadata["task_id"] = task_id

                task_token_claims = call_kwargs.get("task_token_claims")
                if isinstance(task_token_claims, dict):
                    trusted_subject = str(
                        task_token_claims.get("sub")
                        or task_token_claims.get("principal_id")
                        or ""
                    ).strip()
                    if trusted_subject and trusted_subject != str(principal_id):
                        raise CaracalError(
                            "principal_id does not match authenticated token subject"
                        )
                    metadata["task_token_claims"] = task_token_claims

                mcp_context = MCPContext(
                    principal_id=str(principal_id),
                    metadata=metadata,
                )
                
                logger.debug(
                    f"Decorator intercepting MCP tool: tool={tool_name}, principal={principal_id}"
                )
                
                try:
                    tool_mapping = self._resolve_active_tool_mapping(
                        tool_id=tool_name,
                        mcp_context=mcp_context,
                        require_credential=True,
                    )

                    # 1. Resolve and validate authority using principal identity.
                    caveat_kwargs = self._extract_caveat_authority_kwargs(mcp_context)
                    mandate, denial_reason, _denial_error_class = self._authorize_principal_request(
                        requested_action=tool_mapping["action_scope"],
                        requested_resource=tool_mapping["resource_scope"],
                        principal_id=str(principal_id),
                        caveat_kwargs=caveat_kwargs,
                    )
                    if not mandate:
                        logger.warning(
                            f"Authority denied for principal {principal_id}: {denial_reason}"
                        )
                        raise CaracalError(f"Authority denied: {denial_reason}")
                    
                    logger.info(
                        f"Authority granted for principal {principal_id}, tool {tool_name}"
                    )
                    
                    # 2. Execute the actual tool function
                    if inspect.iscoroutinefunction(func):
                        tool_result = await func(*args, **kwargs)
                    else:
                        tool_result = func(*args, **kwargs)
                    
                    # 3. Emit metering event with enhanced features
                    # Generate correlation_id for tracing
                    import uuid
                    correlation_id = str(uuid.uuid4())
                    
                    # Extract source_event_id from context if present
                    source_event_id = mcp_context.get("source_event_id")
                    
                    # Create tags for categorization
                    tags = ["mcp", "tool", tool_name, "decorator"]
                    
                    metering_event = MeteringEvent(
                        principal_id=str(principal_id),
                        resource_type=f"mcp.tool.{tool_name}",
                        quantity=Decimal("1"),
                        timestamp=datetime.utcnow(),
                        metadata={
                            "tool_name": tool_name,
                            "decorator_mode": True,
                        },
                        correlation_id=correlation_id,
                        source_event_id=source_event_id,
                        tags=tags
                    )
                    
                    self._collect_metering_event(
                        metering_event,
                        operation="decorator_tool_call",
                        principal_id=str(principal_id),
                        resource_identifier=tool_name,
                    )
                    
                    logger.info(
                        f"MCP tool call completed (decorated): tool={tool_name}, principal={principal_id}"
                    )
                    
                    return tool_result
            
                except CaracalError:
                    raise
                except Exception as e:
                    # Fail closed
                    logger.error(
                        f"Failed to execute decorated tool '{tool_name}' for principal {principal_id}: {e}",
                        exc_info=True
                    )
                    raise CaracalError(f"Tool execution failed: {e}")
            
            return wrapper
        
        return decorator
