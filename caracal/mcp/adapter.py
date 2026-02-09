"""
MCP Adapter for Caracal Core.

This module provides the MCPAdapter service that intercepts MCP tool calls
and resource reads, enforces budget policies, and emits metering events.
"""

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, Optional
from uuid import UUID

from ase.protocol import MeteringEvent
from caracal.core.metering import MeteringCollector
from caracal.core.policy import PolicyEvaluator
from caracal.kafka.producer import KafkaEventProducer
from caracal.core.error_handling import (
    get_error_handler,
    handle_error_with_denial,
    ErrorCategory,
    ErrorSeverity
)
from caracal.exceptions import BudgetExceededError, CaracalError
from caracal.logging_config import get_logger
from caracal.mcp.cost_calculator import MCPCostCalculator

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
    Adapter for integrating Caracal budget enforcement with MCP protocol.
    
    This adapter intercepts MCP tool calls and resource reads, performs
    budget checks, forwards requests to MCP servers, and emits metering events.
    
    Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 12.1, 12.2, 12.3
    """

    def __init__(
        self,
        policy_evaluator: PolicyEvaluator,
        metering_collector: MeteringCollector,
        cost_calculator: MCPCostCalculator,
        kafka_producer: Optional[KafkaEventProducer] = None,
        enable_kafka: bool = False
    ):
        """
        Initialize MCPAdapter.
        
        Args:
            policy_evaluator: PolicyEvaluator for budget checks
            metering_collector: MeteringCollector for emitting events
            cost_calculator: MCPCostCalculator for cost estimation
            kafka_producer: Optional KafkaEventProducer for v0.3 event publishing
            enable_kafka: Enable Kafka event publishing (default: False for v0.2 compatibility)
        """
        self.policy_evaluator = policy_evaluator
        self.metering_collector = metering_collector
        self.cost_calculator = cost_calculator
        self.kafka_producer = kafka_producer
        self.enable_kafka = enable_kafka
        logger.info(f"MCPAdapter initialized with kafka_enabled={enable_kafka}")

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
        2. Estimates cost based on tool and args
        3. Checks budget via Policy Evaluator
        4. If allowed, forwards to MCP server (simulated in v0.2)
        5. Emits metering event with actual cost
        6. Returns result
        
        Args:
            tool_name: Name of the MCP tool being invoked
            tool_args: Arguments passed to the tool
            mcp_context: MCP context containing agent ID and metadata
            
        Returns:
            MCPResult with success status and result/error
            
        Raises:
            BudgetExceededError: If budget check fails
            CaracalError: If operation fails critically
            
        Requirements: 11.1, 11.2, 11.3, 11.4, 11.5
        """
        try:
            # 1. Extract agent ID from MCP context
            agent_id = self._extract_agent_id(mcp_context)
            logger.debug(
                f"Intercepting MCP tool call: tool={tool_name}, agent={agent_id}"
            )
            
            # 2. Estimate cost based on tool and args
            estimated_cost = await self.cost_calculator.estimate_tool_cost(
                tool_name, tool_args
            )
            logger.debug(
                f"Estimated cost for tool '{tool_name}': {estimated_cost} USD"
            )
            
            # 3. Check budget via Policy Evaluator
            policy_decision = self.policy_evaluator.check_budget(
                agent_id, estimated_cost
            )
            
            if not policy_decision.allowed:
                logger.warning(
                    f"Budget check denied for agent {agent_id}: {policy_decision.reason}"
                )
                raise BudgetExceededError(
                    f"Budget check failed: {policy_decision.reason}"
                )
            
            logger.info(
                f"Budget check passed for agent {agent_id}: "
                f"remaining={policy_decision.remaining_budget} USD"
            )
            
            # 4. Forward to MCP server (simulated in v0.2 - actual forwarding in v0.3)
            # In a real implementation, this would call the actual MCP server
            tool_result = await self._forward_to_mcp_server(tool_name, tool_args)
            
            # 5. Calculate actual cost from result
            actual_cost = await self.cost_calculator.calculate_actual_tool_cost(
                tool_name, tool_args, tool_result
            )
            logger.debug(
                f"Actual cost for tool '{tool_name}': {actual_cost} USD"
            )
            
            # 6. Emit metering event with actual cost
            # v0.3: Publish to Kafka if enabled, otherwise write directly to ledger
            if self.enable_kafka and self.kafka_producer:
                try:
                    await self.kafka_producer.publish_metering_event(
                        agent_id=agent_id,
                        resource_type=f"mcp.tool.{tool_name}",
                        quantity=Decimal("1"),
                        cost=actual_cost,
                        currency="USD",
                        # provisional_charge_id removed
                        metadata={
                            "tool_name": tool_name,
                            "tool_args": str(tool_args),
                            "estimated_cost": str(estimated_cost),
                            "actual_cost": str(actual_cost),
                        },
                        timestamp=datetime.utcnow()
                    )
                    
                    logger.info(
                        f"Published MCP metering event to Kafka: tool={tool_name}, "
                        f"agent={agent_id}, cost={actual_cost} USD"
                    )
                    
                    # Also publish policy decision event
                    await self.kafka_producer.publish_policy_decision(
                        agent_id=agent_id,
                        decision="allowed",
                        reason=policy_decision.reason,
                        estimated_cost=estimated_cost,
                        remaining_budget=policy_decision.remaining_budget,
                        metadata={
                            "tool_name": tool_name,
                            "resource_type": f"mcp.tool.{tool_name}",
                        },
                        timestamp=datetime.utcnow()
                    )
                    
                except Exception as kafka_error:
                    logger.error(
                        f"Failed to publish MCP events to Kafka for agent {agent_id}: {kafka_error}",
                        exc_info=True
                    )
                    # Fall back to direct ledger write
                    logger.warning("Falling back to direct ledger write due to Kafka failure")
                    
                    metering_event = MeteringEvent(
                        agent_id=agent_id,
                        resource_type=f"mcp.tool.{tool_name}",
                        quantity=Decimal("1"),
                        timestamp=datetime.utcnow(),
                        metadata={
                            "tool_name": tool_name,
                            "tool_args": tool_args,
                            "estimated_cost": str(estimated_cost),
                            "actual_cost": str(actual_cost),
                            "mcp_context": mcp_context.metadata,
                        }
                    )
                    
                    self.metering_collector.collect_event(metering_event)
            else:
                # v0.2 compatibility: Direct ledger write
                metering_event = MeteringEvent(
                    agent_id=agent_id,
                    resource_type=f"mcp.tool.{tool_name}",
                    quantity=Decimal("1"),  # One tool invocation
                    timestamp=datetime.utcnow(),
                    metadata={
                        "tool_name": tool_name,
                        "tool_args": tool_args,
                        "estimated_cost": str(estimated_cost),
                        "actual_cost": str(actual_cost),
                        "mcp_context": mcp_context.metadata,
                    }
                )
                
                self.metering_collector.collect_event(metering_event)
            
            logger.info(
                f"MCP tool call completed: tool={tool_name}, agent={agent_id}, "
                f"cost={actual_cost} USD"
            )
            
            return MCPResult(
                success=True,
                result=tool_result,
                metadata={
                    "estimated_cost": str(estimated_cost),
                    "actual_cost": str(actual_cost),
                    "remaining_budget": str(policy_decision.remaining_budget) if policy_decision.remaining_budget else None,
                }
            )
            
        except BudgetExceededError:
            # Re-raise budget errors (already logged by policy evaluator)
            raise
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
        2. Estimates cost based on resource type and size
        3. Checks budget via Policy Evaluator
        4. If allowed, forwards to MCP server (simulated in v0.2)
        5. Emits metering event with actual cost
        6. Returns resource
        
        Args:
            resource_uri: URI of the resource to read
            mcp_context: MCP context containing agent ID and metadata
            
        Returns:
            MCPResult with success status and resource/error
            
        Raises:
            BudgetExceededError: If budget check fails
            CaracalError: If operation fails critically
            
        Requirements: 12.1, 12.2, 12.3
        """
        try:
            # 1. Extract agent ID from MCP context
            agent_id = self._extract_agent_id(mcp_context)
            logger.debug(
                f"Intercepting MCP resource read: uri={resource_uri}, agent={agent_id}"
            )
            
            # 2. Estimate cost based on resource URI (before fetching)
            # For now, use a default estimate - actual size will be known after fetch
            estimated_cost = await self.cost_calculator.estimate_resource_cost(
                resource_uri, estimated_size=0  # Will be refined after fetch
            )
            logger.debug(
                f"Estimated cost for resource '{resource_uri}': {estimated_cost} USD"
            )
            
            # 3. Check budget via Policy Evaluator
            policy_decision = self.policy_evaluator.check_budget(
                agent_id, estimated_cost
            )
            
            if not policy_decision.allowed:
                logger.warning(
                    f"Budget check denied for agent {agent_id}: {policy_decision.reason}"
                )
                raise BudgetExceededError(
                    f"Budget check failed: {policy_decision.reason}"
                )
            
            logger.info(
                f"Budget check passed for agent {agent_id}: "
                f"remaining={policy_decision.remaining_budget} USD"
            )
            
            # 4. Fetch resource from MCP server (simulated in v0.2)
            resource = await self._fetch_resource(resource_uri)
            
            # 5. Calculate actual cost based on resource size
            actual_cost = await self.cost_calculator.estimate_resource_cost(
                resource_uri, estimated_size=resource.size
            )
            logger.debug(
                f"Actual cost for resource '{resource_uri}': {actual_cost} USD"
            )
            
            # 6. Emit metering event with actual cost
            # v0.3: Publish to Kafka if enabled, otherwise write directly to ledger
            if self.enable_kafka and self.kafka_producer:
                try:
                    await self.kafka_producer.publish_metering_event(
                        agent_id=agent_id,
                        resource_type=f"mcp.resource.{self._get_resource_type(resource_uri)}",
                        quantity=Decimal(str(resource.size)),
                        cost=actual_cost,
                        currency="USD",
                        # provisional_charge_id removed
                        metadata={
                            "resource_uri": resource_uri,
                            "mime_type": resource.mime_type,
                            "size_bytes": str(resource.size),
                            "estimated_cost": str(estimated_cost),
                            "actual_cost": str(actual_cost),
                        },
                        timestamp=datetime.utcnow()
                    )
                    
                    logger.info(
                        f"Published MCP resource metering event to Kafka: uri={resource_uri}, "
                        f"agent={agent_id}, size={resource.size} bytes, cost={actual_cost} USD"
                    )
                    
                    # Also publish policy decision event
                    await self.kafka_producer.publish_policy_decision(
                        agent_id=agent_id,
                        decision="allowed",
                        reason=policy_decision.reason,
                        estimated_cost=estimated_cost,
                        remaining_budget=policy_decision.remaining_budget,
                        metadata={
                            "resource_uri": resource_uri,
                            "resource_type": f"mcp.resource.{self._get_resource_type(resource_uri)}",
                        },
                        timestamp=datetime.utcnow()
                    )
                    
                except Exception as kafka_error:
                    logger.error(
                        f"Failed to publish MCP resource events to Kafka for agent {agent_id}: {kafka_error}",
                        exc_info=True
                    )
                    # Fall back to direct ledger write
                    logger.warning("Falling back to direct ledger write due to Kafka failure")
                    
                    metering_event = MeteringEvent(
                        agent_id=agent_id,
                        resource_type=f"mcp.resource.{self._get_resource_type(resource_uri)}",
                        quantity=Decimal(str(resource.size)),
                        timestamp=datetime.utcnow(),
                        metadata={
                            "resource_uri": resource_uri,
                            "mime_type": resource.mime_type,
                            "size_bytes": resource.size,
                            "estimated_cost": str(estimated_cost),
                            "actual_cost": str(actual_cost),
                            "mcp_context": mcp_context.metadata,
                        }
                    )
                    
                    self.metering_collector.collect_event(metering_event)
            else:
                # v0.2 compatibility: Direct ledger write
                metering_event = MeteringEvent(
                    agent_id=agent_id,
                    resource_type=f"mcp.resource.{self._get_resource_type(resource_uri)}",
                    quantity=Decimal(str(resource.size)),  # Size in bytes
                    timestamp=datetime.utcnow(),
                    metadata={
                        "resource_uri": resource_uri,
                        "mime_type": resource.mime_type,
                        "size_bytes": resource.size,
                        "estimated_cost": str(estimated_cost),
                        "actual_cost": str(actual_cost),
                        "mcp_context": mcp_context.metadata,
                    }
                )
                
                self.metering_collector.collect_event(metering_event)
            
            logger.info(
                f"MCP resource read completed: uri={resource_uri}, agent={agent_id}, "
                f"size={resource.size} bytes, cost={actual_cost} USD"
            )
            
            return MCPResult(
                success=True,
                result=resource,
                metadata={
                    "estimated_cost": str(estimated_cost),
                    "actual_cost": str(actual_cost),
                    "remaining_budget": str(policy_decision.remaining_budget) if policy_decision.remaining_budget else None,
                    "resource_size": resource.size,
                }
            )
            
        except BudgetExceededError:
            # Re-raise budget errors (already logged by policy evaluator)
            raise
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
        - Budget checks before execution
        - Metering events after execution
        - Error handling and logging
        
        Usage:
            @mcp_adapter.as_decorator()
            async def my_mcp_tool(agent_id: str, **kwargs):
                # Tool implementation
                return result
        
        The decorated function must accept agent_id as the first parameter
        or in kwargs. All other parameters are passed as tool_args.
        
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
                Wrapped function with budget enforcement
            """
            import functools
            import inspect
            
            @functools.wraps(func)
            async def wrapper(*args, **kwargs):
                """
                Wrapper that handles budget checks and metering.
                
                Args:
                    *args: Positional arguments for the tool
                    **kwargs: Keyword arguments for the tool
                    
                Returns:
                    Tool execution result
                    
                Raises:
                    BudgetExceededError: If budget check fails
                    CaracalError: If agent_id not provided or other errors
                """
                # Extract agent_id from arguments
                agent_id = None
                tool_args = {}
                
                # Get function signature to understand parameters
                sig = inspect.signature(func)
                param_names = list(sig.parameters.keys())
                
                # Check if agent_id is in kwargs
                if 'agent_id' in kwargs:
                    agent_id = kwargs.pop('agent_id')
                    tool_args = kwargs
                # Check if first positional arg is agent_id
                elif len(args) > 0 and len(param_names) > 0 and param_names[0] == 'agent_id':
                    agent_id = args[0]
                    # Remaining args become tool_args
                    for i, arg in enumerate(args[1:], start=1):
                        if i < len(param_names):
                            tool_args[param_names[i]] = arg
                    tool_args.update(kwargs)
                else:
                    # Try to find agent_id in kwargs with different names
                    for key in ['agent_id', 'agent', 'caracal_agent_id']:
                        if key in kwargs:
                            agent_id = kwargs.pop(key)
                            tool_args = kwargs
                            break
                
                if not agent_id:
                    logger.error(
                        f"agent_id not provided to decorated MCP tool '{func.__name__}'"
                    )
                    raise CaracalError(
                        f"agent_id is required for MCP tool '{func.__name__}'. "
                        "Pass it as the first argument or as a keyword argument."
                    )
                
                # Get tool name from function name
                tool_name = func.__name__
                
                # Create MCP context
                mcp_context = MCPContext(
                    agent_id=agent_id,
                    metadata={
                        "tool_name": tool_name,
                        "decorator_mode": True,
                    }
                )
                
                logger.debug(
                    f"Decorator intercepting MCP tool: tool={tool_name}, agent={agent_id}"
                )
                
                try:
                    # 1. Estimate cost based on tool and args
                    estimated_cost = await self.cost_calculator.estimate_tool_cost(
                        tool_name, tool_args
                    )
                    logger.debug(
                        f"Estimated cost for tool '{tool_name}': {estimated_cost} USD"
                    )
                    
                    # 2. Check budget via Policy Evaluator
                    policy_decision = self.policy_evaluator.check_budget(
                        agent_id, estimated_cost
                    )
                    
                    if not policy_decision.allowed:
                        logger.warning(
                            f"Budget check denied for agent {agent_id}: {policy_decision.reason}"
                        )
                        raise BudgetExceededError(
                            f"Budget check failed: {policy_decision.reason}"
                        )
                    
                    logger.info(
                        f"Budget check passed for agent {agent_id}: "
                        f"remaining={policy_decision.remaining_budget} USD"
                    )
                    
                    # 3. Execute the actual tool function
                    if inspect.iscoroutinefunction(func):
                        # Reconstruct original call with agent_id
                        if len(args) > 0 and len(param_names) > 0 and param_names[0] == 'agent_id':
                            # agent_id was first positional arg
                            tool_result = await func(agent_id, **tool_args)
                        else:
                            # agent_id should be passed as kwarg
                            tool_result = await func(agent_id=agent_id, **tool_args)
                    else:
                        # Synchronous function
                        if len(args) > 0 and len(param_names) > 0 and param_names[0] == 'agent_id':
                            tool_result = func(agent_id, **tool_args)
                        else:
                            tool_result = func(agent_id=agent_id, **tool_args)
                    
                    # 4. Calculate actual cost from result
                    actual_cost = await self.cost_calculator.calculate_actual_tool_cost(
                        tool_name, tool_args, tool_result
                    )
                    logger.debug(
                        f"Actual cost for tool '{tool_name}': {actual_cost} USD"
                    )
                    
                    # 5. Emit metering event with actual cost
                    metering_event = MeteringEvent(
                        agent_id=agent_id,
                        resource_type=f"mcp.tool.{tool_name}",
                        quantity=Decimal("1"),  # One tool invocation
                        timestamp=datetime.utcnow(),
                        metadata={
                            "tool_name": tool_name,
                            "tool_args": tool_args,
                            "estimated_cost": str(estimated_cost),
                            "actual_cost": str(actual_cost),
                            "decorator_mode": True,
                        }
                    )
                    
                    self.metering_collector.collect_event(
                        metering_event,
                        provisional_charge_id=policy_decision.provisional_charge_id
                    )
                    
                    logger.info(
                        f"MCP tool call completed (decorator): tool={tool_name}, "
                        f"agent={agent_id}, cost={actual_cost} USD"
                    )
                    
                    return tool_result
                    
                except BudgetExceededError:
                    # Re-raise budget errors
                    raise
                except Exception as e:
                    logger.error(
                        f"Failed to execute decorated MCP tool '{tool_name}' for agent {agent_id}: {e}",
                        exc_info=True
                    )
                    raise CaracalError(
                        f"MCP tool execution failed: {e}"
                    ) from e
            
            return wrapper
        
        return decorator
