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
    MCPUnknownMandateError,
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
        principal_id: ID of the agent making the request
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
        resolved_mode = caveat_mode or os.environ.get("CARACAL_SESSION_CAVEAT_MODE") or "jwt"
        self._caveat_mode = self._resolve_caveat_mode(resolved_mode)
        self._caveat_hmac_key = str(
            caveat_hmac_key
            or os.environ.get("CARACAL_SESSION_CAVEAT_HMAC_KEY")
            or ""
        ).strip()
        self._decorator_bindings: dict[str, Any] = {}
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
        if tool_type == "direct_api" and handler_ref:
            raise MCPToolTypeMismatchError(
                f"Tool '{tool_id}' is direct_api and cannot set handler_ref"
            )

        if tool_type == "logic" and not handler_ref:
            raise MCPToolBindingError(
                f"Tool '{tool_id}' is logic and requires handler_ref"
            )

        if execution_mode == "mcp_forward" and tool_type == "logic" and not handler_ref:
            raise MCPToolBindingError(
                f"Tool '{tool_id}' forward logic execution requires handler_ref"
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
        normalized_workspace_name = self._normalize_workspace_name(workspace_name)
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

        existing = (
            session.query(RegisteredTool)
            .filter_by(tool_id=normalized_tool_id)
            .first()
        )
        if existing:
            was_active = bool(existing.active)
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
            raise CaracalError(f"Tool already registered: {normalized_tool_id}") from exc

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

    def list_registered_tools(self, *, include_inactive: bool = True) -> list[RegisteredTool]:
        """List persisted tool registrations."""
        session = self._get_registry_session()
        query = session.query(RegisteredTool)
        if not include_inactive:
            query = query.filter_by(active=True)
        return query.order_by(RegisteredTool.created_at.asc()).all()

    def get_registered_tool(self, *, tool_id: str, require_active: bool = False) -> Optional[RegisteredTool]:
        """Fetch a persisted tool registration by tool_id."""
        normalized_tool_id = self._normalize_tool_id(tool_id)
        session = self._get_registry_session()
        row = session.query(RegisteredTool).filter_by(tool_id=normalized_tool_id).first()
        if row is None:
            return None
        if require_active and not row.active:
            return None
        return row

    def deactivate_tool(self, *, tool_id: str, actor_principal_id: str) -> RegisteredTool:
        """Deactivate an existing tool registration."""
        normalized_tool_id = self._normalize_tool_id(tool_id)
        session = self._get_registry_session()

        row = session.query(RegisteredTool).filter_by(tool_id=normalized_tool_id).first()
        if not row:
            raise MCPUnknownToolError(f"Unknown tool_id: {normalized_tool_id}")

        if not row.active:
            return row

        row.active = False
        row.updated_at = datetime.utcnow()
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

    def reactivate_tool(self, *, tool_id: str, actor_principal_id: str) -> RegisteredTool:
        """Reactivate an existing tool registration."""
        normalized_tool_id = self._normalize_tool_id(tool_id)
        session = self._get_registry_session()

        row = session.query(RegisteredTool).filter_by(tool_id=normalized_tool_id).first()
        if not row:
            raise MCPUnknownToolError(f"Unknown tool_id: {normalized_tool_id}")

        if row.active:
            return row

        row.active = True
        row.updated_at = datetime.utcnow()
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
        1. Extracts agent ID from MCP context
        2. Extracts Mandate ID from metadata
        3. Validates authority via Authority Evaluator
        4. If allowed, forwards to MCP server
        5. Emits metering event
        6. Returns result
        
        Args:
            tool_name: Name of the MCP tool being invoked
            tool_args: Arguments passed to the tool
            mcp_context: MCP context containing agent ID and metadata
            
        Returns:
            MCPResult with success status and result/error
            
        Raises:
            CaracalError: If operation fails critically
            
        """
        try:
            # 1. Extract agent ID from MCP context
            principal_id = self._extract_principal_id(mcp_context)
            logger.debug(
                f"Intercepting MCP tool call: tool={tool_name}, agent={principal_id}"
            )
            
            # 2. Extract Mandate ID
            mandate_id_str = mcp_context.get("mandate_id")
            if not mandate_id_str:
                logger.warning(f"No mandate_id provided for agent {principal_id}, tool {tool_name}")
                return MCPResult(
                    success=False,
                    result=None,
                    error="Authority denied: Missing mandate_id"
                )
            
            try:
                mandate_id = UUID(mandate_id_str)
            except ValueError:
                logger.warning(f"Invalid mandate_id format: {mandate_id_str}")
                return MCPResult(
                    success=False,
                    result=None,
                    error="Authority denied: Invalid mandate_id format"
                )

            # 3. Fetch Mandate
            mandate = self.authority_evaluator._get_mandate_with_cache(mandate_id)
            if not mandate:
                logger.warning(f"Mandate not found: {mandate_id}")
                not_found_error = MCPUnknownMandateError(f"Unknown mandate_id: {mandate_id}")
                return MCPResult(
                    success=False,
                    result=None,
                    error=f"Authority denied: {not_found_error}"
                )

            if not self._is_mandate_subject(principal_id, mandate):
                logger.warning(
                    f"Mandate subject mismatch for mandate {mandate_id}: "
                    f"caller={principal_id}, subject={getattr(mandate, 'subject_id', None)}"
                )
                return MCPResult(
                    success=False,
                    result=None,
                    error="Authority denied: Authenticated principal does not match mandate subject",
                )

            try:
                tool_mapping = self._resolve_active_tool_mapping(
                    tool_id=tool_name,
                    mcp_context=mcp_context,
                    require_credential=True,
                )
            except CaracalError as exc:
                logger.warning(
                    f"Mapped tool/provider validation failed for tool {tool_name}: {exc}"
                )
                return MCPResult(
                    success=False,
                    result=None,
                    error=f"Authority denied: {exc}",
                )

            # 4. Validate Authority
            caveat_kwargs = self._extract_caveat_authority_kwargs(mcp_context)
            decision = self.authority_evaluator.validate_mandate(
                mandate=mandate,
                requested_action=tool_mapping["action_scope"],
                requested_resource=tool_mapping["resource_scope"],
                caller_principal_id=principal_id,
                **caveat_kwargs,
            )
            
            if not decision.allowed:
                logger.warning(
                    f"Authority denied for agent {principal_id}: {decision.reason}"
                )
                return MCPResult(
                    success=False,
                    result=None,
                    error=f"Authority denied: {decision.reason}"
                )
            
            logger.info(
                f"Authority granted for agent {principal_id}, tool {tool_name} (mandate {mandate_id})"
            )

            execution_mode = tool_mapping["execution_mode"]
            try:
                if execution_mode == "local":
                    tool_result = await self._execute_local_tool(
                        tool_id=tool_mapping["tool_id"],
                        principal_id=principal_id,
                        mandate_id=mandate_id,
                        tool_args=tool_args,
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
                    "tool_name": tool_name,
                    "tool_args": tool_args,
                    "execution_mode": execution_mode,
                    "mcp_context": mcp_context.metadata,
                    "mandate_id": str(mandate_id)
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
                f"MCP tool call completed: tool={tool_name}, agent={principal_id}"
            )
            
            return MCPResult(
                success=True,
                result=tool_result,
                metadata={
                    "mandate_id": str(mandate_id),
                    "execution_mode": execution_mode,
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
                f"Failed to intercept MCP tool call '{tool_name}' for agent {mcp_context.principal_id} (fail-closed): {e}",
                exc_info=True
            )
            
            return MCPResult(
                success=False,
                result=None,
                error=error_response.message
            )

    async def intercept_resource_read(
        self,
        resource_uri: str,
        mcp_context: MCPContext
    ) -> MCPResult:
        """
        Intercept MCP resource read.
        
        This method:
        1. Extracts agent ID from MCP context
        2. Extracts Mandate ID from metadata
        3. Validates authority via Authority Evaluator
        4. If allowed, forwards to MCP server
        5. Emits metering event
        6. Returns resource
        
        Args:
            resource_uri: URI of the resource to read
            mcp_context: MCP context containing agent ID and metadata
            
        Returns:
            MCPResult with success status and resource/error
            
        Raises:
            CaracalError: If operation fails critically
            
        """
        try:
            # 1. Extract agent ID from MCP context
            principal_id = self._extract_principal_id(mcp_context)
            logger.debug(
                f"Intercepting MCP resource read: uri={resource_uri}, agent={principal_id}"
            )
            
            # 2. Extract Mandate ID
            mandate_id_str = mcp_context.get("mandate_id")
            if not mandate_id_str:
                logger.warning(f"No mandate_id provided for agent {principal_id}, resource {resource_uri}")
                return MCPResult(
                    success=False,
                    result=None,
                    error="Authority denied: Missing mandate_id"
                )
            
            try:
                mandate_id = UUID(mandate_id_str)
            except ValueError:
                logger.warning(f"Invalid mandate_id format: {mandate_id_str}")
                return MCPResult(
                    success=False,
                    result=None,
                    error="Authority denied: Invalid mandate_id format"
                )

            # 3. Fetch Mandate
            mandate = self.authority_evaluator._get_mandate_with_cache(mandate_id)
            if not mandate:
                logger.warning(f"Mandate not found: {mandate_id}")
                not_found_error = MCPUnknownMandateError(f"Unknown mandate_id: {mandate_id}")
                return MCPResult(
                    success=False,
                    result=None,
                    error=f"Authority denied: {not_found_error}"
                )

            if not self._is_mandate_subject(principal_id, mandate):
                logger.warning(
                    f"Mandate subject mismatch for mandate {mandate_id}: "
                    f"caller={principal_id}, subject={getattr(mandate, 'subject_id', None)}"
                )
                return MCPResult(
                    success=False,
                    result=None,
                    error="Authority denied: Authenticated principal does not match mandate subject",
                )

            # 4. Validate Authority
            # Action: read, Resource: resource_uri
            caveat_kwargs = self._extract_caveat_authority_kwargs(mcp_context)
            decision = self.authority_evaluator.validate_mandate(
                mandate=mandate,
                requested_action="read",
                requested_resource=resource_uri,
                caller_principal_id=principal_id,
                **caveat_kwargs,
            )
            
            if not decision.allowed:
                logger.warning(
                    f"Authority denied for agent {principal_id}: {decision.reason}"
                )
                return MCPResult(
                    success=False,
                    result=None,
                    error=f"Authority denied: {decision.reason}"
                )
            
            logger.info(
                f"Authority granted for agent {principal_id}, resource {resource_uri} (mandate {mandate_id})"
            )
            
            # 5. Fetch resource from MCP server
            resource = await self._fetch_resource(resource_uri)
            
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
                    "mandate_id": str(mandate_id)
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
                f"MCP resource read completed: uri={resource_uri}, agent={principal_id}, "
                f"size={resource.size} bytes"
            )
            
            return MCPResult(
                success=True,
                result=resource,
                metadata={
                    "resource_size": resource.size,
                    "mandate_id": str(mandate_id)
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
                f"Failed to intercept MCP resource read '{resource_uri}' for agent {mcp_context.principal_id} (fail-closed): {e}",
                exc_info=True
            )
            
            return MCPResult(
                success=False,
                result=None,
                error=error_response.message
            )

    def _extract_principal_id(self, mcp_context: MCPContext) -> str:
        """
        Extract agent ID from MCP context.
        
        Args:
            mcp_context: MCP context
            
        Returns:
            Agent ID as string
            
        Raises:
            CaracalError: If agent ID not found in context (fail-closed)
        """
        principal_id = mcp_context.principal_id
            
        if not principal_id:
            # Fail closed: deny operation if agent ID cannot be determined (Requirement 23.3)
            error_handler = get_error_handler("mcp-adapter")
            error = CaracalError("Agent ID not found in MCP context")
            error_handler.handle_error(
                error=error,
                category=ErrorCategory.VALIDATION,
                operation="_extract_principal_id",
                metadata={"mcp_context_metadata": mcp_context.metadata},
                severity=ErrorSeverity.CRITICAL
            )
            
            logger.error("Agent ID not found in MCP context (fail-closed)")
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

    def _is_mandate_subject(self, principal_id: str, mandate: Any) -> bool:
        caller = self._normalize_principal_id(principal_id)
        subject = self._normalize_principal_id(getattr(mandate, "subject_id", None))
        if not caller or not subject:
            return False
        return caller == subject

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
        normalized_tool_id = self._normalize_tool_id(tool_id)

        tool_row = self.get_registered_tool(tool_id=normalized_tool_id, require_active=True)
        if tool_row is None:
            any_state_row = self.get_registered_tool(tool_id=normalized_tool_id, require_active=False)
            if any_state_row is None:
                raise MCPUnknownToolError(f"Unknown tool_id: {normalized_tool_id}")

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
                        f"Tool '{normalized_tool_id}' is inactive due provider drift: {drift_error}"
                    ) from drift_error

            raise CaracalError(f"Tool '{normalized_tool_id}' is inactive")

        provider_name = str(getattr(tool_row, "provider_name", "") or "").strip()
        resource_scope = str(getattr(tool_row, "resource_scope", "") or "").strip()
        action_scope = str(getattr(tool_row, "action_scope", "") or "").strip()
        provider_definition_id = str(getattr(tool_row, "provider_definition_id", "") or "").strip() or None
        workspace_name = self._normalize_workspace_name(
            getattr(tool_row, "workspace_name", None)
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
            tool_id=normalized_tool_id,
            execution_mode=execution_target["execution_mode"] or "mcp_forward",
            tool_type=tool_type,
            handler_ref=handler_ref,
        )

        if not provider_name or not resource_scope or not action_scope:
            raise MCPToolMappingMismatchError(
                f"Tool '{normalized_tool_id}' is missing provider/resource/action mapping"
            )

        session = self._get_registry_session()
        provider_row = session.query(GatewayProvider).filter_by(provider_id=provider_name).first()
        if provider_row is None:
            raise MCPProviderMissingError(
                f"Mapped provider '{provider_name}' for tool '{normalized_tool_id}' was removed"
            )
        if not bool(getattr(provider_row, "enabled", True)):
            raise MCPProviderMissingError(
                f"Mapped provider '{provider_name}' for tool '{normalized_tool_id}' is inactive"
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
        normalized_auth_scheme = auth_scheme.replace("-", "_").strip().lower()
        if require_credential and normalized_auth_scheme != "none":
            credential_ref = str(getattr(provider_row, "credential_ref", "") or "").strip()
            if not credential_ref:
                raise CaracalError(
                    f"Mapped provider '{provider_name}' for tool '{normalized_tool_id}' has no credential_ref"
                )

            workspace_name = self._resolve_workspace_name(mcp_context)
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
            "tool_id": normalized_tool_id,
            **mapping,
            "workspace_name": workspace_name,
            "tool_type": tool_type,
            "handler_ref": handler_ref,
            "mapping_version": mapping_version,
            "allowed_downstream_scopes": allowed_downstream_scopes,
            **execution_target,
        }

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

        raw_chain = (
            mcp_context.get("task_caveat_chain")
            or mcp_context.get("caveat_chain")
            or task_claims.get("task_caveat_chain")
        )
        if raw_chain is None:
            return {}
        if not isinstance(raw_chain, list):
            raise CaracalError("task_caveat_chain metadata must be a list")

        caveat_hmac_key = str(
            mcp_context.get("task_caveat_hmac_key")
            or mcp_context.get("caveat_hmac_key")
            or task_claims.get("task_caveat_hmac_key")
            or self._caveat_hmac_key
            or ""
        ).strip()
        if not caveat_hmac_key:
            raise CaracalError(
                "Caveat-chain enforcement requires a caveat HMAC key when task_caveat_chain is provided"
            )

        task_id = (
            mcp_context.get("task_id")
            or mcp_context.get("caveat_task_id")
            or task_claims.get("task_id")
        )
        resolved_task_id = str(task_id).strip() if task_id is not None else None

        return {
            "caveat_chain": raw_chain,
            "caveat_hmac_key": caveat_hmac_key,
            "caveat_task_id": resolved_task_id,
        }

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
        mandate_id: UUID,
        tool_args: Dict[str, Any],
    ) -> Any:
        bound_func = self._decorator_bindings.get(tool_id)
        if bound_func is None:
            raise CaracalError(f"No local function binding found for tool '{tool_id}'")

        call_kwargs = dict(tool_args or {})
        call_kwargs.pop("principal_id", None)
        call_kwargs.pop("mandate_id", None)
        call_kwargs["principal_id"] = principal_id
        call_kwargs["mandate_id"] = str(mandate_id)

        import inspect

        if inspect.iscoroutinefunction(bound_func):
            return await bound_func(**call_kwargs)
        return bound_func(**call_kwargs)

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

    async def _fetch_resource(self, resource_uri: str) -> MCPResource:
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
        if not self.mcp_server_url:
            raise CaracalError(
                "MCP server URL not configured — cannot fetch resource"
            )

        url = f"{self.mcp_server_url}/resource/read"
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
                f"Cannot connect to upstream MCP server at {self.mcp_server_url}: {exc}"
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
        - Mandate validation before execution
        - Metering events after execution
        - Error handling and logging
        
        Usage:
            @mcp_adapter.as_decorator(tool_id="provider:endframe:resource:deployments")
            async def my_mcp_tool(principal_id: str, mandate_id: str, **kwargs):
                # Tool implementation
                return result
        
        The decorated function must accept principal_id and mandate_id as arguments.
        
        Returns:
            Decorator function that wraps MCP tool functions
            
        """
        resolved_tool_id = str(tool_id or "").strip()
        if not resolved_tool_id:
            raise CaracalError("tool_id is required for MCP decorator registration")

        tool_row = self.get_registered_tool(tool_id=resolved_tool_id)
        if tool_row is None:
            raise CaracalError(
                f"tool_id '{resolved_tool_id}' is not registered in persisted tool registry"
            )
        if not bool(getattr(tool_row, "active", False)):
            raise CaracalError(
                f"tool_id '{resolved_tool_id}' is inactive and cannot be bound"
            )

        # Fail import-time binding if provider/action/resource mapping drifted.
        self._resolve_active_tool_mapping(
            tool_id=resolved_tool_id,
            mcp_context=None,
            require_credential=False,
        )

        def decorator(func):
            """
            Decorator that wraps an MCP tool function.
            
            Args:
                func: The MCP tool function to wrap
                
            Returns:
                Wrapped function with authority enforcement
            """
            existing = self._decorator_bindings.get(resolved_tool_id)
            if existing is not None and existing is not func:
                raise CaracalError(
                    f"tool_id '{resolved_tool_id}' is already bound to another local function"
                )
            self._decorator_bindings[resolved_tool_id] = func

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
                # Extract principal_id and mandate_id from arguments
                principal_id = None
                mandate_id = None
                tool_args = {}
                
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
                
                # Extract mandate_id
                if 'mandate_id' in call_kwargs:
                    mandate_id = call_kwargs.pop('mandate_id')
                # Check positional args if mandate_id is expected
                elif len(args) > 1 and len(param_names) > 1 and param_names[1] == 'mandate_id':
                    mandate_id = args[1]
                
                # If principal_id not found in args, try alternative names
                if not principal_id:
                    for key in ['agent', 'caracal_principal_id']:
                        if key in call_kwargs:
                            principal_id = call_kwargs.pop(key)
                            break
                            
                # Collect remaining args as tool_args
                # This is a simplification; in reality we'd need to map remaining args to param names
                tool_args = call_kwargs
                
                if not principal_id:
                    logger.error(
                        f"principal_id not provided to decorated MCP tool '{func.__name__}'"
                    )
                    raise CaracalError(
                        f"principal_id is required for MCP tool '{func.__name__}'."
                    )
                    
                if not mandate_id:
                    logger.error(
                        f"mandate_id not provided to decorated MCP tool '{func.__name__}'"
                    )
                    raise CaracalError(
                        f"mandate_id is required for MCP tool '{func.__name__}'."
                    )
                
                tool_name = resolved_tool_id
                
                # Create MCP context
                metadata: Dict[str, Any] = {
                    "tool_name": tool_name,
                    "tool_id": tool_name,
                    "decorator_mode": True,
                    "mandate_id": str(mandate_id),
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
                    metadata["task_token_claims"] = task_token_claims

                mcp_context = MCPContext(
                    principal_id=str(principal_id),
                    metadata=metadata,
                )
                
                logger.debug(
                    f"Decorator intercepting MCP tool: tool={tool_name}, agent={principal_id}"
                )
                
                try:
                    # 1. Fetch Mandate
                    try:
                        mandate_uuid = UUID(str(mandate_id))
                    except ValueError:
                        raise CaracalError(f"Invalid mandate_id format: {mandate_id}")
                        
                    mandate = self.authority_evaluator._get_mandate_with_cache(mandate_uuid)
                    if not mandate:
                        raise MCPUnknownMandateError(f"Unknown mandate_id: {mandate_id}")

                    if not self._is_mandate_subject(str(principal_id), mandate):
                        raise CaracalError(
                            "Authority denied: Authenticated principal does not match mandate subject"
                        )

                    tool_mapping = self._resolve_active_tool_mapping(
                        tool_id=tool_name,
                        mcp_context=mcp_context,
                        require_credential=True,
                    )

                    # 2. Validate Authority
                    caveat_kwargs = self._extract_caveat_authority_kwargs(mcp_context)
                    decision = self.authority_evaluator.validate_mandate(
                        mandate=mandate,
                        requested_action=tool_mapping["action_scope"],
                        requested_resource=tool_mapping["resource_scope"],
                        caller_principal_id=str(principal_id),
                        **caveat_kwargs,
                    )
                    
                    if not decision.allowed:
                        logger.warning(
                            f"Authority denied for agent {principal_id}: {decision.reason}"
                        )
                        raise CaracalError(f"Authority denied: {decision.reason}")
                    
                    logger.info(
                        f"Authority granted for agent {principal_id}, tool {tool_name}"
                    )
                    
                    # 3. Execute the actual tool function
                    if inspect.iscoroutinefunction(func):
                        tool_result = await func(*args, **kwargs)
                    else:
                        tool_result = func(*args, **kwargs)
                    
                    # 4. Emit metering event with enhanced features
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
                            "mandate_id": str(mandate_id)
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
                        f"MCP tool call completed (decorated): tool={tool_name}, agent={principal_id}"
                    )
                    
                    return tool_result
            
                except CaracalError:
                    raise
                except Exception as e:
                    # Fail closed
                    logger.error(
                        f"Failed to execute decorated tool '{tool_name}' for agent {principal_id}: {e}",
                        exc_info=True
                    )
                    raise CaracalError(f"Tool execution failed: {e}")
            
            return wrapper
        
        return decorator
