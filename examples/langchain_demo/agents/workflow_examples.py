"""
Complex workflow examples demonstrating nested agent orchestration.

This module provides example workflows that showcase the full capabilities
of the multi-agent system with nested sub-agents, result aggregation,
and Caracal integration.
"""

import logging
from typing import Any, Dict, Optional

from examples.langchain_demo.agents.base import AgentRole
from examples.langchain_demo.agents.nested_spawning import get_nested_spawner
from examples.langchain_demo.agents.result_aggregation import (
    ResultAggregator,
    AgentResult,
    aggregate_finance_and_ops,
    aggregate_with_analyst,
)
from examples.langchain_demo.scenarios.base import Scenario

logger = logging.getLogger(__name__)


class ComplexWorkflowOrchestrator:
    """
    Orchestrator for complex multi-agent workflows.
    
    This class demonstrates advanced patterns:
    1. Nested agent spawning (agents spawning sub-agents)
    2. Parallel execution of multiple agents
    3. Sequential workflows with dependencies
    4. Result aggregation across multiple levels
    5. Dynamic workflow routing based on results
    """
    
    def __init__(self, caracal_client: Any):
        """
        Initialize the workflow orchestrator.
        
        Args:
            caracal_client: Caracal client for mandate operations
        """
        self.caracal_client = caracal_client
        self.spawner = get_nested_spawner(caracal_client)
        self.aggregator = ResultAggregator()
        
        logger.info("Initialized ComplexWorkflowOrchestrator")
    
    async def execute_deep_analysis_workflow(
        self,
        orchestrator_agent: Any,
        scenario: Scenario,
        finance_mandate_id: str,
        ops_mandate_id: str,
        analyst_mandate_id: str,
        reporter_mandate_id: str,
    ) -> Dict[str, Any]:
        """
        Execute a deep analysis workflow with nested sub-agents.
        
        Workflow:
        1. Orchestrator spawns Finance and Ops agents (parallel)
        2. Finance agent spawns Analyst sub-agent for deep financial analysis
        3. Ops agent spawns Analyst sub-agent for deep operational analysis
        4. Orchestrator spawns Reporter agent to consolidate all results
        5. Results are aggregated at multiple levels
        
        # CARACAL INTEGRATION POINT
        # This workflow demonstrates multi-level mandate delegation:
        # - Orchestrator has root mandate
        # - Finance/Ops agents have delegated mandates from orchestrator
        # - Analyst sub-agents have delegated mandates from Finance/Ops
        # - Reporter agent has delegated mandate from orchestrator
        # - Each level has appropriate authority scope
        
        Args:
            orchestrator_agent: The orchestrator agent
            scenario: Scenario context
            finance_mandate_id: Mandate ID for finance agent
            ops_mandate_id: Mandate ID for ops agent
            analyst_mandate_id: Mandate ID for analyst agents
            reporter_mandate_id: Mandate ID for reporter agent
        
        Returns:
            Dictionary containing workflow results
        """
        logger.info(
            f"Executing deep analysis workflow for scenario: {scenario.scenario_id}"
        )
        
        workflow_results = {
            "workflow_type": "deep_analysis",
            "scenario_id": scenario.scenario_id,
            "stages": {},
        }
        
        # Stage 1: Spawn and execute Finance agent
        logger.info("Stage 1: Executing Finance agent")
        finance_result = await self.spawner.spawn_and_execute(
            parent_agent=orchestrator_agent,
            sub_agent_role=AgentRole.FINANCE,
            task_description=f"Analyze financial data for {scenario.company.name}",
            sub_agent_mandate_id=finance_mandate_id,
            scenario=scenario,
        )
        
        workflow_results["stages"]["finance"] = finance_result
        
        # Stage 1b: If finance shows high risk, spawn analyst for deep dive
        if finance_result.get("status") == "success":
            risk_level = finance_result.get("risk_assessment", {}).get("overall_risk_level", "low")
            
            if risk_level in ["high", "critical"]:
                logger.info("Stage 1b: High financial risk detected, spawning Analyst")
                
                # Get the finance agent from spawner
                finance_agents = self.spawner.get_spawned_agents_by_parent(
                    orchestrator_agent.agent_id
                )
                finance_agent = next(
                    (a.agent for a in finance_agents if a.agent.role == AgentRole.FINANCE),
                    None
                )
                
                if finance_agent:
                    analyst_result = await self.spawner.spawn_and_execute(
                        parent_agent=finance_agent,
                        sub_agent_role=AgentRole.ANALYST,
                        task_description="Perform deep financial data analysis",
                        sub_agent_mandate_id=analyst_mandate_id,
                        scenario=scenario,
                        analysis_type="financial",
                        data_source="all",
                    )
                    
                    workflow_results["stages"]["finance_analyst"] = analyst_result
        
        # Stage 2: Spawn and execute Ops agent
        logger.info("Stage 2: Executing Ops agent")
        ops_result = await self.spawner.spawn_and_execute(
            parent_agent=orchestrator_agent,
            sub_agent_role=AgentRole.OPS,
            task_description=f"Analyze operational data for {scenario.company.name}",
            sub_agent_mandate_id=ops_mandate_id,
            scenario=scenario,
        )
        
        workflow_results["stages"]["ops"] = ops_result
        
        # Stage 2b: If ops shows degraded services, spawn analyst
        if ops_result.get("status") == "success":
            degraded_count = ops_result.get("service_analysis", {}).get("degraded_count", 0)
            
            if degraded_count > 0:
                logger.info("Stage 2b: Degraded services detected, spawning Analyst")
                
                # Get the ops agent from spawner
                ops_agents = self.spawner.get_spawned_agents_by_parent(
                    orchestrator_agent.agent_id
                )
                ops_agent = next(
                    (a.agent for a in ops_agents if a.agent.role == AgentRole.OPS),
                    None
                )
                
                if ops_agent:
                    analyst_result = await self.spawner.spawn_and_execute(
                        parent_agent=ops_agent,
                        sub_agent_role=AgentRole.ANALYST,
                        task_description="Perform deep operational data analysis",
                        sub_agent_mandate_id=analyst_mandate_id,
                        scenario=scenario,
                        analysis_type="operational",
                        data_source="all",
                    )
                    
                    workflow_results["stages"]["ops_analyst"] = analyst_result
        
        # Stage 3: Aggregate results from Finance and Ops
        logger.info("Stage 3: Aggregating Finance and Ops results")
        
        aggregated_primary = aggregate_finance_and_ops(
            finance_result,
            ops_result
        )
        
        workflow_results["stages"]["aggregated_primary"] = aggregated_primary
        
        # Stage 4: If we have analyst results, aggregate with them
        if "finance_analyst" in workflow_results["stages"] or "ops_analyst" in workflow_results["stages"]:
            logger.info("Stage 4: Aggregating with Analyst insights")
            
            # Combine analyst results
            analyst_combined = {}
            if "finance_analyst" in workflow_results["stages"]:
                analyst_combined["financial"] = workflow_results["stages"]["finance_analyst"]
            if "ops_analyst" in workflow_results["stages"]:
                analyst_combined["operational"] = workflow_results["stages"]["ops_analyst"]
            
            aggregated_with_analyst = aggregate_with_analyst(
                aggregated_primary,
                analyst_combined
            )
            
            workflow_results["stages"]["aggregated_with_analyst"] = aggregated_with_analyst
        
        # Stage 5: Spawn Reporter agent to generate final report
        logger.info("Stage 5: Generating final report")
        
        # Prepare agent results for reporter
        agent_results_for_report = {
            "finance": finance_result,
            "ops": ops_result,
        }
        
        if "finance_analyst" in workflow_results["stages"]:
            agent_results_for_report["analyst"] = workflow_results["stages"]["finance_analyst"]
        elif "ops_analyst" in workflow_results["stages"]:
            agent_results_for_report["analyst"] = workflow_results["stages"]["ops_analyst"]
        
        reporter_result = await self.spawner.spawn_and_execute(
            parent_agent=orchestrator_agent,
            sub_agent_role=AgentRole.REPORTER,
            task_description=f"Generate executive briefing for {scenario.company.name}",
            sub_agent_mandate_id=reporter_mandate_id,
            scenario=scenario,
            report_type="executive",
            agent_results=agent_results_for_report,
        )
        
        workflow_results["stages"]["reporter"] = reporter_result
        workflow_results["final_report"] = reporter_result.get("report_content", "")
        
        # Generate workflow summary
        workflow_results["summary"] = self._generate_workflow_summary(workflow_results)
        
        logger.info("Deep analysis workflow completed")
        
        return workflow_results
    
    async def execute_parallel_analysis_workflow(
        self,
        orchestrator_agent: Any,
        scenario: Scenario,
        finance_mandate_id: str,
        ops_mandate_id: str,
        analyst_mandate_id: str,
    ) -> Dict[str, Any]:
        """
        Execute a parallel analysis workflow.
        
        Workflow:
        1. Orchestrator spawns Finance, Ops, and Analyst agents in parallel
        2. All agents execute simultaneously
        3. Results are aggregated using consensus strategy
        
        Args:
            orchestrator_agent: The orchestrator agent
            scenario: Scenario context
            finance_mandate_id: Mandate ID for finance agent
            ops_mandate_id: Mandate ID for ops agent
            analyst_mandate_id: Mandate ID for analyst agent
        
        Returns:
            Dictionary containing workflow results
        """
        logger.info(
            f"Executing parallel analysis workflow for scenario: {scenario.scenario_id}"
        )
        
        workflow_results = {
            "workflow_type": "parallel_analysis",
            "scenario_id": scenario.scenario_id,
            "agent_results": [],
        }
        
        # Spawn all agents (in practice, these would execute in parallel)
        logger.info("Spawning Finance, Ops, and Analyst agents")
        
        # Finance agent
        finance_result = await self.spawner.spawn_and_execute(
            parent_agent=orchestrator_agent,
            sub_agent_role=AgentRole.FINANCE,
            task_description=f"Analyze financial data for {scenario.company.name}",
            sub_agent_mandate_id=finance_mandate_id,
            scenario=scenario,
        )
        
        # Ops agent
        ops_result = await self.spawner.spawn_and_execute(
            parent_agent=orchestrator_agent,
            sub_agent_role=AgentRole.OPS,
            task_description=f"Analyze operational data for {scenario.company.name}",
            sub_agent_mandate_id=ops_mandate_id,
            scenario=scenario,
        )
        
        # Analyst agent
        analyst_result = await self.spawner.spawn_and_execute(
            parent_agent=orchestrator_agent,
            sub_agent_role=AgentRole.ANALYST,
            task_description="Perform comprehensive data analysis",
            sub_agent_mandate_id=analyst_mandate_id,
            scenario=scenario,
            analysis_type="general",
            data_source="all",
        )
        
        # Create AgentResult objects for aggregation
        agent_results = [
            AgentResult(
                agent_id="finance",
                agent_role=AgentRole.FINANCE,
                status=finance_result.get("status", "error"),
                result_data=finance_result,
            ),
            AgentResult(
                agent_id="ops",
                agent_role=AgentRole.OPS,
                status=ops_result.get("status", "error"),
                result_data=ops_result,
            ),
            AgentResult(
                agent_id="analyst",
                agent_role=AgentRole.ANALYST,
                status=analyst_result.get("status", "error"),
                result_data=analyst_result,
            ),
        ]
        
        # Aggregate using consensus strategy
        logger.info("Aggregating results using consensus strategy")
        aggregated = self.aggregator.aggregate(
            agent_results=agent_results,
            strategy="consensus",
        )
        
        workflow_results["aggregated_results"] = aggregated.to_dict()
        workflow_results["summary"] = aggregated.summary
        
        logger.info("Parallel analysis workflow completed")
        
        return workflow_results
    
    async def execute_conditional_workflow(
        self,
        orchestrator_agent: Any,
        scenario: Scenario,
        finance_mandate_id: str,
        ops_mandate_id: str,
        analyst_mandate_id: str,
        reporter_mandate_id: str,
    ) -> Dict[str, Any]:
        """
        Execute a conditional workflow with dynamic routing.
        
        Workflow:
        1. Orchestrator spawns Finance agent
        2. Based on finance results, decide next steps:
           - If high risk: spawn Analyst for deep dive
           - If operational issues mentioned: spawn Ops agent
        3. Aggregate all results
        4. Generate report
        
        Args:
            orchestrator_agent: The orchestrator agent
            scenario: Scenario context
            finance_mandate_id: Mandate ID for finance agent
            ops_mandate_id: Mandate ID for ops agent
            analyst_mandate_id: Mandate ID for analyst agent
            reporter_mandate_id: Mandate ID for reporter agent
        
        Returns:
            Dictionary containing workflow results
        """
        logger.info(
            f"Executing conditional workflow for scenario: {scenario.scenario_id}"
        )
        
        workflow_results = {
            "workflow_type": "conditional",
            "scenario_id": scenario.scenario_id,
            "stages": {},
            "decisions": [],
        }
        
        # Stage 1: Execute Finance agent
        logger.info("Stage 1: Executing Finance agent")
        finance_result = await self.spawner.spawn_and_execute(
            parent_agent=orchestrator_agent,
            sub_agent_role=AgentRole.FINANCE,
            task_description=f"Analyze financial data for {scenario.company.name}",
            sub_agent_mandate_id=finance_mandate_id,
            scenario=scenario,
        )
        
        workflow_results["stages"]["finance"] = finance_result
        
        # Decision 1: Check financial risk level
        risk_level = finance_result.get("risk_assessment", {}).get("overall_risk_level", "low")
        
        if risk_level in ["high", "critical"]:
            logger.info("Decision: High financial risk detected, spawning Analyst")
            workflow_results["decisions"].append({
                "stage": 1,
                "condition": f"risk_level == {risk_level}",
                "action": "spawn_analyst",
            })
            
            analyst_result = await self.spawner.spawn_and_execute(
                parent_agent=orchestrator_agent,
                sub_agent_role=AgentRole.ANALYST,
                task_description="Perform deep financial analysis",
                sub_agent_mandate_id=analyst_mandate_id,
                scenario=scenario,
                analysis_type="financial",
            )
            
            workflow_results["stages"]["analyst"] = analyst_result
        
        # Decision 2: Check if ops analysis is needed
        # (e.g., if finance mentions operational costs or service issues)
        finance_summary = finance_result.get("summary", "").lower()
        needs_ops_analysis = any(
            keyword in finance_summary
            for keyword in ["service", "operational", "infrastructure", "incident"]
        )
        
        if needs_ops_analysis or scenario.ops_data.incidents:
            logger.info("Decision: Operational analysis needed, spawning Ops agent")
            workflow_results["decisions"].append({
                "stage": 2,
                "condition": "operational_keywords_found or incidents_present",
                "action": "spawn_ops",
            })
            
            ops_result = await self.spawner.spawn_and_execute(
                parent_agent=orchestrator_agent,
                sub_agent_role=AgentRole.OPS,
                task_description=f"Analyze operational data for {scenario.company.name}",
                sub_agent_mandate_id=ops_mandate_id,
                scenario=scenario,
            )
            
            workflow_results["stages"]["ops"] = ops_result
        
        # Stage 3: Generate report with available results
        logger.info("Stage 3: Generating report")
        
        agent_results_for_report = {
            "finance": finance_result,
        }
        
        if "ops" in workflow_results["stages"]:
            agent_results_for_report["ops"] = workflow_results["stages"]["ops"]
        
        if "analyst" in workflow_results["stages"]:
            agent_results_for_report["analyst"] = workflow_results["stages"]["analyst"]
        
        reporter_result = await self.spawner.spawn_and_execute(
            parent_agent=orchestrator_agent,
            sub_agent_role=AgentRole.REPORTER,
            task_description=f"Generate briefing for {scenario.company.name}",
            sub_agent_mandate_id=reporter_mandate_id,
            scenario=scenario,
            report_type="briefing",
            agent_results=agent_results_for_report,
        )
        
        workflow_results["stages"]["reporter"] = reporter_result
        workflow_results["final_report"] = reporter_result.get("report_content", "")
        
        # Generate workflow summary
        workflow_results["summary"] = self._generate_workflow_summary(workflow_results)
        
        logger.info("Conditional workflow completed")
        
        return workflow_results
    
    def _generate_workflow_summary(
        self,
        workflow_results: Dict[str, Any]
    ) -> str:
        """
        Generate a summary of the workflow execution.
        
        Args:
            workflow_results: Results from workflow execution
        
        Returns:
            Summary text
        """
        lines = []
        
        workflow_type = workflow_results.get("workflow_type", "unknown")
        lines.append(f"Workflow Type: {workflow_type}")
        
        # Count stages
        stages = workflow_results.get("stages", {})
        lines.append(f"Stages Executed: {len(stages)}")
        
        # List agents involved
        agent_roles = set()
        for stage_name, stage_result in stages.items():
            if isinstance(stage_result, dict) and "status" in stage_result:
                # Extract agent role from stage name
                if "finance" in stage_name:
                    agent_roles.add("finance")
                if "ops" in stage_name:
                    agent_roles.add("ops")
                if "analyst" in stage_name:
                    agent_roles.add("analyst")
                if "reporter" in stage_name:
                    agent_roles.add("reporter")
        
        lines.append(f"Agents Involved: {', '.join(sorted(agent_roles))}")
        
        # Count decisions (for conditional workflows)
        decisions = workflow_results.get("decisions", [])
        if decisions:
            lines.append(f"Decisions Made: {len(decisions)}")
        
        # Check if report was generated
        if "final_report" in workflow_results:
            lines.append("Final Report: Generated")
        
        return "\n".join(lines)


# Example usage functions

async def example_deep_analysis(
    orchestrator_agent: Any,
    scenario: Scenario,
    caracal_client: Any,
    mandate_ids: Dict[str, str],
) -> Dict[str, Any]:
    """
    Example: Execute a deep analysis workflow.
    
    Args:
        orchestrator_agent: The orchestrator agent
        scenario: Scenario to analyze
        caracal_client: Caracal client
        mandate_ids: Dictionary of mandate IDs for each agent role
    
    Returns:
        Workflow results
    """
    orchestrator = ComplexWorkflowOrchestrator(caracal_client)
    
    return await orchestrator.execute_deep_analysis_workflow(
        orchestrator_agent=orchestrator_agent,
        scenario=scenario,
        finance_mandate_id=mandate_ids["finance"],
        ops_mandate_id=mandate_ids["ops"],
        analyst_mandate_id=mandate_ids["analyst"],
        reporter_mandate_id=mandate_ids["reporter"],
    )


async def example_parallel_analysis(
    orchestrator_agent: Any,
    scenario: Scenario,
    caracal_client: Any,
    mandate_ids: Dict[str, str],
) -> Dict[str, Any]:
    """
    Example: Execute a parallel analysis workflow.
    
    Args:
        orchestrator_agent: The orchestrator agent
        scenario: Scenario to analyze
        caracal_client: Caracal client
        mandate_ids: Dictionary of mandate IDs for each agent role
    
    Returns:
        Workflow results
    """
    orchestrator = ComplexWorkflowOrchestrator(caracal_client)
    
    return await orchestrator.execute_parallel_analysis_workflow(
        orchestrator_agent=orchestrator_agent,
        scenario=scenario,
        finance_mandate_id=mandate_ids["finance"],
        ops_mandate_id=mandate_ids["ops"],
        analyst_mandate_id=mandate_ids["analyst"],
    )


async def example_conditional_workflow(
    orchestrator_agent: Any,
    scenario: Scenario,
    caracal_client: Any,
    mandate_ids: Dict[str, str],
) -> Dict[str, Any]:
    """
    Example: Execute a conditional workflow.
    
    Args:
        orchestrator_agent: The orchestrator agent
        scenario: Scenario to analyze
        caracal_client: Caracal client
        mandate_ids: Dictionary of mandate IDs for each agent role
    
    Returns:
        Workflow results
    """
    orchestrator = ComplexWorkflowOrchestrator(caracal_client)
    
    return await orchestrator.execute_conditional_workflow(
        orchestrator_agent=orchestrator_agent,
        scenario=scenario,
        finance_mandate_id=mandate_ids["finance"],
        ops_mandate_id=mandate_ids["ops"],
        analyst_mandate_id=mandate_ids["analyst"],
        reporter_mandate_id=mandate_ids["reporter"],
    )
