"""
LangGraph workflow builder for multi-agent orchestration.

This module provides StateGraph definitions and workflow construction
for coordinating multi-agent execution using LangGraph patterns.

# CARACAL INTEGRATION POINT
# LangGraph workflows coordinate agent execution while Caracal enforces:
# - Authority validation at each node
# - Mandate-based tool execution
# - Delegation chain tracking
"""

import logging
from typing import Any, Dict, List, Literal, Optional, TypedDict
from enum import Enum

try:
    from langgraph.graph import StateGraph, END
    from langgraph.graph.graph import CompiledGraph
    LANGGRAPH_AVAILABLE = True
except ImportError:
    LANGGRAPH_AVAILABLE = False
    StateGraph = None
    END = None
    CompiledGraph = None

from examples.langchain_demo.agents.base import AgentRole, AgentMessage, MessageType

logger = logging.getLogger(__name__)


class WorkflowState(TypedDict, total=False):
    """
    State maintained throughout the workflow execution.
    
    This state is passed between nodes in the LangGraph workflow and
    accumulates information as agents execute their tasks.
    
    Attributes:
        task: The original high-level task
        scenario_id: ID of the scenario being executed
        scenario_data: Full scenario data dictionary
        orchestrator_id: ID of the orchestrator agent
        orchestrator_principal_id: Mandate ID for orchestrator
        finance_agent_id: ID of the finance agent (if spawned)
        finance_principal_id: Mandate ID for finance agent
        finance_results: Results from finance agent execution
        ops_agent_id: ID of the ops agent (if spawned)
        ops_principal_id: Mandate ID for ops agent
        ops_results: Results from ops agent execution
        analyst_agent_id: ID of the analyst agent (if spawned)
        analyst_principal_id: Mandate ID for analyst agent
        analyst_results: Results from analyst agent execution
        reporter_agent_id: ID of the reporter agent (if spawned)
        reporter_principal_id: Mandate ID for reporter agent
        reporter_results: Results from reporter agent execution
        aggregated_results: Aggregated results from all agents
        executive_summary: Final executive summary
        messages: List of all messages from all agents
        errors: List of errors encountered during execution
        current_step: Current step in the workflow
        next_step: Next step to execute
        iteration: Current iteration number
        max_iterations: Maximum allowed iterations
    """
    
    # Task and scenario
    task: str
    scenario_id: str
    scenario_data: Dict[str, Any]
    
    # Orchestrator
    orchestrator_id: str
    orchestrator_principal_id: str
    
    # Finance agent
    finance_agent_id: Optional[str]
    finance_principal_id: Optional[str]
    finance_results: Optional[Dict[str, Any]]
    
    # Ops agent
    ops_agent_id: Optional[str]
    ops_principal_id: Optional[str]
    ops_results: Optional[Dict[str, Any]]
    
    # Analyst agent
    analyst_agent_id: Optional[str]
    analyst_principal_id: Optional[str]
    analyst_results: Optional[Dict[str, Any]]
    
    # Reporter agent
    reporter_agent_id: Optional[str]
    reporter_principal_id: Optional[str]
    reporter_results: Optional[Dict[str, Any]]
    
    # Aggregated results
    aggregated_results: Optional[Dict[str, Any]]
    executive_summary: Optional[str]
    
    # Execution tracking
    messages: List[Dict[str, Any]]
    errors: List[str]
    current_step: str
    next_step: Optional[str]
    iteration: int
    max_iterations: int


class WorkflowStep(str, Enum):
    """Enumeration of workflow steps."""
    
    START = "start"
    ORCHESTRATOR = "orchestrator"
    FINANCE = "finance"
    OPS = "ops"
    ANALYST = "analyst"
    REPORTER = "reporter"
    AGGREGATOR = "aggregator"
    END = "end"


class GraphBuilder:
    """
    Builder for creating LangGraph workflows for multi-agent orchestration.
    
    This class provides methods to construct StateGraph instances that
    coordinate agent execution with proper state management and routing.
    
    # CARACAL INTEGRATION POINT
    # The graph builder creates workflows where:
    # - Each node represents an agent execution
    # - Agents use Caracal mandates for authority
    # - State tracks mandate IDs and delegation chains
    # - Conditional edges route based on authority decisions
    """
    
    def __init__(
        self,
        caracal_client: Any,
        scenario: Optional[Any] = None,
        principal_ids: Optional[Dict[str, str]] = None,
    ):
        """
        Initialize the graph builder.
        
        Args:
            caracal_client: Caracal client for governed tool calls
            scenario: Optional scenario object for context
            principal_ids: Optional dictionary of mandate IDs for each agent role
                        (e.g., {"orchestrator": "...", "finance": "...", "ops": "..."})
        
        Raises:
            ImportError: If langgraph is not installed
        """
        if not LANGGRAPH_AVAILABLE:
            raise ImportError(
                "langgraph is not installed. "
                "Install it with: pip install langgraph"
            )
        
        self.caracal_client = caracal_client
        self.scenario = scenario
        self.principal_ids = principal_ids or {}
        
        # Cache for agent instances
        self._agent_cache: Dict[str, Any] = {}
        
        logger.info("Initialized GraphBuilder with Caracal client")
    
    def build_standard_workflow(
        self,
        max_iterations: int = 10,
    ) -> CompiledGraph:
        """
        Build the standard multi-agent workflow.
        
        This workflow follows the pattern:
        1. Orchestrator analyzes task and decomposes
        2. Finance agent executes (if needed)
        3. Ops agent executes (if needed)
        4. Analyst agent processes data (if needed)
        5. Reporter agent generates summary
        6. Aggregator combines results
        
        State Graph Structure:
        ┌─────────────┐
        │ Orchestrator│ (Entry Point)
        └──────┬──────┘
               │
        ┌──────┴──────┬──────────┬─────────┐
        │             │          │         │
        ▼             ▼          ▼         ▼
    ┌────────┐  ┌────────┐  ┌──────────┐ END
    │Finance │  │  Ops   │  │ Reporter │
    └───┬────┘  └───┬────┘  └────┬─────┘
        │           │            │
        ├───────────┼────────────┘
        │           │
        ▼           ▼
    ┌────────┐  ┌──────────┐
    │Analyst │  │ Reporter │
    └───┬────┘  └────┬─────┘
        │            │
        └────────────┤
                     ▼
              ┌────────────┐
              │ Aggregator │
              └─────┬──────┘
                    │
                    ▼
                   END
        
        Args:
            max_iterations: Maximum number of workflow iterations
        
        Returns:
            Compiled LangGraph workflow
        
        # CARACAL INTEGRATION POINT
        # Each node in the graph represents an agent that:
        # - Executes with a specific mandate
        # - Has authority validated by Caracal
        # - Can delegate to sub-agents
        # - Logs all actions to the authority ledger
        """
        logger.info("Building standard multi-agent workflow")
        
        # Create state graph with WorkflowState schema
        # This ensures type safety and proper state management
        workflow = StateGraph(WorkflowState)
        
        # Add nodes for each agent type
        # Each node is a function that takes state and returns updated state
        workflow.add_node("orchestrator", self._orchestrator_node)
        workflow.add_node("finance", self._finance_node)
        workflow.add_node("ops", self._ops_node)
        workflow.add_node("analyst", self._analyst_node)
        workflow.add_node("reporter", self._reporter_node)
        workflow.add_node("aggregator", self._aggregator_node)
        
        # Set entry point - workflow always starts with orchestrator
        workflow.set_entry_point("orchestrator")
        
        # Add conditional edges from orchestrator to specialized agents
        # The orchestrator decides which agents to invoke based on the scenario
        workflow.add_conditional_edges(
            "orchestrator",
            self._route_from_orchestrator,
            {
                "finance": "finance",
                "ops": "ops",
                "reporter": "reporter",
                "end": END,
            }
        )
        
        # Add conditional edges from finance agent
        # Finance can route to ops, analyst, or reporter based on results
        workflow.add_conditional_edges(
            "finance",
            self._route_from_finance,
            {
                "ops": "ops",
                "analyst": "analyst",
                "reporter": "reporter",
                "end": END,
            }
        )
        
        # Add conditional edges from ops agent
        # Ops can route to analyst or reporter
        workflow.add_conditional_edges(
            "ops",
            self._route_from_ops,
            {
                "analyst": "analyst",
                "reporter": "reporter",
                "end": END,
            }
        )
        
        # Add conditional edges from analyst agent
        # Analyst always routes to reporter or ends
        workflow.add_conditional_edges(
            "analyst",
            self._route_from_analyst,
            {
                "reporter": "reporter",
                "end": END,
            }
        )
        
        # Add unconditional edge from reporter to aggregator
        # Reporter always passes results to aggregator
        workflow.add_edge("reporter", "aggregator")
        
        # Add unconditional edge from aggregator to end
        # Aggregator is always the final step
        workflow.add_edge("aggregator", END)
        
        # Compile the workflow into an executable graph
        # This validates the graph structure and creates the execution engine
        compiled = workflow.compile()
        
        logger.info("Standard workflow compiled successfully")
        return compiled
    
    def build_parallel_workflow(
        self,
        max_iterations: int = 10,
    ) -> CompiledGraph:
        """
        Build a parallel execution workflow.
        
        This workflow executes finance and ops agents in parallel,
        then aggregates their results.
        
        State Graph Structure:
        ┌─────────────┐
        │ Orchestrator│ (Entry Point)
        └──────┬──────┘
               │
        ┌──────┴──────┐
        │             │
        ▼             ▼
    ┌────────┐  ┌────────┐
    │Finance │  │  Ops   │
    └───┬────┘  └───┬────┘
        │           │
        └─────┬─────┘
              ▼
        ┌──────────┐
        │ Reporter │
        └────┬─────┘
             ▼
      ┌────────────┐
      │ Aggregator │
      └─────┬──────┘
            │
            ▼
           END
        
        Note: LangGraph doesn't support true parallel execution,
        but this workflow simulates parallel behavior by having
        both agents execute before proceeding to the reporter.
        
        Args:
            max_iterations: Maximum number of workflow iterations
        
        Returns:
            Compiled LangGraph workflow
        
        # CARACAL INTEGRATION POINT
        # Parallel execution means multiple agents with different mandates
        # execute concurrently, each with their own authority validation.
        """
        logger.info("Building parallel multi-agent workflow")
        
        # Create state graph with WorkflowState schema
        workflow = StateGraph(WorkflowState)
        
        # Add nodes for parallel execution pattern
        workflow.add_node("orchestrator", self._orchestrator_node)
        workflow.add_node("finance", self._finance_node)
        workflow.add_node("ops", self._ops_node)
        workflow.add_node("reporter", self._reporter_node)
        workflow.add_node("aggregator", self._aggregator_node)
        
        # Set entry point
        workflow.set_entry_point("orchestrator")
        
        # From orchestrator, route to both finance and ops
        # Note: LangGraph doesn't support true parallel execution in the same way,
        # but we can simulate it with conditional routing that executes both paths
        workflow.add_conditional_edges(
            "orchestrator",
            self._route_parallel,
            {
                "finance": "finance",
                "ops": "ops",
                "reporter": "reporter",
                "end": END,
            }
        )
        
        # Both finance and ops go to reporter
        # This creates a join point where we wait for both to complete
        workflow.add_edge("finance", "reporter")
        workflow.add_edge("ops", "reporter")
        
        # Reporter goes to aggregator
        workflow.add_edge("reporter", "aggregator")
        
        # Aggregator goes to end
        workflow.add_edge("aggregator", END)
        
        # Compile the workflow
        compiled = workflow.compile()
        
        logger.info("Parallel workflow compiled successfully")
        return compiled
    
    def build_dynamic_workflow(
        self,
        max_iterations: int = 10,
    ) -> CompiledGraph:
        """
        Build a dynamic workflow with runtime decision-making.
        
        This workflow adapts its execution path based on:
        - Scenario complexity
        - Agent results
        - Error conditions
        - Authority decisions
        
        State Graph Structure:
        ┌─────────────┐
        │ Orchestrator│ (Entry Point)
        └──────┬──────┘
               │
        ┌──────┴──────┬──────────┬─────────┐
        │             │          │         │
        ▼             ▼          ▼         ▼
    ┌────────┐  ┌────────┐  ┌──────────┐ END
    │Finance │  │  Ops   │  │ Reporter │
    └───┬────┘  └───┬────┘  └────┬─────┘
        │           │            │
        ▼           ▼            │
    ┌────────┐  ┌────────┐      │
    │Analyst │  │Analyst │      │
    └───┬────┘  └───┬────┘      │
        │           │            │
        └─────┬─────┴────────────┘
              ▼
        ┌──────────┐
        │ Reporter │
        └────┬─────┘
             ▼
      ┌────────────┐
      │ Aggregator │
      └─────┬──────┘
            │
            ▼
           END
        
        Args:
            max_iterations: Maximum number of workflow iterations
        
        Returns:
            Compiled LangGraph workflow
        
        # CARACAL INTEGRATION POINT
        # Dynamic routing allows the workflow to adapt based on:
        # - Authority validation results
        # - Mandate availability
        # - Resource access permissions
        # - Delegation chain depth
        """
        logger.info("Building dynamic multi-agent workflow")
        
        # Create state graph
        workflow = StateGraph(WorkflowState)
        
        # Add all possible nodes
        workflow.add_node("orchestrator", self._orchestrator_node)
        workflow.add_node("finance", self._finance_node)
        workflow.add_node("ops", self._ops_node)
        workflow.add_node("analyst", self._analyst_node)
        workflow.add_node("reporter", self._reporter_node)
        workflow.add_node("aggregator", self._aggregator_node)
        
        # Set entry point
        workflow.set_entry_point("orchestrator")
        
        # Dynamic routing from orchestrator
        workflow.add_conditional_edges(
            "orchestrator",
            self._route_from_orchestrator,
            {
                "finance": "finance",
                "ops": "ops",
                "reporter": "reporter",
                "end": END,
            }
        )
        
        # Dynamic routing from finance
        workflow.add_conditional_edges(
            "finance",
            self._route_from_finance,
            {
                "ops": "ops",
                "analyst": "analyst",
                "reporter": "reporter",
                "end": END,
            }
        )
        
        # Dynamic routing from ops
        workflow.add_conditional_edges(
            "ops",
            self._route_from_ops,
            {
                "analyst": "analyst",
                "reporter": "reporter",
                "end": END,
            }
        )
        
        # Dynamic routing from analyst
        workflow.add_conditional_edges(
            "analyst",
            self._route_from_analyst,
            {
                "reporter": "reporter",
                "end": END,
            }
        )
        
        # Reporter always goes to aggregator
        workflow.add_edge("reporter", "aggregator")
        
        # Aggregator always ends
        workflow.add_edge("aggregator", END)
        
        # Compile the workflow
        compiled = workflow.compile()
        
        logger.info("Dynamic workflow compiled successfully")
        return compiled
    
    # Agent instance management
    
    def _get_or_create_agent(
        self,
        agent_role: AgentRole,
        state: WorkflowState,
    ) -> Any:
        """
        Get or create an agent instance for the given role.
        
        Args:
            agent_role: Role of the agent to create
            state: Current workflow state
        
        Returns:
            Agent instance
        """
        # Check cache first
        cache_key = f"{agent_role.value}_{state.get('scenario_id', 'default')}"
        if cache_key in self._agent_cache:
            return self._agent_cache[cache_key]
        
        # Get mandate ID for this role
        principal_id = self.principal_ids.get(agent_role.value)
        if not principal_id:
            # Try to get from state
            mandate_key = f"{agent_role.value}_principal_id"
            principal_id = state.get(mandate_key)
        
        if not principal_id:
            raise ValueError(
                f"No mandate ID provided for {agent_role.value} agent"
            )
        
        # Create agent based on role
        if agent_role == AgentRole.ORCHESTRATOR:
            from examples.langchain_demo.agents.orchestrator import OrchestratorAgent
            agent = OrchestratorAgent(
                principal_id=principal_id,
                caracal_client=self.caracal_client,
                scenario=self.scenario,
            )
        elif agent_role == AgentRole.FINANCE:
            from examples.langchain_demo.agents.finance_agent import FinanceAgent
            agent = FinanceAgent(
                principal_id=principal_id,
                caracal_client=self.caracal_client,
                scenario=self.scenario,
            )
        elif agent_role == AgentRole.OPS:
            from examples.langchain_demo.agents.ops_agent import OpsAgent
            agent = OpsAgent(
                principal_id=principal_id,
                caracal_client=self.caracal_client,
                scenario=self.scenario,
            )
        elif agent_role == AgentRole.ANALYST:
            from examples.langchain_demo.agents.analyst_agent import AnalystAgent
            agent = AnalystAgent(
                principal_id=principal_id,
                caracal_client=self.caracal_client,
                scenario=self.scenario,
            )
        elif agent_role == AgentRole.REPORTER:
            from examples.langchain_demo.agents.reporter_agent import ReporterAgent
            agent = ReporterAgent(
                principal_id=principal_id,
                caracal_client=self.caracal_client,
                scenario=self.scenario,
            )
        else:
            raise ValueError(f"Unknown agent role: {agent_role}")
        
        # Cache the agent
        self._agent_cache[cache_key] = agent
        
        # Store agent ID in state
        state[f"{agent_role.value}_agent_id"] = agent.agent_id
        
        return agent
    
    # Node implementations
    
    def _orchestrator_node(self, state: WorkflowState) -> WorkflowState:
        """
        Execute the orchestrator node.
        
        # CARACAL INTEGRATION POINT
        # The orchestrator uses its mandate to:
        # - Analyze the task
        # - Determine which sub-agents to spawn
        # - Delegate mandates to sub-agents
        
        Args:
            state: Current workflow state
        
        Returns:
            Updated workflow state
        """
        logger.info("Executing orchestrator node")
        
        # Update current step
        state["current_step"] = WorkflowStep.ORCHESTRATOR.value
        state["iteration"] = state.get("iteration", 0) + 1
        
        try:
            # Get or create orchestrator agent
            agent = self._get_or_create_agent(AgentRole.ORCHESTRATOR, state)
            
            # Add orchestrator message
            message = {
                "agent_id": agent.agent_id,
                "agent_role": AgentRole.ORCHESTRATOR.value,
                "message_type": MessageType.THOUGHT.value,
                "content": f"Analyzing task: {state['task']}",
                "timestamp": None,
            }
            state.setdefault("messages", []).append(message)
            
            # Determine next steps based on scenario
            scenario_data = state.get("scenario_data", {})
            
            # Check if finance analysis is needed
            finance_data = scenario_data.get("finance_data")
            if finance_data and finance_data.get("departments"):
                state["next_step"] = "finance"
            # Check if ops analysis is needed
            elif scenario_data.get("ops_data"):
                state["next_step"] = "ops"
            else:
                # Go directly to reporter
                state["next_step"] = "reporter"
            
            logger.info(f"Orchestrator determined next step: {state['next_step']}")
            
        except Exception as e:
            logger.error(f"Error in orchestrator node: {e}", exc_info=True)
            state.setdefault("errors", []).append(str(e))
            state["next_step"] = "end"
        
        return state
    
    def _finance_node(self, state: WorkflowState) -> WorkflowState:
        """
        Execute the finance agent node.
        
        # CARACAL INTEGRATION POINT
        # The finance agent uses its delegated mandate to:
        # - Call finance-specific tools
        # - Access finance data APIs
        # - Perform budget analysis
        
        Args:
            state: Current workflow state
        
        Returns:
            Updated workflow state
        """
        logger.info("Executing finance node")
        
        state["current_step"] = WorkflowStep.FINANCE.value
        
        try:
            # Get or create finance agent
            agent = self._get_or_create_agent(AgentRole.FINANCE, state)
            
            # Add finance agent message
            message = {
                "agent_id": agent.agent_id,
                "agent_role": AgentRole.FINANCE.value,
                "message_type": MessageType.ACTION.value,
                "content": "Analyzing financial data",
                "timestamp": None,
            }
            state.setdefault("messages", []).append(message)
            
            # Execute finance agent (simplified for graph execution)
            # In full implementation, this would call agent.execute()
            state["finance_results"] = {
                "status": "success",
                "summary": "Finance analysis completed",
                "key_findings": [],
                "recommendations": [],
                "agent_id": agent.agent_id,
            }
            
            # Determine next step
            scenario_data = state.get("scenario_data", {})
            if scenario_data.get("ops_data"):
                state["next_step"] = "ops"
            else:
                state["next_step"] = "reporter"
            
            logger.info(f"Finance node completed, next step: {state['next_step']}")
            
        except Exception as e:
            logger.error(f"Error in finance node: {e}", exc_info=True)
            state.setdefault("errors", []).append(str(e))
            state["next_step"] = "reporter"
        
        return state
    
    def _ops_node(self, state: WorkflowState) -> WorkflowState:
        """
        Execute the ops agent node.
        
        # CARACAL INTEGRATION POINT
        # The ops agent uses its delegated mandate to:
        # - Call ops-specific tools
        # - Access incident management APIs
        # - Monitor service health
        
        Args:
            state: Current workflow state
        
        Returns:
            Updated workflow state
        """
        logger.info("Executing ops node")
        
        state["current_step"] = WorkflowStep.OPS.value
        
        try:
            # Get or create ops agent
            agent = self._get_or_create_agent(AgentRole.OPS, state)
            
            # Add ops agent message
            message = {
                "agent_id": agent.agent_id,
                "agent_role": AgentRole.OPS.value,
                "message_type": MessageType.ACTION.value,
                "content": "Analyzing operational data",
                "timestamp": None,
            }
            state.setdefault("messages", []).append(message)
            
            # Execute ops agent (simplified for graph execution)
            state["ops_results"] = {
                "status": "success",
                "summary": "Ops analysis completed",
                "key_findings": [],
                "recommendations": [],
                "agent_id": agent.agent_id,
            }
            
            # Determine if analyst is needed
            # For now, go directly to reporter
            state["next_step"] = "reporter"
            
            logger.info(f"Ops node completed, next step: {state['next_step']}")
            
        except Exception as e:
            logger.error(f"Error in ops node: {e}", exc_info=True)
            state.setdefault("errors", []).append(str(e))
            state["next_step"] = "reporter"
        
        return state
    
    def _analyst_node(self, state: WorkflowState) -> WorkflowState:
        """
        Execute the analyst agent node.
        
        Args:
            state: Current workflow state
        
        Returns:
            Updated workflow state
        """
        logger.info("Executing analyst node")
        
        state["current_step"] = WorkflowStep.ANALYST.value
        
        # Add analyst agent message
        message = {
            "agent_role": AgentRole.ANALYST.value,
            "message_type": MessageType.ACTION.value,
            "content": "Performing data analysis",
            "timestamp": None,
        }
        state.setdefault("messages", []).append(message)
        
        # Placeholder for actual analyst agent execution
        state["analyst_results"] = {
            "status": "success",
            "analysis": "Data analysis completed",
        }
        
        state["next_step"] = "reporter"
        
        logger.info("Analyst node completed")
        return state
    
    def _reporter_node(self, state: WorkflowState) -> WorkflowState:
        """
        Execute the reporter agent node.
        
        Args:
            state: Current workflow state
        
        Returns:
            Updated workflow state
        """
        logger.info("Executing reporter node")
        
        state["current_step"] = WorkflowStep.REPORTER.value
        
        # Add reporter agent message
        message = {
            "agent_role": AgentRole.REPORTER.value,
            "message_type": MessageType.ACTION.value,
            "content": "Generating executive summary",
            "timestamp": None,
        }
        state.setdefault("messages", []).append(message)
        
        # Placeholder for actual reporter agent execution
        state["reporter_results"] = {
            "status": "success",
            "report": "Executive summary generated",
        }
        
        state["next_step"] = "aggregator"
        
        logger.info("Reporter node completed")
        return state
    
    def _aggregator_node(self, state: WorkflowState) -> WorkflowState:
        """
        Aggregate results from all agents.
        
        Args:
            state: Current workflow state
        
        Returns:
            Updated workflow state with aggregated results
        """
        logger.info("Executing aggregator node")
        
        state["current_step"] = WorkflowStep.AGGREGATOR.value
        
        # Aggregate all results
        aggregated = {
            "scenario_id": state.get("scenario_id"),
            "finance": state.get("finance_results"),
            "ops": state.get("ops_results"),
            "analyst": state.get("analyst_results"),
            "reporter": state.get("reporter_results"),
        }
        
        state["aggregated_results"] = aggregated
        
        # Generate executive summary
        summary_parts = []
        if state.get("finance_results"):
            summary_parts.append(
                f"Finance: {state['finance_results'].get('summary', 'N/A')}"
            )
        if state.get("ops_results"):
            summary_parts.append(
                f"Ops: {state['ops_results'].get('summary', 'N/A')}"
            )
        
        state["executive_summary"] = " | ".join(summary_parts)
        
        state["next_step"] = "end"
        
        logger.info("Aggregation completed")
        return state
    
    # Routing functions
    
    def _route_from_orchestrator(
        self,
        state: WorkflowState
    ) -> Literal["finance", "ops", "reporter", "end"]:
        """
        Route from orchestrator to next node based on scenario analysis.
        
        This routing function implements dynamic decision-making based on:
        - Scenario data availability
        - Task requirements
        - Agent availability
        - Authority constraints
        
        Args:
            state: Current workflow state
        
        Returns:
            Next node to execute
        
        # CARACAL INTEGRATION POINT
        # Routing decisions can be influenced by:
        # - Mandate availability for each agent
        # - Authority validation results
        # - Resource access permissions
        """
        next_step = state.get("next_step", "end")
        
        # Validate the next step is allowed
        allowed_steps = ["finance", "ops", "reporter", "end"]
        if next_step not in allowed_steps:
            logger.warning(
                f"Invalid next step '{next_step}' from orchestrator, "
                f"defaulting to 'end'"
            )
            next_step = "end"
        
        logger.info(f"Routing from orchestrator to: {next_step}")
        return next_step
    
    def _route_from_finance(
        self,
        state: WorkflowState
    ) -> Literal["ops", "analyst", "reporter", "end"]:
        """
        Route from finance agent to next node based on results.
        
        Dynamic routing logic:
        - If finance results need deeper analysis → analyst
        - If ops data is available → ops
        - If ready for summary → reporter
        - If errors occurred → end
        
        Args:
            state: Current workflow state
        
        Returns:
            Next node to execute
        
        # CARACAL INTEGRATION POINT
        # Finance agent's authority determines which paths are available.
        # If finance lacks delegation authority, analyst path may be blocked.
        """
        next_step = state.get("next_step", "end")
        
        # Check if finance results indicate need for analysis
        finance_results = state.get("finance_results", {})
        if finance_results.get("needs_analysis") and next_step != "analyst":
            logger.info("Finance results require analysis, routing to analyst")
            next_step = "analyst"
        
        # Validate the next step is allowed
        allowed_steps = ["ops", "analyst", "reporter", "end"]
        if next_step not in allowed_steps:
            logger.warning(
                f"Invalid next step '{next_step}' from finance, "
                f"defaulting to 'reporter'"
            )
            next_step = "reporter"
        
        logger.info(f"Routing from finance to: {next_step}")
        return next_step
    
    def _route_from_ops(
        self,
        state: WorkflowState
    ) -> Literal["analyst", "reporter", "end"]:
        """
        Route from ops agent to next node based on results.
        
        Dynamic routing logic:
        - If ops results need deeper analysis → analyst
        - If ready for summary → reporter
        - If errors occurred → end
        
        Args:
            state: Current workflow state
        
        Returns:
            Next node to execute
        
        # CARACAL INTEGRATION POINT
        # Ops agent's mandate determines available delegation paths.
        """
        next_step = state.get("next_step", "end")
        
        # Check if ops results indicate need for analysis
        ops_results = state.get("ops_results", {})
        if ops_results.get("needs_analysis") and next_step != "analyst":
            logger.info("Ops results require analysis, routing to analyst")
            next_step = "analyst"
        
        # Validate the next step is allowed
        allowed_steps = ["analyst", "reporter", "end"]
        if next_step not in allowed_steps:
            logger.warning(
                f"Invalid next step '{next_step}' from ops, "
                f"defaulting to 'reporter'"
            )
            next_step = "reporter"
        
        logger.info(f"Routing from ops to: {next_step}")
        return next_step
    
    def _route_from_analyst(
        self,
        state: WorkflowState
    ) -> Literal["reporter", "end"]:
        """
        Route from analyst agent to next node.
        
        Analyst typically routes to reporter for final summary,
        unless errors occurred.
        
        Args:
            state: Current workflow state
        
        Returns:
            Next node to execute
        """
        next_step = state.get("next_step", "reporter")
        
        # Check for errors
        errors = state.get("errors", [])
        if errors:
            logger.warning(f"Errors detected: {errors}, routing to end")
            next_step = "end"
        
        # Validate the next step is allowed
        allowed_steps = ["reporter", "end"]
        if next_step not in allowed_steps:
            logger.warning(
                f"Invalid next step '{next_step}' from analyst, "
                f"defaulting to 'reporter'"
            )
            next_step = "reporter"
        
        logger.info(f"Routing from analyst to: {next_step}")
        return next_step
    
    def _route_parallel(
        self,
        state: WorkflowState
    ) -> Literal["finance", "ops", "reporter", "end"]:
        """
        Route for parallel execution mode.
        
        In parallel mode, we need to execute both finance and ops
        before proceeding to reporter. This function manages the
        sequencing to simulate parallel execution.
        
        Dynamic routing logic:
        - First execution → finance
        - After finance → ops
        - After ops → reporter
        - On error → end
        
        Args:
            state: Current workflow state
        
        Returns:
            Next node to execute
        
        # CARACAL INTEGRATION POINT
        # Parallel execution requires both agents to have valid mandates.
        # If either mandate is invalid, we skip that agent.
        """
        next_step = state.get("next_step", "end")
        
        # Check which agents have already executed
        finance_executed = state.get("finance_results") is not None
        ops_executed = state.get("ops_results") is not None
        
        # If neither has executed, start with finance
        if not finance_executed and not ops_executed:
            logger.info("Starting parallel execution with finance")
            next_step = "finance"
        # If finance executed but not ops, do ops
        elif finance_executed and not ops_executed:
            logger.info("Finance complete, executing ops")
            next_step = "ops"
        # If both executed, go to reporter
        elif finance_executed and ops_executed:
            logger.info("Both agents complete, routing to reporter")
            next_step = "reporter"
        
        # Validate the next step is allowed
        allowed_steps = ["finance", "ops", "reporter", "end"]
        if next_step not in allowed_steps:
            logger.warning(
                f"Invalid next step '{next_step}' in parallel mode, "
                f"defaulting to 'end'"
            )
            next_step = "end"
        
        logger.info(f"Routing in parallel mode to: {next_step}")
        return next_step
    
    # Visualization methods
    
    def export_to_mermaid(
        self,
        workflow_type: str = "standard"
    ) -> str:
        """
        Export workflow to Mermaid diagram format.
        
        Mermaid is a markdown-like syntax for creating diagrams.
        The output can be rendered in GitHub, documentation sites, etc.
        
        Args:
            workflow_type: Type of workflow ("standard", "parallel", "dynamic")
        
        Returns:
            Mermaid diagram as string
        
        Example output:
            ```mermaid
            graph TD
                START([Start]) --> orchestrator[Orchestrator]
                orchestrator --> finance[Finance Agent]
                orchestrator --> ops[Ops Agent]
                finance --> reporter[Reporter]
                ops --> reporter
                reporter --> aggregator[Aggregator]
                aggregator --> END([End])
            ```
        """
        logger.info(f"Exporting {workflow_type} workflow to Mermaid format")
        
        if workflow_type == "standard":
            return self._export_standard_to_mermaid()
        elif workflow_type == "parallel":
            return self._export_parallel_to_mermaid()
        elif workflow_type == "dynamic":
            return self._export_dynamic_to_mermaid()
        else:
            raise ValueError(f"Unknown workflow type: {workflow_type}")
    
    def _export_standard_to_mermaid(self) -> str:
        """Export standard workflow to Mermaid format."""
        mermaid = """graph TD
    START([Start]) --> orchestrator[Orchestrator Agent]
    
    orchestrator -->|finance needed| finance[Finance Agent]
    orchestrator -->|ops needed| ops[Ops Agent]
    orchestrator -->|direct report| reporter[Reporter Agent]
    orchestrator -->|no action| END([End])
    
    finance -->|ops needed| ops
    finance -->|analysis needed| analyst[Analyst Agent]
    finance -->|ready| reporter
    finance -->|error| END
    
    ops -->|analysis needed| analyst
    ops -->|ready| reporter
    ops -->|error| END
    
    analyst -->|ready| reporter
    analyst -->|error| END
    
    reporter --> aggregator[Aggregator]
    aggregator --> END
    
    style START fill:#90EE90
    style END fill:#FFB6C1
    style orchestrator fill:#87CEEB
    style finance fill:#DDA0DD
    style ops fill:#F0E68C
    style analyst fill:#FFE4B5
    style reporter fill:#98FB98
    style aggregator fill:#D3D3D3
"""
        return mermaid
    
    def _export_parallel_to_mermaid(self) -> str:
        """Export parallel workflow to Mermaid format."""
        mermaid = """graph TD
    START([Start]) --> orchestrator[Orchestrator Agent]
    
    orchestrator --> finance[Finance Agent]
    orchestrator --> ops[Ops Agent]
    
    finance --> reporter[Reporter Agent]
    ops --> reporter
    
    reporter --> aggregator[Aggregator]
    aggregator --> END([End])
    
    style START fill:#90EE90
    style END fill:#FFB6C1
    style orchestrator fill:#87CEEB
    style finance fill:#DDA0DD
    style ops fill:#F0E68C
    style reporter fill:#98FB98
    style aggregator fill:#D3D3D3
"""
        return mermaid
    
    def _export_dynamic_to_mermaid(self) -> str:
        """Export dynamic workflow to Mermaid format."""
        mermaid = """graph TD
    START([Start]) --> orchestrator[Orchestrator Agent]
    
    orchestrator -->|scenario analysis| finance[Finance Agent]
    orchestrator -->|scenario analysis| ops[Ops Agent]
    orchestrator -->|direct report| reporter[Reporter Agent]
    orchestrator -->|no action| END([End])
    
    finance -->|complex data| analyst[Analyst Agent]
    finance -->|continue| ops
    finance -->|ready| reporter
    
    ops -->|complex data| analyst
    ops -->|ready| reporter
    
    analyst -->|complete| reporter
    
    reporter --> aggregator[Aggregator]
    aggregator --> END
    
    style START fill:#90EE90
    style END fill:#FFB6C1
    style orchestrator fill:#87CEEB
    style finance fill:#DDA0DD
    style ops fill:#F0E68C
    style analyst fill:#FFE4B5
    style reporter fill:#98FB98
    style aggregator fill:#D3D3D3
"""
        return mermaid
    
    def export_to_dot(
        self,
        workflow_type: str = "standard"
    ) -> str:
        """
        Export workflow to DOT (Graphviz) format.
        
        DOT is a graph description language used by Graphviz.
        The output can be rendered using Graphviz tools.
        
        Args:
            workflow_type: Type of workflow ("standard", "parallel", "dynamic")
        
        Returns:
            DOT diagram as string
        
        Example output:
            digraph workflow {
                rankdir=TD;
                node [shape=box, style=rounded];
                
                start [label="Start", shape=circle];
                orchestrator [label="Orchestrator"];
                finance [label="Finance Agent"];
                
                start -> orchestrator;
                orchestrator -> finance [label="finance needed"];
            }
        """
        logger.info(f"Exporting {workflow_type} workflow to DOT format")
        
        if workflow_type == "standard":
            return self._export_standard_to_dot()
        elif workflow_type == "parallel":
            return self._export_parallel_to_dot()
        elif workflow_type == "dynamic":
            return self._export_dynamic_to_dot()
        else:
            raise ValueError(f"Unknown workflow type: {workflow_type}")
    
    def _export_standard_to_dot(self) -> str:
        """Export standard workflow to DOT format."""
        dot = """digraph standard_workflow {
    rankdir=TD;
    node [shape=box, style=rounded, fontname="Arial"];
    edge [fontname="Arial", fontsize=10];
    
    // Nodes
    start [label="Start", shape=circle, fillcolor="#90EE90", style=filled];
    orchestrator [label="Orchestrator\\nAgent", fillcolor="#87CEEB", style=filled];
    finance [label="Finance\\nAgent", fillcolor="#DDA0DD", style=filled];
    ops [label="Ops\\nAgent", fillcolor="#F0E68C", style=filled];
    analyst [label="Analyst\\nAgent", fillcolor="#FFE4B5", style=filled];
    reporter [label="Reporter\\nAgent", fillcolor="#98FB98", style=filled];
    aggregator [label="Aggregator", fillcolor="#D3D3D3", style=filled];
    end [label="End", shape=circle, fillcolor="#FFB6C1", style=filled];
    
    // Edges
    start -> orchestrator;
    
    orchestrator -> finance [label="finance needed"];
    orchestrator -> ops [label="ops needed"];
    orchestrator -> reporter [label="direct report"];
    orchestrator -> end [label="no action"];
    
    finance -> ops [label="ops needed"];
    finance -> analyst [label="analysis needed"];
    finance -> reporter [label="ready"];
    finance -> end [label="error"];
    
    ops -> analyst [label="analysis needed"];
    ops -> reporter [label="ready"];
    ops -> end [label="error"];
    
    analyst -> reporter [label="ready"];
    analyst -> end [label="error"];
    
    reporter -> aggregator;
    aggregator -> end;
}
"""
        return dot
    
    def _export_parallel_to_dot(self) -> str:
        """Export parallel workflow to DOT format."""
        dot = """digraph parallel_workflow {
    rankdir=TD;
    node [shape=box, style=rounded, fontname="Arial"];
    edge [fontname="Arial"];
    
    // Nodes
    start [label="Start", shape=circle, fillcolor="#90EE90", style=filled];
    orchestrator [label="Orchestrator\\nAgent", fillcolor="#87CEEB", style=filled];
    finance [label="Finance\\nAgent", fillcolor="#DDA0DD", style=filled];
    ops [label="Ops\\nAgent", fillcolor="#F0E68C", style=filled];
    reporter [label="Reporter\\nAgent", fillcolor="#98FB98", style=filled];
    aggregator [label="Aggregator", fillcolor="#D3D3D3", style=filled];
    end [label="End", shape=circle, fillcolor="#FFB6C1", style=filled];
    
    // Edges
    start -> orchestrator;
    
    // Parallel execution
    orchestrator -> finance;
    orchestrator -> ops;
    
    // Join point
    finance -> reporter;
    ops -> reporter;
    
    reporter -> aggregator;
    aggregator -> end;
}
"""
        return dot
    
    def _export_dynamic_to_dot(self) -> str:
        """Export dynamic workflow to DOT format."""
        dot = """digraph dynamic_workflow {
    rankdir=TD;
    node [shape=box, style=rounded, fontname="Arial"];
    edge [fontname="Arial", fontsize=10];
    
    // Nodes
    start [label="Start", shape=circle, fillcolor="#90EE90", style=filled];
    orchestrator [label="Orchestrator\\nAgent", fillcolor="#87CEEB", style=filled];
    finance [label="Finance\\nAgent", fillcolor="#DDA0DD", style=filled];
    ops [label="Ops\\nAgent", fillcolor="#F0E68C", style=filled];
    analyst [label="Analyst\\nAgent", fillcolor="#FFE4B5", style=filled];
    reporter [label="Reporter\\nAgent", fillcolor="#98FB98", style=filled];
    aggregator [label="Aggregator", fillcolor="#D3D3D3", style=filled];
    end [label="End", shape=circle, fillcolor="#FFB6C1", style=filled];
    
    // Edges with dynamic routing
    start -> orchestrator;
    
    orchestrator -> finance [label="scenario\\nanalysis"];
    orchestrator -> ops [label="scenario\\nanalysis"];
    orchestrator -> reporter [label="direct\\nreport"];
    orchestrator -> end [label="no action"];
    
    finance -> analyst [label="complex\\ndata"];
    finance -> ops [label="continue"];
    finance -> reporter [label="ready"];
    
    ops -> analyst [label="complex\\ndata"];
    ops -> reporter [label="ready"];
    
    analyst -> reporter [label="complete"];
    
    reporter -> aggregator;
    aggregator -> end;
}
"""
        return dot
    
    def save_visualization(
        self,
        output_path: str,
        workflow_type: str = "standard",
        format: str = "mermaid"
    ) -> None:
        """
        Save workflow visualization to file.
        
        Args:
            output_path: Path to save the visualization file
            workflow_type: Type of workflow ("standard", "parallel", "dynamic")
            format: Output format ("mermaid" or "dot")
        
        Raises:
            ValueError: If format is not supported
        """
        logger.info(
            f"Saving {workflow_type} workflow visualization to {output_path}"
        )
        
        if format == "mermaid":
            content = self.export_to_mermaid(workflow_type)
        elif format == "dot":
            content = self.export_to_dot(workflow_type)
        else:
            raise ValueError(f"Unsupported format: {format}")
        
        with open(output_path, "w") as f:
            f.write(content)
        
        logger.info(f"Visualization saved to {output_path}")


def create_standard_workflow(caracal_client: Any) -> CompiledGraph:
    """
    Convenience function to create a standard workflow.
    
    Args:
        caracal_client: Caracal client for governed tool calls
    
    Returns:
        Compiled LangGraph workflow
    """
    builder = GraphBuilder(caracal_client)
    return builder.build_standard_workflow()


def create_parallel_workflow(caracal_client: Any) -> CompiledGraph:
    """
    Convenience function to create a parallel workflow.
    
    Args:
        caracal_client: Caracal client for governed tool calls
    
    Returns:
        Compiled LangGraph workflow
    """
    builder = GraphBuilder(caracal_client)
    return builder.build_parallel_workflow()


def create_dynamic_workflow(caracal_client: Any) -> CompiledGraph:
    """
    Convenience function to create a dynamic workflow.
    
    Args:
        caracal_client: Caracal client for governed tool calls
    
    Returns:
        Compiled LangGraph workflow
    """
    builder = GraphBuilder(caracal_client)
    return builder.build_dynamic_workflow()


class WorkflowExecutionEngine:
    """
    Engine for executing LangGraph workflows with comprehensive tracking.
    
    This engine wraps LangGraph workflow execution and provides:
    - State initialization and management
    - Execution monitoring and logging
    - Error handling and recovery
    - Result aggregation
    - Execution history tracking
    
    # CARACAL INTEGRATION POINT
    # The execution engine ensures that:
    # - All agents have valid mandates before execution
    # - Authority is validated at each step
    # - Execution is logged to the authority ledger
    # - Delegation chains are properly tracked
    """
    
    def __init__(
        self,
        workflow: CompiledGraph,
        caracal_client: Any,
        scenario: Optional[Any] = None,
    ):
        """
        Initialize the workflow execution engine.
        
        Args:
            workflow: Compiled LangGraph workflow
            caracal_client: Caracal client for governed tool calls
            scenario: Optional scenario object for context
        """
        self.workflow = workflow
        self.caracal_client = caracal_client
        self.scenario = scenario
        
        # Execution tracking
        self._execution_history: List[Dict[str, Any]] = []
        self._current_execution_id: Optional[str] = None
        
        logger.info("Initialized WorkflowExecutionEngine")
    
    async def execute(
        self,
        task: str,
        scenario_id: str,
        scenario_data: Dict[str, Any],
        principal_ids: Dict[str, str],
        max_iterations: int = 10,
    ) -> Dict[str, Any]:
        """
        Execute the workflow with the given task and scenario.
        
        Args:
            task: High-level task description
            scenario_id: ID of the scenario to execute
            scenario_data: Full scenario data dictionary
            principal_ids: Dictionary mapping agent roles to mandate IDs
            max_iterations: Maximum number of workflow iterations
        
        Returns:
            Execution results including:
            - execution_id: Unique execution identifier
            - status: Execution status (success, error, timeout)
            - aggregated_results: Results from all agents
            - executive_summary: Final summary
            - messages: All agent messages
            - errors: Any errors encountered
            - duration_ms: Total execution time
        
        # CARACAL INTEGRATION POINT
        # Before execution, we validate that all required mandates exist
        # and have the necessary authority for their respective agents.
        """
        import time
        import uuid
        
        execution_id = str(uuid.uuid4())
        self._current_execution_id = execution_id
        start_time = time.time()
        
        logger.info(
            f"Starting workflow execution {execution_id} "
            f"for scenario {scenario_id}"
        )
        
        try:
            # Initialize workflow state
            initial_state = self._initialize_state(
                task=task,
                scenario_id=scenario_id,
                scenario_data=scenario_data,
                principal_ids=principal_ids,
                max_iterations=max_iterations,
            )
            
            # Validate mandates before execution
            await self._validate_mandates(principal_ids)
            
            # Execute the workflow
            logger.info("Executing workflow...")
            final_state = await self._execute_workflow(initial_state)
            
            # Calculate execution time
            duration_ms = int((time.time() - start_time) * 1000)
            
            # Build result
            result = {
                "execution_id": execution_id,
                "status": "success" if not final_state.get("errors") else "error",
                "aggregated_results": final_state.get("aggregated_results"),
                "executive_summary": final_state.get("executive_summary"),
                "messages": final_state.get("messages", []),
                "errors": final_state.get("errors", []),
                "duration_ms": duration_ms,
                "final_state": final_state,
            }
            
            # Store in execution history
            self._execution_history.append(result)
            
            logger.info(
                f"Workflow execution {execution_id} completed "
                f"in {duration_ms}ms with status: {result['status']}"
            )
            
            return result
            
        except Exception as e:
            duration_ms = int((time.time() - start_time) * 1000)
            logger.error(
                f"Workflow execution {execution_id} failed: {e}",
                exc_info=True
            )
            
            result = {
                "execution_id": execution_id,
                "status": "error",
                "aggregated_results": None,
                "executive_summary": None,
                "messages": [],
                "errors": [str(e)],
                "duration_ms": duration_ms,
                "final_state": None,
            }
            
            self._execution_history.append(result)
            return result
    
    def _initialize_state(
        self,
        task: str,
        scenario_id: str,
        scenario_data: Dict[str, Any],
        principal_ids: Dict[str, str],
        max_iterations: int,
    ) -> WorkflowState:
        """
        Initialize the workflow state.
        
        Args:
            task: High-level task description
            scenario_id: ID of the scenario
            scenario_data: Full scenario data
            principal_ids: Mandate IDs for each agent
            max_iterations: Maximum iterations
        
        Returns:
            Initialized workflow state
        """
        logger.info("Initializing workflow state")
        
        state: WorkflowState = {
            "task": task,
            "scenario_id": scenario_id,
            "scenario_data": scenario_data,
            "orchestrator_id": "",
            "orchestrator_principal_id": principal_ids.get("orchestrator", ""),
            "finance_agent_id": None,
            "finance_principal_id": principal_ids.get("finance"),
            "finance_results": None,
            "ops_agent_id": None,
            "ops_principal_id": principal_ids.get("ops"),
            "ops_results": None,
            "analyst_agent_id": None,
            "analyst_principal_id": principal_ids.get("analyst"),
            "analyst_results": None,
            "reporter_agent_id": None,
            "reporter_principal_id": principal_ids.get("reporter"),
            "reporter_results": None,
            "aggregated_results": None,
            "executive_summary": None,
            "messages": [],
            "errors": [],
            "current_step": WorkflowStep.START.value,
            "next_step": None,
            "iteration": 0,
            "max_iterations": max_iterations,
        }
        
        return state
    
    async def _validate_mandates(
        self,
        principal_ids: Dict[str, str]
    ) -> None:
        """
        Validate that all required mandates exist and are valid.
        
        Args:
            principal_ids: Dictionary of mandate IDs to validate
        
        Raises:
            ValueError: If any mandate is invalid
        
        # CARACAL INTEGRATION POINT
        # This validates mandates before workflow execution to fail fast
        # if there are authority issues.
        """
        logger.info("Validating mandates before execution")
        
        for role, principal_id in principal_ids.items():
            if not principal_id:
                logger.warning(f"No mandate ID provided for {role}")
                continue
            
            # In a full implementation, we would validate with Caracal
            # For now, just log
            logger.info(f"Mandate {principal_id} for {role} - validation skipped")
    
    async def _execute_workflow(
        self,
        initial_state: WorkflowState
    ) -> WorkflowState:
        """
        Execute the workflow with the given initial state.
        
        Args:
            initial_state: Initial workflow state
        
        Returns:
            Final workflow state after execution
        """
        logger.info("Executing workflow graph")
        
        # Execute the workflow
        # Note: LangGraph's invoke method is synchronous, but we're in an async context
        # In a real implementation, we might need to use asyncio.to_thread or similar
        try:
            final_state = self.workflow.invoke(initial_state)
            return final_state
        except Exception as e:
            logger.error(f"Workflow execution failed: {e}", exc_info=True)
            # Return state with error
            initial_state["errors"].append(str(e))
            return initial_state
    
    def get_execution_history(self) -> List[Dict[str, Any]]:
        """
        Get the execution history.
        
        Returns:
            List of execution results
        """
        return self._execution_history
    
    def get_last_execution(self) -> Optional[Dict[str, Any]]:
        """
        Get the most recent execution result.
        
        Returns:
            Last execution result or None if no executions
        """
        if not self._execution_history:
            return None
        return self._execution_history[-1]
    
    def clear_history(self) -> None:
        """Clear the execution history."""
        logger.info("Clearing execution history")
        self._execution_history.clear()
        self._current_execution_id = None


def create_execution_engine(
    caracal_client: Any,
    workflow_type: str = "standard",
    scenario: Optional[Any] = None,
    principal_ids: Optional[Dict[str, str]] = None,
) -> WorkflowExecutionEngine:
    """
    Convenience function to create a workflow execution engine.
    
    Args:
        caracal_client: Caracal client for governed tool calls
        workflow_type: Type of workflow ("standard", "parallel", "dynamic")
        scenario: Optional scenario object
        principal_ids: Optional mandate IDs for agents
    
    Returns:
        Configured workflow execution engine
    
    Raises:
        ValueError: If workflow_type is not supported
    """
    # Build the appropriate workflow
    builder = GraphBuilder(caracal_client, scenario, principal_ids)
    
    if workflow_type == "standard":
        workflow = builder.build_standard_workflow()
    elif workflow_type == "parallel":
        workflow = builder.build_parallel_workflow()
    elif workflow_type == "dynamic":
        workflow = builder.build_dynamic_workflow()
    else:
        raise ValueError(f"Unknown workflow type: {workflow_type}")
    
    # Create and return the execution engine
    return WorkflowExecutionEngine(workflow, caracal_client, scenario)
