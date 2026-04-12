"""
Orchestrator agent for coordinating multi-agent workflows.

The orchestrator is the top-level agent that receives high-level tasks,
decomposes them into sub-tasks, and delegates to specialized agents.
"""

import logging
from typing import Any, Dict, List, Optional
from uuid import uuid4

from examples.langchain_demo.agents.base import (
    BaseAgent,
    AgentRole,
    MessageType,
)
from examples.langchain_demo.scenarios.base import Scenario

logger = logging.getLogger(__name__)


class OrchestratorAgent(BaseAgent):
    """
    Orchestrator agent that coordinates multi-agent workflows.
    
    The orchestrator:
    1. Receives high-level tasks (e.g., "Prepare quarterly review")
    2. Analyzes the task and scenario context
    3. Decomposes the task into sub-tasks
    4. Delegates sub-tasks to specialized agents (finance, ops, etc.)
    5. Aggregates results from sub-agents
    6. Produces final executive summary
    
    # CARACAL INTEGRATION POINT
    # The orchestrator uses its mandate to:
    # - Call tools for task analysis
    # - Delegate mandates to sub-agents
    # - Coordinate authority across the agent hierarchy
    """
    
    def __init__(
        self,
        mandate_id: str,
        caracal_client: Any,
        scenario: Optional[Scenario] = None,
        parent_agent: Optional[BaseAgent] = None,
        agent_id: Optional[str] = None,
        context: Optional[Dict[str, Any]] = None,
        max_iterations: int = 10,
    ):
        """
        Initialize the orchestrator agent.
        
        Args:
            mandate_id: Caracal mandate ID for this agent
            caracal_client: Caracal client for governed tool calls
            scenario: Optional scenario context
            parent_agent: Parent agent (should be None for orchestrator)
            agent_id: Optional custom agent ID
            context: Optional initial context
            max_iterations: Maximum number of orchestration iterations
        """
        super().__init__(
            role=AgentRole.ORCHESTRATOR,
            mandate_id=mandate_id,
            parent_agent=parent_agent,
            agent_id=agent_id,
            context=context,
        )
        
        self.caracal_client = caracal_client
        self.scenario = scenario
        self.max_iterations = max_iterations
        
        # Track delegated agents
        self.delegated_agents: Dict[str, BaseAgent] = {}
        
        logger.info(
            f"Initialized OrchestratorAgent {self.agent_id[:8]} "
            f"with mandate {mandate_id[:8]}"
        )
    
    async def execute(self, task: str, **kwargs) -> Dict[str, Any]:
        """
        Execute the orchestration workflow.
        
        Args:
            task: High-level task description
            **kwargs: Additional parameters
                - scenario: Scenario object (overrides self.scenario)
                - finance_mandate_id: Mandate ID for finance agent
                - ops_mandate_id: Mandate ID for ops agent
                - reporter_mandate_id: Mandate ID for reporter agent
        
        Returns:
            Dictionary containing:
                - status: "success" or "error"
                - executive_summary: Final summary
                - finance_results: Results from finance agent
                - ops_results: Results from ops agent
                - messages: All messages from orchestration
                - sub_agents: List of sub-agent IDs
        """
        self.emit_message(
            MessageType.THOUGHT,
            f"Starting orchestration for task: {task}"
        )
        
        try:
            # Get scenario context
            scenario = kwargs.get("scenario", self.scenario)
            if not scenario:
                raise ValueError("No scenario provided for orchestration")
            
            self.state.context["scenario"] = scenario.to_dict()
            
            # Step 1: Analyze task and decompose
            self.emit_message(
                MessageType.THOUGHT,
                "Analyzing task and decomposing into sub-tasks"
            )
            
            sub_tasks = await self._decompose_task(task, scenario)
            
            self.emit_message(
                MessageType.ACTION,
                f"Decomposed task into {len(sub_tasks)} sub-tasks: "
                f"{', '.join(st['type'] for st in sub_tasks)}"
            )
            
            # Step 2: Delegate to specialized agents
            results = {}
            
            for sub_task in sub_tasks:
                task_type = sub_task["type"]
                task_description = sub_task["description"]
                
                self.emit_message(
                    MessageType.ACTION,
                    f"Delegating {task_type} task to specialized agent"
                )
                
                # Delegate based on task type
                if task_type == "finance":
                    finance_mandate_id = kwargs.get("finance_mandate_id")
                    if not finance_mandate_id:
                        raise ValueError("finance_mandate_id required for finance tasks")
                    
                    result = await self._delegate_to_finance(
                        task_description,
                        finance_mandate_id,
                        scenario
                    )
                    results["finance"] = result
                
                elif task_type == "ops":
                    ops_mandate_id = kwargs.get("ops_mandate_id")
                    if not ops_mandate_id:
                        raise ValueError("ops_mandate_id required for ops tasks")
                    
                    result = await self._delegate_to_ops(
                        task_description,
                        ops_mandate_id,
                        scenario
                    )
                    results["ops"] = result
                
                else:
                    logger.warning(f"Unknown task type: {task_type}")
            
            # Step 3: Aggregate results
            self.emit_message(
                MessageType.THOUGHT,
                "Aggregating results from specialized agents"
            )
            
            aggregated = self._aggregate_results(results, scenario)
            
            # Step 4: Generate executive summary
            self.emit_message(
                MessageType.ACTION,
                "Generating executive summary"
            )
            
            executive_summary = self._generate_executive_summary(
                aggregated,
                scenario
            )
            
            self.emit_message(
                MessageType.RESPONSE,
                f"Orchestration complete. Executive Summary:\n{executive_summary}"
            )
            
            # Mark as completed
            self.state.mark_completed()
            
            return {
                "status": "success",
                "executive_summary": executive_summary,
                "finance_results": results.get("finance"),
                "ops_results": results.get("ops"),
                "aggregated_results": aggregated,
                "messages": [msg.to_dict() for msg in self.get_messages()],
                "sub_agents": list(self.delegated_agents.keys()),
            }
        
        except Exception as e:
            logger.error(f"Orchestration failed: {e}", exc_info=True)
            self.state.mark_error()
            self.emit_message(
                MessageType.ERROR,
                f"Orchestration failed: {str(e)}"
            )
            
            return {
                "status": "error",
                "error": str(e),
                "messages": [msg.to_dict() for msg in self.get_messages()],
            }
    
    async def _decompose_task(
        self,
        task: str,
        scenario: Scenario
    ) -> List[Dict[str, Any]]:
        """
        Decompose high-level task into sub-tasks.
        
        Args:
            task: High-level task description
            scenario: Scenario context
        
        Returns:
            List of sub-task dictionaries with 'type' and 'description'
        """
        # For now, use rule-based decomposition
        # In a real implementation, this could use an LLM
        
        sub_tasks = []
        
        # Check if finance analysis is needed
        if scenario.finance_data and scenario.finance_data.departments:
            sub_tasks.append({
                "type": "finance",
                "description": (
                    f"Analyze financial data for {scenario.company.name} "
                    f"in {scenario.context.quarter} {scenario.context.month}. "
                    f"Review budget status for {len(scenario.finance_data.departments)} departments "
                    f"and {len(scenario.finance_data.pending_invoices)} pending invoices."
                ),
                "priority": 1,
            })
        
        # Check if ops analysis is needed
        if scenario.ops_data and scenario.ops_data.services:
            sub_tasks.append({
                "type": "ops",
                "description": (
                    f"Analyze operational data for {scenario.company.name}. "
                    f"Review health of {len(scenario.ops_data.services)} services "
                    f"and {len(scenario.ops_data.incidents)} active incidents."
                ),
                "priority": 1,
            })
        
        # Sort by priority
        sub_tasks.sort(key=lambda x: x.get("priority", 999))
        
        return sub_tasks
    
    async def _delegate_to_finance(
        self,
        task: str,
        mandate_id: str,
        scenario: Scenario
    ) -> Dict[str, Any]:
        """
        Delegate task to finance agent.
        
        # CARACAL INTEGRATION POINT
        # This method demonstrates agent-to-agent delegation:
        # 1. The orchestrator has a mandate with broad authority
        # 2. It delegates a scoped mandate to the finance agent
        # 3. The finance agent can only access finance-related tools
        
        Args:
            task: Task description for finance agent
            mandate_id: Mandate ID for finance agent
            scenario: Scenario context
        
        Returns:
            Results from finance agent
        """
        self.emit_message(
            MessageType.ACTION,
            f"Delegating to finance agent with mandate {mandate_id[:8]}"
        )
        
        # Import here to avoid circular dependency
        from examples.langchain_demo.agents.finance_agent import FinanceAgent
        
        # Create finance agent
        finance_agent = FinanceAgent(
            mandate_id=mandate_id,
            caracal_client=self.caracal_client,
            scenario=scenario,
            parent_agent=self,
        )
        
        # Track the delegated agent
        self.delegated_agents[finance_agent.agent_id] = finance_agent
        self.state.add_sub_agent(finance_agent.agent_id)
        
        # Execute finance agent
        result = await finance_agent.execute(task)
        
        self.emit_message(
            MessageType.OBSERVATION,
            f"Finance agent completed with status: {result.get('status')}"
        )
        
        return result
    
    async def _delegate_to_ops(
        self,
        task: str,
        mandate_id: str,
        scenario: Scenario
    ) -> Dict[str, Any]:
        """
        Delegate task to ops agent.
        
        # CARACAL INTEGRATION POINT
        # Similar to finance delegation, but for ops-related tasks
        
        Args:
            task: Task description for ops agent
            mandate_id: Mandate ID for ops agent
            scenario: Scenario context
        
        Returns:
            Results from ops agent
        """
        self.emit_message(
            MessageType.ACTION,
            f"Delegating to ops agent with mandate {mandate_id[:8]}"
        )
        
        # Import here to avoid circular dependency
        from examples.langchain_demo.agents.ops_agent import OpsAgent
        
        # Create ops agent
        ops_agent = OpsAgent(
            mandate_id=mandate_id,
            caracal_client=self.caracal_client,
            scenario=scenario,
            parent_agent=self,
        )
        
        # Track the delegated agent
        self.delegated_agents[ops_agent.agent_id] = ops_agent
        self.state.add_sub_agent(ops_agent.agent_id)
        
        # Execute ops agent
        result = await ops_agent.execute(task)
        
        self.emit_message(
            MessageType.OBSERVATION,
            f"Ops agent completed with status: {result.get('status')}"
        )
        
        return result
    
    def _aggregate_results(
        self,
        results: Dict[str, Any],
        scenario: Scenario
    ) -> Dict[str, Any]:
        """
        Aggregate results from multiple agents.
        
        Args:
            results: Dictionary of results from different agents
            scenario: Scenario context
        
        Returns:
            Aggregated results
        """
        aggregated = {
            "scenario_id": scenario.scenario_id,
            "scenario_name": scenario.name,
            "company": scenario.company.name,
            "period": f"{scenario.context.quarter} {scenario.context.month}",
            "agents_executed": list(results.keys()),
        }
        
        # Extract key findings from finance
        if "finance" in results and results["finance"].get("status") == "success":
            finance_data = results["finance"]
            aggregated["finance"] = {
                "summary": finance_data.get("summary", ""),
                "key_findings": finance_data.get("key_findings", []),
                "recommendations": finance_data.get("recommendations", []),
            }
        
        # Extract key findings from ops
        if "ops" in results and results["ops"].get("status") == "success":
            ops_data = results["ops"]
            aggregated["ops"] = {
                "summary": ops_data.get("summary", ""),
                "key_findings": ops_data.get("key_findings", []),
                "recommendations": ops_data.get("recommendations", []),
            }
        
        return aggregated
    
    def _generate_executive_summary(
        self,
        aggregated: Dict[str, Any],
        scenario: Scenario
    ) -> str:
        """
        Generate executive summary from aggregated results.
        
        Args:
            aggregated: Aggregated results from agents
            scenario: Scenario context
        
        Returns:
            Executive summary text
        """
        lines = []
        
        lines.append(f"# Executive Summary: {scenario.name}")
        lines.append(f"Company: {scenario.company.name}")
        lines.append(f"Period: {aggregated.get('period', 'Unknown')}")
        lines.append(f"Trigger: {scenario.context.trigger_event}")
        lines.append("")
        
        # Finance summary
        if "finance" in aggregated:
            lines.append("## Financial Analysis")
            finance = aggregated["finance"]
            lines.append(finance.get("summary", "No summary available"))
            
            if finance.get("key_findings"):
                lines.append("\nKey Findings:")
                for finding in finance["key_findings"]:
                    lines.append(f"- {finding}")
            
            if finance.get("recommendations"):
                lines.append("\nRecommendations:")
                for rec in finance["recommendations"]:
                    lines.append(f"- {rec}")
            lines.append("")
        
        # Ops summary
        if "ops" in aggregated:
            lines.append("## Operations Analysis")
            ops = aggregated["ops"]
            lines.append(ops.get("summary", "No summary available"))
            
            if ops.get("key_findings"):
                lines.append("\nKey Findings:")
                for finding in ops["key_findings"]:
                    lines.append(f"- {finding}")
            
            if ops.get("recommendations"):
                lines.append("\nRecommendations:")
                for rec in ops["recommendations"]:
                    lines.append(f"- {rec}")
            lines.append("")
        
        # Overall conclusion
        lines.append("## Conclusion")
        lines.append(scenario.expected_outcomes.executive_summary)
        
        return "\n".join(lines)
    
    def spawn_sub_agent(
        self,
        sub_agent_role: AgentRole,
        sub_agent_mandate_id: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> BaseAgent:
        """
        Spawn a sub-agent for delegated tasks.
        
        Args:
            sub_agent_role: Role for the sub-agent
            sub_agent_mandate_id: Mandate ID for the sub-agent
            context: Optional context to pass to the sub-agent
        
        Returns:
            The created sub-agent instance
        
        Raises:
            ValueError: If sub_agent_role is not supported
        """
        if sub_agent_role == AgentRole.FINANCE:
            from examples.langchain_demo.agents.finance_agent import FinanceAgent
            agent = FinanceAgent(
                mandate_id=sub_agent_mandate_id,
                caracal_client=self.caracal_client,
                scenario=self.scenario,
                parent_agent=self,
                context=context,
            )
        elif sub_agent_role == AgentRole.OPS:
            from examples.langchain_demo.agents.ops_agent import OpsAgent
            agent = OpsAgent(
                mandate_id=sub_agent_mandate_id,
                caracal_client=self.caracal_client,
                scenario=self.scenario,
                parent_agent=self,
                context=context,
            )
        else:
            raise ValueError(
                f"Orchestrator does not support spawning {sub_agent_role.value} agents"
            )
        
        # Track the sub-agent
        self.delegated_agents[agent.agent_id] = agent
        self.state.add_sub_agent(agent.agent_id)
        
        return agent
