"""
Unit tests for agent tools.

Tests cover:
- FinanceTools: Budget, spending, invoice, and risk tools
- OpsTools: Incident, health, SLA, and escalation tools
- SharedTools: Ticket, notification, report, and query tools
- Tool integration with Caracal SDK
- ToolCallResult data model
"""

import pytest
import asyncio
from pathlib import Path
import sys
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent))

from agents.tools import (
    FinanceTools,
    OpsTools,
    SharedTools,
    ToolCallResult,
    FINANCE_TOOL_METHODS,
    OPS_TOOL_METHODS,
    SHARED_TOOL_METHODS,
    create_tool_suite,
    get_all_tool_methods,
)


class TestToolCallResult:
    """Tests for ToolCallResult data model."""
    
    def test_init_success(self):
        """Test successful result initialization."""
        result = ToolCallResult(
            success=True,
            data={"key": "value"},
            provider_name="test-provider"
        )
        
        assert result.success is True
        assert result.data == {"key": "value"}
        assert result.error is None
        assert result.provider_name == "test-provider"
    
    def test_init_failure(self):
        """Test failure result initialization."""
        result = ToolCallResult(
            success=False,
            data={},
            error="Test error message"
        )
        
        assert result.success is False
        assert result.data == {}
        assert result.error == "Test error message"
    
    def test_to_dict(self):
        """Test converting result to dictionary."""
        result = ToolCallResult(
            success=True,
            data={"count": 42},
            execution_time_ms=150,
            provider_name="demo-api-mock"
        )
        
        result_dict = result.to_dict()
        
        assert isinstance(result_dict, dict)
        assert result_dict["success"] is True
        assert result_dict["data"] == {"count": 42}
        assert result_dict["execution_time_ms"] == 150
        assert result_dict["provider_name"] == "demo-api-mock"


class TestFinanceTools:
    """Tests for FinanceTools."""
    
    def setup_method(self):
        """Set up test fixtures."""
        self.mock_client = MagicMock()
        self.mock_client.call_tool = AsyncMock()
        self.tools = FinanceTools(self.mock_client, mode="mock")
    
    @pytest.mark.asyncio
    async def test_get_budget_data_success(self):
        """Test successful budget data retrieval."""
        self.mock_client.call_tool.return_value = {
            "departments": [
                {"name": "Engineering", "budget": 1000000, "spent": 950000}
            ]
        }
        
        result = await self.tools.get_budget_data(
            mandate_id="mandate-123",
            department="Engineering"
        )
        
        assert result.success is True
        assert "departments" in result.data
        assert result.provider_name == "demo-finance-api-mock"
        
        # Verify Caracal client was called correctly
        self.mock_client.call_tool.assert_called_once()
        call_args = self.mock_client.call_tool.call_args
        assert call_args.kwargs["tool_id"] == "demo:employee:mock:finance:budget"
        assert call_args.kwargs["mandate_id"] == "mandate-123"
        assert call_args.kwargs["tool_args"]["department"] == "Engineering"
    
    @pytest.mark.asyncio
    async def test_get_budget_data_failure(self):
        """Test budget data retrieval failure."""
        self.mock_client.call_tool.side_effect = Exception("API error")
        
        result = await self.tools.get_budget_data(
            mandate_id="mandate-123"
        )
        
        assert result.success is False
        assert result.error == "API error"
        assert result.data == {}
    
    @pytest.mark.asyncio
    async def test_get_spending_data(self):
        """Test spending data retrieval."""
        self.mock_client.call_tool.return_value = {
            "total_spent": 500000,
            "transactions": []
        }
        
        result = await self.tools.get_spending_data(
            mandate_id="mandate-456",
            department="Marketing",
            start_date="2024-01-01",
            end_date="2024-12-31"
        )
        
        assert result.success is True
        assert result.data["total_spent"] == 500000
        
        call_args = self.mock_client.call_tool.call_args
        assert call_args.kwargs["tool_id"] == "demo:employee:mock:finance:spending"
        assert call_args.kwargs["tool_args"]["department"] == "Marketing"
    
    @pytest.mark.asyncio
    async def test_get_invoice_data(self):
        """Test invoice data retrieval."""
        self.mock_client.call_tool.return_value = {
            "invoices": [
                {"invoice_id": "INV-001", "amount": 5000, "status": "pending"}
            ]
        }
        
        result = await self.tools.get_invoice_data(
            mandate_id="mandate-789",
            status="pending"
        )
        
        assert result.success is True
        assert len(result.data["invoices"]) == 1
        
        call_args = self.mock_client.call_tool.call_args
        assert call_args.kwargs["tool_id"] == "demo:employee:mock:finance:invoices"
    
    @pytest.mark.asyncio
    async def test_calculate_risk_score(self):
        """Test risk score calculation."""
        self.mock_client.call_tool.return_value = {
            "risk_score": 75,
            "risk_level": "medium"
        }
        
        result = await self.tools.calculate_risk_score(
            mandate_id="mandate-abc",
            department="Engineering",
            include_projections=True
        )
        
        assert result.success is True
        assert result.data["risk_score"] == 75
        
        call_args = self.mock_client.call_tool.call_args
        assert call_args.kwargs["tool_id"] == "demo:employee:mock:finance:risk"
        assert call_args.kwargs["tool_args"]["include_projections"] is True
    
    @pytest.mark.asyncio
    async def test_get_variance_report(self):
        """Test variance report retrieval."""
        self.mock_client.call_tool.return_value = {
            "variances": [
                {"department": "Engineering", "variance_percent": 8.5}
            ]
        }
        
        result = await self.tools.get_variance_report(
            mandate_id="mandate-def",
            threshold_percent=5.0
        )
        
        assert result.success is True
        assert len(result.data["variances"]) == 1
    
    @pytest.mark.asyncio
    async def test_approve_payment(self):
        """Test payment approval."""
        self.mock_client.call_tool.return_value = {
            "approved": True,
            "approval_id": "APPR-001"
        }
        
        result = await self.tools.approve_payment(
            mandate_id="mandate-ghi",
            invoice_id="INV-001",
            approver_id="user-123",
            notes="Approved for payment"
        )
        
        assert result.success is True
        assert result.data["approved"] is True
        
        call_args = self.mock_client.call_tool.call_args
        assert call_args.kwargs["tool_id"] == "demo:employee:mock:finance:approve_payment"
    
    @pytest.mark.asyncio
    async def test_freeze_spending(self):
        """Test spending freeze."""
        self.mock_client.call_tool.return_value = {
            "frozen": True,
            "department": "Engineering"
        }
        
        result = await self.tools.freeze_spending(
            mandate_id="mandate-jkl",
            department="Engineering",
            reason="Budget overrun",
            duration_days=30
        )
        
        assert result.success is True
        assert result.data["frozen"] is True
    
    def test_tool_methods_registry(self):
        """Test that all expected tool methods are registered."""
        expected_methods = [
            "get_budget_data",
            "get_spending_data",
            "get_invoice_data",
            "calculate_risk_score",
            "get_variance_report",
            "approve_payment",
            "freeze_spending",
        ]
        
        assert FINANCE_TOOL_METHODS == expected_methods


class TestOpsTools:
    """Tests for OpsTools."""
    
    def setup_method(self):
        """Set up test fixtures."""
        self.mock_client = MagicMock()
        self.mock_client.call_tool = AsyncMock()
        self.tools = OpsTools(self.mock_client, mode="mock")
    
    @pytest.mark.asyncio
    async def test_get_incidents_success(self):
        """Test successful incident retrieval."""
        self.mock_client.call_tool.return_value = {
            "incidents": [
                {"incident_id": "INC-001", "severity": "high", "status": "open"}
            ]
        }
        
        result = await self.tools.get_incidents(
            mandate_id="mandate-123",
            severity="high",
            time_range_hours=24
        )
        
        assert result.success is True
        assert len(result.data["incidents"]) == 1
        assert result.provider_name == "demo-ops-api-mock"
        
        call_args = self.mock_client.call_tool.call_args
        assert call_args.kwargs["tool_id"] == "demo:employee:mock:ops:incidents"
        assert call_args.kwargs["tool_args"]["severity"] == "high"
    
    @pytest.mark.asyncio
    async def test_get_service_health(self):
        """Test service health retrieval."""
        self.mock_client.call_tool.return_value = {
            "services": [
                {"name": "API Gateway", "status": "healthy", "uptime": 99.9}
            ]
        }
        
        result = await self.tools.get_service_health(
            mandate_id="mandate-456",
            service="API Gateway",
            include_metrics=True
        )
        
        assert result.success is True
        assert len(result.data["services"]) == 1
        
        call_args = self.mock_client.call_tool.call_args
        assert call_args.kwargs["tool_id"] == "demo:employee:mock:ops:health"
    
    @pytest.mark.asyncio
    async def test_get_sla_status(self):
        """Test SLA status retrieval."""
        self.mock_client.call_tool.return_value = {
            "sla_compliance": 98.5,
            "breaches": 2
        }
        
        result = await self.tools.get_sla_status(
            mandate_id="mandate-789",
            period="current_month"
        )
        
        assert result.success is True
        assert result.data["sla_compliance"] == 98.5
    
    @pytest.mark.asyncio
    async def test_get_performance_metrics(self):
        """Test performance metrics retrieval."""
        self.mock_client.call_tool.return_value = {
            "metrics": {
                "latency_p95": 150,
                "throughput": 1000
            }
        }
        
        result = await self.tools.get_performance_metrics(
            mandate_id="mandate-abc",
            service="API Gateway",
            metric_type="latency"
        )
        
        assert result.success is True
        assert "metrics" in result.data
    
    @pytest.mark.asyncio
    async def test_escalate_incident(self):
        """Test incident escalation."""
        self.mock_client.call_tool.return_value = {
            "escalated": True,
            "escalation_id": "ESC-001"
        }
        
        result = await self.tools.escalate_incident(
            mandate_id="mandate-def",
            incident_id="INC-001",
            escalation_level="L3",
            reason="Critical issue",
            notify_oncall=True
        )
        
        assert result.success is True
        assert result.data["escalated"] is True
        
        call_args = self.mock_client.call_tool.call_args
        assert call_args.kwargs["tool_id"] == "demo:employee:mock:ops:escalate"
    
    @pytest.mark.asyncio
    async def test_update_incident_status(self):
        """Test incident status update."""
        self.mock_client.call_tool.return_value = {
            "updated": True,
            "new_status": "resolved"
        }
        
        result = await self.tools.update_incident_status(
            mandate_id="mandate-ghi",
            incident_id="INC-001",
            new_status="resolved",
            notes="Issue fixed"
        )
        
        assert result.success is True
        assert result.data["updated"] is True
    
    @pytest.mark.asyncio
    async def test_scale_service(self):
        """Test service scaling."""
        self.mock_client.call_tool.return_value = {
            "scaled": True,
            "current_instances": 10
        }
        
        result = await self.tools.scale_service(
            mandate_id="mandate-jkl",
            service="API Gateway",
            target_instances=10,
            reason="High load"
        )
        
        assert result.success is True
        assert result.data["scaled"] is True
    
    @pytest.mark.asyncio
    async def test_trigger_runbook(self):
        """Test runbook triggering."""
        self.mock_client.call_tool.return_value = {
            "triggered": True,
            "execution_id": "EXEC-001"
        }
        
        result = await self.tools.trigger_runbook(
            mandate_id="mandate-mno",
            runbook_id="RB-001",
            incident_id="INC-001",
            parameters={"param1": "value1"}
        )
        
        assert result.success is True
        assert result.data["triggered"] is True
    
    @pytest.mark.asyncio
    async def test_get_incidents_failure(self):
        """Test incident retrieval failure."""
        self.mock_client.call_tool.side_effect = Exception("Connection error")
        
        result = await self.tools.get_incidents(
            mandate_id="mandate-123"
        )
        
        assert result.success is False
        assert result.error == "Connection error"
    
    def test_tool_methods_registry(self):
        """Test that all expected tool methods are registered."""
        expected_methods = [
            "get_incidents",
            "get_service_health",
            "get_sla_status",
            "get_performance_metrics",
            "escalate_incident",
            "update_incident_status",
            "scale_service",
            "trigger_runbook",
        ]
        
        assert OPS_TOOL_METHODS == expected_methods


class TestSharedTools:
    """Tests for SharedTools."""
    
    def setup_method(self):
        """Set up test fixtures."""
        self.mock_client = MagicMock()
        self.mock_client.call_tool = AsyncMock()
        self.tools = SharedTools(self.mock_client, mode="mock")
    
    @pytest.mark.asyncio
    async def test_create_ticket_success(self):
        """Test successful ticket creation."""
        self.mock_client.call_tool.return_value = {
            "ticket_id": "TKT-001",
            "status": "open"
        }
        
        result = await self.tools.create_ticket(
            mandate_id="mandate-123",
            title="Test ticket",
            description="Test description",
            priority="high"
        )
        
        assert result.success is True
        assert result.data["ticket_id"] == "TKT-001"
        assert result.provider_name == "demo-ticketing-api-mock"
        
        call_args = self.mock_client.call_tool.call_args
        assert call_args.kwargs["tool_id"] == "demo:employee:mock:shared:create_ticket"
        assert call_args.kwargs["tool_args"]["title"] == "Test ticket"
    
    @pytest.mark.asyncio
    async def test_get_tickets(self):
        """Test ticket retrieval."""
        self.mock_client.call_tool.return_value = {
            "tickets": [
                {"ticket_id": "TKT-001", "status": "open"}
            ]
        }
        
        result = await self.tools.get_tickets(
            mandate_id="mandate-456",
            status="open",
            limit=50
        )
        
        assert result.success is True
        assert len(result.data["tickets"]) == 1
    
    @pytest.mark.asyncio
    async def test_update_ticket(self):
        """Test ticket update."""
        self.mock_client.call_tool.return_value = {
            "updated": True,
            "ticket_id": "TKT-001"
        }
        
        result = await self.tools.update_ticket(
            mandate_id="mandate-789",
            ticket_id="TKT-001",
            status="resolved",
            notes="Issue fixed"
        )
        
        assert result.success is True
        assert result.data["updated"] is True
    
    @pytest.mark.asyncio
    async def test_send_notification(self):
        """Test notification sending."""
        self.mock_client.call_tool.return_value = {
            "sent": True,
            "notification_id": "NOTIF-001"
        }
        
        result = await self.tools.send_notification(
            mandate_id="mandate-abc",
            recipient="user@example.com",
            subject="Test notification",
            message="Test message",
            channel="email"
        )
        
        assert result.success is True
        assert result.data["sent"] is True
        
        call_args = self.mock_client.call_tool.call_args
        assert call_args.kwargs["tool_id"] == "demo:employee:mock:shared:notify"
    
    @pytest.mark.asyncio
    async def test_generate_report(self):
        """Test report generation."""
        self.mock_client.call_tool.return_value = {
            "report_id": "RPT-001",
            "data": {"summary": "test"}
        }
        
        result = await self.tools.generate_report(
            mandate_id="mandate-def",
            report_type="financial",
            parameters={"date_range": "Q4"},
            format="json"
        )
        
        assert result.success is True
        assert result.data["report_id"] == "RPT-001"
    
    @pytest.mark.asyncio
    async def test_query_data(self):
        """Test data querying."""
        self.mock_client.call_tool.return_value = {
            "results": [{"id": 1, "value": "test"}]
        }
        
        result = await self.tools.query_data(
            mandate_id="mandate-ghi",
            query="SELECT * FROM table",
            data_source="database",
            parameters={"limit": 10}
        )
        
        assert result.success is True
        assert len(result.data["results"]) == 1
    
    @pytest.mark.asyncio
    async def test_send_alert(self):
        """Test alert sending."""
        self.mock_client.call_tool.return_value = {
            "sent": True,
            "alert_id": "ALERT-001"
        }
        
        result = await self.tools.send_alert(
            mandate_id="mandate-jkl",
            alert_type="incident",
            severity="critical",
            message="Critical alert",
            recipients=["user1", "user2"]
        )
        
        assert result.success is True
        assert result.data["sent"] is True
    
    @pytest.mark.asyncio
    async def test_log_event(self):
        """Test event logging."""
        self.mock_client.call_tool.return_value = {
            "logged": True,
            "event_id": "EVT-001"
        }
        
        result = await self.tools.log_event(
            mandate_id="mandate-mno",
            event_type="user_action",
            event_data={"action": "login"},
            severity="info"
        )
        
        assert result.success is True
        assert result.data["logged"] is True
    
    @pytest.mark.asyncio
    async def test_create_ticket_failure(self):
        """Test ticket creation failure."""
        self.mock_client.call_tool.side_effect = Exception("API error")
        
        result = await self.tools.create_ticket(
            mandate_id="mandate-123",
            title="Test",
            description="Test"
        )
        
        assert result.success is False
        assert result.error == "API error"
    
    def test_tool_methods_registry(self):
        """Test that all expected tool methods are registered."""
        expected_methods = [
            "create_ticket",
            "get_tickets",
            "update_ticket",
            "send_notification",
            "generate_report",
            "query_data",
            "send_alert",
            "log_event",
        ]
        
        assert SHARED_TOOL_METHODS == expected_methods


class TestToolIntegration:
    """Tests for tool integration functions."""
    
    def test_create_tool_suite(self):
        """Test creating complete tool suite."""
        mock_client = MagicMock()
        
        suite = create_tool_suite(mock_client, mode="mock")
        
        assert "finance" in suite
        assert "ops" in suite
        assert "shared" in suite
        assert isinstance(suite["finance"], FinanceTools)
        assert isinstance(suite["ops"], OpsTools)
        assert isinstance(suite["shared"], SharedTools)
        assert suite["finance"].mode == "mock"
        assert suite["ops"].mode == "mock"
        assert suite["shared"].mode == "mock"
    
    def test_create_tool_suite_real_mode(self):
        """Test creating tool suite in real mode."""
        mock_client = MagicMock()
        
        suite = create_tool_suite(mock_client, mode="real")
        
        assert suite["finance"].mode == "real"
        assert suite["ops"].mode == "real"
        assert suite["shared"].mode == "real"
    
    def test_get_all_tool_methods(self):
        """Test getting all tool methods."""
        methods = get_all_tool_methods()
        
        assert "finance" in methods
        assert "ops" in methods
        assert "shared" in methods
        assert isinstance(methods["finance"], list)
        assert isinstance(methods["ops"], list)
        assert isinstance(methods["shared"], list)
        assert len(methods["finance"]) > 0
        assert len(methods["ops"]) > 0
        assert len(methods["shared"]) > 0


class TestToolCaracalIntegration:
    """Tests for Caracal SDK integration patterns."""
    
    def setup_method(self):
        """Set up test fixtures."""
        self.mock_client = MagicMock()
        self.mock_client.call_tool = AsyncMock()
    
    @pytest.mark.asyncio
    async def test_mandate_id_required(self):
        """Test that all tool calls require mandate_id."""
        tools = FinanceTools(self.mock_client, mode="mock")
        self.mock_client.call_tool.return_value = {"data": "test"}
        
        await tools.get_budget_data(mandate_id="mandate-123")
        
        call_args = self.mock_client.call_tool.call_args
        assert "mandate_id" in call_args.kwargs
        assert call_args.kwargs["mandate_id"] == "mandate-123"
    
    @pytest.mark.asyncio
    async def test_tool_id_format(self):
        """Test that tool IDs follow correct format."""
        tools = FinanceTools(self.mock_client, mode="mock")
        self.mock_client.call_tool.return_value = {"data": "test"}
        
        await tools.get_budget_data(mandate_id="mandate-123")
        
        call_args = self.mock_client.call_tool.call_args
        tool_id = call_args.kwargs["tool_id"]
        
        # Format: demo:employee:{mode}:{category}:{tool_name}
        parts = tool_id.split(":")
        assert len(parts) == 5
        assert parts[0] == "demo"
        assert parts[1] == "employee"
        assert parts[2] == "mock"
        assert parts[3] == "finance"
        assert parts[4] == "budget"
    
    @pytest.mark.asyncio
    async def test_tool_args_passed_correctly(self):
        """Test that tool arguments are passed correctly."""
        tools = OpsTools(self.mock_client, mode="mock")
        self.mock_client.call_tool.return_value = {"data": "test"}
        
        await tools.get_incidents(
            mandate_id="mandate-123",
            severity="high",
            status="open",
            time_range_hours=48
        )
        
        call_args = self.mock_client.call_tool.call_args
        tool_args = call_args.kwargs["tool_args"]
        
        assert tool_args["severity"] == "high"
        assert tool_args["status"] == "open"
        assert tool_args["time_range_hours"] == 48
    
    @pytest.mark.asyncio
    async def test_mode_affects_tool_id(self):
        """Test that mode affects tool ID generation."""
        mock_tools = FinanceTools(self.mock_client, mode="mock")
        real_tools = FinanceTools(self.mock_client, mode="real")
        
        self.mock_client.call_tool.return_value = {"data": "test"}
        
        await mock_tools.get_budget_data(mandate_id="m1")
        mock_tool_id = self.mock_client.call_tool.call_args.kwargs["tool_id"]
        
        await real_tools.get_budget_data(mandate_id="m2")
        real_tool_id = self.mock_client.call_tool.call_args.kwargs["tool_id"]
        
        assert "mock" in mock_tool_id
        assert "real" in real_tool_id
        assert mock_tool_id != real_tool_id
