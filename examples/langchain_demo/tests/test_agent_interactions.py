"""
Integration tests for agent interactions.

Tests cover:
- Orchestrator agent task decomposition and delegation
- Finance agent budget analysis
- Ops agent incident analysis
- Agent tool binding and execution
- Agent-to-agent delegation protocol
- Multi-agent workflows
"""

import pytest
import asyncio
from pathlib import Path
import sys
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent))

from agents.orchestrator import OrchestratorAgent
from agents.finance_agent import FinanceAgent
from agents.ops_agent import OpsAgent
from agents.base import AgentRole, MessageType
from agents.tool_binding import (
    ToolBinding,
    ToolDefinition,
    ToolCall,
    ToolRegistry,
    get_tool_registry,
    reset_tool_registry,
)
from agents.delegation import (
    DelegationProtocol,
    DelegationRequest,
    DelegationResult,
    MandateDelegation,
    get_delegation_protocol,
    reset_delegation_protocol,
)
from scenarios.base import (
    Scenario,
    CompanyInfo,
    ScenarioContext,
    FinanceData,
    OpsData,
    ExpectedOutcomes,
    Department,
    Invoice,
    Service,
    Incident,
)


# Mock Caracal client for testing
class MockCaracalClient:
    """Mock Caracal client for testing."""
    
    def __init__(self):
        self.call_history = []
    
    async def call_tool(self, tool_id, principal_id, tool_args, correlation_id=None):
        """Mock tool call."""
        call_record = {
            "tool_id": tool_id,
            "principal_id": principal_id,
            "tool_args": tool_args,
            "correlation_id": correlation_id,
        }
        self.call_history.append(call_record)
        
        # Return mock result
        return {
            "status": "success",
            "data": {"mock": "result"},
        }


# Test fixtures
@pytest.fixture
def mock_caracal_client():
    """Create mock Caracal client."""
    return MockCaracalClient()


@pytest.fixture
def test_scenario():
    """Create test scenario."""
    return Scenario(
        scenario_id="test",
        name="Test Scenario",
        description="Test scenario for integration tests",
        company=CompanyInfo(
            name="Test Corp",
            industry="Technology",
            size="100 employees",
            fiscal_year="2026",
        ),
        context=ScenarioContext(
            quarter="Q4",
            month="November",
            trigger_event="Quarterly review",
        ),
        finance_data=FinanceData(
            departments=[
                Department(
                    name="Engineering",
                    budget=1000000,
                    spent=1080000,
                    variance_percent=8.0,
                    status="over_budget",
                ),
                Department(
                    name="Marketing",
                    budget=500000,
                    spent=480000,
                    variance_percent=-4.0,
                    status="under_budget",
                ),
            ],
            pending_invoices=[
                Invoice(
                    invoice_id="INV-001",
                    vendor="AWS",
                    amount=50000,
                    due_date="2026-11-30",
                    department="Engineering",
                ),
            ],
        ),
        ops_data=OpsData(
            services=[
                Service(
                    name="API Gateway",
                    status="degraded",
                    uptime_percent=97.5,
                    incidents_24h=2,
                ),
                Service(
                    name="Database",
                    status="healthy",
                    uptime_percent=99.9,
                    incidents_24h=0,
                ),
            ],
            incidents=[
                Incident(
                    incident_id="INC-001",
                    severity="high",
                    service="API Gateway",
                    description="Increased latency",
                    status="investigating",
                ),
            ],
        ),
        expected_outcomes=ExpectedOutcomes(
            finance_actions=["Review Engineering spending", "Approve pending invoices"],
            ops_actions=["Investigate API Gateway latency", "Scale resources"],
            executive_summary="Address budget overrun and service degradation",
        ),
    )


class TestOrchestratorAgent:
    """Tests for OrchestratorAgent."""
    
    @pytest.mark.asyncio
    async def test_init(self, mock_caracal_client, test_scenario):
        """Test orchestrator initialization."""
        agent = OrchestratorAgent(
            principal_id="mandate-orch",
            caracal_client=mock_caracal_client,
            scenario=test_scenario,
        )
        
        assert agent.role == AgentRole.ORCHESTRATOR
        assert agent.principal_id == "mandate-orch"
        assert agent.scenario is test_scenario
        assert agent.caracal_client is mock_caracal_client
        assert len(agent.delegated_agents) == 0
    
    @pytest.mark.asyncio
    async def test_decompose_task(self, mock_caracal_client, test_scenario):
        """Test task decomposition."""
        agent = OrchestratorAgent(
            principal_id="mandate-orch",
            caracal_client=mock_caracal_client,
            scenario=test_scenario,
        )
        
        sub_tasks = await agent._decompose_task(
            "Prepare quarterly review",
            test_scenario
        )
        
        assert len(sub_tasks) == 2
        assert any(t["type"] == "finance" for t in sub_tasks)
        assert any(t["type"] == "ops" for t in sub_tasks)
    
    @pytest.mark.asyncio
    async def test_execute_with_delegation(self, mock_caracal_client, test_scenario):
        """Test orchestrator execution with delegation."""
        agent = OrchestratorAgent(
            principal_id="mandate-orch",
            caracal_client=mock_caracal_client,
            scenario=test_scenario,
        )
        
        result = await agent.execute(
            "Prepare quarterly review",
            scenario=test_scenario,
            finance_principal_id="mandate-finance",
            ops_principal_id="mandate-ops",
        )
        
        assert result["status"] == "success"
        assert "executive_summary" in result
        assert "finance_results" in result
        assert "ops_results" in result
        assert len(agent.delegated_agents) == 2
        assert agent.state.status == "completed"
    
    @pytest.mark.asyncio
    async def test_generate_executive_summary(self, mock_caracal_client, test_scenario):
        """Test executive summary generation."""
        agent = OrchestratorAgent(
            principal_id="mandate-orch",
            caracal_client=mock_caracal_client,
            scenario=test_scenario,
        )
        
        aggregated = {
            "scenario_id": "test",
            "scenario_name": "Test Scenario",
            "company": "Test Corp",
            "period": "Q4 November",
            "finance": {
                "summary": "Budget overrun in Engineering",
                "key_findings": ["Engineering 8% over budget"],
                "recommendations": ["Freeze spending"],
            },
            "ops": {
                "summary": "API Gateway degraded",
                "key_findings": ["High latency incidents"],
                "recommendations": ["Scale resources"],
            },
        }
        
        summary = agent._generate_executive_summary(aggregated, test_scenario)
        
        assert "Test Scenario" in summary
        assert "Test Corp" in summary
        assert "Financial Analysis" in summary
        assert "Operations Analysis" in summary


class TestFinanceAgent:
    """Tests for FinanceAgent."""
    
    @pytest.mark.asyncio
    async def test_init(self, mock_caracal_client, test_scenario):
        """Test finance agent initialization."""
        agent = FinanceAgent(
            principal_id="mandate-finance",
            caracal_client=mock_caracal_client,
            scenario=test_scenario,
        )
        
        assert agent.role == AgentRole.FINANCE
        assert agent.principal_id == "mandate-finance"
        assert agent.scenario is test_scenario
    
    @pytest.mark.asyncio
    async def test_analyze_budgets(self, mock_caracal_client, test_scenario):
        """Test budget analysis."""
        agent = FinanceAgent(
            principal_id="mandate-finance",
            caracal_client=mock_caracal_client,
            scenario=test_scenario,
        )
        
        analysis = await agent._analyze_budgets(test_scenario)
        
        assert analysis["total_departments"] == 2
        assert analysis["over_budget_count"] == 1
        assert analysis["under_budget_count"] == 1
        assert analysis["highest_variance_dept"] == "Engineering"
        assert analysis["highest_variance_percent"] == 8.0
    
    @pytest.mark.asyncio
    async def test_analyze_invoices(self, mock_caracal_client, test_scenario):
        """Test invoice analysis."""
        agent = FinanceAgent(
            principal_id="mandate-finance",
            caracal_client=mock_caracal_client,
            scenario=test_scenario,
        )
        
        analysis = await agent._analyze_invoices(test_scenario)
        
        assert analysis["total_invoices"] == 1
        assert analysis["total_amount"] == 50000
        assert "Engineering" in analysis["by_department"]
    
    @pytest.mark.asyncio
    async def test_assess_risks(self, mock_caracal_client, test_scenario):
        """Test risk assessment."""
        agent = FinanceAgent(
            principal_id="mandate-finance",
            caracal_client=mock_caracal_client,
            scenario=test_scenario,
        )
        
        budget_analysis = await agent._analyze_budgets(test_scenario)
        invoice_analysis = await agent._analyze_invoices(test_scenario)
        
        risk_assessment = await agent._assess_risks(
            budget_analysis,
            invoice_analysis,
            test_scenario
        )
        
        assert "overall_risk_level" in risk_assessment
        assert risk_assessment["risk_count"] > 0
        assert len(risk_assessment["risks"]) > 0
    
    @pytest.mark.asyncio
    async def test_execute(self, mock_caracal_client, test_scenario):
        """Test finance agent execution."""
        agent = FinanceAgent(
            principal_id="mandate-finance",
            caracal_client=mock_caracal_client,
            scenario=test_scenario,
        )
        
        result = await agent.execute(
            "Analyze financial data",
            scenario=test_scenario
        )
        
        assert result["status"] == "success"
        assert "summary" in result
        assert "key_findings" in result
        assert "recommendations" in result
        assert "budget_analysis" in result
        assert "invoice_analysis" in result
        assert "risk_assessment" in result
        assert agent.state.status == "completed"


class TestOpsAgent:
    """Tests for OpsAgent."""
    
    @pytest.mark.asyncio
    async def test_init(self, mock_caracal_client, test_scenario):
        """Test ops agent initialization."""
        agent = OpsAgent(
            principal_id="mandate-ops",
            caracal_client=mock_caracal_client,
            scenario=test_scenario,
        )
        
        assert agent.role == AgentRole.OPS
        assert agent.principal_id == "mandate-ops"
        assert agent.scenario is test_scenario
    
    @pytest.mark.asyncio
    async def test_analyze_services(self, mock_caracal_client, test_scenario):
        """Test service analysis."""
        agent = OpsAgent(
            principal_id="mandate-ops",
            caracal_client=mock_caracal_client,
            scenario=test_scenario,
        )
        
        analysis = await agent._analyze_services(test_scenario)
        
        assert analysis["total_services"] == 2
        assert analysis["healthy_count"] == 1
        assert analysis["degraded_count"] == 1
        assert analysis["down_count"] == 0
        assert analysis["total_incidents_24h"] == 2
    
    @pytest.mark.asyncio
    async def test_analyze_incidents(self, mock_caracal_client, test_scenario):
        """Test incident analysis."""
        agent = OpsAgent(
            principal_id="mandate-ops",
            caracal_client=mock_caracal_client,
            scenario=test_scenario,
        )
        
        analysis = await agent._analyze_incidents(test_scenario)
        
        assert analysis["total_incidents"] == 1
        assert analysis["high_count"] == 1
        assert analysis["unresolved_count"] == 1
    
    @pytest.mark.asyncio
    async def test_analyze_sla(self, mock_caracal_client, test_scenario):
        """Test SLA analysis."""
        agent = OpsAgent(
            principal_id="mandate-ops",
            caracal_client=mock_caracal_client,
            scenario=test_scenario,
        )
        
        service_analysis = await agent._analyze_services(test_scenario)
        sla_analysis = await agent._analyze_sla(test_scenario, service_analysis)
        
        assert "overall_compliance" in sla_analysis
        assert "violations" in sla_analysis
    
    @pytest.mark.asyncio
    async def test_execute(self, mock_caracal_client, test_scenario):
        """Test ops agent execution."""
        agent = OpsAgent(
            principal_id="mandate-ops",
            caracal_client=mock_caracal_client,
            scenario=test_scenario,
        )
        
        result = await agent.execute(
            "Analyze operational data",
            scenario=test_scenario
        )
        
        assert result["status"] == "success"
        assert "summary" in result
        assert "key_findings" in result
        assert "recommendations" in result
        assert "service_analysis" in result
        assert "incident_analysis" in result
        assert "sla_analysis" in result
        assert agent.state.status == "completed"


class TestToolBinding:
    """Tests for ToolBinding."""
    
    def setup_method(self):
        """Reset tool registry before each test."""
        reset_tool_registry()
    
    def test_init(self, mock_caracal_client):
        """Test tool binding initialization."""
        binding = ToolBinding(
            agent_id="agent-1",
            principal_id="mandate-1",
            caracal_client=mock_caracal_client,
        )
        
        assert binding.agent_id == "agent-1"
        assert binding.principal_id == "mandate-1"
        assert len(binding.available_tools) == 0
        assert len(binding.call_history) == 0
    
    def test_register_tool(self, mock_caracal_client):
        """Test registering a tool."""
        binding = ToolBinding(
            agent_id="agent-1",
            principal_id="mandate-1",
            caracal_client=mock_caracal_client,
        )
        
        tool = ToolDefinition(
            tool_id="tool-1",
            name="Test Tool",
            description="A test tool",
            category="finance",
        )
        
        binding.register_tool(tool)
        
        assert binding.has_tool("tool-1")
        assert binding.get_tool("tool-1") is tool
    
    def test_list_tools(self, mock_caracal_client):
        """Test listing tools."""
        binding = ToolBinding(
            agent_id="agent-1",
            principal_id="mandate-1",
            caracal_client=mock_caracal_client,
        )
        
        tool1 = ToolDefinition(tool_id="tool-1", name="Tool 1", description="", category="finance")
        tool2 = ToolDefinition(tool_id="tool-2", name="Tool 2", description="", category="ops")
        tool3 = ToolDefinition(tool_id="tool-3", name="Tool 3", description="", category="finance")
        
        binding.register_tool(tool1)
        binding.register_tool(tool2)
        binding.register_tool(tool3)
        
        all_tools = binding.list_tools()
        finance_tools = binding.list_tools(category="finance")
        
        assert len(all_tools) == 3
        assert len(finance_tools) == 2
    
    @pytest.mark.asyncio
    async def test_call_tool(self, mock_caracal_client):
        """Test calling a tool."""
        binding = ToolBinding(
            agent_id="agent-1",
            principal_id="mandate-1",
            caracal_client=mock_caracal_client,
        )
        
        tool = ToolDefinition(
            tool_id="tool-1",
            name="Test Tool",
            description="A test tool",
        )
        binding.register_tool(tool)
        
        tool_call = await binding.call_tool(
            tool_id="tool-1",
            tool_args={"arg1": "value1"},
        )
        
        assert isinstance(tool_call, ToolCall)
        assert tool_call.tool_id == "tool-1"
        assert tool_call.agent_id == "agent-1"
        assert tool_call.principal_id == "mandate-1"
        assert tool_call.status == "success"
        assert tool_call.result is not None
        assert len(binding.call_history) == 1
    
    @pytest.mark.asyncio
    async def test_call_tool_not_available(self, mock_caracal_client):
        """Test calling unavailable tool."""
        binding = ToolBinding(
            agent_id="agent-1",
            principal_id="mandate-1",
            caracal_client=mock_caracal_client,
        )
        
        with pytest.raises(ValueError):
            await binding.call_tool(
                tool_id="nonexistent",
                tool_args={},
            )
    
    def test_get_call_statistics(self, mock_caracal_client):
        """Test getting call statistics."""
        binding = ToolBinding(
            agent_id="agent-1",
            principal_id="mandate-1",
            caracal_client=mock_caracal_client,
        )
        
        # Add some mock call history
        call1 = ToolCall(
            call_id="call-1",
            tool_id="tool-1",
            agent_id="agent-1",
            principal_id="mandate-1",
            tool_args={},
            status="success",
            duration_ms=100,
        )
        call2 = ToolCall(
            call_id="call-2",
            tool_id="tool-2",
            agent_id="agent-1",
            principal_id="mandate-1",
            tool_args={},
            status="error",
            duration_ms=50,
        )
        
        binding.call_history.append(call1)
        binding.call_history.append(call2)
        
        stats = binding.get_call_statistics()
        
        assert stats["total_calls"] == 2
        assert stats["successful_calls"] == 1
        assert stats["failed_calls"] == 1
        assert stats["average_duration_ms"] == 75.0


class TestDelegationProtocol:
    """Tests for DelegationProtocol."""
    
    def setup_method(self):
        """Reset delegation protocol before each test."""
        reset_delegation_protocol()
    
    def test_init(self, mock_caracal_client):
        """Test delegation protocol initialization."""
        protocol = DelegationProtocol(mock_caracal_client)
        
        assert len(protocol.delegation_requests) == 0
        assert len(protocol.delegation_results) == 0
        assert len(protocol.mandate_delegations) == 0
    
    def test_create_delegation_request(self, mock_caracal_client):
        """Test creating delegation request."""
        protocol = DelegationProtocol(mock_caracal_client)
        
        request = protocol.create_delegation_request(
            from_agent_id="agent-1",
            from_agent_role=AgentRole.ORCHESTRATOR,
            to_agent_role=AgentRole.FINANCE,
            task_description="Analyze budget",
            priority=1,
        )
        
        assert isinstance(request, DelegationRequest)
        assert request.from_agent_id == "agent-1"
        assert request.from_agent_role == AgentRole.ORCHESTRATOR
        assert request.to_agent_role == AgentRole.FINANCE
        assert request.task_description == "Analyze budget"
        assert request.priority == 1
    
    @pytest.mark.asyncio
    async def test_delegate_mandate(self, mock_caracal_client):
        """Test mandate delegation."""
        protocol = DelegationProtocol(mock_caracal_client)
        
        delegation = await protocol.delegate_mandate(
            source_agent_id="agent-1",
            source_principal_id="mandate-1",
            target_agent_id="agent-2",
            target_principal_id="mandate-2",
            resource_scopes=["finance:budgets"],
            action_scopes=["read"],
        )
        
        assert isinstance(delegation, MandateDelegation)
        assert delegation.source_principal_id == "mandate-1"
        assert delegation.target_principal_id == "mandate-2"
        assert delegation.resource_scopes == ["finance:budgets"]
        assert delegation.action_scopes == ["read"]
        assert not delegation.revoked
    
    def test_record_delegation_result(self, mock_caracal_client):
        """Test recording delegation result."""
        protocol = DelegationProtocol(mock_caracal_client)
        
        request = protocol.create_delegation_request(
            from_agent_id="agent-1",
            from_agent_role=AgentRole.ORCHESTRATOR,
            to_agent_role=AgentRole.FINANCE,
            task_description="Test task",
        )
        
        from datetime import datetime
        started = datetime.utcnow()
        completed = datetime.utcnow()
        
        result = protocol.record_delegation_result(
            request_id=request.request_id,
            agent_id="agent-2",
            agent_role=AgentRole.FINANCE,
            status="success",
            result={"data": "completed"},
            started_at=started,
            completed_at=completed,
        )
        
        assert isinstance(result, DelegationResult)
        assert result.request_id == request.request_id
        assert result.status == "success"
        assert result.result == {"data": "completed"}
    
    def test_revoke_mandate_delegation(self, mock_caracal_client):
        """Test revoking mandate delegation."""
        protocol = DelegationProtocol(mock_caracal_client)
        
        # Create delegation
        delegation = MandateDelegation(
            delegation_id="del-1",
            source_principal_id="mandate-1",
            target_principal_id="mandate-2",
            source_agent_id="agent-1",
            target_agent_id="agent-2",
        )
        protocol.mandate_delegations[delegation.delegation_id] = delegation
        
        # Revoke it
        success = protocol.revoke_mandate_delegation(
            delegation_id="del-1",
            reason="Test revocation",
        )
        
        assert success
        assert delegation.revoked
        assert delegation.revoked_at is not None
    
    def test_get_statistics(self, mock_caracal_client):
        """Test getting delegation statistics."""
        protocol = DelegationProtocol(mock_caracal_client)
        
        # Create some delegations
        protocol.create_delegation_request(
            from_agent_id="agent-1",
            from_agent_role=AgentRole.ORCHESTRATOR,
            to_agent_role=AgentRole.FINANCE,
            task_description="Task 1",
        )
        
        delegation = MandateDelegation(
            delegation_id="del-1",
            source_principal_id="mandate-1",
            target_principal_id="mandate-2",
            source_agent_id="agent-1",
            target_agent_id="agent-2",
        )
        protocol.mandate_delegations[delegation.delegation_id] = delegation
        
        stats = protocol.get_statistics()
        
        assert stats["total_requests"] == 1
        assert stats["total_mandate_delegations"] == 1
        assert stats["active_delegations"] == 1
        assert stats["revoked_delegations"] == 0


class TestMultiAgentWorkflow:
    """Integration tests for complete multi-agent workflows."""
    
    @pytest.mark.asyncio
    async def test_full_orchestration_workflow(self, mock_caracal_client, test_scenario):
        """Test complete orchestration workflow with finance and ops agents."""
        # Create orchestrator
        orchestrator = OrchestratorAgent(
            principal_id="mandate-orch",
            caracal_client=mock_caracal_client,
            scenario=test_scenario,
        )
        
        # Execute workflow
        result = await orchestrator.execute(
            "Prepare quarterly review",
            scenario=test_scenario,
            finance_principal_id="mandate-finance",
            ops_principal_id="mandate-ops",
        )
        
        # Verify orchestrator completed successfully
        assert result["status"] == "success"
        assert orchestrator.state.status == "completed"
        
        # Verify sub-agents were created
        assert len(orchestrator.delegated_agents) == 2
        
        # Verify finance results
        assert result["finance_results"]["status"] == "success"
        assert "budget_analysis" in result["finance_results"]
        
        # Verify ops results
        assert result["ops_results"]["status"] == "success"
        assert "service_analysis" in result["ops_results"]
        
        # Verify executive summary was generated
        assert "executive_summary" in result
        assert "Test Corp" in result["executive_summary"]
        
        # Verify messages were emitted
        messages = orchestrator.get_messages()
        assert len(messages) > 0
        assert any(msg.message_type == MessageType.THOUGHT for msg in messages)
        assert any(msg.message_type == MessageType.ACTION for msg in messages)
