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
from caracal.db.models import RegisteredTool
from caracal.core.error_handling import (
    get_error_handler,
    handle_error_with_denial,
    ErrorCategory,
    ErrorSeverity
)
from caracal.exceptions import CaracalError
from caracal.logging_config import get_logger

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
        self.request_timeout_seconds = request_timeout_seconds
        resolved_mode = caveat_mode or os.environ.get("CARACAL_SESSION_CAVEAT_MODE") or "jwt"
        self._caveat_mode = self._resolve_caveat_mode(resolved_mode)
        self._caveat_hmac_key = str(
            caveat_hmac_key
            or os.environ.get("CARACAL_SESSION_CAVEAT_HMAC_KEY")
            or ""
        ).strip()
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

    def _get_registry_session(self):
        session = getattr(self.authority_evaluator, "db_session", None)
        if session is None:
            raise CaracalError("MCP adapter requires an authority evaluator DB session")
        return session

    def register_tool(self, *, tool_id: str, active: bool = True) -> RegisteredTool:
        """Create or update a persisted tool registration record."""
        normalized_tool_id = self._normalize_tool_id(tool_id)
        session = self._get_registry_session()

        existing = (
            session.query(RegisteredTool)
            .filter_by(tool_id=normalized_tool_id)
            .first()
        )
        if existing:
            existing.active = bool(active)
            existing.updated_at = datetime.utcnow()
            session.flush()
            session.commit()
            return existing

        row = RegisteredTool(tool_id=normalized_tool_id, active=bool(active))
        session.add(row)
        try:
            session.flush()
            session.commit()
        except IntegrityError as exc:
            session.rollback()
            raise CaracalError(f"Tool already registered: {normalized_tool_id}") from exc

        return row

    def list_registered_tools(self, *, include_inactive: bool = True) -> list[RegisteredTool]:
        """List persisted tool registrations."""
        session = self._get_registry_session()
        query = session.query(RegisteredTool)
        if not include_inactive:
            query = query.filter_by(active=True)
        return query.order_by(RegisteredTool.created_at.asc()).all()

    def deactivate_tool(self, *, tool_id: str) -> RegisteredTool:
        """Deactivate an existing tool registration."""
        normalized_tool_id = self._normalize_tool_id(tool_id)
        session = self._get_registry_session()

        row = session.query(RegisteredTool).filter_by(tool_id=normalized_tool_id).first()
        if not row:
            raise CaracalError(f"Unknown tool_id: {normalized_tool_id}")

        if not row.active:
            return row

        row.active = False
        row.updated_at = datetime.utcnow()
        session.flush()
        session.commit()
        return row

    def reactivate_tool(self, *, tool_id: str) -> RegisteredTool:
        """Reactivate an existing tool registration."""
        normalized_tool_id = self._normalize_tool_id(tool_id)
        session = self._get_registry_session()

        row = session.query(RegisteredTool).filter_by(tool_id=normalized_tool_id).first()
        if not row:
            raise CaracalError(f"Unknown tool_id: {normalized_tool_id}")

        if row.active:
            return row

        row.active = True
        row.updated_at = datetime.utcnow()
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
                return MCPResult(
                    success=False,
                    result=None,
                    error="Authority denied: Mandate not found"
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
            # Action: execute, Resource: tool_name
            caveat_kwargs = self._extract_caveat_authority_kwargs(mcp_context)
            decision = self.authority_evaluator.validate_mandate(
                mandate=mandate,
                requested_action="execute",
                requested_resource=tool_name,
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
            
            # 5. Forward to MCP server (simulated - actual forwarding in production)
            # In a real implementation, this would call the actual MCP server
            tool_result = await self._forward_to_mcp_server(tool_name, tool_args)
            
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
                    "mandate_id": str(mandate_id)
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
                return MCPResult(
                    success=False,
                    result=None,
                    error="Authority denied: Mandate not found"
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

    async def _forward_to_mcp_server(
        self,
        tool_name: str,
        tool_args: Dict[str, Any]
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
        if not self.mcp_server_url:
            raise CaracalError(
                "MCP server URL not configured — cannot forward tool call"
            )

        url = f"{self.mcp_server_url}/tool/call"
        payload = {
            "tool_name": tool_name,
            "tool_args": tool_args,
        }

        logger.debug(
            f"Forwarding MCP tool call to upstream: url={url}, tool={tool_name}"
        )

        try:
            client = await self._get_http_client()
            response = await client.post(url, json=payload)

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
                f"Cannot connect to upstream MCP server at {self.mcp_server_url}: {exc}"
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

        def decorator(func):
            """
            Decorator that wraps an MCP tool function.
            
            Args:
                func: The MCP tool function to wrap
                
            Returns:
                Wrapped function with authority enforcement
            """
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
                        raise CaracalError(f"Mandate not found: {mandate_id}")

                    if not self._is_mandate_subject(str(principal_id), mandate):
                        raise CaracalError(
                            "Authority denied: Authenticated principal does not match mandate subject"
                        )

                    # 2. Validate Authority
                    caveat_kwargs = self._extract_caveat_authority_kwargs(mcp_context)
                    decision = self.authority_evaluator.validate_mandate(
                        mandate=mandate,
                        requested_action="execute",
                        requested_resource=tool_name,
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
