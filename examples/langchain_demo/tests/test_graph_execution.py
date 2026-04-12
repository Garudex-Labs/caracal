"""
Tests for LangGraph workflow execution.

This module tests the graph_builder module including:
- Workflow construction
- State management
- Conditional routing
- Workflow execution
- Visualization export
"""

import pytest
from typing import Any, Dict
from unittest.mock import Mock, MagicMock, patch

# Import the modules to test
from examples.langchain_demo.agents.graph_builder import (
    GraphBuilder,
    WorkflowState,
    WorkflowStep,
    WorkflowExecutionEngine,
    create_standard_workflow,
    create_parallel_workflow,
    create_dynamic_workflow,
    create_execution_engine,
    LANGGRAPH_AVAILABLE,
)


# Skip all tests if langgraph is not available
pytestmark = pytest.mark.skipif(
    not LANGGRAPH_AVAILABLE,
    reason="langgraph not installed"
)


@pytest.fixture
def mock_caracal_client():
    """Create a mock Caracal client."""
    client = Mock()
    client.call_tool = Mock(return_value={"status": "success"})
    return client


@pytest.fixture
def mock_scenario():
    """Create a mock scenario."""
    scenario = Mock()
    scenario.scenario_id = "test_scenario"
    scenario.name = "Test Scenario"
    return scenario


@pytest.fixture
def mandate_ids():
    """Create test mandate IDs."""
    return {
        "orchestrator": "mandate_orchestrator_123",
        "finance": "mandate_finance_456",
        "ops": "mandate_ops_789",
        "analyst": "mandate_analyst_012",
        "reporter": "mandate_reporter_345",
    }


@pytest.fixture
def graph_builder(mock_caracal_client, mock_scenario, mandate_ids):
    """Create a GraphBuilder instance."""
    return GraphBuilder(
        caracal_client=mock_caracal_client,
        scenario=mock_scenario,
        mandate_ids=mandate_ids,
    )


class TestGraphBuilder:
    """Tests for the GraphBuilder class."""
    
    def test_initialization(self, mock_caracal_client, mock_scenario, mandate_ids):
        """Test GraphBuilder initialization."""
        builder = GraphBuilder(
            caracal_client=mock_caracal_client,
            scenario=mock_scenario,
            mandate_ids=mandate_ids,
        )
        
        assert builder.caracal_client == mock_caracal_client
        assert builder.scenario == mock_scenario
        assert builder.mandate_ids == mandate_ids
        assert builder._agent_cache == {}
    
    def test_initialization_without_langgraph(self, mock_caracal_client):
        """Test that initialization fails gracefully without langgraph."""
        with patch('examples.langchain_demo.agents.graph_builder.LANGGRAPH_AVAILABLE', False):
            with pytest.raises(ImportError, match="langgraph is not installed"):
                GraphBuilder(caracal_client=mock_caracal_client)
    
    def test_build_standard_workflow(self, graph_builder):
        """Test building a standard workflow."""
        workflow = graph_builder.build_standard_workflow()
        
        assert workflow is not None
        # Workflow should be a compiled graph
        assert hasattr(workflow, 'invoke')
    
    def test_build_parallel_workflow(self, graph_builder):
        """Test building a parallel workflow."""
        workflow = graph_builder.build_parallel_workflow()
        
        assert workflow is not None
        assert hasattr(workflow, 'invoke')
    
    def test_build_dynamic_workflow(self, graph_builder):
        """Test building a dynamic workflow."""
        workflow = graph_builder.build_dynamic_workflow()
        
        assert workflow is not None
        assert hasattr(workflow, 'invoke')


class TestWorkflowState:
    """Tests for workflow state management."""
    
    def test_initial_state_structure(self):
        """Test that initial state has correct structure."""
        state: WorkflowState = {
            "task": "Test task",
            "scenario_id": "test_scenario",
            "scenario_data": {},
            "orchestrator_id": "orch_123",
            "orchestrator_mandate_id": "mandate_123",
            "finance_agent_id": None,
            "finance_mandate_id": None,
            "finance_results": None,
            "ops_agent_id": None,
            "ops_mandate_id": None,
            "ops_results": None,
            "analyst_agent_id": None,
            "analyst_mandate_id": None,
            "analyst_results": None,
            "reporter_agent_id": None,
            "reporter_mandate_id": None,
            "reporter_results": None,
            "aggregated_results": None,
            "executive_summary": None,
            "messages": [],
            "errors": [],
            "current_step": "start",
            "next_step": None,
            "iteration": 0,
            "max_iterations": 10,
        }
        
        # Verify required fields exist
        assert "task" in state
        assert "scenario_id" in state
        assert "messages" in state
        assert "errors" in state
        assert "current_step" in state


class TestConditionalRouting:
    """Tests for conditional routing logic."""
    
    def test_route_from_orchestrator_to_finance(self, graph_builder):
        """Test routing from orchestrator to finance."""
        state: WorkflowState = {
            "next_step": "finance",
            "task": "Test",
            "scenario_id": "test",
            "scenario_data": {},
            "orchestrator_id": "orch",
            "orchestrator_mandate_id": "mandate",
            "messages": [],
            "errors": [],
            "current_step": "orchestrator",
            "iteration": 0,
            "max_iterations": 10,
        }
        
        result = graph_builder._route_from_orchestrator(state)
        assert result == "finance"
    
    def test_route_from_orchestrator_to_ops(self, graph_builder):
        """Test routing from orchestrator to ops."""
        state: WorkflowState = {
            "next_step": "ops",
            "task": "Test",
            "scenario_id": "test",
            "scenario_data": {},
            "orchestrator_id": "orch",
            "orchestrator_mandate_id": "mandate",
            "messages": [],
            "errors": [],
            "current_step": "orchestrator",
            "iteration": 0,
            "max_iterations": 10,
        }
        
        result = graph_builder._route_from_orchestrator(state)
        assert result == "ops"
    
    def test_route_from_orchestrator_invalid_step(self, graph_builder):
        """Test routing with invalid next step defaults to end."""
        state: WorkflowState = {
            "next_step": "invalid_step",
            "task": "Test",
            "scenario_id": "test",
            "scenario_data": {},
            "orchestrator_id": "orch",
            "orchestrator_mandate_id": "mandate",
            "messages": [],
            "errors": [],
            "current_step": "orchestrator",
            "iteration": 0,
            "max_iterations": 10,
        }
        
        result = graph_builder._route_from_orchestrator(state)
        assert result == "end"
    
    def test_route_from_finance_with_analysis_needed(self, graph_builder):
        """Test routing from finance when analysis is needed."""
        state: WorkflowState = {
            "next_step": "reporter",
            "finance_results": {"needs_analysis": True},
            "task": "Test",
            "scenario_id": "test",
            "scenario_data": {},
            "orchestrator_id": "orch",
            "orchestrator_mandate_id": "mandate",
            "messages": [],
            "errors": [],
            "current_step": "finance",
            "iteration": 0,
            "max_iterations": 10,
        }
        
        result = graph_builder._route_from_finance(state)
        assert result == "analyst"
    
    def test_route_from_ops_with_analysis_needed(self, graph_builder):
        """Test routing from ops when analysis is needed."""
        state: WorkflowState = {
            "next_step": "reporter",
            "ops_results": {"needs_analysis": True},
            "task": "Test",
            "scenario_id": "test",
            "scenario_data": {},
            "orchestrator_id": "orch",
            "orchestrator_mandate_id": "mandate",
            "messages": [],
            "errors": [],
            "current_step": "ops",
            "iteration": 0,
            "max_iterations": 10,
        }
        
        result = graph_builder._route_from_ops(state)
        assert result == "analyst"
    
    def test_route_from_analyst_with_errors(self, graph_builder):
        """Test routing from analyst when errors exist."""
        state: WorkflowState = {
            "next_step": "reporter",
            "errors": ["Some error occurred"],
            "task": "Test",
            "scenario_id": "test",
            "scenario_data": {},
            "orchestrator_id": "orch",
            "orchestrator_mandate_id": "mandate",
            "messages": [],
            "current_step": "analyst",
            "iteration": 0,
            "max_iterations": 10,
        }
        
        result = graph_builder._route_from_analyst(state)
        assert result == "end"
    
    def test_route_parallel_first_execution(self, graph_builder):
        """Test parallel routing on first execution."""
        state: WorkflowState = {
            "next_step": "finance",
            "finance_results": None,
            "ops_results": None,
            "task": "Test",
            "scenario_id": "test",
            "scenario_data": {},
            "orchestrator_id": "orch",
            "orchestrator_mandate_id": "mandate",
            "messages": [],
            "errors": [],
            "current_step": "orchestrator",
            "iteration": 0,
            "max_iterations": 10,
        }
        
        result = graph_builder._route_parallel(state)
        assert result == "finance"
    
    def test_route_parallel_after_finance(self, graph_builder):
        """Test parallel routing after finance completes."""
        state: WorkflowState = {
            "next_step": "ops",
            "finance_results": {"status": "success"},
            "ops_results": None,
            "task": "Test",
            "scenario_id": "test",
            "scenario_data": {},
            "orchestrator_id": "orch",
            "orchestrator_mandate_id": "mandate",
            "messages": [],
            "errors": [],
            "current_step": "finance",
            "iteration": 0,
            "max_iterations": 10,
        }
        
        result = graph_builder._route_parallel(state)
        assert result == "ops"
    
    def test_route_parallel_both_complete(self, graph_builder):
        """Test parallel routing when both agents complete."""
        state: WorkflowState = {
            "next_step": "reporter",
            "finance_results": {"status": "success"},
            "ops_results": {"status": "success"},
            "task": "Test",
            "scenario_id": "test",
            "scenario_data": {},
            "orchestrator_id": "orch",
            "orchestrator_mandate_id": "mandate",
            "messages": [],
            "errors": [],
            "current_step": "ops",
            "iteration": 0,
            "max_iterations": 10,
        }
        
        result = graph_builder._route_parallel(state)
        assert result == "reporter"


class TestVisualization:
    """Tests for workflow visualization."""
    
    def test_export_to_mermaid_standard(self, graph_builder):
        """Test exporting standard workflow to Mermaid format."""
        mermaid = graph_builder.export_to_mermaid("standard")
        
        assert "graph TD" in mermaid
        assert "orchestrator" in mermaid
        assert "finance" in mermaid
        assert "ops" in mermaid
        assert "reporter" in mermaid
        assert "aggregator" in mermaid
    
    def test_export_to_mermaid_parallel(self, graph_builder):
        """Test exporting parallel workflow to Mermaid format."""
        mermaid = graph_builder.export_to_mermaid("parallel")
        
        assert "graph TD" in mermaid
        assert "orchestrator" in mermaid
        assert "finance" in mermaid
        assert "ops" in mermaid
    
    def test_export_to_mermaid_dynamic(self, graph_builder):
        """Test exporting dynamic workflow to Mermaid format."""
        mermaid = graph_builder.export_to_mermaid("dynamic")
        
        assert "graph TD" in mermaid
        assert "orchestrator" in mermaid
        assert "analyst" in mermaid
    
    def test_export_to_mermaid_invalid_type(self, graph_builder):
        """Test exporting with invalid workflow type."""
        with pytest.raises(ValueError, match="Unknown workflow type"):
            graph_builder.export_to_mermaid("invalid")
    
    def test_export_to_dot_standard(self, graph_builder):
        """Test exporting standard workflow to DOT format."""
        dot = graph_builder.export_to_dot("standard")
        
        assert "digraph standard_workflow" in dot
        assert "orchestrator" in dot
        assert "finance" in dot
        assert "ops" in dot
        assert "reporter" in dot
        assert "aggregator" in dot
    
    def test_export_to_dot_parallel(self, graph_builder):
        """Test exporting parallel workflow to DOT format."""
        dot = graph_builder.export_to_dot("parallel")
        
        assert "digraph parallel_workflow" in dot
        assert "orchestrator" in dot
        assert "finance" in dot
        assert "ops" in dot
    
    def test_export_to_dot_dynamic(self, graph_builder):
        """Test exporting dynamic workflow to DOT format."""
        dot = graph_builder.export_to_dot("dynamic")
        
        assert "digraph dynamic_workflow" in dot
        assert "orchestrator" in dot
        assert "analyst" in dot
    
    def test_export_to_dot_invalid_type(self, graph_builder):
        """Test exporting with invalid workflow type."""
        with pytest.raises(ValueError, match="Unknown workflow type"):
            graph_builder.export_to_dot("invalid")
    
    def test_save_visualization_mermaid(self, graph_builder, tmp_path):
        """Test saving visualization to file in Mermaid format."""
        output_file = tmp_path / "workflow.mmd"
        
        graph_builder.save_visualization(
            str(output_file),
            workflow_type="standard",
            format="mermaid"
        )
        
        assert output_file.exists()
        content = output_file.read_text()
        assert "graph TD" in content
    
    def test_save_visualization_dot(self, graph_builder, tmp_path):
        """Test saving visualization to file in DOT format."""
        output_file = tmp_path / "workflow.dot"
        
        graph_builder.save_visualization(
            str(output_file),
            workflow_type="standard",
            format="dot"
        )
        
        assert output_file.exists()
        content = output_file.read_text()
        assert "digraph" in content
    
    def test_save_visualization_invalid_format(self, graph_builder, tmp_path):
        """Test saving with invalid format."""
        output_file = tmp_path / "workflow.txt"
        
        with pytest.raises(ValueError, match="Unsupported format"):
            graph_builder.save_visualization(
                str(output_file),
                workflow_type="standard",
                format="invalid"
            )


class TestWorkflowExecutionEngine:
    """Tests for the WorkflowExecutionEngine class."""
    
    @pytest.fixture
    def mock_workflow(self):
        """Create a mock compiled workflow."""
        workflow = Mock()
        workflow.invoke = Mock(return_value={
            "task": "Test task",
            "scenario_id": "test",
            "scenario_data": {},
            "orchestrator_id": "orch",
            "orchestrator_mandate_id": "mandate",
            "messages": [],
            "errors": [],
            "current_step": "end",
            "next_step": None,
            "iteration": 1,
            "max_iterations": 10,
            "aggregated_results": {"status": "success"},
            "executive_summary": "Test summary",
        })
        return workflow
    
    @pytest.fixture
    def execution_engine(self, mock_workflow, mock_caracal_client, mock_scenario):
        """Create a WorkflowExecutionEngine instance."""
        return WorkflowExecutionEngine(
            workflow=mock_workflow,
            caracal_client=mock_caracal_client,
            scenario=mock_scenario,
        )
    
    def test_initialization(self, mock_workflow, mock_caracal_client, mock_scenario):
        """Test WorkflowExecutionEngine initialization."""
        engine = WorkflowExecutionEngine(
            workflow=mock_workflow,
            caracal_client=mock_caracal_client,
            scenario=mock_scenario,
        )
        
        assert engine.workflow == mock_workflow
        assert engine.caracal_client == mock_caracal_client
        assert engine.scenario == mock_scenario
        assert engine._execution_history == []
        assert engine._current_execution_id is None
    
    @pytest.mark.asyncio
    async def test_execute_success(self, execution_engine, mandate_ids):
        """Test successful workflow execution."""
        result = await execution_engine.execute(
            task="Test task",
            scenario_id="test_scenario",
            scenario_data={"test": "data"},
            mandate_ids=mandate_ids,
            max_iterations=10,
        )
        
        assert result["status"] == "success"
        assert "execution_id" in result
        assert "aggregated_results" in result
        assert "executive_summary" in result
        assert "duration_ms" in result
        assert isinstance(result["duration_ms"], int)
    
    @pytest.mark.asyncio
    async def test_execute_with_errors(self, execution_engine, mandate_ids):
        """Test workflow execution with errors."""
        # Mock workflow to return errors
        execution_engine.workflow.invoke = Mock(return_value={
            "task": "Test task",
            "scenario_id": "test",
            "scenario_data": {},
            "orchestrator_id": "orch",
            "orchestrator_mandate_id": "mandate",
            "messages": [],
            "errors": ["Test error"],
            "current_step": "end",
            "next_step": None,
            "iteration": 1,
            "max_iterations": 10,
            "aggregated_results": None,
            "executive_summary": None,
        })
        
        result = await execution_engine.execute(
            task="Test task",
            scenario_id="test_scenario",
            scenario_data={"test": "data"},
            mandate_ids=mandate_ids,
            max_iterations=10,
        )
        
        assert result["status"] == "error"
        assert len(result["errors"]) > 0
    
    @pytest.mark.asyncio
    async def test_execute_exception_handling(self, execution_engine, mandate_ids):
        """Test workflow execution exception handling."""
        # Mock workflow to raise exception
        execution_engine.workflow.invoke = Mock(
            side_effect=Exception("Test exception")
        )
        
        result = await execution_engine.execute(
            task="Test task",
            scenario_id="test_scenario",
            scenario_data={"test": "data"},
            mandate_ids=mandate_ids,
            max_iterations=10,
        )
        
        assert result["status"] == "error"
        assert "Test exception" in result["errors"][0]
    
    def test_get_execution_history(self, execution_engine):
        """Test getting execution history."""
        # Initially empty
        history = execution_engine.get_execution_history()
        assert history == []
        
        # Add a mock execution
        execution_engine._execution_history.append({"test": "result"})
        history = execution_engine.get_execution_history()
        assert len(history) == 1
    
    def test_get_last_execution(self, execution_engine):
        """Test getting last execution."""
        # Initially None
        last = execution_engine.get_last_execution()
        assert last is None
        
        # Add executions
        execution_engine._execution_history.append({"id": 1})
        execution_engine._execution_history.append({"id": 2})
        
        last = execution_engine.get_last_execution()
        assert last["id"] == 2
    
    def test_clear_history(self, execution_engine):
        """Test clearing execution history."""
        # Add some history
        execution_engine._execution_history.append({"test": "result"})
        execution_engine._current_execution_id = "test_id"
        
        # Clear
        execution_engine.clear_history()
        
        assert execution_engine._execution_history == []
        assert execution_engine._current_execution_id is None


class TestConvenienceFunctions:
    """Tests for convenience functions."""
    
    def test_create_standard_workflow(self, mock_caracal_client):
        """Test creating standard workflow via convenience function."""
        workflow = create_standard_workflow(mock_caracal_client)
        assert workflow is not None
        assert hasattr(workflow, 'invoke')
    
    def test_create_parallel_workflow(self, mock_caracal_client):
        """Test creating parallel workflow via convenience function."""
        workflow = create_parallel_workflow(mock_caracal_client)
        assert workflow is not None
        assert hasattr(workflow, 'invoke')
    
    def test_create_dynamic_workflow(self, mock_caracal_client):
        """Test creating dynamic workflow via convenience function."""
        workflow = create_dynamic_workflow(mock_caracal_client)
        assert workflow is not None
        assert hasattr(workflow, 'invoke')
    
    def test_create_execution_engine_standard(self, mock_caracal_client):
        """Test creating execution engine with standard workflow."""
        engine = create_execution_engine(
            caracal_client=mock_caracal_client,
            workflow_type="standard"
        )
        assert isinstance(engine, WorkflowExecutionEngine)
    
    def test_create_execution_engine_parallel(self, mock_caracal_client):
        """Test creating execution engine with parallel workflow."""
        engine = create_execution_engine(
            caracal_client=mock_caracal_client,
            workflow_type="parallel"
        )
        assert isinstance(engine, WorkflowExecutionEngine)
    
    def test_create_execution_engine_dynamic(self, mock_caracal_client):
        """Test creating execution engine with dynamic workflow."""
        engine = create_execution_engine(
            caracal_client=mock_caracal_client,
            workflow_type="dynamic"
        )
        assert isinstance(engine, WorkflowExecutionEngine)
    
    def test_create_execution_engine_invalid_type(self, mock_caracal_client):
        """Test creating execution engine with invalid workflow type."""
        with pytest.raises(ValueError, match="Unknown workflow type"):
            create_execution_engine(
                caracal_client=mock_caracal_client,
                workflow_type="invalid"
            )
