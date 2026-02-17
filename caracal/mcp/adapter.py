"""
MCP Adapter for Caracal Core.

This module provides the MCPAdapter service that intercepts MCP tool calls
and resource reads, enforces authority policies, and emits metering events.
"""

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, Optional
from uuid import UUID

from ase.protocol import MeteringEvent
from caracal.core.metering import MeteringCollector
from caracal.core.authority import AuthorityEvaluator
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
        agent_id: ID of the agent making the request
        metadata: Additional metadata from the MCP request
    """
    agent_id: str
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
    
    Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 12.1, 12.2, 12.3
    """

    def __init__(
        self,
        authority_evaluator: AuthorityEvaluator,
        metering_collector: MeteringCollector,
    ):
        """
        Initialize MCPAdapter.
        
        Args:
            authority_evaluator: AuthorityEvaluator for mandate checks
            metering_collector: MeteringCollector for emitting events
        """
        self.authority_evaluator = authority_evaluator
        self.metering_collector = metering_collector
        logger.info("MCPAdapter initialized")

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
            
        Requirements: 11.1, 11.2, 11.3, 11.4, 11.5
        """
        try:
            # 1. Extract agent ID from MCP context
            agent_id = self._extract_agent_id(mcp_context)
            logger.debug(
                f"Intercepting MCP tool call: tool={tool_name}, agent={agent_id}"
            )
            
            # 2. Extract Mandate ID
            mandate_id_str = mcp_context.get("mandate_id")
            if not mandate_id_str:
                logger.warning(f"No mandate_id provided for agent {agent_id}, tool {tool_name}")
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

            # 4. Validate Authority
            # Action: execute, Resource: tool_name
            decision = self.authority_evaluator.validate_mandate(
                mandate=mandate,
                requested_action="execute",
                requested_resource=tool_name
            )
            
            if not decision.allowed:
                logger.warning(
                    f"Authority denied for agent {agent_id}: {decision.reason}"
                )
                return MCPResult(
                    success=False,
                    result=None,
                    error=f"Authority denied: {decision.reason}"
                )
            
            logger.info(
                f"Authority granted for agent {agent_id}, tool {tool_name} (mandate {mandate_id})"
            )
            
            # 5. Forward to MCP server (simulated - actual forwarding in production)
            # In a real implementation, this would call the actual MCP server
            tool_result = await self._forward_to_mcp_server(tool_name, tool_args)
            
            # 6. Emit metering event (usage tracking only)
            metering_event = MeteringEvent(
                agent_id=agent_id,
                resource_type=f"mcp.tool.{tool_name}",
                quantity=Decimal("1"),  # One tool invocation
                timestamp=datetime.utcnow(),
                metadata={
                    "tool_name": tool_name,
                    "tool_args": tool_args,
                    "mcp_context": mcp_context.metadata,
                    "mandate_id": str(mandate_id)
                }
            )
            
            self.metering_collector.collect_event(metering_event)
            
            logger.info(
                f"MCP tool call completed: tool={tool_name}, agent={agent_id}"
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
                agent_id=mcp_context.agent_id,
                metadata={
                    "tool_name": tool_name,
                    "tool_args": tool_args
                },
                severity=ErrorSeverity.HIGH
            )
            
            error_response = error_handler.create_error_response(context, include_details=False)
            
            logger.error(
                f"Failed to intercept MCP tool call '{tool_name}' for agent {mcp_context.agent_id} (fail-closed): {e}",
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
            
        Requirements: 12.1, 12.2, 12.3
        """
        try:
            # 1. Extract agent ID from MCP context
            agent_id = self._extract_agent_id(mcp_context)
            logger.debug(
                f"Intercepting MCP resource read: uri={resource_uri}, agent={agent_id}"
            )
            
            # 2. Extract Mandate ID
            mandate_id_str = mcp_context.get("mandate_id")
            if not mandate_id_str:
                logger.warning(f"No mandate_id provided for agent {agent_id}, resource {resource_uri}")
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

            # 4. Validate Authority
            # Action: read, Resource: resource_uri
            decision = self.authority_evaluator.validate_mandate(
                mandate=mandate,
                requested_action="read",
                requested_resource=resource_uri
            )
            
            if not decision.allowed:
                logger.warning(
                    f"Authority denied for agent {agent_id}: {decision.reason}"
                )
                return MCPResult(
                    success=False,
                    result=None,
                    error=f"Authority denied: {decision.reason}"
                )
            
            logger.info(
                f"Authority granted for agent {agent_id}, resource {resource_uri} (mandate {mandate_id})"
            )
            
            # 5. Fetch resource from MCP server
            resource = await self._fetch_resource(resource_uri)
            
            # 6. Emit metering event (usage tracking only)
            metering_event = MeteringEvent(
                agent_id=agent_id,
                resource_type=f"mcp.resource.{self._get_resource_type(resource_uri)}",
                quantity=Decimal(str(resource.size)),  # Size in bytes
                timestamp=datetime.utcnow(),
                metadata={
                    "resource_uri": resource_uri,
                    "mime_type": resource.mime_type,
                    "size_bytes": resource.size,
                    "mcp_context": mcp_context.metadata,
                    "mandate_id": str(mandate_id)
                }
            )
            
            self.metering_collector.collect_event(metering_event)
            
            logger.info(
                f"MCP resource read completed: uri={resource_uri}, agent={agent_id}, "
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
                agent_id=mcp_context.agent_id,
                metadata={
                    "resource_uri": resource_uri
                },
                severity=ErrorSeverity.HIGH
            )
            
            error_response = error_handler.create_error_response(context, include_details=False)
            
            logger.error(
                f"Failed to intercept MCP resource read '{resource_uri}' for agent {mcp_context.agent_id} (fail-closed): {e}",
                exc_info=True
            )
            
            return MCPResult(
                success=False,
                result=None,
                error=error_response.message
            )

    def _extract_agent_id(self, mcp_context: MCPContext) -> str:
        """
        Extract agent ID from MCP context.
        
        Args:
            mcp_context: MCP context
            
        Returns:
            Agent ID as string
            
        Raises:
            CaracalError: If agent ID not found in context (fail-closed)
        """
        agent_id = mcp_context.agent_id
        
        if not agent_id:
            # Try to get from metadata as fallback
            agent_id = mcp_context.get("caracal_agent_id")
            
        if not agent_id:
            # Fail closed: deny operation if agent ID cannot be determined (Requirement 23.3)
            error_handler = get_error_handler("mcp-adapter")
            error = CaracalError("Agent ID not found in MCP context")
            error_handler.handle_error(
                error=error,
                category=ErrorCategory.VALIDATION,
                operation="_extract_agent_id",
                metadata={"mcp_context_metadata": mcp_context.metadata},
                severity=ErrorSeverity.CRITICAL
            )
            
            logger.error("Agent ID not found in MCP context (fail-closed)")
            raise error
        
        return agent_id

    async def _forward_to_mcp_server(
        self,
        tool_name: str,
        tool_args: Dict[str, Any]
    ) -> Any:
        """
        Forward tool invocation to MCP server.
        
        This is a placeholder implementation for v0.2.
        In v0.3, this will make actual HTTP/gRPC calls to MCP servers.
        
        Args:
            tool_name: Name of the tool
            tool_args: Tool arguments
            
        Returns:
            Simulated tool result
        """
        # Simulated tool execution for v0.2
        logger.debug(
            f"Simulating MCP tool execution: tool={tool_name}, args={tool_args}"
        )
        
        # Return a simulated result
        return {
            "status": "success",
            "tool": tool_name,
            "result": f"Simulated result for {tool_name}",
            "metadata": {
                "execution_time_ms": 100,
                "tokens_used": tool_args.get("max_tokens", 1000),
            }
        }

    async def _fetch_resource(self, resource_uri: str) -> MCPResource:
        """
        Fetch resource from MCP server.
        
        This is a placeholder implementation for v0.2.
        In v0.3, this will make actual HTTP/gRPC calls to MCP servers.
        
        Args:
            resource_uri: URI of the resource
            
        Returns:
            MCPResource with simulated content
        """
        # Simulated resource fetch for v0.2
        logger.debug(f"Simulating MCP resource fetch: uri={resource_uri}")
        
        # Return a simulated resource
        content = f"Simulated content for {resource_uri}"
        return MCPResource(
            uri=resource_uri,
            content=content,
            mime_type="text/plain",
            size=len(content.encode('utf-8'))
        )

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

    def as_decorator(self):
        """
        Return Python decorator for in-process integration.
        
        This decorator wraps MCP tool functions to automatically handle:
        - Mandate validation before execution
        - Metering events after execution
        - Error handling and logging
        
        Usage:
            @mcp_adapter.as_decorator()
            async def my_mcp_tool(agent_id: str, mandate_id: str, **kwargs):
                # Tool implementation
                return result
        
        The decorated function must accept agent_id and mandate_id as arguments.
        
        Returns:
            Decorator function that wraps MCP tool functions
            
        Requirements: 18.4
        """
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
                # Extract agent_id and mandate_id from arguments
                agent_id = None
                mandate_id = None
                tool_args = {}
                
                # Get function signature to understand parameters
                sig = inspect.signature(func)
                param_names = list(sig.parameters.keys())
                
                # Copy kwargs to modify
                call_kwargs = kwargs.copy()
                
                # Extract agent_id
                if 'agent_id' in call_kwargs:
                    agent_id = call_kwargs.pop('agent_id')
                elif len(args) > 0 and len(param_names) > 0 and param_names[0] == 'agent_id':
                    agent_id = args[0]
                
                # Extract mandate_id
                if 'mandate_id' in call_kwargs:
                    mandate_id = call_kwargs.pop('mandate_id')
                # Check positional args if mandate_id is expected
                elif len(args) > 1 and len(param_names) > 1 and param_names[1] == 'mandate_id':
                    mandate_id = args[1]
                
                # If agent_id not found in args, try alternative names
                if not agent_id:
                    for key in ['agent', 'caracal_agent_id']:
                        if key in call_kwargs:
                            agent_id = call_kwargs.pop(key)
                            break
                            
                # Collect remaining args as tool_args
                # This is a simplification; in reality we'd need to map remaining args to param names
                tool_args = call_kwargs
                
                if not agent_id:
                    logger.error(
                        f"agent_id not provided to decorated MCP tool '{func.__name__}'"
                    )
                    raise CaracalError(
                        f"agent_id is required for MCP tool '{func.__name__}'."
                    )
                    
                if not mandate_id:
                    logger.error(
                        f"mandate_id not provided to decorated MCP tool '{func.__name__}'"
                    )
                    raise CaracalError(
                        f"mandate_id is required for MCP tool '{func.__name__}'."
                    )
                
                # Get tool name from function name
                tool_name = func.__name__
                
                # Create MCP context
                mcp_context = MCPContext(
                    agent_id=str(agent_id),
                    metadata={
                        "tool_name": tool_name,
                        "decorator_mode": True,
                        "mandate_id": str(mandate_id)
                    }
                )
                
                logger.debug(
                    f"Decorator intercepting MCP tool: tool={tool_name}, agent={agent_id}"
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

                    # 2. Validate Authority
                    decision = self.authority_evaluator.validate_mandate(
                        mandate=mandate,
                        requested_action="execute",
                        requested_resource=tool_name
                    )
                    
                    if not decision.allowed:
                        logger.warning(
                            f"Authority denied for agent {agent_id}: {decision.reason}"
                        )
                        raise CaracalError(f"Authority denied: {decision.reason}")
                    
                    logger.info(
                        f"Authority granted for agent {agent_id}, tool {tool_name}"
                    )
                    
                    # 3. Execute the actual tool function
                    if inspect.iscoroutinefunction(func):
                        tool_result = await func(*args, **kwargs)
                    else:
                        tool_result = func(*args, **kwargs)
                    
                    # 4. Emit metering event
                    metering_event = MeteringEvent(
                        agent_id=str(agent_id),
                        resource_type=f"mcp.tool.{tool_name}",
                        quantity=Decimal("1"),
                        timestamp=datetime.utcnow(),
                        metadata={
                            "tool_name": tool_name,
                            "decorator_mode": True,
                            "mandate_id": str(mandate_id)
                        }
                    )
                    
                    self.metering_collector.collect_event(metering_event)
                    
                    logger.info(
                        f"MCP tool call completed (decorated): tool={tool_name}, agent={agent_id}"
                    )
                    
                    return tool_result
            
                except CaracalError:
                    raise
                except Exception as e:
                    # Fail closed
                    logger.error(
                        f"Failed to execute decorated tool '{tool_name}' for agent {agent_id}: {e}",
                        exc_info=True
                    )
                    raise CaracalError(f"Tool execution failed: {e}")
            
            return wrapper
        
        return decorator
