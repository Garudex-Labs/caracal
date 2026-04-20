"""
Unit tests for nested agent workflows.

Tests the sub-agent spawning, result aggregation, and complex workflow
orchestration functionality.
"""

import pytest
from datetime import datetime
from unittest.mock import Mock, AsyncMock, patch

from examples.langchain_demo.agents.base import AgentRole, BaseAgent, AgentState, MessageType
from examples.langchain_demo.agents.nested_spawning import (
    NestedAgentSpawner,
    SpawnRequest,
    SpawnedAgent,
    get_nested_spawner,
    reset_nested_spawner,
)
from examples.langchain_demo.agents.result_aggregation import (
    ResultAggregator,
    AgentResult,
    AggregatedResult,
    aggregate_finance_and_ops,
    aggregate_with_analyst,
)
from examples.langchain_demo.agents.analyst_agent import AnalystAgent
from examples.langchain_demo.agents.reporter_agent import ReporterAgent
from examples.langchain_demo.scenarios.base import (
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


# Fixtures

@pytest.fixture
def mock_caracal_client():
    """Create a mock Caracal client."""
    client = Mock()
    client.tools = Mock()
    client.tools.call = AsyncMock()
    return client


@pytest.fixture
def sample_scenario():
    """Create a sample scenario for testing."""
    return Scenario(
        scenario_id="test-scenario",
        name="Test Scenario",
        description="A test scenario",
        company=CompanyInfo(
            name="Test Corp",
            industry="Technology",
            size="100 employees",
            fiscal_year="2026",
        ),
        context=ScenarioContext(
            quarter="Q4",
            month="November",
            trigger_event="Test event",
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
            finance_actions=["Review budget"],
            ops_actions=["Investigate latency"],
            executive_summary="Test summary",
        ),
    )


@pytest.fixture
def mock_parent_agent():
    """Create a mock parent agent."""
    agent = Mock(spec=BaseAgent)
    agent.agent_id = "parent-agent-123"
    agent.role = AgentRole.ORCHESTRATOR
    agent.principal_id = "parent-mandate-123"
    agent.state = AgentState(
        agent_id="parent-agent-123",
        agent_role=AgentRole.ORCHESTRATOR,
        principal_id="parent-mandate-123",
    )
    agent.emit_message = Mock()
    return agent


# Tests for NestedAgentSpawner

class TestNestedAgentSpawner:
    """Tests for the NestedAgentSpawner class."""
    
    def test_spawner_initialization(self, mock_caracal_client):
        """Test spawner initializes correctly."""
        spawner = NestedAgentSpawner(mock_caracal_client)
        
        assert spawner.caracal_client == mock_caracal_client
        assert len(spawner.spawn_requests) == 0
        assert len(spawner.spawned_agents) == 0
        assert len(spawner.agent_registry) == 0
    
    def test_register_agent_class(self, mock_caracal_client):
        """Test registering agent classes."""
        spawner = NestedAgentSpawner(mock_caracal_client)
        
        spawner.register_agent_class(AgentRole.ANALYST, AnalystAgent)
        spawner.register_agent_class(AgentRole.REPORTER, ReporterAgent)
        
        assert AgentRole.ANALYST in spawner.agent_registry
        assert AgentRole.REPORTER in spawner.agent_registry
        assert spawner.agent_registry[AgentRole.ANALYST] == AnalystAgent
    
    @pytest.mark.asyncio
    async def test_spawn_sub_agent(
        self,
        mock_caracal_client,
        mock_parent_agent,
        sample_scenario
    ):
        """Test spawning a sub-agent."""
        spawner = NestedAgentSpawner(mock_caracal_client)
        spawner.register_agent_class(AgentRole.ANALYST, AnalystAgent)
        
        sub_agent = await spawner.spawn_sub_agent(
            parent_agent=mock_parent_agent,
            sub_agent_role=AgentRole.ANALYST,
            task_description="Analyze data",
            sub_agent_principal_id="sub-mandate-123",
            scenario=sample_scenario,
        )
        
        # Verify sub-agent was created
        assert isinstance(sub_agent, AnalystAgent)
        assert sub_agent.role == AgentRole.ANALYST
        assert sub_agent.principal_id == "sub-mandate-123"
        assert sub_agent.parent_agent == mock_parent_agent
        
        # Verify spawn request was recorded
        assert len(spawner.spawn_requests) == 1
        
        # Verify spawned agent was recorded
        assert len(spawner.spawned_agents) == 1
        
        # Verify parent agent state was updated
        assert len(mock_parent_agent.state.sub_agents) == 1
    
    @pytest.mark.asyncio
    async def test_spawn_unregistered_agent_fails(
        self,
        mock_caracal_client,
        mock_parent_agent,
        sample_scenario
    ):
        """Test spawning an unregistered agent role fails."""
        spawner = NestedAgentSpawner(mock_caracal_client)
        
        with pytest.raises(ValueError, match="No agent class registered"):
            await spawner.spawn_sub_agent(
                parent_agent=mock_parent_agent,
                sub_agent_role=AgentRole.ANALYST,
                task_description="Analyze data",
                sub_agent_principal_id="sub-mandate-123",
                scenario=sample_scenario,
            )
    
    def test_get_agent_hierarchy(self, mock_caracal_client):
        """Test getting agent hierarchy."""
        spawner = NestedAgentSpawner(mock_caracal_client)
        
        # Create mock spawned agents
        parent_agent = Mock()
        parent_agent.agent_id = "parent-123"
        
        child1 = Mock()
        child1.agent_id = "child1-123"
        child1.role = AgentRole.ANALYST
        
        child2 = Mock()
        child2.agent_id = "child2-123"
        child2.role = AgentRole.REPORTER
        
        spawner.spawned_agents["spawn1"] = SpawnedAgent(
            spawn_id="spawn1",
            agent=child1,
            parent_agent_id="parent-123",
            status="completed",
        )
        
        spawner.spawned_agents["spawn2"] = SpawnedAgent(
            spawn_id="spawn2",
            agent=child2,
            parent_agent_id="parent-123",
            status="completed",
        )
        
        hierarchy = spawner.get_agent_hierarchy("parent-123")
        
        assert hierarchy["agent_id"] == "parent-123"
        assert len(hierarchy["children"]) == 2
    
    def test_get_statistics(self, mock_caracal_client):
        """Test getting spawner statistics."""
        spawner = NestedAgentSpawner(mock_caracal_client)
        spawner.register_agent_class(AgentRole.ANALYST, AnalystAgent)
        spawner.register_agent_class(AgentRole.REPORTER, ReporterAgent)
        
        stats = spawner.get_statistics()
        
        assert stats["total_spawn_requests"] == 0
        assert stats["total_spawned_agents"] == 0
        assert len(stats["registered_roles"]) == 2
        assert AgentRole.ANALYST in stats["registered_roles"]


# Tests for ResultAggregator

class TestResultAggregator:
    """Tests for the ResultAggregator class."""
    
    def test_aggregator_initialization(self):
        """Test aggregator initializes correctly."""
        aggregator = ResultAggregator()
        
        assert "merge" in aggregator.aggregation_strategies
        assert "weighted" in aggregator.aggregation_strategies
        assert "consensus" in aggregator.aggregation_strategies
        assert "statistical" in aggregator.aggregation_strategies
    
    def test_merge_strategy(self):
        """Test merge aggregation strategy."""
        aggregator = ResultAggregator()
        
        results = [
            AgentResult(
                agent_id="finance-123",
                agent_role=AgentRole.FINANCE,
                status="success",
                result_data={"summary": "Finance summary", "key_findings": ["Finding 1"]},
            ),
            AgentResult(
                agent_id="ops-123",
                agent_role=AgentRole.OPS,
                status="success",
                result_data={"summary": "Ops summary", "key_findings": ["Finding 2"]},
            ),
        ]
        
        aggregated = aggregator.aggregate(results, strategy="merge")
        
        assert "finance" in aggregated.aggregated_data
        assert "ops" in aggregated.aggregated_data
        assert aggregated.statistics["successful"] == 2
    
    def test_consensus_strategy(self):
        """Test consensus aggregation strategy."""
        aggregator = ResultAggregator()
        
        results = [
            AgentResult(
                agent_id="finance-123",
                agent_role=AgentRole.FINANCE,
                status="success",
                result_data={
                    "key_findings": ["Budget overrun", "High risk"],
                    "recommendations": ["Freeze spending"],
                },
            ),
            AgentResult(
                agent_id="ops-123",
                agent_role=AgentRole.OPS,
                status="success",
                result_data={
                    "key_findings": ["Service degraded", "High risk"],
                    "recommendations": ["Increase capacity"],
                },
            ),
        ]
        
        aggregated = aggregator.aggregate(results, strategy="consensus")
        
        assert "common_findings" in aggregated.aggregated_data
        assert "common_recommendations" in aggregated.aggregated_data
        
        # "High risk" should be identified as common
        common_findings = aggregated.aggregated_data["common_findings"]
        assert len(common_findings) > 0
    
    def test_statistical_strategy(self):
        """Test statistical aggregation strategy."""
        aggregator = ResultAggregator()
        
        results = [
            AgentResult(
                agent_id="agent1",
                agent_role=AgentRole.ANALYST,
                status="success",
                result_data={
                    "metrics": {
                        "score": 85.0,
                        "utilization": 92.5,
                    }
                },
            ),
            AgentResult(
                agent_id="agent2",
                agent_role=AgentRole.ANALYST,
                status="success",
                result_data={
                    "metrics": {
                        "score": 90.0,
                        "utilization": 88.0,
                    }
                },
            ),
        ]
        
        aggregated = aggregator.aggregate(results, strategy="statistical")
        
        assert "metrics" in aggregated.aggregated_data
        metrics = aggregated.aggregated_data["metrics"]
        
        # Check that statistics were computed
        assert "score" in metrics
        assert "mean" in metrics["score"]
        assert metrics["score"]["mean"] == 87.5  # (85 + 90) / 2
    
    def test_filter_failed_results(self):
        """Test that failed results are filtered out."""
        aggregator = ResultAggregator()
        
        results = [
            AgentResult(
                agent_id="agent1",
                agent_role=AgentRole.FINANCE,
                status="success",
                result_data={"summary": "Success"},
            ),
            AgentResult(
                agent_id="agent2",
                agent_role=AgentRole.OPS,
                status="error",
                result_data={},
                error="Failed to execute",
            ),
        ]
        
        aggregated = aggregator.aggregate(results, strategy="merge")
        
        # Only successful result should be aggregated
        assert aggregated.statistics["successful"] == 1
        assert aggregated.statistics["failed"] == 1
        assert "finance" in aggregated.aggregated_data
        assert "ops" not in aggregated.aggregated_data
    
    def test_register_custom_strategy(self):
        """Test registering a custom aggregation strategy."""
        aggregator = ResultAggregator()
        
        def custom_strategy(results, weights):
            return {"custom": "data"}
        
        aggregator.register_strategy("custom", custom_strategy)
        
        assert "custom" in aggregator.aggregation_strategies
        
        results = [
            AgentResult(
                agent_id="agent1",
                agent_role=AgentRole.ANALYST,
                status="success",
                result_data={},
            ),
        ]
        
        aggregated = aggregator.aggregate(results, strategy="custom")
        assert aggregated.aggregated_data == {"custom": "data"}


# Tests for convenience functions

class TestConvenienceFunctions:
    """Tests for convenience aggregation functions."""
    
    def test_aggregate_finance_and_ops(self):
        """Test aggregating finance and ops results."""
        finance_result = {
            "summary": "Finance summary",
            "risk_assessment": {"overall_risk_level": "high"},
            "recommendations": ["Freeze spending"],
        }
        
        ops_result = {
            "summary": "Ops summary",
            "service_analysis": {"average_uptime": 94.0},
            "recommendations": ["Increase capacity"],
        }
        
        aggregated = aggregate_finance_and_ops(finance_result, ops_result)
        
        assert "finance" in aggregated
        assert "ops" in aggregated
        assert "cross_functional_insights" in aggregated
        assert "combined_recommendations" in aggregated
        
        # Should identify cross-functional issue (high risk + low uptime)
        assert len(aggregated["cross_functional_insights"]) > 0
    
    def test_aggregate_with_analyst(self):
        """Test aggregating with analyst insights."""
        primary_results = {
            "finance": {
                "recommendations": ["Freeze spending"],
            },
            "ops": {
                "recommendations": ["Increase capacity"],
            },
        }
        
        analyst_result = {
            "insights": [
                {"type": "trend", "description": "Budget trending up"},
            ],
            "metrics": {"score": 85.0},
            "trends": {"financial_trends": []},
            "recommendations": ["Review forecasting"],
        }
        
        aggregated = aggregate_with_analyst(primary_results, analyst_result)
        
        assert "primary_results" in aggregated
        assert "analytical_insights" in aggregated
        assert "metrics" in aggregated
        assert "trends" in aggregated
        assert "enhanced_recommendations" in aggregated
        
        # Should combine recommendations
        assert len(aggregated["enhanced_recommendations"]) >= 3


# Tests for AnalystAgent

class TestAnalystAgent:
    """Tests for the AnalystAgent class."""
    
    @pytest.mark.asyncio
    async def test_analyst_agent_initialization(
        self,
        mock_caracal_client,
        sample_scenario
    ):
        """Test analyst agent initializes correctly."""
        agent = AnalystAgent(
            principal_id="analyst-mandate-123",
            caracal_client=mock_caracal_client,
            scenario=sample_scenario,
        )
        
        assert agent.role == AgentRole.ANALYST
        assert agent.principal_id == "analyst-mandate-123"
        assert agent.scenario == sample_scenario
    
    @pytest.mark.asyncio
    async def test_analyst_financial_analysis(
        self,
        mock_caracal_client,
        sample_scenario
    ):
        """Test analyst performs financial analysis."""
        agent = AnalystAgent(
            principal_id="analyst-mandate-123",
            caracal_client=mock_caracal_client,
            scenario=sample_scenario,
        )
        
        result = await agent.execute(
            task="Analyze financial data",
            scenario=sample_scenario,
            analysis_type="financial",
        )
        
        assert result["status"] == "success"
        assert "insights" in result
        assert "metrics" in result
        assert "financial" in result["raw_data"]
    
    @pytest.mark.asyncio
    async def test_analyst_operational_analysis(
        self,
        mock_caracal_client,
        sample_scenario
    ):
        """Test analyst performs operational analysis."""
        agent = AnalystAgent(
            principal_id="analyst-mandate-123",
            caracal_client=mock_caracal_client,
            scenario=sample_scenario,
        )
        
        result = await agent.execute(
            task="Analyze operational data",
            scenario=sample_scenario,
            analysis_type="operational",
        )
        
        assert result["status"] == "success"
        assert "insights" in result
        assert "operational" in result["raw_data"]


# Tests for ReporterAgent

class TestReporterAgent:
    """Tests for the ReporterAgent class."""
    
    @pytest.mark.asyncio
    async def test_reporter_agent_initialization(
        self,
        mock_caracal_client,
        sample_scenario
    ):
        """Test reporter agent initializes correctly."""
        agent = ReporterAgent(
            principal_id="reporter-mandate-123",
            caracal_client=mock_caracal_client,
            scenario=sample_scenario,
        )
        
        assert agent.role == AgentRole.REPORTER
        assert agent.principal_id == "reporter-mandate-123"
        assert agent.scenario == sample_scenario
    
    @pytest.mark.asyncio
    async def test_reporter_generates_executive_report(
        self,
        mock_caracal_client,
        sample_scenario
    ):
        """Test reporter generates executive report."""
        agent = ReporterAgent(
            principal_id="reporter-mandate-123",
            caracal_client=mock_caracal_client,
            scenario=sample_scenario,
        )
        
        agent_results = {
            "finance": {
                "status": "success",
                "summary": "Finance summary",
                "key_findings": ["Budget overrun"],
                "recommendations": ["Freeze spending"],
            },
            "ops": {
                "status": "success",
                "summary": "Ops summary",
                "key_findings": ["Service degraded"],
                "recommendations": ["Increase capacity"],
            },
        }
        
        result = await agent.execute(
            task="Generate executive report",
            scenario=sample_scenario,
            report_type="executive",
            agent_results=agent_results,
        )
        
        assert result["status"] == "success"
        assert "report_content" in result
        assert "executive_summary" in result
        assert "key_highlights" in result
        assert len(result["report_content"]) > 0
    
    @pytest.mark.asyncio
    async def test_reporter_generates_detailed_report(
        self,
        mock_caracal_client,
        sample_scenario
    ):
        """Test reporter generates detailed report."""
        agent = ReporterAgent(
            principal_id="reporter-mandate-123",
            caracal_client=mock_caracal_client,
            scenario=sample_scenario,
        )
        
        agent_results = {
            "finance": {
                "status": "success",
                "summary": "Finance summary",
                "key_findings": ["Budget overrun"],
                "budget_analysis": {"over_budget_count": 1},
            },
        }
        
        result = await agent.execute(
            task="Generate detailed report",
            scenario=sample_scenario,
            report_type="detailed",
            agent_results=agent_results,
        )
        
        assert result["status"] == "success"
        assert "sections" in result
        assert "financial_analysis" in result["sections"]


# Global spawner tests

class TestGlobalSpawner:
    """Tests for global spawner instance management."""
    
    def test_get_nested_spawner(self, mock_caracal_client):
        """Test getting global spawner instance."""
        reset_nested_spawner()
        
        spawner1 = get_nested_spawner(mock_caracal_client)
        spawner2 = get_nested_spawner(mock_caracal_client)
        
        # Should return same instance
        assert spawner1 is spawner2
    
    def test_reset_nested_spawner(self, mock_caracal_client):
        """Test resetting global spawner."""
        spawner1 = get_nested_spawner(mock_caracal_client)
        reset_nested_spawner()
        spawner2 = get_nested_spawner(mock_caracal_client)
        
        # Should return different instance after reset
        assert spawner1 is not spawner2


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
