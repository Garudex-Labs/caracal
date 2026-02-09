"""
MCP Adapter Standalone Service for Caracal Core v0.2.

Provides HTTP API for MCP request proxying with budget enforcement:
- HTTP API for intercepting MCP tool calls and resource reads
- Health check endpoints for monitoring
- Configuration loading from YAML or environment variables
- Integration with Caracal Core policy evaluation and metering

Requirements: 18.1, 18.3
"""

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, Optional
from uuid import UUID

import httpx
from fastapi import FastAPI, Request, Response, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from caracal._version import __version__
from caracal.mcp.adapter import MCPAdapter, MCPContext, MCPResult
from caracal.mcp.cost_calculator import MCPCostCalculator
from caracal.core.policy import PolicyEvaluator
from caracal.core.metering import MeteringCollector
from caracal.exceptions import BudgetExceededError, CaracalError
from caracal.logging_config import get_logger

logger = get_logger(__name__)


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
    
    def __post_init__(self):
        if self.mcp_servers is None:
            self.mcp_servers = []


# Pydantic models for API requests/responses
class ToolCallRequest(BaseModel):
    """Request model for MCP tool call."""
    tool_name: str = Field(..., description="Name of the MCP tool to invoke")
    tool_args: Dict[str, Any] = Field(default_factory=dict, description="Arguments for the tool")
    agent_id: str = Field(..., description="ID of the agent making the request")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional metadata")


class ResourceReadRequest(BaseModel):
    """Request model for MCP resource read."""
    resource_uri: str = Field(..., description="URI of the resource to read")
    agent_id: str = Field(..., description="ID of the agent making the request")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional metadata")


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
    enforcing budget policies, and forwarding requests to MCP servers.
    
    Requirements: 18.1, 18.3
    """
    
    def __init__(
        self,
        config: MCPServiceConfig,
        mcp_adapter: MCPAdapter,
        policy_evaluator: PolicyEvaluator,
        metering_collector: MeteringCollector,
        db_connection_manager: Optional[Any] = None
    ):
        """
        Initialize MCP Adapter Service.
        
        Args:
            config: MCPServiceConfig with server settings
            mcp_adapter: MCPAdapter for budget enforcement
            policy_evaluator: PolicyEvaluator for budget checks
            metering_collector: MeteringCollector for metering events
            db_connection_manager: Optional DatabaseConnectionManager for health checks
        """
        self.config = config
        self.mcp_adapter = mcp_adapter
        self.policy_evaluator = policy_evaluator
        self.metering_collector = metering_collector
        self.db_connection_manager = db_connection_manager
        
        # Create FastAPI app
        self.app = FastAPI(
            title="Caracal MCP Adapter Service",
            description="HTTP API for MCP request proxying with budget enforcement",
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
    
    def _register_routes(self):
        """Register FastAPI routes."""
        
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
            
            Requirements: 18.3, 17.4, 22.5
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
        
        @self.app.post("/mcp/tool/call", response_model=MCPServiceResponse)
        async def tool_call(request: ToolCallRequest):
            """
            Intercept and forward MCP tool call.
            
            This endpoint:
            1. Extracts agent ID and tool information from request
            2. Performs budget check via MCPAdapter
            3. Forwards tool call to appropriate MCP server
            4. Emits metering event
            5. Returns result
            
            Args:
                request: ToolCallRequest with tool name, args, and agent ID
                
            Returns:
                MCPServiceResponse with tool execution result
                
            Requirements: 18.1
            """
            start_time = time.time()
            self._request_count += 1
            self._tool_call_count += 1
            
            try:
                logger.info(
                    f"Received tool call request: tool={request.tool_name}, "
                    f"agent={request.agent_id}"
                )
                
                # Create MCP context
                mcp_context = MCPContext(
                    agent_id=request.agent_id,
                    metadata=request.metadata
                )
                
                # Intercept tool call through MCPAdapter
                # This handles budget check, forwarding, and metering
                result = await self.mcp_adapter.intercept_tool_call(
                    tool_name=request.tool_name,
                    tool_args=request.tool_args,
                    mcp_context=mcp_context
                )
                
                if result.success:
                    self._allowed_count += 1
                else:
                    self._error_count += 1
                
                duration_ms = (time.time() - start_time) * 1000
                logger.info(
                    f"Tool call completed: tool={request.tool_name}, "
                    f"agent={request.agent_id}, success={result.success}, "
                    f"duration={duration_ms:.2f}ms"
                )
                
                return MCPServiceResponse(
                    success=result.success,
                    result=result.result,
                    error=result.error,
                    metadata=result.metadata
                )
                
            except BudgetExceededError as e:
                self._denied_count += 1
                logger.warning(
                    f"Budget exceeded for tool call: tool={request.tool_name}, "
                    f"agent={request.agent_id}, error={e}"
                )
                return MCPServiceResponse(
                    success=False,
                    result=None,
                    error=f"Budget exceeded: {e}",
                    metadata={"error_type": "budget_exceeded"}
                )
            except CaracalError as e:
                self._error_count += 1
                logger.error(
                    f"Caracal error during tool call: tool={request.tool_name}, "
                    f"agent={request.agent_id}, error={e}"
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
                    f"Unexpected error during tool call: tool={request.tool_name}, "
                    f"agent={request.agent_id}, error={e}",
                    exc_info=True
                )
                return MCPServiceResponse(
                    success=False,
                    result=None,
                    error=f"Internal error: {e}",
                    metadata={"error_type": "internal_error"}
                )
        
        @self.app.post("/mcp/resource/read", response_model=MCPServiceResponse)
        async def resource_read(request: ResourceReadRequest):
            """
            Intercept and forward MCP resource read.
            
            This endpoint:
            1. Extracts agent ID and resource URI from request
            2. Performs budget check via MCPAdapter
            3. Forwards resource read to appropriate MCP server
            4. Emits metering event
            5. Returns resource
            
            Args:
                request: ResourceReadRequest with resource URI and agent ID
                
            Returns:
                MCPServiceResponse with resource content
                
            Requirements: 18.1
            """
            start_time = time.time()
            self._request_count += 1
            self._resource_read_count += 1
            
            try:
                logger.info(
                    f"Received resource read request: uri={request.resource_uri}, "
                    f"agent={request.agent_id}"
                )
                
                # Create MCP context
                mcp_context = MCPContext(
                    agent_id=request.agent_id,
                    metadata=request.metadata
                )
                
                # Intercept resource read through MCPAdapter
                # This handles budget check, forwarding, and metering
                result = await self.mcp_adapter.intercept_resource_read(
                    resource_uri=request.resource_uri,
                    mcp_context=mcp_context
                )
                
                if result.success:
                    self._allowed_count += 1
                else:
                    self._error_count += 1
                
                duration_ms = (time.time() - start_time) * 1000
                logger.info(
                    f"Resource read completed: uri={request.resource_uri}, "
                    f"agent={request.agent_id}, success={result.success}, "
                    f"duration={duration_ms:.2f}ms"
                )
                
                return MCPServiceResponse(
                    success=result.success,
                    result=result.result,
                    error=result.error,
                    metadata=result.metadata
                )
                
            except BudgetExceededError as e:
                self._denied_count += 1
                logger.warning(
                    f"Budget exceeded for resource read: uri={request.resource_uri}, "
                    f"agent={request.agent_id}, error={e}"
                )
                return MCPServiceResponse(
                    success=False,
                    result=None,
                    error=f"Budget exceeded: {e}",
                    metadata={"error_type": "budget_exceeded"}
                )
            except CaracalError as e:
                self._error_count += 1
                logger.error(
                    f"Caracal error during resource read: uri={request.resource_uri}, "
                    f"agent={request.agent_id}, error={e}"
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
                    f"agent={request.agent_id}, error={e}",
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
            log_level="info",
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


def load_config_from_yaml(config_path: str) -> MCPServiceConfig:
    """
    Load MCP service configuration from YAML file.
    
    Args:
        config_path: Path to YAML configuration file
        
    Returns:
        MCPServiceConfig loaded from file
        
    Raises:
        FileNotFoundError: If config file doesn't exist
        ValueError: If config file is invalid
        
    Requirements: 18.3
    """
    import yaml
    import os
    
    if not os.path.exists(config_path):
        raise FileNotFoundError(f"Configuration file not found: {config_path}")
    
    try:
        with open(config_path, 'r') as f:
            config_data = yaml.safe_load(f)
        
        # Extract MCP adapter configuration
        mcp_config = config_data.get('mcp_adapter', {})
        
        # Parse MCP servers
        mcp_servers = []
        for server_data in mcp_config.get('mcp_servers', []):
            mcp_servers.append(MCPServerConfig(
                name=server_data['name'],
                url=server_data['url'],
                timeout_seconds=server_data.get('timeout_seconds', 30)
            ))
        
        # Create service config
        service_config = MCPServiceConfig(
            listen_address=mcp_config.get('listen_address', '0.0.0.0:8080'),
            mcp_servers=mcp_servers,
            request_timeout_seconds=mcp_config.get('request_timeout_seconds', 30),
            max_request_size_mb=mcp_config.get('max_request_size_mb', 10),
            enable_health_check=mcp_config.get('enable_health_check', True),
            health_check_path=mcp_config.get('health_check_path', '/health')
        )
        
        logger.info(
            f"Loaded configuration from {config_path}: "
            f"listen_address={service_config.listen_address}, "
            f"mcp_servers={len(service_config.mcp_servers)}"
        )
        
        return service_config
        
    except yaml.YAMLError as e:
        raise ValueError(f"Invalid YAML configuration: {e}")
    except KeyError as e:
        raise ValueError(f"Missing required configuration key: {e}")
    except Exception as e:
        raise ValueError(f"Failed to load configuration: {e}")


def load_config_from_env() -> MCPServiceConfig:
    """
    Load MCP service configuration from environment variables.
    
    Environment variables:
    - CARACAL_MCP_LISTEN_ADDRESS: Listen address (default: "0.0.0.0:8080")
    - CARACAL_MCP_SERVERS: JSON array of MCP server configs
    - CARACAL_MCP_REQUEST_TIMEOUT: Request timeout in seconds (default: 30)
    - CARACAL_MCP_MAX_REQUEST_SIZE_MB: Max request size in MB (default: 10)
    
    Returns:
        MCPServiceConfig loaded from environment
        
    Requirements: 18.3
    """
    import os
    import json
    
    # Parse listen address
    listen_address = os.getenv('CARACAL_MCP_LISTEN_ADDRESS', '0.0.0.0:8080')
    
    # Parse MCP servers from JSON
    mcp_servers = []
    mcp_servers_json = os.getenv('CARACAL_MCP_SERVERS', '[]')
    try:
        servers_data = json.loads(mcp_servers_json)
        for server_data in servers_data:
            mcp_servers.append(MCPServerConfig(
                name=server_data['name'],
                url=server_data['url'],
                timeout_seconds=server_data.get('timeout_seconds', 30)
            ))
    except json.JSONDecodeError as e:
        logger.warning(f"Invalid CARACAL_MCP_SERVERS JSON: {e}, using empty list")
    except KeyError as e:
        logger.warning(f"Missing required key in MCP server config: {e}")
    
    # Parse other settings
    request_timeout = int(os.getenv('CARACAL_MCP_REQUEST_TIMEOUT', '30'))
    max_request_size_mb = int(os.getenv('CARACAL_MCP_MAX_REQUEST_SIZE_MB', '10'))
    
    service_config = MCPServiceConfig(
        listen_address=listen_address,
        mcp_servers=mcp_servers,
        request_timeout_seconds=request_timeout,
        max_request_size_mb=max_request_size_mb
    )
    
    logger.info(
        f"Loaded configuration from environment: "
        f"listen_address={service_config.listen_address}, "
        f"mcp_servers={len(service_config.mcp_servers)}"
    )
    
    return service_config


async def main():
    """
    Main entry point for MCP Adapter Service.
    
    Loads configuration and starts the service.
    """
    import sys
    import os
    
    # Determine config source
    config_path = os.getenv('CARACAL_CONFIG_PATH')
    
    if config_path:
        logger.info(f"Loading configuration from file: {config_path}")
        config = load_config_from_yaml(config_path)
    else:
        logger.info("Loading configuration from environment variables")
        config = load_config_from_env()
    
    # Initialize Caracal Core components
    # Note: In a real deployment, these would be initialized from the main config
    # For now, we'll create minimal instances for demonstration
    from caracal.db.connection import DatabaseConnectionManager
    from caracal.db.models import Base
    from caracal.core.identity import AgentRegistry
    from caracal.core.policy import PolicyStore
    from caracal.core.ledger import LedgerWriter, LedgerQuery
    
    # TODO: Load database config from main config file
    # For now, use environment variables
    db_config = {
        'host': os.getenv('CARACAL_DB_HOST', 'localhost'),
        'port': int(os.getenv('CARACAL_DB_PORT', '5432')),
        'database': os.getenv('CARACAL_DB_NAME', 'caracal'),
        'user': os.getenv('CARACAL_DB_USER', 'caracal_user'),
        'password': os.getenv('CARACAL_DB_PASSWORD', ''),
    }
    
    logger.info("Initializing Caracal Core components...")
    
    # Initialize database connection
    db_manager = DatabaseConnectionManager(db_config)
    session = db_manager.get_session()
    
    # Initialize core components
    agent_registry = AgentRegistry(session)
    policy_store = PolicyStore(session)
    ledger_writer = LedgerWriter(session)
    ledger_query = LedgerQuery(session)
    
    # Initialize policy evaluator
    policy_evaluator = PolicyEvaluator(
        policy_store=policy_store,
        ledger_query=ledger_query
    )
    
    # Initialize metering collector
    metering_collector = MeteringCollector(
        ledger_writer=ledger_writer
    )
    
    # Initialize MCP cost calculator
    cost_calculator = MCPCostCalculator()
    
    # Initialize MCP adapter
    mcp_adapter = MCPAdapter(
        policy_evaluator=policy_evaluator,
        metering_collector=metering_collector,
        # cost_calculator=cost_calculator
    )
    
    # Initialize MCP service
    service = MCPAdapterService(
        config=config,
        mcp_adapter=mcp_adapter,
        policy_evaluator=policy_evaluator,
        metering_collector=metering_collector,
        db_connection_manager=db_manager
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
