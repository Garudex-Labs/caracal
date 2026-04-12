"""
Analyst agent for deep data analysis and insights generation.

The analyst agent is a sub-agent that specializes in performing detailed
data analysis, statistical computations, trend identification, and generating
actionable insights from raw data.
"""

import logging
from typing import Any, Dict, List, Optional
from statistics import mean, median, stdev

from examples.langchain_demo.agents.base import (
    BaseAgent,
    AgentRole,
    MessageType,
)
from examples.langchain_demo.scenarios.base import Scenario

logger = logging.getLogger(__name__)


class AnalystAgent(BaseAgent):
    """
    Analyst agent specialized in data analysis and insights generation.
    
    The analyst agent:
    1. Performs statistical analysis on financial and operational data
    2. Identifies trends and patterns
    3. Calculates key metrics and KPIs
    4. Generates data-driven insights
    5. Provides analytical recommendations
    
    This is typically spawned as a sub-agent by finance or ops agents
    when deep analysis is required.
    
    # CARACAL INTEGRATION POINT
    # The analyst agent uses its delegated mandate to:
    # - Call analytical tools (data queries, statistical functions, etc.)
    # - Access data sources through Caracal's provider routing
    # - Inherit authority from parent agent's mandate delegation
    """
    
    def __init__(
        self,
        mandate_id: str,
        caracal_client: Any,
        scenario: Optional[Scenario] = None,
        parent_agent: Optional[BaseAgent] = None,
        agent_id: Optional[str] = None,
        context: Optional[Dict[str, Any]] = None,
    ):
        """
        Initialize the analyst agent.
        
        Args:
            mandate_id: Caracal mandate ID for this agent (delegated from parent)
            caracal_client: Caracal client for governed tool calls
            scenario: Optional scenario context
            parent_agent: Parent agent (typically finance or ops agent)
            agent_id: Optional custom agent ID
            context: Optional initial context with analysis parameters
        """
        super().__init__(
            role=AgentRole.ANALYST,
            mandate_id=mandate_id,
            parent_agent=parent_agent,
            agent_id=agent_id,
            context=context,
        )
        
        self.caracal_client = caracal_client
        self.scenario = scenario
        
        logger.info(
            f"Initialized AnalystAgent {self.agent_id[:8]} "
            f"with mandate {mandate_id[:8]} "
            f"(parent: {parent_agent.agent_id[:8] if parent_agent else 'none'})"
        )
    
    async def execute(self, task: str, **kwargs) -> Dict[str, Any]:
        """
        Execute data analysis task.
        
        Args:
            task: Task description
            **kwargs: Additional parameters
                - scenario: Scenario object (overrides self.scenario)
                - analysis_type: Type of analysis ("financial", "operational", "trend")
                - data_source: Which data to analyze ("departments", "invoices", "services", "incidents")
                - metrics: List of specific metrics to calculate
        
        Returns:
            Dictionary containing:
                - status: "success" or "error"
                - analysis_type: Type of analysis performed
                - insights: List of key insights
                - metrics: Calculated metrics
                - trends: Identified trends
                - recommendations: Analytical recommendations
                - raw_data: Raw analysis data
                - messages: All messages from analysis
        """
        self.emit_message(
            MessageType.THOUGHT,
            f"Starting data analysis for task: {task}"
        )
        
        try:
            # Get scenario context
            scenario = kwargs.get("scenario", self.scenario)
            if not scenario:
                raise ValueError("No scenario provided for analysis")
            
            self.state.context["scenario"] = scenario.to_dict()
            
            # Determine analysis type
            analysis_type = kwargs.get("analysis_type", "general")
            data_source = kwargs.get("data_source", "all")
            requested_metrics = kwargs.get("metrics", [])
            
            self.emit_message(
                MessageType.ACTION,
                f"Performing {analysis_type} analysis on {data_source} data"
            )
            
            # Perform analysis based on type
            results = {}
            
            if analysis_type == "financial" or data_source in ["departments", "invoices", "all"]:
                financial_analysis = await self._analyze_financial_data(
                    scenario,
                    requested_metrics
                )
                results["financial"] = financial_analysis
            
            if analysis_type == "operational" or data_source in ["services", "incidents", "all"]:
                operational_analysis = await self._analyze_operational_data(
                    scenario,
                    requested_metrics
                )
                results["operational"] = operational_analysis
            
            if analysis_type == "trend" or "trend" in requested_metrics:
                trend_analysis = await self._analyze_trends(scenario, results)
                results["trends"] = trend_analysis
            
            # Generate insights
            self.emit_message(
                MessageType.THOUGHT,
                "Generating insights from analysis"
            )
            
            insights = self._generate_insights(results, scenario)
            
            # Generate recommendations
            recommendations = self._generate_recommendations(results, insights)
            
            # Calculate summary metrics
            summary_metrics = self._calculate_summary_metrics(results)
            
            self.emit_message(
                MessageType.RESPONSE,
                f"Analysis complete. Generated {len(insights)} insights and "
                f"{len(recommendations)} recommendations"
            )
            
            # Mark as completed
            self.state.mark_completed()
            
            return {
                "status": "success",
                "analysis_type": analysis_type,
                "data_source": data_source,
                "insights": insights,
                "metrics": summary_metrics,
                "trends": results.get("trends", {}),
                "recommendations": recommendations,
                "raw_data": results,
                "messages": [msg.to_dict() for msg in self.get_messages()],
            }
        
        except Exception as e:
            logger.error(f"Data analysis failed: {e}", exc_info=True)
            self.state.mark_error()
            self.emit_message(
                MessageType.ERROR,
                f"Data analysis failed: {str(e)}"
            )
            
            return {
                "status": "error",
                "error": str(e),
                "messages": [msg.to_dict() for msg in self.get_messages()],
            }
    
    async def _analyze_financial_data(
        self,
        scenario: Scenario,
        requested_metrics: List[str]
    ) -> Dict[str, Any]:
        """
        Perform deep financial data analysis.
        
        # CARACAL INTEGRATION POINT
        # In a real implementation, this would call analytical tools through Caracal:
        # result = await self.caracal_client.call_tool(
        #     tool_id="demo:employee:mock:analytics:financial",
        #     mandate_id=self.mandate_id,
        #     tool_args={"metrics": requested_metrics}
        # )
        
        Args:
            scenario: Scenario context
            requested_metrics: List of specific metrics to calculate
        
        Returns:
            Financial analysis results
        """
        finance_data = scenario.finance_data
        
        # Extract budget data
        budgets = [d.budget for d in finance_data.departments]
        spent = [d.spent for d in finance_data.departments]
        variances = [d.variance_percent for d in finance_data.departments]
        
        analysis = {
            "department_count": len(finance_data.departments),
            "budget_statistics": {},
            "spending_statistics": {},
            "variance_statistics": {},
            "invoice_statistics": {},
            "risk_indicators": {},
        }
        
        # Budget statistics
        if budgets:
            analysis["budget_statistics"] = {
                "total": sum(budgets),
                "mean": mean(budgets),
                "median": median(budgets),
                "min": min(budgets),
                "max": max(budgets),
                "std_dev": stdev(budgets) if len(budgets) > 1 else 0.0,
            }
        
        # Spending statistics
        if spent:
            analysis["spending_statistics"] = {
                "total": sum(spent),
                "mean": mean(spent),
                "median": median(spent),
                "min": min(spent),
                "max": max(spent),
                "std_dev": stdev(spent) if len(spent) > 1 else 0.0,
                "utilization_rate": (sum(spent) / sum(budgets) * 100) if sum(budgets) > 0 else 0.0,
            }
        
        # Variance statistics
        if variances:
            analysis["variance_statistics"] = {
                "mean": mean(variances),
                "median": median(variances),
                "min": min(variances),
                "max": max(variances),
                "std_dev": stdev(variances) if len(variances) > 1 else 0.0,
                "over_budget_count": sum(1 for v in variances if v > 0),
                "under_budget_count": sum(1 for v in variances if v < 0),
            }
        
        # Invoice statistics
        if finance_data.pending_invoices:
            invoice_amounts = [inv.amount for inv in finance_data.pending_invoices]
            analysis["invoice_statistics"] = {
                "count": len(finance_data.pending_invoices),
                "total_amount": sum(invoice_amounts),
                "mean_amount": mean(invoice_amounts),
                "median_amount": median(invoice_amounts),
                "largest_amount": max(invoice_amounts),
                "smallest_amount": min(invoice_amounts),
            }
        
        # Risk indicators
        analysis["risk_indicators"] = {
            "high_variance_departments": [
                d.name for d in finance_data.departments
                if abs(d.variance_percent) > 10.0
            ],
            "budget_pressure_score": self._calculate_budget_pressure(finance_data),
            "cash_flow_risk": self._calculate_cash_flow_risk(finance_data),
        }
        
        self.emit_message(
            MessageType.OBSERVATION,
            f"Financial analysis complete: {analysis['department_count']} departments analyzed, "
            f"budget utilization: {analysis['spending_statistics'].get('utilization_rate', 0):.1f}%"
        )
        
        return analysis
    
    async def _analyze_operational_data(
        self,
        scenario: Scenario,
        requested_metrics: List[str]
    ) -> Dict[str, Any]:
        """
        Perform deep operational data analysis.
        
        # CARACAL INTEGRATION POINT
        # In a real implementation, this would call analytical tools through Caracal
        
        Args:
            scenario: Scenario context
            requested_metrics: List of specific metrics to calculate
        
        Returns:
            Operational analysis results
        """
        ops_data = scenario.ops_data
        
        # Extract service data
        uptimes = [s.uptime_percent for s in ops_data.services]
        incidents_24h = [s.incidents_24h for s in ops_data.services]
        
        analysis = {
            "service_count": len(ops_data.services),
            "uptime_statistics": {},
            "incident_statistics": {},
            "service_health_score": 0.0,
            "reliability_indicators": {},
        }
        
        # Uptime statistics
        if uptimes:
            analysis["uptime_statistics"] = {
                "mean": mean(uptimes),
                "median": median(uptimes),
                "min": min(uptimes),
                "max": max(uptimes),
                "std_dev": stdev(uptimes) if len(uptimes) > 1 else 0.0,
                "below_sla_count": sum(1 for u in uptimes if u < 99.0),
            }
        
        # Incident statistics
        if ops_data.incidents:
            severity_counts = {}
            status_counts = {}
            
            for incident in ops_data.incidents:
                severity_counts[incident.severity] = severity_counts.get(incident.severity, 0) + 1
                status_counts[incident.status] = status_counts.get(incident.status, 0) + 1
            
            analysis["incident_statistics"] = {
                "total_count": len(ops_data.incidents),
                "by_severity": severity_counts,
                "by_status": status_counts,
                "critical_count": severity_counts.get("critical", 0),
                "high_count": severity_counts.get("high", 0),
                "unresolved_count": sum(
                    1 for inc in ops_data.incidents
                    if inc.status != "resolved"
                ),
            }
        
        # Service health score (0-100)
        if uptimes:
            health_score = mean(uptimes)
            # Penalize for incidents
            incident_penalty = len(ops_data.incidents) * 2.0
            health_score = max(0.0, health_score - incident_penalty)
            analysis["service_health_score"] = health_score
        
        # Reliability indicators
        analysis["reliability_indicators"] = {
            "high_risk_services": [
                s.name for s in ops_data.services
                if s.uptime_percent < 99.0 or s.incidents_24h > 3
            ],
            "stability_score": self._calculate_stability_score(ops_data),
            "incident_rate": len(ops_data.incidents) / len(ops_data.services) if ops_data.services else 0.0,
        }
        
        self.emit_message(
            MessageType.OBSERVATION,
            f"Operational analysis complete: {analysis['service_count']} services analyzed, "
            f"health score: {analysis['service_health_score']:.1f}"
        )
        
        return analysis
    
    async def _analyze_trends(
        self,
        scenario: Scenario,
        previous_results: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Analyze trends in the data.
        
        Args:
            scenario: Scenario context
            previous_results: Results from previous analyses
        
        Returns:
            Trend analysis results
        """
        trends = {
            "financial_trends": [],
            "operational_trends": [],
            "cross_functional_trends": [],
        }
        
        # Financial trends
        if "financial" in previous_results:
            fin = previous_results["financial"]
            
            if fin.get("variance_statistics", {}).get("mean", 0) > 5.0:
                trends["financial_trends"].append({
                    "type": "budget_variance",
                    "direction": "increasing",
                    "severity": "high",
                    "description": "Budget variances trending upward across departments",
                })
            
            if fin.get("spending_statistics", {}).get("utilization_rate", 0) > 95.0:
                trends["financial_trends"].append({
                    "type": "budget_utilization",
                    "direction": "high",
                    "severity": "medium",
                    "description": "Budget utilization approaching limits",
                })
        
        # Operational trends
        if "operational" in previous_results:
            ops = previous_results["operational"]
            
            if ops.get("uptime_statistics", {}).get("mean", 100) < 99.0:
                trends["operational_trends"].append({
                    "type": "uptime_degradation",
                    "direction": "decreasing",
                    "severity": "high",
                    "description": "Service uptime trending below SLA thresholds",
                })
            
            if ops.get("incident_statistics", {}).get("critical_count", 0) > 0:
                trends["operational_trends"].append({
                    "type": "incident_escalation",
                    "direction": "increasing",
                    "severity": "critical",
                    "description": "Critical incidents requiring immediate attention",
                })
        
        # Cross-functional trends
        if "financial" in previous_results and "operational" in previous_results:
            # Check for correlation between budget issues and operational problems
            budget_pressure = previous_results["financial"].get("risk_indicators", {}).get("budget_pressure_score", 0)
            ops_health = previous_results["operational"].get("service_health_score", 100)
            
            if budget_pressure > 0.7 and ops_health < 95.0:
                trends["cross_functional_trends"].append({
                    "type": "resource_constraint",
                    "correlation": "high",
                    "description": "Budget constraints may be impacting operational performance",
                })
        
        self.emit_message(
            MessageType.OBSERVATION,
            f"Trend analysis complete: identified {len(trends['financial_trends'])} financial trends, "
            f"{len(trends['operational_trends'])} operational trends"
        )
        
        return trends
    
    def _calculate_budget_pressure(self, finance_data) -> float:
        """
        Calculate budget pressure score (0.0 to 1.0).
        
        Args:
            finance_data: Financial data from scenario
        
        Returns:
            Budget pressure score
        """
        if not finance_data.departments:
            return 0.0
        
        # Factors: over-budget count, variance magnitude, invoice burden
        over_budget_ratio = sum(
            1 for d in finance_data.departments if d.status == "over_budget"
        ) / len(finance_data.departments)
        
        avg_variance = mean([abs(d.variance_percent) for d in finance_data.departments])
        variance_factor = min(1.0, avg_variance / 20.0)  # Normalize to 0-1
        
        total_budget = sum(d.budget for d in finance_data.departments)
        total_invoices = sum(inv.amount for inv in finance_data.pending_invoices)
        invoice_factor = min(1.0, total_invoices / total_budget) if total_budget > 0 else 0.0
        
        # Weighted average
        pressure = (over_budget_ratio * 0.4) + (variance_factor * 0.4) + (invoice_factor * 0.2)
        
        return pressure
    
    def _calculate_cash_flow_risk(self, finance_data) -> str:
        """
        Calculate cash flow risk level.
        
        Args:
            finance_data: Financial data from scenario
        
        Returns:
            Risk level: "low", "medium", "high", "critical"
        """
        total_budget = sum(d.budget for d in finance_data.departments)
        total_spent = sum(d.spent for d in finance_data.departments)
        total_invoices = sum(inv.amount for inv in finance_data.pending_invoices)
        
        # Calculate remaining budget vs pending obligations
        remaining = total_budget - total_spent
        coverage_ratio = remaining / total_invoices if total_invoices > 0 else 999.0
        
        if coverage_ratio < 0.5:
            return "critical"
        elif coverage_ratio < 1.0:
            return "high"
        elif coverage_ratio < 2.0:
            return "medium"
        else:
            return "low"
    
    def _calculate_stability_score(self, ops_data) -> float:
        """
        Calculate operational stability score (0.0 to 1.0).
        
        Args:
            ops_data: Operational data from scenario
        
        Returns:
            Stability score
        """
        if not ops_data.services:
            return 1.0
        
        # Factors: uptime, incident count, service status
        avg_uptime = mean([s.uptime_percent for s in ops_data.services]) / 100.0
        
        healthy_ratio = sum(
            1 for s in ops_data.services if s.status == "healthy"
        ) / len(ops_data.services)
        
        # Penalize for incidents
        incident_penalty = min(1.0, len(ops_data.incidents) / (len(ops_data.services) * 5))
        
        # Weighted average
        stability = (avg_uptime * 0.5) + (healthy_ratio * 0.3) + ((1.0 - incident_penalty) * 0.2)
        
        return stability
    
    def _generate_insights(
        self,
        results: Dict[str, Any],
        scenario: Scenario
    ) -> List[Dict[str, Any]]:
        """
        Generate actionable insights from analysis results.
        
        Args:
            results: Analysis results
            scenario: Scenario context
        
        Returns:
            List of insights
        """
        insights = []
        
        # Financial insights
        if "financial" in results:
            fin = results["financial"]
            
            # Budget utilization insight
            utilization = fin.get("spending_statistics", {}).get("utilization_rate", 0)
            if utilization > 90.0:
                insights.append({
                    "category": "financial",
                    "type": "budget_utilization",
                    "severity": "high" if utilization > 95.0 else "medium",
                    "title": "High Budget Utilization",
                    "description": f"Budget utilization at {utilization:.1f}% - approaching limits",
                    "impact": "May require budget reallocation or spending controls",
                })
            
            # Variance insight
            variance_mean = fin.get("variance_statistics", {}).get("mean", 0)
            if abs(variance_mean) > 5.0:
                insights.append({
                    "category": "financial",
                    "type": "budget_variance",
                    "severity": "high" if abs(variance_mean) > 10.0 else "medium",
                    "title": "Significant Budget Variance",
                    "description": f"Average variance of {variance_mean:.1f}% across departments",
                    "impact": "Indicates forecasting issues or unexpected spending",
                })
            
            # Cash flow insight
            cash_flow_risk = fin.get("risk_indicators", {}).get("cash_flow_risk", "low")
            if cash_flow_risk in ["high", "critical"]:
                insights.append({
                    "category": "financial",
                    "type": "cash_flow",
                    "severity": cash_flow_risk,
                    "title": "Cash Flow Risk",
                    "description": f"Cash flow risk level: {cash_flow_risk}",
                    "impact": "May affect ability to meet payment obligations",
                })
        
        # Operational insights
        if "operational" in results:
            ops = results["operational"]
            
            # Service health insight
            health_score = ops.get("service_health_score", 100)
            if health_score < 95.0:
                insights.append({
                    "category": "operational",
                    "type": "service_health",
                    "severity": "high" if health_score < 90.0 else "medium",
                    "title": "Degraded Service Health",
                    "description": f"Overall service health score: {health_score:.1f}/100",
                    "impact": "May affect customer experience and SLA compliance",
                })
            
            # Incident insight
            critical_count = ops.get("incident_statistics", {}).get("critical_count", 0)
            if critical_count > 0:
                insights.append({
                    "category": "operational",
                    "type": "incidents",
                    "severity": "critical",
                    "title": "Critical Incidents Active",
                    "description": f"{critical_count} critical incident(s) requiring immediate attention",
                    "impact": "Service disruption and potential revenue loss",
                })
        
        # Trend insights
        if "trends" in results:
            for trend_category in results["trends"].values():
                for trend in trend_category:
                    if trend.get("severity") in ["high", "critical"]:
                        insights.append({
                            "category": "trend",
                            "type": trend.get("type", "unknown"),
                            "severity": trend.get("severity", "medium"),
                            "title": f"Trend: {trend.get('type', 'Unknown').replace('_', ' ').title()}",
                            "description": trend.get("description", ""),
                            "impact": "Requires monitoring and potential intervention",
                        })
        
        return insights
    
    def _generate_recommendations(
        self,
        results: Dict[str, Any],
        insights: List[Dict[str, Any]]
    ) -> List[str]:
        """
        Generate analytical recommendations.
        
        Args:
            results: Analysis results
            insights: Generated insights
        
        Returns:
            List of recommendations
        """
        recommendations = []
        
        # Generate recommendations based on insights
        for insight in insights:
            if insight["severity"] in ["high", "critical"]:
                if insight["type"] == "budget_utilization":
                    recommendations.append(
                        "Implement immediate spending controls to prevent budget overruns"
                    )
                elif insight["type"] == "budget_variance":
                    recommendations.append(
                        "Review budget forecasting methodology and adjust for accuracy"
                    )
                elif insight["type"] == "cash_flow":
                    recommendations.append(
                        "Prioritize invoice payments and explore short-term financing options"
                    )
                elif insight["type"] == "service_health":
                    recommendations.append(
                        "Allocate additional resources to restore service health"
                    )
                elif insight["type"] == "incidents":
                    recommendations.append(
                        "Activate incident response team for critical issues"
                    )
        
        # Add general analytical recommendations
        if "financial" in results and "operational" in results:
            recommendations.append(
                "Conduct cross-functional review to identify resource optimization opportunities"
            )
        
        return recommendations
    
    def _calculate_summary_metrics(self, results: Dict[str, Any]) -> Dict[str, Any]:
        """
        Calculate summary metrics from all analyses.
        
        Args:
            results: All analysis results
        
        Returns:
            Summary metrics
        """
        summary = {}
        
        if "financial" in results:
            fin = results["financial"]
            summary["financial"] = {
                "budget_utilization": fin.get("spending_statistics", {}).get("utilization_rate", 0),
                "average_variance": fin.get("variance_statistics", {}).get("mean", 0),
                "budget_pressure_score": fin.get("risk_indicators", {}).get("budget_pressure_score", 0),
            }
        
        if "operational" in results:
            ops = results["operational"]
            summary["operational"] = {
                "service_health_score": ops.get("service_health_score", 100),
                "average_uptime": ops.get("uptime_statistics", {}).get("mean", 100),
                "stability_score": ops.get("reliability_indicators", {}).get("stability_score", 1.0),
            }
        
        return summary
