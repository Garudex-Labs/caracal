"""
Finance agent for budget analysis and financial risk assessment.

The finance agent specializes in analyzing financial data, identifying
budget variances, assessing financial risks, and providing recommendations.
"""

import logging
from typing import Any, Dict, List, Optional

from examples.langchain_demo.agents.base import (
    BaseAgent,
    AgentRole,
    MessageType,
)
from examples.langchain_demo.scenarios.base import Scenario, Department, Invoice

logger = logging.getLogger(__name__)


class FinanceAgent(BaseAgent):
    """
    Finance agent specialized in budget analysis and risk assessment.
    
    The finance agent:
    1. Analyzes department budgets and spending
    2. Identifies budget variances and overruns
    3. Reviews pending invoices and payment obligations
    4. Assesses financial risks
    5. Provides actionable recommendations
    
    # CARACAL INTEGRATION POINT (THIN SDK)
    # The finance agent uses its principal identity to:
    # - Authenticate via Bearer token (generated from principal_id)
    # - Call finance-related tools (authority resolved internally)
    # - Access finance APIs through Caracal's provider routing
    # - No manual principal_id parameters in tool calls
    """
    
    def __init__(
        self,
        principal_id: str,
        caracal_client: Any,
        scenario: Optional[Scenario] = None,
        parent_agent: Optional[BaseAgent] = None,
        agent_id: Optional[str] = None,
        context: Optional[Dict[str, Any]] = None,
    ):
        """
        Initialize the finance agent.
        
        Args:
            principal_id: Caracal principal ID for this agent (used for Bearer token)
            caracal_client: Caracal client for governed tool calls
            scenario: Optional scenario context
            parent_agent: Parent agent (typically orchestrator)
            agent_id: Optional custom agent ID
            context: Optional initial context
        """
        super().__init__(
            role=AgentRole.FINANCE,
            principal_id=principal_id,
            parent_agent=parent_agent,
            agent_id=agent_id,
            context=context,
        )
        
        self.caracal_client = caracal_client
        self.scenario = scenario
        
        logger.info(
            f"Initialized FinanceAgent {self.agent_id[:8]} "
            f"with principal {principal_id[:8]}"
        )
    
    async def execute(self, task: str, **kwargs) -> Dict[str, Any]:
        """
        Execute financial analysis.
        
        Args:
            task: Task description
            **kwargs: Additional parameters
                - scenario: Scenario object (overrides self.scenario)
        
        Returns:
            Dictionary containing:
                - status: "success" or "error"
                - summary: Executive summary of financial analysis
                - key_findings: List of key findings
                - recommendations: List of recommendations
                - budget_analysis: Detailed budget analysis
                - invoice_analysis: Detailed invoice analysis
                - risk_assessment: Risk assessment results
                - messages: All messages from analysis
        """
        self.emit_message(
            MessageType.THOUGHT,
            f"Starting financial analysis for task: {task}"
        )
        
        try:
            # Get scenario context
            scenario = kwargs.get("scenario", self.scenario)
            if not scenario:
                raise ValueError("No scenario provided for financial analysis")
            
            self.state.context["scenario"] = scenario.to_dict()
            
            # Step 1: Analyze department budgets
            self.emit_message(
                MessageType.ACTION,
                "Analyzing department budgets and spending"
            )
            
            budget_analysis = await self._analyze_budgets(scenario)
            
            # Step 2: Analyze pending invoices
            self.emit_message(
                MessageType.ACTION,
                "Analyzing pending invoices and payment obligations"
            )
            
            invoice_analysis = await self._analyze_invoices(scenario)
            
            # Step 3: Assess financial risks
            self.emit_message(
                MessageType.ACTION,
                "Assessing financial risks"
            )
            
            risk_assessment = await self._assess_risks(
                budget_analysis,
                invoice_analysis,
                scenario
            )
            
            # Step 4: Generate findings and recommendations
            self.emit_message(
                MessageType.THOUGHT,
                "Generating key findings and recommendations"
            )
            
            key_findings = self._generate_findings(
                budget_analysis,
                invoice_analysis,
                risk_assessment
            )
            
            recommendations = self._generate_recommendations(
                budget_analysis,
                invoice_analysis,
                risk_assessment,
                scenario
            )
            
            # Step 5: Generate summary
            summary = self._generate_summary(
                key_findings,
                recommendations,
                scenario
            )
            
            self.emit_message(
                MessageType.RESPONSE,
                f"Financial analysis complete. Summary:\n{summary}"
            )
            
            # Mark as completed
            self.state.mark_completed()
            
            return {
                "status": "success",
                "summary": summary,
                "key_findings": key_findings,
                "recommendations": recommendations,
                "budget_analysis": budget_analysis,
                "invoice_analysis": invoice_analysis,
                "risk_assessment": risk_assessment,
                "messages": [msg.to_dict() for msg in self.get_messages()],
            }
        
        except Exception as e:
            logger.error(f"Financial analysis failed: {e}", exc_info=True)
            self.state.mark_error()
            self.emit_message(
                MessageType.ERROR,
                f"Financial analysis failed: {str(e)}"
            )
            
            return {
                "status": "error",
                "error": str(e),
                "messages": [msg.to_dict() for msg in self.get_messages()],
            }
    
    async def _analyze_budgets(self, scenario: Scenario) -> Dict[str, Any]:
        """
        Analyze department budgets and spending.
        
        # CARACAL INTEGRATION POINT
        # In a real implementation, this would call finance tools through Caracal:
        # result = await self.caracal_client.call_tool(
        #     tool_id="demo:employee:mock:finance:data",
        #     principal_id=self.principal_id,
        #     tool_args={"query": "department_budgets"}
        # )
        
        Args:
            scenario: Scenario context
        
        Returns:
            Budget analysis results
        """
        finance_data = scenario.finance_data
        
        analysis = {
            "total_departments": len(finance_data.departments),
            "departments": [],
            "over_budget_count": 0,
            "under_budget_count": 0,
            "on_budget_count": 0,
            "total_variance": 0.0,
            "highest_variance_dept": None,
            "highest_variance_percent": 0.0,
        }
        
        for dept in finance_data.departments:
            dept_analysis = {
                "name": dept.name,
                "budget": dept.budget,
                "spent": dept.spent,
                "remaining": dept.budget - dept.spent,
                "variance_percent": dept.variance_percent,
                "status": dept.status,
                "notes": dept.notes,
            }
            
            analysis["departments"].append(dept_analysis)
            
            # Track statistics
            if dept.status == "over_budget":
                analysis["over_budget_count"] += 1
            elif dept.status == "under_budget":
                analysis["under_budget_count"] += 1
            else:
                analysis["on_budget_count"] += 1
            
            # Track highest variance
            if abs(dept.variance_percent) > abs(analysis["highest_variance_percent"]):
                analysis["highest_variance_percent"] = dept.variance_percent
                analysis["highest_variance_dept"] = dept.name
            
            analysis["total_variance"] += dept.variance_percent
        
        # Calculate average variance
        if analysis["total_departments"] > 0:
            analysis["average_variance"] = (
                analysis["total_variance"] / analysis["total_departments"]
            )
        else:
            analysis["average_variance"] = 0.0
        
        self.emit_message(
            MessageType.OBSERVATION,
            f"Budget analysis complete: {analysis['over_budget_count']} departments over budget, "
            f"{analysis['on_budget_count']} on budget, {analysis['under_budget_count']} under budget"
        )
        
        return analysis
    
    async def _analyze_invoices(self, scenario: Scenario) -> Dict[str, Any]:
        """
        Analyze pending invoices and payment obligations.
        
        # CARACAL INTEGRATION POINT
        # In a real implementation, this would call invoice tools through Caracal
        
        Args:
            scenario: Scenario context
        
        Returns:
            Invoice analysis results
        """
        finance_data = scenario.finance_data
        
        analysis = {
            "total_invoices": len(finance_data.pending_invoices),
            "invoices": [],
            "total_amount": 0.0,
            "by_department": {},
            "by_status": {},
            "largest_invoice": None,
            "largest_amount": 0.0,
        }
        
        for invoice in finance_data.pending_invoices:
            invoice_data = {
                "invoice_id": invoice.invoice_id,
                "vendor": invoice.vendor,
                "amount": invoice.amount,
                "due_date": invoice.due_date,
                "department": invoice.department,
                "status": invoice.status,
                "notes": invoice.notes,
            }
            
            analysis["invoices"].append(invoice_data)
            analysis["total_amount"] += invoice.amount
            
            # Track by department
            if invoice.department not in analysis["by_department"]:
                analysis["by_department"][invoice.department] = {
                    "count": 0,
                    "total_amount": 0.0,
                }
            analysis["by_department"][invoice.department]["count"] += 1
            analysis["by_department"][invoice.department]["total_amount"] += invoice.amount
            
            # Track by status
            if invoice.status not in analysis["by_status"]:
                analysis["by_status"][invoice.status] = {
                    "count": 0,
                    "total_amount": 0.0,
                }
            analysis["by_status"][invoice.status]["count"] += 1
            analysis["by_status"][invoice.status]["total_amount"] += invoice.amount
            
            # Track largest invoice
            if invoice.amount > analysis["largest_amount"]:
                analysis["largest_amount"] = invoice.amount
                analysis["largest_invoice"] = invoice.invoice_id
        
        self.emit_message(
            MessageType.OBSERVATION,
            f"Invoice analysis complete: {analysis['total_invoices']} pending invoices "
            f"totaling ${analysis['total_amount']:,.2f}"
        )
        
        return analysis
    
    async def _assess_risks(
        self,
        budget_analysis: Dict[str, Any],
        invoice_analysis: Dict[str, Any],
        scenario: Scenario
    ) -> Dict[str, Any]:
        """
        Assess financial risks based on budget and invoice analysis.
        
        Args:
            budget_analysis: Budget analysis results
            invoice_analysis: Invoice analysis results
            scenario: Scenario context
        
        Returns:
            Risk assessment results
        """
        risks = []
        risk_level = "low"
        
        # Risk 1: Departments over budget
        if budget_analysis["over_budget_count"] > 0:
            severity = "high" if budget_analysis["over_budget_count"] > 2 else "medium"
            risks.append({
                "type": "budget_overrun",
                "severity": severity,
                "description": (
                    f"{budget_analysis['over_budget_count']} department(s) over budget. "
                    f"Highest variance: {budget_analysis['highest_variance_dept']} "
                    f"at {budget_analysis['highest_variance_percent']:.1f}%"
                ),
                "affected_departments": [
                    d["name"] for d in budget_analysis["departments"]
                    if d["status"] == "over_budget"
                ],
            })
            if severity == "high":
                risk_level = "high"
            elif risk_level != "high":
                risk_level = "medium"
        
        # Risk 2: Large pending invoices
        if invoice_analysis["total_amount"] > 100000:
            severity = "high" if invoice_analysis["total_amount"] > 500000 else "medium"
            risks.append({
                "type": "payment_obligations",
                "severity": severity,
                "description": (
                    f"${invoice_analysis['total_amount']:,.2f} in pending invoices. "
                    f"Largest invoice: {invoice_analysis['largest_invoice']} "
                    f"for ${invoice_analysis['largest_amount']:,.2f}"
                ),
                "total_amount": invoice_analysis["total_amount"],
            })
            if severity == "high" and risk_level != "high":
                risk_level = "high"
            elif risk_level == "low":
                risk_level = "medium"
        
        # Risk 3: Cash flow concerns
        if budget_analysis["average_variance"] > 5.0:
            risks.append({
                "type": "cash_flow",
                "severity": "medium",
                "description": (
                    f"Average budget variance of {budget_analysis['average_variance']:.1f}% "
                    "indicates potential cash flow management issues"
                ),
            })
            if risk_level == "low":
                risk_level = "medium"
        
        assessment = {
            "overall_risk_level": risk_level,
            "risk_count": len(risks),
            "risks": risks,
        }
        
        self.emit_message(
            MessageType.OBSERVATION,
            f"Risk assessment complete: {risk_level} risk level with {len(risks)} identified risks"
        )
        
        return assessment
    
    def _generate_findings(
        self,
        budget_analysis: Dict[str, Any],
        invoice_analysis: Dict[str, Any],
        risk_assessment: Dict[str, Any]
    ) -> List[str]:
        """
        Generate key findings from analysis.
        
        Args:
            budget_analysis: Budget analysis results
            invoice_analysis: Invoice analysis results
            risk_assessment: Risk assessment results
        
        Returns:
            List of key findings
        """
        findings = []
        
        # Budget findings
        if budget_analysis["over_budget_count"] > 0:
            findings.append(
                f"{budget_analysis['over_budget_count']} department(s) over budget, "
                f"with {budget_analysis['highest_variance_dept']} showing "
                f"{budget_analysis['highest_variance_percent']:.1f}% variance"
            )
        
        if budget_analysis["average_variance"] > 5.0:
            findings.append(
                f"Average budget variance of {budget_analysis['average_variance']:.1f}% "
                "exceeds acceptable threshold"
            )
        
        # Invoice findings
        if invoice_analysis["total_invoices"] > 0:
            findings.append(
                f"{invoice_analysis['total_invoices']} pending invoices "
                f"totaling ${invoice_analysis['total_amount']:,.2f}"
            )
        
        # Risk findings
        if risk_assessment["overall_risk_level"] in ["high", "critical"]:
            findings.append(
                f"Overall financial risk level: {risk_assessment['overall_risk_level'].upper()}"
            )
        
        return findings
    
    def _generate_recommendations(
        self,
        budget_analysis: Dict[str, Any],
        invoice_analysis: Dict[str, Any],
        risk_assessment: Dict[str, Any],
        scenario: Scenario
    ) -> List[str]:
        """
        Generate actionable recommendations.
        
        Args:
            budget_analysis: Budget analysis results
            invoice_analysis: Invoice analysis results
            risk_assessment: Risk assessment results
            scenario: Scenario context
        
        Returns:
            List of recommendations
        """
        recommendations = []
        
        # Budget recommendations
        if budget_analysis["over_budget_count"] > 0:
            over_budget_depts = [
                d["name"] for d in budget_analysis["departments"]
                if d["status"] == "over_budget"
            ]
            recommendations.append(
                f"Implement spending freeze for over-budget departments: {', '.join(over_budget_depts)}"
            )
            recommendations.append(
                "Conduct detailed review of discretionary spending in affected departments"
            )
        
        # Invoice recommendations
        if invoice_analysis["total_amount"] > 100000:
            recommendations.append(
                "Prioritize invoice reconciliation to avoid late payment penalties"
            )
            recommendations.append(
                "Review payment terms with major vendors for potential extensions"
            )
        
        # Risk-based recommendations
        for risk in risk_assessment["risks"]:
            if risk["severity"] == "high":
                if risk["type"] == "budget_overrun":
                    recommendations.append(
                        "Escalate budget overrun to executive leadership for immediate action"
                    )
                elif risk["type"] == "payment_obligations":
                    recommendations.append(
                        "Secure additional credit line or defer non-critical payments"
                    )
        
        # Use scenario expected outcomes as guidance
        for action in scenario.expected_outcomes.finance_actions:
            if action not in recommendations:
                recommendations.append(action)
        
        return recommendations
    
    def _generate_summary(
        self,
        key_findings: List[str],
        recommendations: List[str],
        scenario: Scenario
    ) -> str:
        """
        Generate executive summary of financial analysis.
        
        Args:
            key_findings: List of key findings
            recommendations: List of recommendations
            scenario: Scenario context
        
        Returns:
            Summary text
        """
        lines = []
        
        lines.append(f"Financial analysis for {scenario.company.name} - {scenario.context.quarter} {scenario.context.month}")
        lines.append("")
        
        if key_findings:
            lines.append("Key Findings:")
            for finding in key_findings:
                lines.append(f"• {finding}")
            lines.append("")
        
        if recommendations:
            lines.append("Recommendations:")
            for i, rec in enumerate(recommendations[:5], 1):  # Top 5 recommendations
                lines.append(f"{i}. {rec}")
        
        return "\n".join(lines)
