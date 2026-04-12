"""
Reporter agent for generating comprehensive reports and summaries.

The reporter agent is a sub-agent that specializes in aggregating results
from multiple agents, formatting data, and generating executive-level reports
and briefings.
"""

import logging
from typing import Any, Dict, List, Optional
from datetime import datetime

from examples.langchain_demo.agents.base import (
    BaseAgent,
    AgentRole,
    MessageType,
)
from examples.langchain_demo.scenarios.base import Scenario

logger = logging.getLogger(__name__)


class ReporterAgent(BaseAgent):
    """
    Reporter agent specialized in report generation and summarization.
    
    The reporter agent:
    1. Aggregates results from multiple agents
    2. Formats data into readable reports
    3. Generates executive summaries
    4. Creates visualizations and charts (text-based)
    5. Produces briefing documents
    
    This is typically spawned as a sub-agent by the orchestrator
    to consolidate findings from finance, ops, and analyst agents.
    
    # CARACAL INTEGRATION POINT
    # The reporter agent uses its delegated mandate to:
    # - Call reporting tools (document generation, formatting, etc.)
    # - Access report templates through Caracal's provider routing
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
        Initialize the reporter agent.
        
        Args:
            mandate_id: Caracal mandate ID for this agent (delegated from parent)
            caracal_client: Caracal client for governed tool calls
            scenario: Optional scenario context
            parent_agent: Parent agent (typically orchestrator)
            agent_id: Optional custom agent ID
            context: Optional initial context with report parameters
        """
        super().__init__(
            role=AgentRole.REPORTER,
            mandate_id=mandate_id,
            parent_agent=parent_agent,
            agent_id=agent_id,
            context=context,
        )
        
        self.caracal_client = caracal_client
        self.scenario = scenario
        
        logger.info(
            f"Initialized ReporterAgent {self.agent_id[:8]} "
            f"with mandate {mandate_id[:8]} "
            f"(parent: {parent_agent.agent_id[:8] if parent_agent else 'none'})"
        )
    
    async def execute(self, task: str, **kwargs) -> Dict[str, Any]:
        """
        Execute report generation task.
        
        Args:
            task: Task description
            **kwargs: Additional parameters
                - scenario: Scenario object (overrides self.scenario)
                - report_type: Type of report ("executive", "detailed", "briefing")
                - agent_results: Dictionary of results from other agents
                - format: Output format ("markdown", "text", "json")
        
        Returns:
            Dictionary containing:
                - status: "success" or "error"
                - report_type: Type of report generated
                - report_content: The generated report
                - executive_summary: Executive summary
                - key_highlights: List of key highlights
                - sections: Dictionary of report sections
                - metadata: Report metadata
                - messages: All messages from generation
        """
        self.emit_message(
            MessageType.THOUGHT,
            f"Starting report generation for task: {task}"
        )
        
        try:
            # Get scenario context
            scenario = kwargs.get("scenario", self.scenario)
            if not scenario:
                raise ValueError("No scenario provided for report generation")
            
            self.state.context["scenario"] = scenario.to_dict()
            
            # Get parameters
            report_type = kwargs.get("report_type", "executive")
            agent_results = kwargs.get("agent_results", {})
            output_format = kwargs.get("format", "markdown")
            
            self.emit_message(
                MessageType.ACTION,
                f"Generating {report_type} report in {output_format} format"
            )
            
            # Aggregate data from agent results
            self.emit_message(
                MessageType.THOUGHT,
                f"Aggregating data from {len(agent_results)} agent result(s)"
            )
            
            aggregated_data = self._aggregate_agent_results(agent_results)
            
            # Generate report sections
            sections = {}
            
            if report_type in ["executive", "detailed"]:
                sections["header"] = self._generate_header(scenario)
                sections["executive_summary"] = self._generate_executive_summary(
                    aggregated_data, scenario
                )
                sections["key_highlights"] = self._generate_key_highlights(aggregated_data)
            
            if report_type in ["detailed", "briefing"]:
                if "finance" in aggregated_data:
                    sections["financial_analysis"] = self._generate_financial_section(
                        aggregated_data["finance"]
                    )
                
                if "ops" in aggregated_data:
                    sections["operational_analysis"] = self._generate_operational_section(
                        aggregated_data["ops"]
                    )
                
                if "analyst" in aggregated_data:
                    sections["analytical_insights"] = self._generate_analytical_section(
                        aggregated_data["analyst"]
                    )
            
            if report_type in ["executive", "detailed", "briefing"]:
                sections["recommendations"] = self._generate_recommendations_section(
                    aggregated_data
                )
                sections["next_steps"] = self._generate_next_steps(aggregated_data, scenario)
            
            # Format the report
            self.emit_message(
                MessageType.ACTION,
                "Formatting report"
            )
            
            report_content = self._format_report(sections, output_format)
            
            # Generate metadata
            metadata = {
                "generated_at": datetime.utcnow().isoformat(),
                "report_type": report_type,
                "format": output_format,
                "scenario_id": scenario.scenario_id,
                "scenario_name": scenario.name,
                "agent_count": len(agent_results),
                "section_count": len(sections),
            }
            
            self.emit_message(
                MessageType.RESPONSE,
                f"Report generation complete. Generated {len(sections)} sections"
            )
            
            # Mark as completed
            self.state.mark_completed()
            
            return {
                "status": "success",
                "report_type": report_type,
                "report_content": report_content,
                "executive_summary": sections.get("executive_summary", ""),
                "key_highlights": sections.get("key_highlights", []),
                "sections": sections,
                "metadata": metadata,
                "messages": [msg.to_dict() for msg in self.get_messages()],
            }
        
        except Exception as e:
            logger.error(f"Report generation failed: {e}", exc_info=True)
            self.state.mark_error()
            self.emit_message(
                MessageType.ERROR,
                f"Report generation failed: {str(e)}"
            )
            
            return {
                "status": "error",
                "error": str(e),
                "messages": [msg.to_dict() for msg in self.get_messages()],
            }
    
    def _aggregate_agent_results(
        self,
        agent_results: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Aggregate results from multiple agents.
        
        Args:
            agent_results: Dictionary of results from different agents
                Expected keys: "finance", "ops", "analyst", etc.
        
        Returns:
            Aggregated data structure
        """
        aggregated = {}
        
        # Process finance results
        if "finance" in agent_results:
            finance_data = agent_results["finance"]
            aggregated["finance"] = {
                "summary": finance_data.get("summary", ""),
                "key_findings": finance_data.get("key_findings", []),
                "recommendations": finance_data.get("recommendations", []),
                "budget_analysis": finance_data.get("budget_analysis", {}),
                "invoice_analysis": finance_data.get("invoice_analysis", {}),
                "risk_assessment": finance_data.get("risk_assessment", {}),
            }
        
        # Process ops results
        if "ops" in agent_results:
            ops_data = agent_results["ops"]
            aggregated["ops"] = {
                "summary": ops_data.get("summary", ""),
                "key_findings": ops_data.get("key_findings", []),
                "recommendations": ops_data.get("recommendations", []),
                "service_analysis": ops_data.get("service_analysis", {}),
                "incident_analysis": ops_data.get("incident_analysis", {}),
                "sla_analysis": ops_data.get("sla_analysis", {}),
            }
        
        # Process analyst results
        if "analyst" in agent_results:
            analyst_data = agent_results["analyst"]
            aggregated["analyst"] = {
                "insights": analyst_data.get("insights", []),
                "metrics": analyst_data.get("metrics", {}),
                "trends": analyst_data.get("trends", {}),
                "recommendations": analyst_data.get("recommendations", []),
            }
        
        self.emit_message(
            MessageType.OBSERVATION,
            f"Aggregated data from {len(aggregated)} agent(s)"
        )
        
        return aggregated
    
    def _generate_header(self, scenario: Scenario) -> str:
        """
        Generate report header.
        
        Args:
            scenario: Scenario context
        
        Returns:
            Header text
        """
        lines = []
        lines.append("=" * 80)
        lines.append(f"EXECUTIVE BRIEFING: {scenario.name}")
        lines.append("=" * 80)
        lines.append(f"Company: {scenario.company.name}")
        lines.append(f"Industry: {scenario.company.industry}")
        lines.append(f"Period: {scenario.context.quarter} {scenario.context.month} {scenario.company.fiscal_year}")
        lines.append(f"Trigger: {scenario.context.trigger_event}")
        lines.append(f"Generated: {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}")
        lines.append("=" * 80)
        lines.append("")
        
        return "\n".join(lines)
    
    def _generate_executive_summary(
        self,
        aggregated_data: Dict[str, Any],
        scenario: Scenario
    ) -> str:
        """
        Generate executive summary.
        
        Args:
            aggregated_data: Aggregated results from agents
            scenario: Scenario context
        
        Returns:
            Executive summary text
        """
        lines = []
        lines.append("## EXECUTIVE SUMMARY")
        lines.append("")
        
        # Overall situation
        lines.append(f"This briefing addresses {scenario.context.trigger_event.lower()} ")
        lines.append(f"for {scenario.company.name} during {scenario.context.quarter} {scenario.context.month}.")
        lines.append("")
        
        # Financial summary
        if "finance" in aggregated_data:
            finance = aggregated_data["finance"]
            if finance.get("key_findings"):
                lines.append("**Financial Status:**")
                for finding in finance["key_findings"][:3]:  # Top 3
                    lines.append(f"- {finding}")
                lines.append("")
        
        # Operational summary
        if "ops" in aggregated_data:
            ops = aggregated_data["ops"]
            if ops.get("key_findings"):
                lines.append("**Operational Status:**")
                for finding in ops["key_findings"][:3]:  # Top 3
                    lines.append(f"- {finding}")
                lines.append("")
        
        # Overall assessment
        lines.append("**Overall Assessment:**")
        lines.append(scenario.expected_outcomes.executive_summary)
        lines.append("")
        
        return "\n".join(lines)
    
    def _generate_key_highlights(
        self,
        aggregated_data: Dict[str, Any]
    ) -> List[str]:
        """
        Generate key highlights from all data.
        
        Args:
            aggregated_data: Aggregated results from agents
        
        Returns:
            List of key highlights
        """
        highlights = []
        
        # Financial highlights
        if "finance" in aggregated_data:
            finance = aggregated_data["finance"]
            
            # Budget highlights
            budget_analysis = finance.get("budget_analysis", {})
            if budget_analysis.get("over_budget_count", 0) > 0:
                highlights.append(
                    f"🔴 {budget_analysis['over_budget_count']} department(s) over budget"
                )
            
            # Risk highlights
            risk_assessment = finance.get("risk_assessment", {})
            if risk_assessment.get("overall_risk_level") in ["high", "critical"]:
                highlights.append(
                    f"⚠️  Financial risk level: {risk_assessment['overall_risk_level'].upper()}"
                )
        
        # Operational highlights
        if "ops" in aggregated_data:
            ops = aggregated_data["ops"]
            
            # Service highlights
            service_analysis = ops.get("service_analysis", {})
            if service_analysis.get("degraded_count", 0) > 0 or service_analysis.get("down_count", 0) > 0:
                highlights.append(
                    f"🔴 {service_analysis.get('degraded_count', 0)} degraded, "
                    f"{service_analysis.get('down_count', 0)} down service(s)"
                )
            
            # Incident highlights
            incident_analysis = ops.get("incident_analysis", {})
            if incident_analysis.get("critical_count", 0) > 0:
                highlights.append(
                    f"🚨 {incident_analysis['critical_count']} critical incident(s) active"
                )
            
            # SLA highlights
            sla_analysis = ops.get("sla_analysis", {})
            if not sla_analysis.get("overall_compliance", True):
                highlights.append("⚠️  SLA non-compliant")
        
        # Analytical highlights
        if "analyst" in aggregated_data:
            analyst = aggregated_data["analyst"]
            
            # High-severity insights
            for insight in analyst.get("insights", []):
                if insight.get("severity") in ["high", "critical"]:
                    highlights.append(f"📊 {insight.get('title', 'Insight')}")
        
        return highlights
    
    def _generate_financial_section(
        self,
        finance_data: Dict[str, Any]
    ) -> str:
        """
        Generate detailed financial analysis section.
        
        Args:
            finance_data: Financial data from finance agent
        
        Returns:
            Financial section text
        """
        lines = []
        lines.append("## FINANCIAL ANALYSIS")
        lines.append("")
        
        # Budget analysis
        budget_analysis = finance_data.get("budget_analysis", {})
        if budget_analysis:
            lines.append("### Budget Status")
            lines.append(f"- Total Departments: {budget_analysis.get('total_departments', 0)}")
            lines.append(f"- Over Budget: {budget_analysis.get('over_budget_count', 0)}")
            lines.append(f"- On Budget: {budget_analysis.get('on_budget_count', 0)}")
            lines.append(f"- Under Budget: {budget_analysis.get('under_budget_count', 0)}")
            
            if budget_analysis.get("highest_variance_dept"):
                lines.append(f"- Highest Variance: {budget_analysis['highest_variance_dept']} "
                           f"({budget_analysis.get('highest_variance_percent', 0):.1f}%)")
            lines.append("")
        
        # Invoice analysis
        invoice_analysis = finance_data.get("invoice_analysis", {})
        if invoice_analysis:
            lines.append("### Pending Invoices")
            lines.append(f"- Total Count: {invoice_analysis.get('total_invoices', 0)}")
            lines.append(f"- Total Amount: ${invoice_analysis.get('total_amount', 0):,.2f}")
            
            if invoice_analysis.get("largest_invoice"):
                lines.append(f"- Largest Invoice: {invoice_analysis['largest_invoice']} "
                           f"(${invoice_analysis.get('largest_amount', 0):,.2f})")
            lines.append("")
        
        # Risk assessment
        risk_assessment = finance_data.get("risk_assessment", {})
        if risk_assessment:
            lines.append("### Risk Assessment")
            lines.append(f"- Overall Risk Level: {risk_assessment.get('overall_risk_level', 'unknown').upper()}")
            lines.append(f"- Identified Risks: {risk_assessment.get('risk_count', 0)}")
            
            for risk in risk_assessment.get("risks", [])[:3]:  # Top 3 risks
                lines.append(f"  - [{risk.get('severity', 'unknown').upper()}] {risk.get('description', '')}")
            lines.append("")
        
        # Key findings
        if finance_data.get("key_findings"):
            lines.append("### Key Findings")
            for finding in finance_data["key_findings"]:
                lines.append(f"- {finding}")
            lines.append("")
        
        return "\n".join(lines)
    
    def _generate_operational_section(
        self,
        ops_data: Dict[str, Any]
    ) -> str:
        """
        Generate detailed operational analysis section.
        
        Args:
            ops_data: Operational data from ops agent
        
        Returns:
            Operational section text
        """
        lines = []
        lines.append("## OPERATIONAL ANALYSIS")
        lines.append("")
        
        # Service analysis
        service_analysis = ops_data.get("service_analysis", {})
        if service_analysis:
            lines.append("### Service Health")
            lines.append(f"- Total Services: {service_analysis.get('total_services', 0)}")
            lines.append(f"- Healthy: {service_analysis.get('healthy_count', 0)}")
            lines.append(f"- Degraded: {service_analysis.get('degraded_count', 0)}")
            lines.append(f"- Down: {service_analysis.get('down_count', 0)}")
            lines.append(f"- Average Uptime: {service_analysis.get('average_uptime', 0):.2f}%")
            
            if service_analysis.get("lowest_uptime_service"):
                lines.append(f"- Lowest Uptime: {service_analysis['lowest_uptime_service']} "
                           f"({service_analysis.get('lowest_uptime_percent', 0):.2f}%)")
            lines.append("")
        
        # Incident analysis
        incident_analysis = ops_data.get("incident_analysis", {})
        if incident_analysis:
            lines.append("### Incident Status")
            lines.append(f"- Total Incidents: {incident_analysis.get('total_incidents', 0)}")
            lines.append(f"- Critical: {incident_analysis.get('critical_count', 0)}")
            lines.append(f"- High: {incident_analysis.get('high_count', 0)}")
            lines.append(f"- Unresolved: {incident_analysis.get('unresolved_count', 0)}")
            lines.append("")
        
        # SLA analysis
        sla_analysis = ops_data.get("sla_analysis", {})
        if sla_analysis:
            lines.append("### SLA Compliance")
            compliance_status = "COMPLIANT" if sla_analysis.get("overall_compliance", True) else "NON-COMPLIANT"
            lines.append(f"- Status: {compliance_status}")
            
            violations = sla_analysis.get("violations", [])
            if violations:
                lines.append(f"- Violations: {len(violations)}")
                for violation in violations[:3]:  # Top 3 violations
                    lines.append(f"  - [{violation.get('severity', 'unknown').upper()}] {violation.get('description', '')}")
            lines.append("")
        
        # Key findings
        if ops_data.get("key_findings"):
            lines.append("### Key Findings")
            for finding in ops_data["key_findings"]:
                lines.append(f"- {finding}")
            lines.append("")
        
        return "\n".join(lines)
    
    def _generate_analytical_section(
        self,
        analyst_data: Dict[str, Any]
    ) -> str:
        """
        Generate analytical insights section.
        
        Args:
            analyst_data: Data from analyst agent
        
        Returns:
            Analytical section text
        """
        lines = []
        lines.append("## ANALYTICAL INSIGHTS")
        lines.append("")
        
        # Insights
        insights = analyst_data.get("insights", [])
        if insights:
            lines.append("### Key Insights")
            for insight in insights:
                severity = insight.get("severity", "medium").upper()
                title = insight.get("title", "Insight")
                description = insight.get("description", "")
                lines.append(f"**[{severity}] {title}**")
                lines.append(f"- {description}")
                if insight.get("impact"):
                    lines.append(f"- Impact: {insight['impact']}")
                lines.append("")
        
        # Metrics
        metrics = analyst_data.get("metrics", {})
        if metrics:
            lines.append("### Key Metrics")
            
            if "financial" in metrics:
                lines.append("**Financial:**")
                fin_metrics = metrics["financial"]
                for key, value in fin_metrics.items():
                    formatted_key = key.replace("_", " ").title()
                    if isinstance(value, float):
                        lines.append(f"- {formatted_key}: {value:.2f}")
                    else:
                        lines.append(f"- {formatted_key}: {value}")
                lines.append("")
            
            if "operational" in metrics:
                lines.append("**Operational:**")
                ops_metrics = metrics["operational"]
                for key, value in ops_metrics.items():
                    formatted_key = key.replace("_", " ").title()
                    if isinstance(value, float):
                        lines.append(f"- {formatted_key}: {value:.2f}")
                    else:
                        lines.append(f"- {formatted_key}: {value}")
                lines.append("")
        
        # Trends
        trends = analyst_data.get("trends", {})
        if trends:
            lines.append("### Identified Trends")
            
            for trend_category, trend_list in trends.items():
                if trend_list:
                    category_name = trend_category.replace("_", " ").title()
                    lines.append(f"**{category_name}:**")
                    for trend in trend_list:
                        lines.append(f"- [{trend.get('severity', 'medium').upper()}] {trend.get('description', '')}")
                    lines.append("")
        
        return "\n".join(lines)
    
    def _generate_recommendations_section(
        self,
        aggregated_data: Dict[str, Any]
    ) -> str:
        """
        Generate consolidated recommendations section.
        
        Args:
            aggregated_data: Aggregated results from all agents
        
        Returns:
            Recommendations section text
        """
        lines = []
        lines.append("## RECOMMENDATIONS")
        lines.append("")
        
        all_recommendations = []
        
        # Collect recommendations from all sources
        if "finance" in aggregated_data:
            all_recommendations.extend(aggregated_data["finance"].get("recommendations", []))
        
        if "ops" in aggregated_data:
            all_recommendations.extend(aggregated_data["ops"].get("recommendations", []))
        
        if "analyst" in aggregated_data:
            all_recommendations.extend(aggregated_data["analyst"].get("recommendations", []))
        
        # Deduplicate and prioritize
        unique_recommendations = list(dict.fromkeys(all_recommendations))
        
        # Output recommendations
        for i, rec in enumerate(unique_recommendations, 1):
            lines.append(f"{i}. {rec}")
        
        if not unique_recommendations:
            lines.append("No specific recommendations at this time.")
        
        lines.append("")
        
        return "\n".join(lines)
    
    def _generate_next_steps(
        self,
        aggregated_data: Dict[str, Any],
        scenario: Scenario
    ) -> str:
        """
        Generate next steps section.
        
        Args:
            aggregated_data: Aggregated results from all agents
            scenario: Scenario context
        
        Returns:
            Next steps text
        """
        lines = []
        lines.append("## NEXT STEPS")
        lines.append("")
        
        # Immediate actions
        lines.append("### Immediate Actions (24-48 hours)")
        
        immediate_actions = []
        
        # Check for critical issues
        if "finance" in aggregated_data:
            risk_level = aggregated_data["finance"].get("risk_assessment", {}).get("overall_risk_level")
            if risk_level in ["high", "critical"]:
                immediate_actions.append("Convene emergency financial review meeting")
        
        if "ops" in aggregated_data:
            critical_count = aggregated_data["ops"].get("incident_analysis", {}).get("critical_count", 0)
            if critical_count > 0:
                immediate_actions.append("Activate incident response team for critical issues")
        
        if immediate_actions:
            for action in immediate_actions:
                lines.append(f"- {action}")
        else:
            lines.append("- Continue monitoring current situation")
        
        lines.append("")
        
        # Short-term actions
        lines.append("### Short-term Actions (1-2 weeks)")
        lines.append("- Implement recommended corrective measures")
        lines.append("- Schedule follow-up review meetings")
        lines.append("- Monitor key metrics and KPIs")
        lines.append("")
        
        # Long-term actions
        lines.append("### Long-term Actions (1-3 months)")
        lines.append("- Review and update policies and procedures")
        lines.append("- Implement process improvements")
        lines.append("- Conduct post-mortem analysis")
        lines.append("")
        
        return "\n".join(lines)
    
    def _format_report(
        self,
        sections: Dict[str, Any],
        output_format: str
    ) -> str:
        """
        Format the report in the requested output format.
        
        Args:
            sections: Dictionary of report sections
            output_format: Desired output format ("markdown", "text", "json")
        
        Returns:
            Formatted report content
        """
        if output_format == "json":
            import json
            return json.dumps(sections, indent=2)
        
        # For markdown and text, concatenate sections
        report_parts = []
        
        # Order sections logically
        section_order = [
            "header",
            "executive_summary",
            "key_highlights",
            "financial_analysis",
            "operational_analysis",
            "analytical_insights",
            "recommendations",
            "next_steps",
        ]
        
        for section_name in section_order:
            if section_name in sections:
                content = sections[section_name]
                
                # Handle key_highlights specially
                if section_name == "key_highlights" and isinstance(content, list):
                    if content:
                        report_parts.append("## KEY HIGHLIGHTS")
                        report_parts.append("")
                        for highlight in content:
                            report_parts.append(highlight)
                        report_parts.append("")
                elif isinstance(content, str):
                    report_parts.append(content)
        
        return "\n".join(report_parts)
