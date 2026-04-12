"""
Shared tools for cross-functional operations like ticketing, notifications, and reporting.

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


class SharedTools:
    """
    Shared tools for cross-functional operations.
    
    # CARACAL INTEGRATION POINT
    # These tools are executed through Caracal's governed pipeline:
    # 1. Tool call initiated with mandate_id
    # 2. Caracal validates mandate has authority for the tool
    # 3. Caracal routes to appropriate provider (mock or real)
    # 4. Provider executes tool with injected credentials
    # 5. Result returned with audit trail logged
    
    # WITHOUT CARACAL:
    # result = requests.post(
    #     "https://api.ticketing.com/tickets",
    #     headers={"Authorization": f"Bearer {API_KEY}"},
    #     json=args
    # )
    
    # WITH CARACAL:
    # result = await client.call_tool(
    #     tool_id="demo:employee:mock:shared:ticket",
    #     mandate_id=mandate_id,
    #     tool_args=args
    # )
    """
    
    def __init__(self, caracal_client: Any, mode: str = "mock"):
        """
        Initialize shared tools.
        
        Args:
            caracal_client: Caracal client for governed tool execution
            mode: Execution mode ("mock" or "real")
        """
        self.caracal_client = caracal_client
        self.mode = mode
        
        # Tool ID prefix based on mode
        self.tool_prefix = f"demo:employee:{mode}:shared"
        
        logger.info(f"Initialized SharedTools in {mode} mode")
    
    async def create_ticket(
        self,
        mandate_id: str,
        title: str,
        description: str,
        priority: str = "medium",
        category: Optional[str] = None,
        assignee: Optional[str] = None,
    ) -> ToolCallResult:
        """
        Create a new ticket in the ticketing system.
        
        # CARACAL_MARKER: TOOL_CALL
        # This tool call goes through Caracal's authority enforcement pipeline
        
        Args:
            mandate_id: Caracal mandate ID for authority validation
            title: Ticket title
            description: Ticket description
            priority: Priority level (low, medium, high, critical)
            category: Optional ticket category
            assignee: Optional assignee ID
        
        Returns:
            ToolCallResult with created ticket data
        """
        tool_id = f"{self.tool_prefix}:create_ticket"
        tool_args = {
            "title": title,
            "description": description,
            "priority": priority,
            "category": category,
            "assignee": assignee,
        }
        
        try:
            logger.info(
                f"Calling create_ticket tool: {tool_id} with mandate {mandate_id[:8]}"
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
                provider_name=f"demo-ticketing-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Create ticket tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )
    
    async def get_tickets(
        self,
        mandate_id: str,
        status: Optional[str] = None,
        priority: Optional[str] = None,
        assignee: Optional[str] = None,
        limit: int = 50,
    ) -> ToolCallResult:
        """
        Get tickets with optional filtering.
        
        # CARACAL_MARKER: TOOL_CALL
        
        Args:
            mandate_id: Caracal mandate ID for authority validation
            status: Optional status filter (open, in_progress, resolved, closed)
            priority: Optional priority filter (low, medium, high, critical)
            assignee: Optional assignee filter
            limit: Maximum number of tickets to return
        
        Returns:
            ToolCallResult with ticket data
        """
        tool_id = f"{self.tool_prefix}:get_tickets"
        tool_args = {
            "status": status,
            "priority": priority,
            "assignee": assignee,
            "limit": limit,
        }
        
        try:
            logger.info(
                f"Calling get_tickets tool: {tool_id} with mandate {mandate_id[:8]}"
            )
            
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                mandate_id=mandate_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-ticketing-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Get tickets tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )
    
    async def update_ticket(
        self,
        mandate_id: str,
        ticket_id: str,
        status: Optional[str] = None,
        priority: Optional[str] = None,
        assignee: Optional[str] = None,
        notes: Optional[str] = None,
    ) -> ToolCallResult:
        """
        Update an existing ticket.
        
        # CARACAL_MARKER: TOOL_CALL
        # This is a write operation requiring authority
        
        Args:
            mandate_id: Caracal mandate ID for authority validation
            ticket_id: Ticket ID to update
            status: Optional new status
            priority: Optional new priority
            assignee: Optional new assignee
            notes: Optional update notes
        
        Returns:
            ToolCallResult with update confirmation
        """
        tool_id = f"{self.tool_prefix}:update_ticket"
        tool_args = {
            "ticket_id": ticket_id,
            "status": status,
            "priority": priority,
            "assignee": assignee,
            "notes": notes,
        }
        
        try:
            logger.info(
                f"Calling update_ticket tool: {tool_id} with mandate {mandate_id[:8]}"
            )
            
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                mandate_id=mandate_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-ticketing-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Update ticket tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )
    
    async def send_notification(
        self,
        mandate_id: str,
        recipient: str,
        subject: str,
        message: str,
        channel: str = "email",
        priority: str = "normal",
    ) -> ToolCallResult:
        """
        Send a notification to a recipient.
        
        # CARACAL_MARKER: TOOL_CALL
        # This is a write operation that sends external communications
        
        Args:
            mandate_id: Caracal mandate ID for authority validation
            recipient: Recipient identifier (email, user ID, etc.)
            subject: Notification subject
            message: Notification message
            channel: Notification channel (email, slack, sms)
            priority: Priority level (low, normal, high, urgent)
        
        Returns:
            ToolCallResult with notification confirmation
        """
        tool_id = f"{self.tool_prefix}:notify"
        tool_args = {
            "recipient": recipient,
            "subject": subject,
            "message": message,
            "channel": channel,
            "priority": priority,
        }
        
        try:
            logger.info(
                f"Calling notify tool: {tool_id} with mandate {mandate_id[:8]}"
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
                provider_name=f"demo-notification-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Notify tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )
    
    async def generate_report(
        self,
        mandate_id: str,
        report_type: str,
        parameters: Dict[str, Any],
        format: str = "json",
    ) -> ToolCallResult:
        """
        Generate a report based on specified parameters.
        
        # CARACAL_MARKER: TOOL_CALL
        
        Args:
            mandate_id: Caracal mandate ID for authority validation
            report_type: Type of report (financial, operational, executive)
            parameters: Report parameters (date range, filters, etc.)
            format: Output format (json, pdf, csv)
        
        Returns:
            ToolCallResult with generated report data
        """
        tool_id = f"{self.tool_prefix}:report"
        tool_args = {
            "report_type": report_type,
            "parameters": parameters,
            "format": format,
        }
        
        try:
            logger.info(
                f"Calling report tool: {tool_id} with mandate {mandate_id[:8]}"
            )
            
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                mandate_id=mandate_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-reporting-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Report tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )
    
    async def query_data(
        self,
        mandate_id: str,
        query: str,
        data_source: str,
        parameters: Optional[Dict[str, Any]] = None,
    ) -> ToolCallResult:
        """
        Execute a data query against a specified data source.
        
        # CARACAL_MARKER: TOOL_CALL
        
        Args:
            mandate_id: Caracal mandate ID for authority validation
            query: Query string or identifier
            data_source: Data source identifier (database, api, warehouse)
            parameters: Optional query parameters
        
        Returns:
            ToolCallResult with query results
        """
        tool_id = f"{self.tool_prefix}:query"
        tool_args = {
            "query": query,
            "data_source": data_source,
            "parameters": parameters or {},
        }
        
        try:
            logger.info(
                f"Calling query tool: {tool_id} with mandate {mandate_id[:8]}"
            )
            
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                mandate_id=mandate_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-data-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Query tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )
    
    async def send_alert(
        self,
        mandate_id: str,
        alert_type: str,
        severity: str,
        message: str,
        recipients: List[str],
        metadata: Optional[Dict[str, Any]] = None,
    ) -> ToolCallResult:
        """
        Send an alert to specified recipients.
        
        # CARACAL_MARKER: TOOL_CALL
        # This is a write operation for critical communications
        
        Args:
            mandate_id: Caracal mandate ID for authority validation
            alert_type: Type of alert (incident, budget, security, etc.)
            severity: Alert severity (info, warning, error, critical)
            message: Alert message
            recipients: List of recipient identifiers
            metadata: Optional alert metadata
        
        Returns:
            ToolCallResult with alert confirmation
        """
        tool_id = f"{self.tool_prefix}:alert"
        tool_args = {
            "alert_type": alert_type,
            "severity": severity,
            "message": message,
            "recipients": recipients,
            "metadata": metadata or {},
        }
        
        try:
            logger.info(
                f"Calling alert tool: {tool_id} with mandate {mandate_id[:8]}"
            )
            
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                mandate_id=mandate_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-alert-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Alert tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )
    
    async def log_event(
        self,
        mandate_id: str,
        event_type: str,
        event_data: Dict[str, Any],
        severity: str = "info",
    ) -> ToolCallResult:
        """
        Log an event to the centralized logging system.
        
        # CARACAL_MARKER: TOOL_CALL
        
        Args:
            mandate_id: Caracal mandate ID for authority validation
            event_type: Type of event to log
            event_data: Event data to log
            severity: Event severity (debug, info, warning, error)
        
        Returns:
            ToolCallResult with logging confirmation
        """
        tool_id = f"{self.tool_prefix}:log"
        tool_args = {
            "event_type": event_type,
            "event_data": event_data,
            "severity": severity,
        }
        
        try:
            logger.info(
                f"Calling log tool: {tool_id} with mandate {mandate_id[:8]}"
            )
            
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                mandate_id=mandate_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-logging-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Log tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )


# Tool registry for easy access
SHARED_TOOL_METHODS = [
    "create_ticket",
    "get_tickets",
    "update_ticket",
    "send_notification",
    "generate_report",
    "query_data",
    "send_alert",
    "log_event",
]
