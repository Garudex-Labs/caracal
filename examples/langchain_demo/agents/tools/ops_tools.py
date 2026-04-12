"""
Operations-specific tools for incident management, service health, and SLA monitoring.

These tools are designed to be called through Caracal's governed execution pipeline,
with mandate-based authority validation and provider routing.

# CARACAL INTEGRATION POINT
# All tools in this module are registered with Caracal and executed through
# the Caracal SDK with mandate_id for authority enforcement.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional
import logging

logger = logging.getLogger(__name__)


@dataclass
class ToolCallResult:
    """Result from a tool call execution."""
    
    success: bool
    data: Dict[str, Any]
    error: Optional[str] = None
    execution_time_ms: Optional[int] = None
    provider_name: Optional[str] = None
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "success": self.success,
            "data": self.data,
            "error": self.error,
            "execution_time_ms": self.execution_time_ms,
            "provider_name": self.provider_name,
        }


class OpsTools:
    """
    Operations-specific tools for incident management and service monitoring.
    
    # CARACAL INTEGRATION POINT
    # These tools are executed through Caracal's governed pipeline:
    # 1. Tool call initiated with mandate_id
    # 2. Caracal validates mandate has authority for the tool
    # 3. Caracal routes to appropriate provider (mock or real)
    # 4. Provider executes tool with injected credentials
    # 5. Result returned with audit trail logged
    
    # WITHOUT CARACAL:
    # result = requests.post(
    #     "https://api.ops.com/incidents",
    #     headers={"Authorization": f"Bearer {API_KEY}"},
    #     json=args
    # )
    
    # WITH CARACAL:
    # result = await client.call_tool(
    #     tool_id="demo:employee:mock:ops:incidents",
    #     mandate_id=mandate_id,
    #     tool_args=args
    # )
    """
    
    def __init__(self, caracal_client: Any, mode: str = "mock"):
        """
        Initialize operations tools.
        
        Args:
            caracal_client: Caracal client for governed tool execution
            mode: Execution mode ("mock" or "real")
        """
        self.caracal_client = caracal_client
        self.mode = mode
        
        # Tool ID prefix based on mode
        self.tool_prefix = f"demo:employee:{mode}:ops"
        
        logger.info(f"Initialized OpsTools in {mode} mode")
    
    async def get_incidents(
        self,
        mandate_id: str,
        severity: Optional[str] = None,
        status: Optional[str] = None,
        service: Optional[str] = None,
        time_range_hours: int = 24,
    ) -> ToolCallResult:
        """
        Get incident data with optional filtering.
        
        # CARACAL_MARKER: TOOL_CALL
        # This tool call goes through Caracal's authority enforcement pipeline
        
        Args:
            mandate_id: Caracal mandate ID for authority validation
            severity: Optional severity filter (low, medium, high, critical)
            status: Optional status filter (open, investigating, resolved)
            service: Optional service name filter
            time_range_hours: Time range to query (default 24 hours)
        
        Returns:
            ToolCallResult with incident data
        """
        tool_id = f"{self.tool_prefix}:incidents"
        tool_args = {
            "severity": severity,
            "status": status,
            "service": service,
            "time_range_hours": time_range_hours,
        }
        
        try:
            logger.info(
                f"Calling incidents tool: {tool_id} with mandate {mandate_id[:8]}"
            )
            
            # CARACAL_MARKER: MANDATE_REQUIRED
            # Every governed call must be bound to an explicit mandate_id
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                mandate_id=mandate_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-ops-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Incidents tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )
    
    async def get_service_health(
        self,
        mandate_id: str,
        service: Optional[str] = None,
        include_metrics: bool = True,
    ) -> ToolCallResult:
        """
        Get service health status and metrics.
        
        # CARACAL_MARKER: TOOL_CALL
        
        Args:
            mandate_id: Caracal mandate ID for authority validation
            service: Optional specific service to query
            include_metrics: Whether to include detailed metrics
        
        Returns:
            ToolCallResult with service health data
        """
        tool_id = f"{self.tool_prefix}:health"
        tool_args = {
            "service": service,
            "include_metrics": include_metrics,
        }
        
        try:
            logger.info(
                f"Calling health tool: {tool_id} with mandate {mandate_id[:8]}"
            )
            
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                mandate_id=mandate_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-ops-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Health tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )
    
    async def get_sla_status(
        self,
        mandate_id: str,
        service: Optional[str] = None,
        period: str = "current_month",
    ) -> ToolCallResult:
        """
        Get SLA compliance status for services.
        
        # CARACAL_MARKER: TOOL_CALL
        
        Args:
            mandate_id: Caracal mandate ID for authority validation
            service: Optional specific service to query
            period: Time period (current_month, last_month, quarter, year)
        
        Returns:
            ToolCallResult with SLA status data
        """
        tool_id = f"{self.tool_prefix}:sla"
        tool_args = {
            "service": service,
            "period": period,
        }
        
        try:
            logger.info(
                f"Calling SLA tool: {tool_id} with mandate {mandate_id[:8]}"
            )
            
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                mandate_id=mandate_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-ops-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"SLA tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )
    
    async def get_performance_metrics(
        self,
        mandate_id: str,
        service: Optional[str] = None,
        metric_type: Optional[str] = None,
        time_range_hours: int = 24,
    ) -> ToolCallResult:
        """
        Get performance metrics for services.
        
        # CARACAL_MARKER: TOOL_CALL
        
        Args:
            mandate_id: Caracal mandate ID for authority validation
            service: Optional specific service to query
            metric_type: Optional metric type (latency, throughput, errors)
            time_range_hours: Time range to query (default 24 hours)
        
        Returns:
            ToolCallResult with performance metrics
        """
        tool_id = f"{self.tool_prefix}:metrics"
        tool_args = {
            "service": service,
            "metric_type": metric_type,
            "time_range_hours": time_range_hours,
        }
        
        try:
            logger.info(
                f"Calling metrics tool: {tool_id} with mandate {mandate_id[:8]}"
            )
            
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                mandate_id=mandate_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-ops-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Metrics tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )
    
    async def escalate_incident(
        self,
        mandate_id: str,
        incident_id: str,
        escalation_level: str,
        reason: str,
        notify_oncall: bool = True,
    ) -> ToolCallResult:
        """
        Escalate an incident to a higher level.
        
        # CARACAL_MARKER: TOOL_CALL
        # This is a write operation requiring elevated authority
        
        Args:
            mandate_id: Caracal mandate ID for authority validation
            incident_id: Incident ID to escalate
            escalation_level: Target escalation level (L2, L3, executive)
            reason: Reason for escalation
            notify_oncall: Whether to notify on-call personnel
        
        Returns:
            ToolCallResult with escalation confirmation
        """
        tool_id = f"{self.tool_prefix}:escalate"
        tool_args = {
            "incident_id": incident_id,
            "escalation_level": escalation_level,
            "reason": reason,
            "notify_oncall": notify_oncall,
        }
        
        try:
            logger.info(
                f"Calling escalate tool: {tool_id} with mandate {mandate_id[:8]}"
            )
            
            # CARACAL_MARKER: AUTHORITY_CHECK
            # Write operations require explicit authority validation
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                mandate_id=mandate_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-ops-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Escalate tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )
    
    async def update_incident_status(
        self,
        mandate_id: str,
        incident_id: str,
        new_status: str,
        notes: Optional[str] = None,
    ) -> ToolCallResult:
        """
        Update the status of an incident.
        
        # CARACAL_MARKER: TOOL_CALL
        # This is a write operation requiring authority
        
        Args:
            mandate_id: Caracal mandate ID for authority validation
            incident_id: Incident ID to update
            new_status: New status (investigating, mitigating, resolved, closed)
            notes: Optional status update notes
        
        Returns:
            ToolCallResult with update confirmation
        """
        tool_id = f"{self.tool_prefix}:update_incident"
        tool_args = {
            "incident_id": incident_id,
            "new_status": new_status,
            "notes": notes,
        }
        
        try:
            logger.info(
                f"Calling update_incident tool: {tool_id} with mandate {mandate_id[:8]}"
            )
            
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                mandate_id=mandate_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-ops-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Update incident tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )
    
    async def scale_service(
        self,
        mandate_id: str,
        service: str,
        target_instances: int,
        reason: str,
    ) -> ToolCallResult:
        """
        Scale a service to a target number of instances.
        
        # CARACAL_MARKER: TOOL_CALL
        # This is a critical write operation requiring high authority
        
        Args:
            mandate_id: Caracal mandate ID for authority validation
            service: Service name to scale
            target_instances: Target number of instances
            reason: Reason for scaling
        
        Returns:
            ToolCallResult with scaling confirmation
        """
        tool_id = f"{self.tool_prefix}:scale"
        tool_args = {
            "service": service,
            "target_instances": target_instances,
            "reason": reason,
        }
        
        try:
            logger.info(
                f"Calling scale tool: {tool_id} with mandate {mandate_id[:8]}"
            )
            
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                mandate_id=mandate_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-ops-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Scale tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )
    
    async def trigger_runbook(
        self,
        mandate_id: str,
        runbook_id: str,
        incident_id: Optional[str] = None,
        parameters: Optional[Dict[str, Any]] = None,
    ) -> ToolCallResult:
        """
        Trigger an automated runbook for incident response.
        
        # CARACAL_MARKER: TOOL_CALL
        # This is a write operation that may trigger automated actions
        
        Args:
            mandate_id: Caracal mandate ID for authority validation
            runbook_id: Runbook ID to execute
            incident_id: Optional incident ID to associate with
            parameters: Optional runbook parameters
        
        Returns:
            ToolCallResult with runbook execution status
        """
        tool_id = f"{self.tool_prefix}:runbook"
        tool_args = {
            "runbook_id": runbook_id,
            "incident_id": incident_id,
            "parameters": parameters or {},
        }
        
        try:
            logger.info(
                f"Calling runbook tool: {tool_id} with mandate {mandate_id[:8]}"
            )
            
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                mandate_id=mandate_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-ops-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Runbook tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )


# Tool registry for easy access
OPS_TOOL_METHODS = [
    "get_incidents",
    "get_service_health",
    "get_sla_status",
    "get_performance_metrics",
    "escalate_incident",
    "update_incident_status",
    "scale_service",
    "trigger_runbook",
]
