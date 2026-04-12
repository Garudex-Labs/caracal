"""
Finance-specific tools for budget analysis, spending tracking, and risk assessment.

These tools are designed to be called through Caracal's governed execution pipeline,
with mandate-based authority validation and provider routing.

# CARACAL INTEGRATION POINT
# All tools in this module are registered with Caracal and executed through
# the Caracal SDK with principal_id for authority enforcement.
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


class FinanceTools:
    """
    Finance-specific tools for budget and financial analysis.
    
    # CARACAL INTEGRATION POINT
    # These tools are executed through Caracal's governed pipeline:
    # 1. Tool call initiated with principal_id
    # 2. Caracal validates mandate has authority for the tool
    # 3. Caracal routes to appropriate provider (mock or real)
    # 4. Provider executes tool with injected credentials
    # 5. Result returned with audit trail logged
    
    # WITHOUT CARACAL:
    # result = requests.post(
    #     "https://api.finance.com/budget",
    #     headers={"Authorization": f"Bearer {API_KEY}"},
    #     json=args
    # )
    
    # WITH CARACAL:
    # result = await client.call_tool(
    #     tool_id="demo:employee:mock:finance:budget",
    #     principal_id=principal_id,
    #     tool_args=args
    # )
    """
    
    def __init__(self, caracal_client: Any, mode: str = "mock"):
        """
        Initialize finance tools.
        
        Args:
            caracal_client: Caracal client for governed tool execution
            mode: Execution mode ("mock" or "real")
        """
        self.caracal_client = caracal_client
        self.mode = mode
        
        # Tool ID prefix based on mode
        self.tool_prefix = f"demo:employee:{mode}:finance"
        
        logger.info(f"Initialized FinanceTools in {mode} mode")
    
    async def get_budget_data(
        self,
        principal_id: str,
        department: Optional[str] = None,
        fiscal_year: Optional[str] = None,
    ) -> ToolCallResult:
        """
        Get budget data for departments.
        
        # CARACAL_MARKER: TOOL_CALL
        # This tool call goes through Caracal's authority enforcement pipeline
        
        Args:
            principal_id: Caracal mandate ID for authority validation
            department: Optional specific department to query
            fiscal_year: Optional fiscal year (defaults to current)
        
        Returns:
            ToolCallResult with budget data
        """
        tool_id = f"{self.tool_prefix}:budget"
        tool_args = {
            "department": department,
            "fiscal_year": fiscal_year or str(datetime.now().year),
        }
        
        try:
            logger.info(
                f"Calling budget tool: {tool_id} with mandate {principal_id[:8]}"
            )
            
            # CARACAL_MARKER: MANDATE_REQUIRED
            # Every governed call must be bound to an explicit principal_id
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-finance-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Budget tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )
    
    async def get_spending_data(
        self,
        principal_id: str,
        department: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> ToolCallResult:
        """
        Get spending data for departments.
        
        # CARACAL_MARKER: TOOL_CALL
        
        Args:
            principal_id: Caracal mandate ID for authority validation
            department: Optional specific department to query
            start_date: Optional start date (ISO format)
            end_date: Optional end date (ISO format)
        
        Returns:
            ToolCallResult with spending data
        """
        tool_id = f"{self.tool_prefix}:spending"
        tool_args = {
            "department": department,
            "start_date": start_date,
            "end_date": end_date,
        }
        
        try:
            logger.info(
                f"Calling spending tool: {tool_id} with mandate {principal_id[:8]}"
            )
            
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-finance-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Spending tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )
    
    async def get_invoice_data(
        self,
        principal_id: str,
        status: Optional[str] = None,
        department: Optional[str] = None,
        vendor: Optional[str] = None,
    ) -> ToolCallResult:
        """
        Get invoice data with optional filtering.
        
        # CARACAL_MARKER: TOOL_CALL
        
        Args:
            principal_id: Caracal mandate ID for authority validation
            status: Optional invoice status filter (pending, paid, overdue)
            department: Optional department filter
            vendor: Optional vendor filter
        
        Returns:
            ToolCallResult with invoice data
        """
        tool_id = f"{self.tool_prefix}:invoices"
        tool_args = {
            "status": status,
            "department": department,
            "vendor": vendor,
        }
        
        try:
            logger.info(
                f"Calling invoice tool: {tool_id} with mandate {principal_id[:8]}"
            )
            
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-finance-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Invoice tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )
    
    async def calculate_risk_score(
        self,
        principal_id: str,
        department: Optional[str] = None,
        include_projections: bool = False,
    ) -> ToolCallResult:
        """
        Calculate financial risk score for departments.
        
        # CARACAL_MARKER: TOOL_CALL
        
        Args:
            principal_id: Caracal mandate ID for authority validation
            department: Optional specific department to analyze
            include_projections: Whether to include future projections
        
        Returns:
            ToolCallResult with risk assessment data
        """
        tool_id = f"{self.tool_prefix}:risk"
        tool_args = {
            "department": department,
            "include_projections": include_projections,
        }
        
        try:
            logger.info(
                f"Calling risk tool: {tool_id} with mandate {principal_id[:8]}"
            )
            
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-finance-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Risk tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )
    
    async def get_variance_report(
        self,
        principal_id: str,
        department: Optional[str] = None,
        threshold_percent: float = 5.0,
    ) -> ToolCallResult:
        """
        Get budget variance report showing departments over/under budget.
        
        # CARACAL_MARKER: TOOL_CALL
        
        Args:
            principal_id: Caracal mandate ID for authority validation
            department: Optional specific department to analyze
            threshold_percent: Variance threshold for flagging (default 5%)
        
        Returns:
            ToolCallResult with variance report data
        """
        tool_id = f"{self.tool_prefix}:variance"
        tool_args = {
            "department": department,
            "threshold_percent": threshold_percent,
        }
        
        try:
            logger.info(
                f"Calling variance tool: {tool_id} with mandate {principal_id[:8]}"
            )
            
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-finance-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Variance tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )
    
    async def approve_payment(
        self,
        principal_id: str,
        invoice_id: str,
        approver_id: str,
        notes: Optional[str] = None,
    ) -> ToolCallResult:
        """
        Approve a pending invoice for payment.
        
        # CARACAL_MARKER: TOOL_CALL
        # This is a write operation requiring elevated authority
        
        Args:
            principal_id: Caracal mandate ID for authority validation
            invoice_id: Invoice ID to approve
            approver_id: ID of the approver
            notes: Optional approval notes
        
        Returns:
            ToolCallResult with approval confirmation
        """
        tool_id = f"{self.tool_prefix}:approve_payment"
        tool_args = {
            "invoice_id": invoice_id,
            "approver_id": approver_id,
            "notes": notes,
        }
        
        try:
            logger.info(
                f"Calling approve_payment tool: {tool_id} with mandate {principal_id[:8]}"
            )
            
            # CARACAL_MARKER: AUTHORITY_CHECK
            # Write operations require explicit authority validation
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-finance-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Approve payment tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )
    
    async def freeze_spending(
        self,
        principal_id: str,
        department: str,
        reason: str,
        duration_days: Optional[int] = None,
    ) -> ToolCallResult:
        """
        Freeze spending for a department.
        
        # CARACAL_MARKER: TOOL_CALL
        # This is a critical write operation requiring high authority
        
        Args:
            principal_id: Caracal mandate ID for authority validation
            department: Department to freeze spending for
            reason: Reason for spending freeze
            duration_days: Optional duration in days (indefinite if not specified)
        
        Returns:
            ToolCallResult with freeze confirmation
        """
        tool_id = f"{self.tool_prefix}:freeze_spending"
        tool_args = {
            "department": department,
            "reason": reason,
            "duration_days": duration_days,
        }
        
        try:
            logger.info(
                f"Calling freeze_spending tool: {tool_id} with mandate {principal_id[:8]}"
            )
            
            result = await self.caracal_client.call_tool(
                tool_id=tool_id,
                tool_args=tool_args,
            )
            
            return ToolCallResult(
                success=True,
                data=result,
                provider_name=f"demo-finance-api-{self.mode}",
            )
        
        except Exception as e:
            logger.error(f"Freeze spending tool call failed: {e}", exc_info=True)
            return ToolCallResult(
                success=False,
                data={},
                error=str(e),
            )


# Tool registry for easy access
FINANCE_TOOL_METHODS = [
    "get_budget_data",
    "get_spending_data",
    "get_invoice_data",
    "calculate_risk_score",
    "get_variance_report",
    "approve_payment",
    "freeze_spending",
]
