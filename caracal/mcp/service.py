"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

MCP Adapter Standalone Service for Caracal Core v0.2.

Provides HTTP API for MCP request proxying with authority enforcement:
- HTTP API for intercepting MCP tool calls and resource reads
- Health check endpoints for monitoring
- Configuration loading from YAML or environment variables
- Integration with Caracal Core policy evaluation and metering

"""

import asyncio
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional
from uuid import UUID

import httpx
from fastapi import FastAPI, Request, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from caracal._version import __version__
from caracal.mcp.adapter import MCPAdapter, MCPContext, MCPResult
from caracal.core.authority import AuthorityEvaluator
from caracal.core.metering import MeteringCollector
from caracal.db.models import RegisteredTool
from caracal.exceptions import (
    CaracalError,
    MCPProviderMissingError,
    MCPToolMappingMismatchError,
    MCPUnknownToolError,
)
from caracal.logging_config import get_logger, setup_runtime_logging
from caracal.mcp.tool_registry_contract import validate_active_tool_mappings

logger = get_logger(__name__)

# Canonical MCP payload contracts (hard-cut release gates depend on these markers).
CANONICAL_TOOL_CALL_CONTRACT_VERSION = "v1"
CANONICAL_TOOL_REGISTRY_CONTRACT_VERSION = "v1"


@dataclass
class MCPServerConfig:
    """
    Configuration for an MCP server.
    
    Attributes:
        name: Name of the MCP server
        url: Base URL of the MCP server
        timeout_seconds: Request timeout in seconds (default: 30)
    """
    name: str
    url: str
    timeout_seconds: int = 30


@dataclass
class MCPServiceConfig:
    """
    Configuration for MCP Adapter Standalone Service.
    
    Attributes:
        listen_address: Address to bind the server (e.g., "0.0.0.0:8080")
        mcp_servers: List of MCP server configurations
        request_timeout_seconds: Timeout for forwarded requests (default: 30)
        max_request_size_mb: Maximum request body size in MB (default: 10)
        enable_health_check: Enable health check endpoint (default: True)
        health_check_path: Path for health check endpoint (default: "/health")
    """
    listen_address: str = "0.0.0.0:8080"
    mcp_servers: list = None
    request_timeout_seconds: int = 30
    max_request_size_mb: int = 10
    enable_health_check: bool = True
    health_check_path: str = "/health"
    log_level: str = "info"
    
    def __post_init__(self):
        if self.mcp_servers is None:
            self.mcp_servers = []


# Pydantic models for API requests/responses
class _StrictRequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ToolCallRequest(_StrictRequestModel):
    """Request model for MCP tool call."""
    tool_id: str = Field(..., description="Explicit registered tool identifier")
    tool_args: Dict[str, Any] = Field(default_factory=dict, description="Arguments for the tool")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional metadata")

class ResourceReadRequest(_StrictRequestModel):
    """Request model for MCP resource read."""
    resource_uri: str = Field(..., description="URI of the resource to read")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional metadata")

class ToolRegistryRequest(_StrictRequestModel):
    """Request model for tool registry write operations."""

    tool_id: str = Field(..., description="Explicit tool identifier")
    workspace_name: Optional[str] = Field(
        None,
        description="Optional workspace selector for deterministic registry targeting",
    )

class ToolRegistryRegisterRequest(ToolRegistryRequest):
    """Request model for tool registration."""

    active: bool = Field(True, description="Whether the tool should be active")
    provider_name: str = Field(..., description="Workspace provider name")
    resource_scope: str = Field(..., description="Canonical provider resource scope")
    action_scope: str = Field(..., description="Canonical provider action scope")
    provider_definition_id: Optional[str] = Field(
        None,
        description="Provider definition identifier",
    )
    action_method: Optional[str] = Field(
        None,
        description="Expected HTTP method for action contract validation",
    )
    action_path_prefix: Optional[str] = Field(
        None,
        description="Expected path prefix for action contract validation",
    )
    execution_mode: str = Field(
        "mcp_forward",
        description="Execution target mode ('local' or 'mcp_forward')",
    )
    mcp_server_name: Optional[str] = Field(
        None,
        description="Optional named upstream target for forward-routed execution",
    )
    workspace_name: Optional[str] = Field(
        None,
        description="Optional workspace name used for deterministic binding identity",
    )
    tool_type: str = Field(
        "direct_api",
        description="Tool behavior type: direct_api (provider-action pass-through) or logic (user-defined logic)",
    )
    handler_ref: Optional[str] = Field(
        None,
        description="Handler reference for local logic tools (module:function)",
    )
    mapping_version: Optional[str] = Field(
        None,
        description="Optional mapping fingerprint/version for drift detection",
    )
    allowed_downstream_scopes: list[str] = Field(
        default_factory=list,
        description="Optional provider scopes that logic tools may call downstream",
    )


class MCPServiceResponse(BaseModel):
    """Response model for MCP service operations."""
    success: bool = Field(..., description="Whether the operation succeeded")
    result: Any = Field(None, description="Operation result")
    error: Optional[str] = Field(None, description="Error message if operation failed")
    metadata: Optional[Dict[str, Any]] = Field(None, description="Additional metadata")


class HealthCheckResponse(BaseModel):
    """Response model for health check."""
    status: str = Field(..., description="Health status (healthy/unhealthy)")
    service: str = Field(..., description="Service name")
    version: str = Field(..., description="Service version")
    mcp_servers: Dict[str, str] = Field(default_factory=dict, description="MCP server statuses")


class MCPAdapterService:
    """
    Standalone HTTP service for MCP adapter.
    
    Provides HTTP API for intercepting MCP tool calls and resource reads,
    enforcing authority policies, and forwarding requests to MCP servers.
    
    """

    _SERVER_CONTROLLED_SECURITY_METADATA_FIELDS = (
        "principal_id",
        "mandate_id",
        "resolved_mandate_id",
        "policy_id",
        "task_token_claims",
        "token_subject",
        "task_caveat_chain",
        "task_caveat_hmac_key",
        "task_id",
        "caveat_chain",
        "caveat_hmac_key",
        "caveat_task_id",
    )
    _SERVER_CONTROLLED_TOOL_ARGUMENT_FIELDS = (
        "principal_id",
        "mandate_id",
        "resolved_mandate_id",
        "policy_id",
    )
    
    def __init__(
        self,
        config: MCPServiceConfig,
        mcp_adapter: MCPAdapter,
        authority_evaluator: AuthorityEvaluator,
        metering_collector: MeteringCollector,
        db_connection_manager: Optional[Any] = None,
        session_manager: Optional[Any] = None,
    ):
        """
        Initialize MCP Adapter Service.
        
        Args:
            config: MCPServiceConfig with server settings
            mcp_adapter: MCPAdapter for authority enforcement
            authority_evaluator: AuthorityEvaluator for mandate checks
            metering_collector: MeteringCollector for metering events
            db_connection_manager: Optional DatabaseConnectionManager for health checks
        """
        self.config = config
        self.mcp_adapter = mcp_adapter
        self.authority_evaluator = authority_evaluator
        self.metering_collector = metering_collector
        self.db_connection_manager = db_connection_manager
        self.session_manager = session_manager
        
        # Create FastAPI app
        self.app = FastAPI(
            title="Caracal MCP Adapter Service",
            description="HTTP API for MCP request proxying with authority enforcement",
            version=__version__
        )
        
        # Register routes
        self._register_routes()
        
        # HTTP clients for MCP servers
        self.mcp_clients = {}
        for server_config in config.mcp_servers:
            self.mcp_clients[server_config.name] = httpx.AsyncClient(
                base_url=server_config.url,
                timeout=httpx.Timeout(server_config.timeout_seconds),
                follow_redirects=True
            )
        
        # Statistics
        self._request_count = 0
        self._tool_call_count = 0
        self._resource_read_count = 0
        self._allowed_count = 0
        self._denied_count = 0
        self._error_count = 0
        
        logger.info(
            f"Initialized MCPAdapterService with {len(config.mcp_servers)} MCP servers"
        )

    @staticmethod
    def _extract_bearer_token(auth_header: Optional[str]) -> str:
        """Extract Bearer token from Authorization header."""
        raw = str(auth_header or "").strip()
        if not raw:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Missing Authorization header",
            )

        parts = raw.split(" ", 1)
        if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid Authorization header format; expected Bearer token",
            )
        return parts[1].strip()

    async def _resolve_authenticated_principal(
        self,
        *,
        raw_request: Request,
    ) -> tuple[str, Dict[str, Any]]:
        """Validate caller token and return authenticated principal identity."""
        if self.session_manager is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Session validation is not configured",
            )

        token = self._extract_bearer_token(raw_request.headers.get("Authorization"))
        try:
            claims = await self.session_manager.validate_access_token(token)
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=f"Invalid access token: {exc}",
            ) from exc

        if not isinstance(claims, dict):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid access token: claims payload must be an object",
            )

        sub_claim = str(claims.get("sub") or "").strip()
        principal_claim = str(claims.get("principal_id") or "").strip()
        if sub_claim and principal_claim and sub_claim != principal_claim:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Validated access token has mismatched principal subject claims",
            )

        principal_id = sub_claim or principal_claim
        if not principal_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Validated access token is missing subject claim",
            )

        try:
            principal_id = str(UUID(principal_id))
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Validated access token subject claim must be a UUID",
            ) from exc

        return principal_id, claims

    @staticmethod
    def _normalize_selector_value(value: Any) -> Optional[str]:
        value = str(value or "").strip()
        return value or None

    def _reject_spoofed_security_metadata(self, metadata: Dict[str, Any]) -> Dict[str, Any]:
        """Reject caller-supplied security metadata fields that are server-controlled."""
        metadata = dict(metadata or {})
        spoofed_fields = [
            field
            for field in self._SERVER_CONTROLLED_SECURITY_METADATA_FIELDS
            if field in metadata
        ]
        if spoofed_fields:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Request metadata contains server-controlled security fields: "
                    + ", ".join(sorted(spoofed_fields))
                ),
            )

        return metadata

    def _reject_spoofed_tool_args(self, tool_args: Dict[str, Any]) -> Dict[str, Any]:
        """Reject caller-supplied tool args that attempt to override identity binding."""
        tool_args = dict(tool_args or {})
        spoofed_fields = [
            field
            for field in self._SERVER_CONTROLLED_TOOL_ARGUMENT_FIELDS
            if field in tool_args
        ]
        if spoofed_fields:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Tool arguments contain server-controlled security fields: "
                    + ", ".join(sorted(spoofed_fields))
                ),
            )
        return tool_args

    def _apply_trusted_security_metadata(
        self,
        *,
        metadata: Dict[str, Any],
        token_claims: Dict[str, Any],
        principal_id: str,
    ) -> Dict[str, Any]:
        """Inject trusted security metadata derived from validated token claims."""
        metadata = dict(metadata or {})
        trusted_claims = dict(token_claims or {})

        metadata["task_token_claims"] = trusted_claims
        metadata["token_subject"] = principal_id

        task_chain = trusted_claims.get("task_caveat_chain")
        if task_chain is None:
            task_chain = trusted_claims.get("caveat_chain")
        if task_chain is not None:
            metadata["task_caveat_chain"] = task_chain

        task_hmac_key = trusted_claims.get("task_caveat_hmac_key")
        if task_hmac_key is None:
            task_hmac_key = trusted_claims.get("caveat_hmac_key")
        if task_hmac_key is not None:
            metadata["task_caveat_hmac_key"] = task_hmac_key

        task_id = trusted_claims.get("task_id")
        if task_id is None:
            task_id = trusted_claims.get("caveat_task_id")
        if task_id is not None:
            metadata["task_id"] = task_id

        # Keep only canonical keys in metadata passed to adapter.
        metadata.pop("caveat_chain", None)
        metadata.pop("caveat_hmac_key", None)
        metadata.pop("caveat_task_id", None)

        return metadata

    def _normalize_workspace_scope_metadata(
        self,
        *,
        raw_request: Request,
        metadata: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Normalize workspace selector from metadata and SDK scope headers."""
        metadata = dict(metadata or {})

        metadata_workspace_values: list[str] = []
        for key in ("workspace", "workspace_name"):
            value = self._normalize_selector_value(metadata.get(key))
            if value and value not in metadata_workspace_values:
                metadata_workspace_values.append(value)
        if len(metadata_workspace_values) > 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Workspace selector mismatch between metadata.workspace and metadata.workspace_name",
            )

        header_workspace_values: list[str] = []
        for header_name in (
            "X-Caracal-Workspace-ID",
            "X-Caracal-Workspace-Name",
            "X-Workspace-Id",
        ):
            header_value = self._normalize_selector_value(raw_request.headers.get(header_name))
            if header_value and header_value not in header_workspace_values:
                header_workspace_values.append(header_value)
        if len(header_workspace_values) > 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Workspace selector mismatch between workspace headers",
            )

        metadata_workspace = metadata_workspace_values[0] if metadata_workspace_values else None
        header_workspace = header_workspace_values[0] if header_workspace_values else None
        if metadata_workspace and header_workspace and metadata_workspace != header_workspace:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Workspace selector mismatch between metadata.workspace/workspace_name "
                    "and X-Caracal-Workspace-ID header"
                ),
            )

        selected_workspace = metadata_workspace or header_workspace
        if selected_workspace:
            metadata["workspace"] = selected_workspace
            metadata["workspace_name"] = selected_workspace

        return metadata

    def _normalize_provider_selector_metadata(
        self,
        *,
        raw_request: Request,
        metadata: Dict[str, Any],
        tool_row: Any,
    ) -> Dict[str, Any]:
        """Normalize provider selector fields from request body + headers and reject conflicts."""
        metadata = dict(metadata or {})

        selector_specs = (
            ("provider_name", "X-Caracal-Provider-Name", "Provider"),
            (
                "provider_definition_id",
                "X-Caracal-Provider-Definition-ID",
                "Provider definition",
            ),
            ("resource_scope", "X-Caracal-Resource-Scope", "Resource scope"),
            ("action_scope", "X-Caracal-Action-Scope", "Action scope"),
        )
        selected_values: Dict[str, Optional[str]] = {}

        for metadata_key, header_name, label in selector_specs:
            body_value = self._normalize_selector_value(metadata.get(metadata_key))
            header_value = self._normalize_selector_value(raw_request.headers.get(header_name))
            if body_value and header_value and body_value != header_value:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        f"{label} selector mismatch between metadata.{metadata_key} "
                        f"and {header_name} header"
                    ),
                )
            selected_values[metadata_key] = body_value or header_value

        provider_name = selected_values["provider_name"]
        provider_definition_id = selected_values["provider_definition_id"]
        resource_scope = selected_values["resource_scope"]
        action_scope = selected_values["action_scope"]

        mapped_provider_name = self._normalize_selector_value(getattr(tool_row, "provider_name", None))
        mapped_definition_id = self._normalize_selector_value(
            getattr(tool_row, "provider_definition_id", None)
        )
        mapped_resource_scope = self._normalize_selector_value(getattr(tool_row, "resource_scope", None))
        mapped_action_scope = self._normalize_selector_value(getattr(tool_row, "action_scope", None))
        if provider_name and mapped_provider_name and provider_name != mapped_provider_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Provider selector '{provider_name}' does not match mapped provider "
                    f"'{mapped_provider_name}' for requested tool"
                ),
            )
        if (
            provider_definition_id
            and mapped_definition_id
            and provider_definition_id != mapped_definition_id
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Provider definition selector '{provider_definition_id}' does not match mapped "
                    f"provider definition '{mapped_definition_id}' for requested tool"
                ),
            )
        if resource_scope and mapped_resource_scope and resource_scope != mapped_resource_scope:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Resource scope selector '{resource_scope}' does not match mapped "
                    f"resource scope '{mapped_resource_scope}' for requested tool"
                ),
            )
        if action_scope and mapped_action_scope and action_scope != mapped_action_scope:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Action scope selector '{action_scope}' does not match mapped "
                    f"action scope '{mapped_action_scope}' for requested tool"
                ),
            )

        metadata["provider_name"] = mapped_provider_name or provider_name
        metadata["provider_definition_id"] = mapped_definition_id or provider_definition_id
        metadata["resource_scope"] = mapped_resource_scope or resource_scope
        metadata["action_scope"] = mapped_action_scope or action_scope

        metadata = {
            key: value
            for key, value in metadata.items()
            if value is not None
        }

        return metadata

    def _require_active_tool(
        self,
        tool_id: str,
        workspace_name: Optional[str] = None,
    ):
        tool_id = str(tool_id or "").strip()
        if not tool_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Missing tool_id",
            )

        try:
            row = self.mcp_adapter.get_registered_tool(
                tool_id=tool_id,
                require_active=False,
                workspace_name=workspace_name,
            )
        except CaracalError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Tool registry unavailable: {exc}",
            ) from exc

        if row is None:
            raise MCPUnknownToolError("Unknown tool_id")
        if not bool(getattr(row, "active", False)):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Tool is inactive",
            )
        return row

    @staticmethod
    def _is_denied_error_message(message: Optional[str]) -> bool:
        message = str(message or "").strip().lower()
        if not message:
            return False
        return (
            "authority denied" in message
            or "mandate subject" in message
            or "no applicable mandate" in message
        )

    def _record_result_outcome(self, result: MCPResult) -> None:
        if result.success:
            self._allowed_count += 1
            return
        if self._is_denied_error_message(result.error):
            self._denied_count += 1
            return
        self._error_count += 1

    def _record_http_exception_outcome(self, exc: HTTPException) -> None:
        if exc.status_code < 500:
            self._denied_count += 1
            return
        self._error_count += 1
    
    def _register_routes(self):
        """Register FastAPI routes."""

        def _serialize_tool_row(row: Any) -> Dict[str, Any]:
            return {
                "tool_id": str(getattr(row, "tool_id", "")),
                "active": bool(getattr(row, "active", False)),
                "workspace_name": getattr(row, "workspace_name", None),
                "provider_name": getattr(row, "provider_name", None),
                "resource_scope": getattr(row, "resource_scope", None),
                "action_scope": getattr(row, "action_scope", None),
                "provider_definition_id": getattr(row, "provider_definition_id", None),
                "tool_type": getattr(row, "tool_type", None),
                "handler_ref": getattr(row, "handler_ref", None),
                "mapping_version": getattr(row, "mapping_version", None),
                "allowed_downstream_scopes": list(
                    getattr(row, "allowed_downstream_scopes", []) or []
                ),
                "execution_mode": getattr(row, "execution_mode", None),
                "mcp_server_name": getattr(row, "mcp_server_name", None),
            }
        
        @self.app.get(self.config.health_check_path, response_model=HealthCheckResponse)
        async def health_check():
            """
            Health check endpoint for liveness/readiness probes.
            
            Checks:
            - Database connectivity (if db_connection_manager provided)
            - MCP server connectivity
            
            Returns:
            - 200 OK: Service is healthy and all dependencies are available
            - 503 Service Unavailable: Service is in degraded mode (some dependencies unavailable)
            
            """
            mcp_server_statuses = {}
            
            # Check connectivity to each MCP server
            for server_name, client in self.mcp_clients.items():
                try:
                    # Try to connect to the MCP server's health endpoint
                    # Most MCP servers should have a health or status endpoint
                    response = await client.get("/health", timeout=5.0)
                    if response.status_code == 200:
                        mcp_server_statuses[server_name] = "healthy"
                    else:
                        mcp_server_statuses[server_name] = f"unhealthy (status={response.status_code})"
                except httpx.TimeoutException:
                    mcp_server_statuses[server_name] = "unhealthy (timeout)"
                except httpx.ConnectError:
                    mcp_server_statuses[server_name] = "unhealthy (connection_failed)"
                except Exception as e:
                    mcp_server_statuses[server_name] = f"unhealthy ({type(e).__name__})"
            
            # Check database connectivity
            db_healthy = True
            db_status = "not_configured"
            if self.db_connection_manager:
                try:
                    db_healthy = self.db_connection_manager.health_check()
                    db_status = "healthy" if db_healthy else "unhealthy"
                except Exception as e:
                    db_healthy = False
                    db_status = f"unhealthy ({type(e).__name__})"
                    logger.error(f"Database health check failed: {e}")
            
            # Add database status to response
            mcp_server_statuses["database"] = db_status
            
            # Determine overall status
            # Service is healthy only if database AND all MCP servers are healthy
            all_mcp_healthy = all(
                status == "healthy" 
                for name, status in mcp_server_statuses.items() 
                if name != "database"
            )
            overall_healthy = db_healthy and all_mcp_healthy
            
            # Return 503 if any dependency is unhealthy (degraded mode)
            if not overall_healthy:
                overall_status = "degraded"
                status_code = status.HTTP_503_SERVICE_UNAVAILABLE
                logger.warning(
                    f"MCP Adapter in degraded mode: db_healthy={db_healthy}, "
                    f"mcp_servers_healthy={all_mcp_healthy}"
                )
            else:
                overall_status = "healthy"
                status_code = status.HTTP_200_OK
            
            response_data = HealthCheckResponse(
                status=overall_status,
                service="caracal-mcp-adapter",
                version=__version__,
                mcp_servers=mcp_server_statuses
            )
            
            return JSONResponse(
                status_code=status_code,
                content=response_data.dict()
            )
        
        @self.app.get("/stats")
        async def get_stats():
            """
            Get service statistics.
            
            Returns request counts and performance metrics.
            """
            return {
                "requests_total": self._request_count,
                "tool_calls_total": self._tool_call_count,
                "resource_reads_total": self._resource_read_count,
                "requests_allowed": self._allowed_count,
                "requests_denied": self._denied_count,
                "errors_total": self._error_count,
                "mcp_servers": [
                    {"name": server.name, "url": server.url}
                    for server in self.config.mcp_servers
                ]
            }

        @self.app.post("/mcp/tools/register", response_model=MCPServiceResponse)
        async def register_tool(request: ToolRegistryRegisterRequest, raw_request: Request):
            """Register or update persisted tool lifecycle state."""
            principal_id, _ = await self._resolve_authenticated_principal(raw_request=raw_request)
            try:
                row = self.mcp_adapter.register_tool(
                    tool_id=request.tool_id,
                    active=request.active,
                    actor_principal_id=principal_id,
                    provider_name=request.provider_name,
                    resource_scope=request.resource_scope,
                    action_scope=request.action_scope,
                    provider_definition_id=request.provider_definition_id,
                    action_method=request.action_method,
                    action_path_prefix=request.action_path_prefix,
                    execution_mode=request.execution_mode,
                    mcp_server_name=request.mcp_server_name,
                    workspace_name=request.workspace_name,
                    tool_type=request.tool_type,
                    handler_ref=request.handler_ref,
                    mapping_version=request.mapping_version,
                    allowed_downstream_scopes=request.allowed_downstream_scopes,
                )
            except CaracalError as exc:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=str(exc),
                ) from exc

            return MCPServiceResponse(
                success=True,
                result=_serialize_tool_row(row),
                metadata={
                    "actor_principal_id": principal_id,
                    "contract_version": CANONICAL_TOOL_REGISTRY_CONTRACT_VERSION,
                },
            )

        @self.app.get("/mcp/tools", response_model=MCPServiceResponse)
        async def list_tools(raw_request: Request, include_inactive: bool = False):
            """List persisted tool registrations."""
            principal_id, _ = await self._resolve_authenticated_principal(raw_request=raw_request)
            workspace_metadata = self._normalize_workspace_scope_metadata(
                raw_request=raw_request,
                metadata={},
            )
            rows = self.mcp_adapter.list_registered_tools(
                include_inactive=include_inactive,
                workspace_name=self._normalize_selector_value(
                    workspace_metadata.get("workspace_name")
                ),
            )
            return MCPServiceResponse(
                success=True,
                result={"tools": [_serialize_tool_row(row) for row in rows]},
                metadata={
                    "actor_principal_id": principal_id,
                    "contract_version": CANONICAL_TOOL_REGISTRY_CONTRACT_VERSION,
                },
            )

        @self.app.post("/mcp/tools/deactivate", response_model=MCPServiceResponse)
        async def deactivate_tool(request: ToolRegistryRequest, raw_request: Request):
            """Deactivate a persisted tool registration."""
            principal_id, _ = await self._resolve_authenticated_principal(raw_request=raw_request)
            workspace_metadata = self._normalize_workspace_scope_metadata(
                raw_request=raw_request,
                metadata={"workspace_name": request.workspace_name},
            )
            try:
                row = self.mcp_adapter.deactivate_tool(
                    tool_id=request.tool_id,
                    actor_principal_id=principal_id,
                    workspace_name=self._normalize_selector_value(
                        workspace_metadata.get("workspace_name")
                    ),
                )
            except CaracalError as exc:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=str(exc),
                ) from exc

            return MCPServiceResponse(
                success=True,
                result=_serialize_tool_row(row),
                metadata={
                    "actor_principal_id": principal_id,
                    "contract_version": CANONICAL_TOOL_REGISTRY_CONTRACT_VERSION,
                },
            )

        @self.app.post("/mcp/tools/reactivate", response_model=MCPServiceResponse)
        async def reactivate_tool(request: ToolRegistryRequest, raw_request: Request):
            """Reactivate a persisted tool registration."""
            principal_id, _ = await self._resolve_authenticated_principal(raw_request=raw_request)
            workspace_metadata = self._normalize_workspace_scope_metadata(
                raw_request=raw_request,
                metadata={"workspace_name": request.workspace_name},
            )
            try:
                row = self.mcp_adapter.reactivate_tool(
                    tool_id=request.tool_id,
                    actor_principal_id=principal_id,
                    workspace_name=self._normalize_selector_value(
                        workspace_metadata.get("workspace_name")
                    ),
                )
            except CaracalError as exc:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=str(exc),
                ) from exc

            return MCPServiceResponse(
                success=True,
                result=_serialize_tool_row(row),
                metadata={
                    "actor_principal_id": principal_id,
                    "contract_version": CANONICAL_TOOL_REGISTRY_CONTRACT_VERSION,
                },
            )
        
        @self.app.post("/mcp/tool/call", response_model=MCPServiceResponse)
        async def tool_call(request: ToolCallRequest, raw_request: Request):
            """
            Intercept and forward MCP tool call.
            
            This endpoint:
            1. Extracts principal ID and tool information from request
            2. Performs authority check via MCPAdapter
            3. Forwards tool call to appropriate MCP server
            4. Emits metering event
            5. Returns result
            
            Args:
                request: ToolCallRequest with tool name and args
                
            Returns:
                MCPServiceResponse with tool execution result
                
            """
            start_time = time.time()
            self._request_count += 1
            self._tool_call_count += 1
            
            try:
                principal_id, token_claims = await self._resolve_authenticated_principal(
                    raw_request=raw_request,
                )

                logger.info(
                    f"Received tool call request: tool={request.tool_id}, "
                    f"principal={principal_id}"
                )

                request_metadata = self._reject_spoofed_security_metadata(request.metadata or {})
                request_metadata = self._normalize_workspace_scope_metadata(
                    raw_request=raw_request,
                    metadata=request_metadata,
                )
                workspace_name = self._normalize_selector_value(
                    request_metadata.get("workspace_name")
                )
                try:
                    tool_row = self._require_active_tool(
                        request.tool_id,
                        workspace_name=workspace_name,
                    )
                except MCPUnknownToolError as exc:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail=str(exc),
                    ) from exc
                request_metadata = self._normalize_provider_selector_metadata(
                    raw_request=raw_request,
                    metadata=request_metadata,
                    tool_row=tool_row,
                )
                request_metadata = self._apply_trusted_security_metadata(
                    metadata=request_metadata,
                    token_claims=token_claims,
                    principal_id=principal_id,
                )
                request_tool_args = self._reject_spoofed_tool_args(request.tool_args or {})
                
                # Create MCP context
                mcp_context = MCPContext(
                    principal_id=principal_id,
                    metadata=request_metadata
                )
                
                # Intercept tool call through MCPAdapter
                # This handles authority check, forwarding, and metering
                result = await self.mcp_adapter.intercept_tool_call(
                    tool_name=request.tool_id,
                    tool_args=request_tool_args,
                    mcp_context=mcp_context
                )
                self._record_result_outcome(result)
                
                duration_ms = (time.time() - start_time) * 1000
                logger.info(
                    f"Tool call completed: tool={request.tool_id}, "
                    f"principal={principal_id}, success={result.success}, "
                    f"duration={duration_ms:.2f}ms"
                )
                
                return MCPServiceResponse(
                    success=result.success,
                    result=result.result,
                    error=result.error,
                    metadata={
                        **dict(result.metadata or {}),
                        "contract_version": CANONICAL_TOOL_CALL_CONTRACT_VERSION,
                    },
                )
                
            except HTTPException as exc:
                self._record_http_exception_outcome(exc)
                raise
            except (MCPToolMappingMismatchError, MCPProviderMissingError) as e:
                self._denied_count += 1
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=str(e),
                ) from e
            except CaracalError as e:
                if self._is_denied_error_message(str(e)):
                    self._denied_count += 1
                else:
                    self._error_count += 1
                logger.error(
                    f"Caracal error during tool call: tool={request.tool_id}, "
                    f"principal=unknown, error={e}"
                )
                return MCPServiceResponse(
                    success=False,
                    result=None,
                    error=f"Caracal error: {e}",
                    metadata={
                        "error_type": "caracal_error",
                        "error_class": e.__class__.__name__,
                    }
                )
            except Exception as e:
                self._error_count += 1
                logger.error(
                    f"Unexpected error during tool call: tool={request.tool_id}, "
                    f"principal=unknown, error={e}",
                    exc_info=True
                )
                return MCPServiceResponse(
                    success=False,
                    result=None,
                    error=f"Internal error: {e}",
                    metadata={"error_type": "internal_error"}
                )
        
        @self.app.post("/mcp/resource/read", response_model=MCPServiceResponse)
        async def resource_read(request: ResourceReadRequest, raw_request: Request):
            """
            Intercept and forward MCP resource read.
            
            This endpoint:
            1. Extracts principal ID and resource URI from request
            2. Performs authority check via MCPAdapter
            3. Forwards resource read to appropriate MCP server
            4. Emits metering event
            5. Returns resource
            
            Args:
                request: ResourceReadRequest with resource URI and principal ID
                
            Returns:
                MCPServiceResponse with resource content
                
            """
            start_time = time.time()
            self._request_count += 1
            self._resource_read_count += 1
            
            try:
                principal_id, token_claims = await self._resolve_authenticated_principal(
                    raw_request=raw_request,
                )

                logger.info(
                    f"Received resource read request: uri={request.resource_uri}, "
                    f"principal={principal_id}"
                )

                request_metadata = self._reject_spoofed_security_metadata(request.metadata or {})
                request_metadata = self._normalize_workspace_scope_metadata(
                    raw_request=raw_request,
                    metadata=request_metadata,
                )
                request_metadata = self._apply_trusted_security_metadata(
                    metadata=request_metadata,
                    token_claims=token_claims,
                    principal_id=principal_id,
                )
                
                # Create MCP context
                mcp_context = MCPContext(
                    principal_id=principal_id,
                    metadata=request_metadata
                )
                
                # Intercept resource read through MCPAdapter
                # This handles authority check, forwarding, and metering
                result = await self.mcp_adapter.intercept_resource_read(
                    resource_uri=request.resource_uri,
                    mcp_context=mcp_context
                )
                self._record_result_outcome(result)
                
                duration_ms = (time.time() - start_time) * 1000
                logger.info(
                    f"Resource read completed: uri={request.resource_uri}, "
                    f"principal={principal_id}, success={result.success}, "
                    f"duration={duration_ms:.2f}ms"
                )
                
                return MCPServiceResponse(
                    success=result.success,
                    result=result.result,
                    error=result.error,
                    metadata=result.metadata
                )
                
            except HTTPException as exc:
                self._record_http_exception_outcome(exc)
                raise
            except CaracalError as e:
                if self._is_denied_error_message(str(e)):
                    self._denied_count += 1
                else:
                    self._error_count += 1
                logger.error(
                    f"Caracal error during resource read: uri={request.resource_uri}, "
                    f"principal=unknown, error={e}"
                )
                return MCPServiceResponse(
                    success=False,
                    result=None,
                    error=f"Caracal error: {e}",
                    metadata={"error_type": "caracal_error"}
                )
            except Exception as e:
                self._error_count += 1
                logger.error(
                    f"Unexpected error during resource read: uri={request.resource_uri}, "
                    f"principal=unknown, error={e}",
                    exc_info=True
                )
                return MCPServiceResponse(
                    success=False,
                    result=None,
                    error=f"Internal error: {e}",
                    metadata={"error_type": "internal_error"}
                )
    
    async def start(self):
        """
        Start the MCP adapter service.
        
        Starts the FastAPI app on the configured listen address.
        """
        import uvicorn
        
        # Parse listen address
        host, port = self.config.listen_address.rsplit(":", 1)
        port = int(port)
        
        logger.info(
            f"Starting MCP Adapter Service on {host}:{port} with "
            f"{len(self.config.mcp_servers)} MCP servers"
        )
        
        # Start server
        config = uvicorn.Config(
            app=self.app,
            host=host,
            port=port,
            log_level=self.config.log_level,
        )
        
        server = uvicorn.Server(config)
        await server.serve()
    
    async def shutdown(self):
        """Shutdown the MCP adapter service."""
        logger.info("Shutting down MCP Adapter Service")
        
        # Close all MCP client connections
        for server_name, client in self.mcp_clients.items():
            logger.info(f"Closing connection to MCP server: {server_name}")
            await client.aclose()
        
        logger.info("MCP Adapter Service shutdown complete")


def _validate_forward_tool_server_bindings(
    db_session,
    *,
    named_server_urls: Dict[str, str],
    has_default_forward_target: bool = False,
) -> None:
    """Fail startup when active forward-routed tools reference unknown named servers."""
    known_server_names = {
        str(name).strip()
        for name in (named_server_urls or {}).keys()
        if str(name).strip()
    }

    rows = db_session.query(RegisteredTool).filter_by(active=True).all()
    unknown_bindings: list[str] = []
    for row in rows:
        mode = str(getattr(row, "execution_mode", "mcp_forward") or "mcp_forward").strip().lower()
        if mode != "mcp_forward":
            continue

        server_name = str(getattr(row, "mcp_server_name", "") or "").strip()
        if server_name and server_name not in known_server_names:
            unknown_bindings.append(f"{getattr(row, 'tool_id', '<unknown>')}->{server_name}")
            continue

        if not server_name and not has_default_forward_target:
            unknown_bindings.append(f"{getattr(row, 'tool_id', '<unknown>')}-><default>")

    if unknown_bindings:
        joined = ", ".join(sorted(unknown_bindings))
        raise RuntimeError(
            "Active forward-routed tools reference unresolved MCP server targets: "
            f"{joined}"
        )


def _validate_active_tool_mapping_bindings(
    db_session,
    *,
    named_server_urls: Dict[str, str],
    has_default_forward_target: bool,
) -> None:
    """Fail startup when active tools have mapping or forward-target drift."""
    issues = validate_active_tool_mappings(
        db_session=db_session,
        named_server_urls=named_server_urls,
        has_default_forward_target=has_default_forward_target,
    )
    if not issues:
        return

    joined = "; ".join(
        f"{issue['tool_id']}[{issue['check']}]: {issue['message']}"
        for issue in issues
    )
    raise RuntimeError(f"Active tool mapping validation failed: {joined}")


async def main(config_path: Optional[str] = None, listen_address: Optional[str] = None):
    """
    Main entry point for MCP Adapter Service.
    
    Loads configuration and starts the service.
    """
    import sys
    import os
    from caracal.config import load_config
    from caracal.db.connection import get_db_manager
    from caracal.core.identity import PrincipalRegistry
    from caracal.core.authority import AuthorityEvaluator
    from caracal.core.authority_ledger import AuthorityLedgerWriter
    from caracal.core.ledger import LedgerWriter
    
    runtime_policy = setup_runtime_logging(
        requested_level=os.environ.get("LOG_LEVEL"),
    )
    logger.info(
        "runtime_logging_configured",
        mode=runtime_policy.mode,
        level=runtime_policy.level,
        json_format=runtime_policy.json_format,
        redact_sensitive=runtime_policy.redact_sensitive,
    )

    logger.info("Initializing Caracal Core components...")
    
    # Load production config
    try:
        config_path = config_path or os.environ.get("CARACAL_CONFIG_PATH")
        core_config = load_config(config_path)
    except Exception as e:
        logger.error(f"Failed to load core config: {e}")
        sys.exit(1)
        
    # Map core config to MCP service config
    mcp_servers = []
    # Support both string URLs and dict configurations from settings if any
    for i, server_entry in enumerate(core_config.mcp_adapter.mcp_server_urls):
        if isinstance(server_entry, dict):
            mcp_servers.append(MCPServerConfig(
                name=server_entry.get('name', f"server-{i}"),
                url=server_entry.get('url', ''),
                timeout_seconds=server_entry.get('timeout_seconds', 30)
            ))
        else:
            mcp_servers.append(MCPServerConfig(
                name=f"server-{i}",
                url=str(server_entry),
                timeout_seconds=30
            ))
            
    config = MCPServiceConfig(
        listen_address=listen_address
        or os.environ.get("CARACAL_MCP_LISTEN_ADDRESS")
        or core_config.mcp_adapter.listen_address,
        mcp_servers=mcp_servers,
        enable_health_check=core_config.mcp_adapter.health_check_enabled,
        log_level=runtime_policy.level.lower(),
    )
    
    # Initialize database connection via standard manager
    db_manager = get_db_manager(core_config)
    session = db_manager.get_session()
    
    # Initialize core components
    principal_registry = PrincipalRegistry(session)
    ledger_writer = LedgerWriter(session)
    authority_ledger_writer = AuthorityLedgerWriter(session)
    
    # Initialize authority evaluator
    authority_evaluator = AuthorityEvaluator(
        db_session=session,
        # authority_ledger=authority_ledger_writer  # If needed by evaluator, but currently it takes session
    )
    
    # Initialize metering collector
    metering_collector = MeteringCollector(
        ledger_writer=ledger_writer
    )
    
    # Initialize MCP adapter
    mcp_server_url_map = {
        server.name: server.url
        for server in mcp_servers
        if str(server.name).strip() and str(server.url).strip()
    }
    upstream_url = mcp_servers[0].url if mcp_servers else None
    mcp_adapter = MCPAdapter(
        authority_evaluator=authority_evaluator,
        metering_collector=metering_collector,
        mcp_server_url=upstream_url,
        mcp_server_urls=mcp_server_url_map,
        request_timeout_seconds=config.request_timeout_seconds,
    )

    try:
        _validate_active_tool_mapping_bindings(
            session,
            named_server_urls=mcp_server_url_map,
            has_default_forward_target=bool(upstream_url),
        )

        _validate_forward_tool_server_bindings(
            session,
            named_server_urls=mcp_server_url_map,
            has_default_forward_target=bool(upstream_url),
        )
    except RuntimeError as e:
        logger.error(f"Invalid MCP forward routing configuration: {e}")
        sys.exit(1)

    # Reuse AIS session token validation for authenticated caller identity binding.
    try:
        from caracal.runtime.entrypoints import _create_ais_session_manager

        session_manager = _create_ais_session_manager()
    except Exception as e:
        logger.error(f"Failed to initialize AIS session manager for MCP auth: {e}")
        sys.exit(1)
    
    # Initialize MCP service
    service = MCPAdapterService(
        config=config,
        mcp_adapter=mcp_adapter,
        authority_evaluator=authority_evaluator,
        metering_collector=metering_collector,
        db_connection_manager=db_manager,
        session_manager=session_manager,
    )
    
    # Start service
    try:
        await service.start()
    except KeyboardInterrupt:
        logger.info("Received shutdown signal")
    finally:
        await service.shutdown()
        db_manager.close()


if __name__ == "__main__":
    asyncio.run(main())
