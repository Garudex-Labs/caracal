"""
Sub-agent result aggregation for multi-agent workflows.

This module provides functionality for aggregating, merging, and synthesizing
results from multiple sub-agents into cohesive outputs.
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Callable
from statistics import mean, median

from examples.langchain_demo.agents.base import AgentRole

logger = logging.getLogger(__name__)


@dataclass
class AgentResult:
    """
    Result from a single agent execution.
    
    Attributes:
        agent_id: ID of the agent that produced this result
        agent_role: Role of the agent
        status: Status of the execution (success, error, timeout)
        result_data: The actual result data
        error: Error message if status is error
        started_at: When execution started
        completed_at: When execution completed
        duration_ms: Duration of execution in milliseconds
        metadata: Additional metadata about the result
    """
    
    agent_id: str
    agent_role: AgentRole
    status: str
    result_data: Dict[str, Any]
    error: Optional[str] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    duration_ms: Optional[int] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert agent result to dictionary."""
        return {
            "agent_id": self.agent_id,
            "agent_role": self.agent_role.value,
            "status": self.status,
            "result_data": self.result_data,
            "error": self.error,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "duration_ms": self.duration_ms,
            "metadata": self.metadata,
        }


@dataclass
class AggregatedResult:
    """
    Aggregated result from multiple agents.
    
    Attributes:
        aggregation_id: Unique identifier for this aggregation
        agent_results: List of individual agent results
        aggregated_data: The aggregated/merged data
        summary: Summary of the aggregation
        statistics: Statistics about the aggregation
        created_at: When the aggregation was created
        metadata: Additional metadata about the aggregation
    """
    
    aggregation_id: str
    agent_results: List[AgentResult]
    aggregated_data: Dict[str, Any]
    summary: str
    statistics: Dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=datetime.utcnow)
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert aggregated result to dictionary."""
        return {
            "aggregation_id": self.aggregation_id,
            "agent_results": [r.to_dict() for r in self.agent_results],
            "aggregated_data": self.aggregated_data,
            "summary": self.summary,
            "statistics": self.statistics,
            "created_at": self.created_at.isoformat(),
            "metadata": self.metadata,
        }


class ResultAggregator:
    """
    Aggregator for combining results from multiple sub-agents.
    
    This class provides various strategies for aggregating results:
    1. Simple merge: Combine all results into a single dictionary
    2. Weighted merge: Combine results with weights based on agent role/priority
    3. Consensus: Find consensus among agent results
    4. Statistical: Compute statistics across numeric results
    5. Custom: Use custom aggregation functions
    """
    
    def __init__(self):
        """Initialize the result aggregator."""
        self.aggregation_strategies: Dict[str, Callable] = {
            "merge": self._merge_strategy,
            "weighted": self._weighted_strategy,
            "consensus": self._consensus_strategy,
            "statistical": self._statistical_strategy,
        }
        
        logger.debug("Initialized ResultAggregator")
    
    def aggregate(
        self,
        agent_results: List[AgentResult],
        strategy: str = "merge",
        weights: Optional[Dict[AgentRole, float]] = None,
        custom_aggregator: Optional[Callable] = None,
    ) -> AggregatedResult:
        """
        Aggregate results from multiple agents.
        
        Args:
            agent_results: List of results from different agents
            strategy: Aggregation strategy ("merge", "weighted", "consensus", "statistical")
            weights: Optional weights for weighted aggregation (by agent role)
            custom_aggregator: Optional custom aggregation function
        
        Returns:
            AggregatedResult containing the aggregated data
        
        Raises:
            ValueError: If strategy is unknown and no custom_aggregator provided
        """
        logger.info(
            f"Aggregating results from {len(agent_results)} agent(s) "
            f"using strategy: {strategy}"
        )
        
        # Filter out failed results
        successful_results = [
            r for r in agent_results if r.status == "success"
        ]
        
        if not successful_results:
            logger.warning("No successful results to aggregate")
            return AggregatedResult(
                aggregation_id=str(datetime.utcnow().timestamp()),
                agent_results=agent_results,
                aggregated_data={},
                summary="No successful results to aggregate",
                statistics=self._compute_statistics(agent_results),
            )
        
        # Use custom aggregator if provided
        if custom_aggregator:
            aggregated_data = custom_aggregator(successful_results)
        else:
            # Use built-in strategy
            aggregation_func = self.aggregation_strategies.get(strategy)
            if not aggregation_func:
                raise ValueError(
                    f"Unknown aggregation strategy: {strategy}. "
                    f"Available: {list(self.aggregation_strategies.keys())}"
                )
            
            aggregated_data = aggregation_func(successful_results, weights)
        
        # Generate summary
        summary = self._generate_summary(successful_results, aggregated_data)
        
        # Compute statistics
        statistics = self._compute_statistics(agent_results)
        
        result = AggregatedResult(
            aggregation_id=str(datetime.utcnow().timestamp()),
            agent_results=agent_results,
            aggregated_data=aggregated_data,
            summary=summary,
            statistics=statistics,
        )
        
        logger.info(
            f"Aggregation complete: {len(successful_results)} successful results"
        )
        
        return result
    
    def _merge_strategy(
        self,
        results: List[AgentResult],
        weights: Optional[Dict[AgentRole, float]] = None
    ) -> Dict[str, Any]:
        """
        Simple merge strategy: combine all results into a single dictionary.
        
        Args:
            results: List of agent results
            weights: Unused for this strategy
        
        Returns:
            Merged data dictionary
        """
        merged = {}
        
        for result in results:
            role_key = result.agent_role.value
            merged[role_key] = result.result_data
        
        return merged
    
    def _weighted_strategy(
        self,
        results: List[AgentResult],
        weights: Optional[Dict[AgentRole, float]] = None
    ) -> Dict[str, Any]:
        """
        Weighted merge strategy: combine results with weights.
        
        This is useful when certain agents' results should have more influence.
        
        Args:
            results: List of agent results
            weights: Weights for each agent role (default: equal weights)
        
        Returns:
            Weighted merged data dictionary
        """
        if not weights:
            # Default: equal weights
            weights = {result.agent_role: 1.0 for result in results}
        
        weighted_data = {}
        
        # Collect all keys across all results
        all_keys = set()
        for result in results:
            all_keys.update(result.result_data.keys())
        
        # For each key, compute weighted average if numeric
        for key in all_keys:
            values = []
            result_weights = []
            
            for result in results:
                if key in result.result_data:
                    value = result.result_data[key]
                    weight = weights.get(result.agent_role, 1.0)
                    
                    # Handle numeric values
                    if isinstance(value, (int, float)):
                        values.append(value)
                        result_weights.append(weight)
            
            if values:
                # Compute weighted average
                total_weight = sum(result_weights)
                weighted_avg = sum(v * w for v, w in zip(values, result_weights)) / total_weight
                weighted_data[key] = weighted_avg
            else:
                # For non-numeric, just collect all values
                weighted_data[key] = [
                    result.result_data.get(key)
                    for result in results
                    if key in result.result_data
                ]
        
        # Also include individual results
        weighted_data["individual_results"] = {
            result.agent_role.value: result.result_data
            for result in results
        }
        
        return weighted_data
    
    def _consensus_strategy(
        self,
        results: List[AgentResult],
        weights: Optional[Dict[AgentRole, float]] = None
    ) -> Dict[str, Any]:
        """
        Consensus strategy: find consensus among agent results.
        
        This identifies common findings and recommendations across agents.
        
        Args:
            results: List of agent results
            weights: Unused for this strategy
        
        Returns:
            Consensus data dictionary
        """
        consensus = {
            "common_findings": [],
            "common_recommendations": [],
            "agreements": [],
            "disagreements": [],
            "individual_results": {},
        }
        
        # Collect findings and recommendations
        all_findings = []
        all_recommendations = []
        
        for result in results:
            role = result.agent_role.value
            data = result.result_data
            
            consensus["individual_results"][role] = data
            
            # Extract findings
            findings = data.get("key_findings", []) or data.get("findings", [])
            all_findings.extend([(role, f) for f in findings])
            
            # Extract recommendations
            recommendations = data.get("recommendations", [])
            all_recommendations.extend([(role, r) for r in recommendations])
        
        # Find common findings (mentioned by multiple agents)
        finding_counts = {}
        for role, finding in all_findings:
            # Normalize finding text for comparison
            normalized = finding.lower().strip()
            if normalized not in finding_counts:
                finding_counts[normalized] = {"text": finding, "agents": []}
            finding_counts[normalized]["agents"].append(role)
        
        # Findings mentioned by 2+ agents are common
        for normalized, info in finding_counts.items():
            if len(info["agents"]) >= 2:
                consensus["common_findings"].append({
                    "finding": info["text"],
                    "mentioned_by": info["agents"],
                    "count": len(info["agents"]),
                })
        
        # Find common recommendations
        rec_counts = {}
        for role, rec in all_recommendations:
            normalized = rec.lower().strip()
            if normalized not in rec_counts:
                rec_counts[normalized] = {"text": rec, "agents": []}
            rec_counts[normalized]["agents"].append(role)
        
        for normalized, info in rec_counts.items():
            if len(info["agents"]) >= 2:
                consensus["common_recommendations"].append({
                    "recommendation": info["text"],
                    "mentioned_by": info["agents"],
                    "count": len(info["agents"]),
                })
        
        # Identify agreements (similar conclusions)
        if len(results) >= 2:
            # Check if all agents have similar status assessments
            statuses = [
                r.result_data.get("status") or r.result_data.get("summary", "")
                for r in results
            ]
            if len(set(statuses)) == 1:
                consensus["agreements"].append({
                    "type": "status",
                    "value": statuses[0],
                    "agents": [r.agent_role.value for r in results],
                })
        
        return consensus
    
    def _statistical_strategy(
        self,
        results: List[AgentResult],
        weights: Optional[Dict[AgentRole, float]] = None
    ) -> Dict[str, Any]:
        """
        Statistical strategy: compute statistics across numeric results.
        
        Args:
            results: List of agent results
            weights: Unused for this strategy
        
        Returns:
            Statistical data dictionary
        """
        stats = {
            "agent_count": len(results),
            "metrics": {},
            "individual_results": {},
        }
        
        # Collect all numeric metrics
        all_metrics = {}
        
        for result in results:
            role = result.agent_role.value
            data = result.result_data
            
            stats["individual_results"][role] = data
            
            # Extract numeric metrics
            metrics = data.get("metrics", {})
            for key, value in metrics.items():
                if isinstance(value, (int, float)):
                    if key not in all_metrics:
                        all_metrics[key] = []
                    all_metrics[key].append(value)
                elif isinstance(value, dict):
                    # Handle nested metrics
                    for subkey, subvalue in value.items():
                        if isinstance(subvalue, (int, float)):
                            full_key = f"{key}.{subkey}"
                            if full_key not in all_metrics:
                                all_metrics[full_key] = []
                            all_metrics[full_key].append(subvalue)
        
        # Compute statistics for each metric
        for metric_name, values in all_metrics.items():
            if len(values) > 0:
                stats["metrics"][metric_name] = {
                    "mean": mean(values),
                    "median": median(values),
                    "min": min(values),
                    "max": max(values),
                    "count": len(values),
                }
                
                if len(values) > 1:
                    from statistics import stdev
                    stats["metrics"][metric_name]["std_dev"] = stdev(values)
        
        return stats
    
    def _generate_summary(
        self,
        results: List[AgentResult],
        aggregated_data: Dict[str, Any]
    ) -> str:
        """
        Generate a summary of the aggregation.
        
        Args:
            results: List of agent results
            aggregated_data: The aggregated data
        
        Returns:
            Summary text
        """
        lines = []
        
        lines.append(f"Aggregated results from {len(results)} agent(s):")
        
        # List agents
        agent_roles = [r.agent_role.value for r in results]
        lines.append(f"- Agents: {', '.join(agent_roles)}")
        
        # Execution time
        durations = [r.duration_ms for r in results if r.duration_ms]
        if durations:
            total_duration = sum(durations)
            lines.append(f"- Total execution time: {total_duration}ms")
        
        # Key data points
        if "common_findings" in aggregated_data:
            common_count = len(aggregated_data["common_findings"])
            lines.append(f"- Common findings: {common_count}")
        
        if "common_recommendations" in aggregated_data:
            common_rec_count = len(aggregated_data["common_recommendations"])
            lines.append(f"- Common recommendations: {common_rec_count}")
        
        if "metrics" in aggregated_data:
            metric_count = len(aggregated_data["metrics"])
            lines.append(f"- Aggregated metrics: {metric_count}")
        
        return "\n".join(lines)
    
    def _compute_statistics(
        self,
        results: List[AgentResult]
    ) -> Dict[str, Any]:
        """
        Compute statistics about the results.
        
        Args:
            results: List of agent results
        
        Returns:
            Statistics dictionary
        """
        stats = {
            "total_agents": len(results),
            "successful": 0,
            "failed": 0,
            "by_role": {},
            "execution_times": {},
        }
        
        for result in results:
            # Count by status
            if result.status == "success":
                stats["successful"] += 1
            else:
                stats["failed"] += 1
            
            # Count by role
            role = result.agent_role.value
            if role not in stats["by_role"]:
                stats["by_role"][role] = {"count": 0, "successful": 0, "failed": 0}
            
            stats["by_role"][role]["count"] += 1
            if result.status == "success":
                stats["by_role"][role]["successful"] += 1
            else:
                stats["by_role"][role]["failed"] += 1
            
            # Track execution times
            if result.duration_ms:
                if role not in stats["execution_times"]:
                    stats["execution_times"][role] = []
                stats["execution_times"][role].append(result.duration_ms)
        
        # Compute average execution times
        for role, times in stats["execution_times"].items():
            if times:
                stats["execution_times"][role] = {
                    "mean": mean(times),
                    "min": min(times),
                    "max": max(times),
                }
        
        return stats
    
    def register_strategy(
        self,
        name: str,
        strategy_func: Callable[[List[AgentResult], Optional[Dict[AgentRole, float]]], Dict[str, Any]]
    ) -> None:
        """
        Register a custom aggregation strategy.
        
        Args:
            name: Name of the strategy
            strategy_func: Function that takes (results, weights) and returns aggregated data
        """
        self.aggregation_strategies[name] = strategy_func
        logger.debug(f"Registered custom aggregation strategy: {name}")
    
    def __repr__(self) -> str:
        """String representation of the aggregator."""
        return (
            f"<ResultAggregator "
            f"strategies={list(self.aggregation_strategies.keys())}>"
        )


# Convenience functions for common aggregation patterns

def aggregate_finance_and_ops(
    finance_result: Dict[str, Any],
    ops_result: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Aggregate finance and ops results into a unified view.
    
    Args:
        finance_result: Result from finance agent
        ops_result: Result from ops agent
    
    Returns:
        Aggregated data
    """
    aggregated = {
        "finance": finance_result,
        "ops": ops_result,
        "cross_functional_insights": [],
    }
    
    # Identify cross-functional issues
    finance_risk = finance_result.get("risk_assessment", {}).get("overall_risk_level", "low")
    ops_health = ops_result.get("service_analysis", {}).get("average_uptime", 100)
    
    if finance_risk in ["high", "critical"] and ops_health < 95.0:
        aggregated["cross_functional_insights"].append({
            "type": "resource_constraint",
            "description": "Budget constraints may be impacting operational performance",
            "severity": "high",
        })
    
    # Combine recommendations
    all_recommendations = []
    all_recommendations.extend(finance_result.get("recommendations", []))
    all_recommendations.extend(ops_result.get("recommendations", []))
    aggregated["combined_recommendations"] = list(dict.fromkeys(all_recommendations))
    
    return aggregated


def aggregate_with_analyst(
    primary_results: Dict[str, Any],
    analyst_result: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Aggregate primary agent results with analyst insights.
    
    Args:
        primary_results: Results from primary agents (finance, ops, etc.)
        analyst_result: Result from analyst agent
    
    Returns:
        Aggregated data with analytical insights
    """
    aggregated = {
        "primary_results": primary_results,
        "analytical_insights": analyst_result.get("insights", []),
        "metrics": analyst_result.get("metrics", {}),
        "trends": analyst_result.get("trends", {}),
        "enhanced_recommendations": [],
    }
    
    # Enhance recommendations with analytical insights
    primary_recommendations = []
    for key, value in primary_results.items():
        if isinstance(value, dict):
            primary_recommendations.extend(value.get("recommendations", []))
    
    analyst_recommendations = analyst_result.get("recommendations", [])
    
    # Combine and deduplicate
    all_recommendations = primary_recommendations + analyst_recommendations
    aggregated["enhanced_recommendations"] = list(dict.fromkeys(all_recommendations))
    
    return aggregated
