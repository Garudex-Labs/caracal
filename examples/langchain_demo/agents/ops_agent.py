"""
Operations agent for incident analysis and service monitoring.

The ops agent specializes in analyzing operational data, monitoring service
health, investigating incidents, and providing operational recommendations.
"""

import logging
from typing import Any, Dict, List, Optional

from examples.langchain_demo.agents.base import (
    BaseAgent,
    AgentRole,
    MessageType,
)
from examples.langchain_demo.scenarios.base import Scenario, Service, Incident

logger = logging.getLogger(__name__)


class OpsAgent(BaseAgent):
    """
    Operations agent specialized in incident analysis and service monitoring.
    
    The ops agent:
    1. Monitors service health and uptime
    2. Analyzes active incidents
    3. Assesses operational risks
    4. Evaluates SLA compliance
    5. Provides actionable recommendations
    
    # CARACAL INTEGRATION POINT
    # The ops agent uses its mandate to:
    # - Call ops-related tools (service health, incident data, etc.)
    # - Access ops APIs through Caracal's provider routing
    # - All tool calls are governed by the agent's mandate authority
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
        Initialize the ops agent.
        
        Args:
            mandate_id: Caracal mandate ID for this agent
            caracal_client: Caracal client for governed tool calls
            scenario: Optional scenario context
            parent_agent: Parent agent (typically orchestrator)
            agent_id: Optional custom agent ID
            context: Optional initial context
        """
        super().__init__(
            role=AgentRole.OPS,
            mandate_id=mandate_id,
            parent_agent=parent_agent,
            agent_id=agent_id,
            context=context,
        )
        
        self.caracal_client = caracal_client
        self.scenario = scenario
        
        logger.info(
            f"Initialized OpsAgent {self.agent_id[:8]} "
            f"with mandate {mandate_id[:8]}"
        )
    
    async def execute(self, task: str, **kwargs) -> Dict[str, Any]:
        """
        Execute operational analysis.
        
        Args:
            task: Task description
            **kwargs: Additional parameters
                - scenario: Scenario object (overrides self.scenario)
        
        Returns:
            Dictionary containing:
                - status: "success" or "error"
                - summary: Executive summary of operational analysis
                - key_findings: List of key findings
                - recommendations: List of recommendations
                - service_analysis: Detailed service health analysis
                - incident_analysis: Detailed incident analysis
                - sla_analysis: SLA compliance analysis
                - messages: All messages from analysis
        """
        self.emit_message(
            MessageType.THOUGHT,
            f"Starting operational analysis for task: {task}"
        )
        
        try:
            # Get scenario context
            scenario = kwargs.get("scenario", self.scenario)
            if not scenario:
                raise ValueError("No scenario provided for operational analysis")
            
            self.state.context["scenario"] = scenario.to_dict()
            
            # Step 1: Analyze service health
            self.emit_message(
                MessageType.ACTION,
                "Analyzing service health and uptime"
            )
            
            service_analysis = await self._analyze_services(scenario)
            
            # Step 2: Analyze incidents
            self.emit_message(
                MessageType.ACTION,
                "Analyzing active incidents"
            )
            
            incident_analysis = await self._analyze_incidents(scenario)
            
            # Step 3: Analyze SLA compliance
            self.emit_message(
                MessageType.ACTION,
                "Evaluating SLA compliance"
            )
            
            sla_analysis = await self._analyze_sla(scenario, service_analysis)
            
            # Step 4: Generate findings and recommendations
            self.emit_message(
                MessageType.THOUGHT,
                "Generating key findings and recommendations"
            )
            
            key_findings = self._generate_findings(
                service_analysis,
                incident_analysis,
                sla_analysis
            )
            
            recommendations = self._generate_recommendations(
                service_analysis,
                incident_analysis,
                sla_analysis,
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
                f"Operational analysis complete. Summary:\n{summary}"
            )
            
            # Mark as completed
            self.state.mark_completed()
            
            return {
                "status": "success",
                "summary": summary,
                "key_findings": key_findings,
                "recommendations": recommendations,
                "service_analysis": service_analysis,
                "incident_analysis": incident_analysis,
                "sla_analysis": sla_analysis,
                "messages": [msg.to_dict() for msg in self.get_messages()],
            }
        
        except Exception as e:
            logger.error(f"Operational analysis failed: {e}", exc_info=True)
            self.state.mark_error()
            self.emit_message(
                MessageType.ERROR,
                f"Operational analysis failed: {str(e)}"
            )
            
            return {
                "status": "error",
                "error": str(e),
                "messages": [msg.to_dict() for msg in self.get_messages()],
            }
    
    async def _analyze_services(self, scenario: Scenario) -> Dict[str, Any]:
        """
        Analyze service health and uptime.
        
        # CARACAL INTEGRATION POINT
        # In a real implementation, this would call ops tools through Caracal:
        # result = await self.caracal_client.call_tool(
        #     tool_id="demo:employee:mock:ops:health",
        #     mandate_id=self.mandate_id,
        #     tool_args={"query": "service_health"}
        # )
        
        Args:
            scenario: Scenario context
        
        Returns:
            Service analysis results
        """
        ops_data = scenario.ops_data
        
        analysis = {
            "total_services": len(ops_data.services),
            "services": [],
            "healthy_count": 0,
            "degraded_count": 0,
            "down_count": 0,
            "average_uptime": 0.0,
            "lowest_uptime_service": None,
            "lowest_uptime_percent": 100.0,
            "total_incidents_24h": 0,
        }
        
        total_uptime = 0.0
        
        for service in ops_data.services:
            service_data = {
                "name": service.name,
                "status": service.status,
                "uptime_percent": service.uptime_percent,
                "incidents_24h": service.incidents_24h,
                "notes": service.notes,
            }
            
            analysis["services"].append(service_data)
            
            # Track statistics
            if service.status == "healthy":
                analysis["healthy_count"] += 1
            elif service.status == "degraded":
                analysis["degraded_count"] += 1
            elif service.status == "down":
                analysis["down_count"] += 1
            
            total_uptime += service.uptime_percent
            analysis["total_incidents_24h"] += service.incidents_24h
            
            # Track lowest uptime
            if service.uptime_percent < analysis["lowest_uptime_percent"]:
                analysis["lowest_uptime_percent"] = service.uptime_percent
                analysis["lowest_uptime_service"] = service.name
        
        # Calculate average uptime
        if analysis["total_services"] > 0:
            analysis["average_uptime"] = total_uptime / analysis["total_services"]
        
        self.emit_message(
            MessageType.OBSERVATION,
            f"Service analysis complete: {analysis['healthy_count']} healthy, "
            f"{analysis['degraded_count']} degraded, {analysis['down_count']} down. "
            f"Average uptime: {analysis['average_uptime']:.2f}%"
        )
        
        return analysis
    
    async def _analyze_incidents(self, scenario: Scenario) -> Dict[str, Any]:
        """
        Analyze active incidents.
        
        # CARACAL INTEGRATION POINT
        # In a real implementation, this would call incident tools through Caracal
        
        Args:
            scenario: Scenario context
        
        Returns:
            Incident analysis results
        """
        ops_data = scenario.ops_data
        
        analysis = {
            "total_incidents": len(ops_data.incidents),
            "incidents": [],
            "by_severity": {},
            "by_status": {},
            "by_service": {},
            "critical_count": 0,
            "high_count": 0,
            "unresolved_count": 0,
        }
        
        for incident in ops_data.incidents:
            incident_data = {
                "incident_id": incident.incident_id,
                "severity": incident.severity,
                "service": incident.service,
                "description": incident.description,
                "status": incident.status,
                "created_at": incident.created_at,
                "resolved_at": incident.resolved_at,
            }
            
            analysis["incidents"].append(incident_data)
            
            # Track by severity
            if incident.severity not in analysis["by_severity"]:
                analysis["by_severity"][incident.severity] = 0
            analysis["by_severity"][incident.severity] += 1
            
            # Track by status
            if incident.status not in analysis["by_status"]:
                analysis["by_status"][incident.status] = 0
            analysis["by_status"][incident.status] += 1
            
            # Track by service
            if incident.service not in analysis["by_service"]:
                analysis["by_service"][incident.service] = 0
            analysis["by_service"][incident.service] += 1
            
            # Track critical/high incidents
            if incident.severity == "critical":
                analysis["critical_count"] += 1
            elif incident.severity == "high":
                analysis["high_count"] += 1
            
            # Track unresolved
            if incident.status != "resolved":
                analysis["unresolved_count"] += 1
        
        self.emit_message(
            MessageType.OBSERVATION,
            f"Incident analysis complete: {analysis['total_incidents']} total incidents, "
            f"{analysis['critical_count']} critical, {analysis['high_count']} high, "
            f"{analysis['unresolved_count']} unresolved"
        )
        
        return analysis
    
    async def _analyze_sla(
        self,
        scenario: Scenario,
        service_analysis: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Analyze SLA compliance.
        
        Args:
            scenario: Scenario context
            service_analysis: Service analysis results
        
        Returns:
            SLA analysis results
        """
        ops_data = scenario.ops_data
        
        # SLA thresholds
        SLA_UPTIME_THRESHOLD = 99.0  # 99% uptime required
        SLA_INCIDENT_THRESHOLD = 5  # Max 5 incidents per 24h
        
        analysis = {
            "overall_compliance": ops_data.sla_compliance,
            "uptime_compliance": True,
            "incident_compliance": True,
            "violations": [],
        }
        
        # Check uptime compliance
        if service_analysis["average_uptime"] < SLA_UPTIME_THRESHOLD:
            analysis["uptime_compliance"] = False
            analysis["violations"].append({
                "type": "uptime",
                "description": (
                    f"Average uptime {service_analysis['average_uptime']:.2f}% "
                    f"below SLA threshold of {SLA_UPTIME_THRESHOLD}%"
                ),
                "severity": "high",
            })
        
        # Check individual service uptime
        for service_data in service_analysis["services"]:
            if service_data["uptime_percent"] < SLA_UPTIME_THRESHOLD:
                analysis["violations"].append({
                    "type": "service_uptime",
                    "service": service_data["name"],
                    "description": (
                        f"{service_data['name']} uptime {service_data['uptime_percent']:.2f}% "
                        f"below SLA threshold"
                    ),
                    "severity": "medium",
                })
        
        # Check incident rate
        if service_analysis["total_incidents_24h"] > SLA_INCIDENT_THRESHOLD:
            analysis["incident_compliance"] = False
            analysis["violations"].append({
                "type": "incident_rate",
                "description": (
                    f"{service_analysis['total_incidents_24h']} incidents in 24h "
                    f"exceeds SLA threshold of {SLA_INCIDENT_THRESHOLD}"
                ),
                "severity": "high",
            })
        
        # Overall compliance
        if analysis["violations"]:
            analysis["overall_compliance"] = False
        
        self.emit_message(
            MessageType.OBSERVATION,
            f"SLA analysis complete: {'COMPLIANT' if analysis['overall_compliance'] else 'NON-COMPLIANT'} "
            f"with {len(analysis['violations'])} violation(s)"
        )
        
        return analysis
    
    def _generate_findings(
        self,
        service_analysis: Dict[str, Any],
        incident_analysis: Dict[str, Any],
        sla_analysis: Dict[str, Any]
    ) -> List[str]:
        """
        Generate key findings from analysis.
        
        Args:
            service_analysis: Service analysis results
            incident_analysis: Incident analysis results
            sla_analysis: SLA analysis results
        
        Returns:
            List of key findings
        """
        findings = []
        
        # Service findings
        if service_analysis["degraded_count"] > 0 or service_analysis["down_count"] > 0:
            findings.append(
                f"{service_analysis['degraded_count']} service(s) degraded, "
                f"{service_analysis['down_count']} service(s) down"
            )
        
        if service_analysis["lowest_uptime_percent"] < 99.0:
            findings.append(
                f"{service_analysis['lowest_uptime_service']} has lowest uptime "
                f"at {service_analysis['lowest_uptime_percent']:.2f}%"
            )
        
        # Incident findings
        if incident_analysis["critical_count"] > 0:
            findings.append(
                f"{incident_analysis['critical_count']} critical incident(s) active"
            )
        
        if incident_analysis["unresolved_count"] > 0:
            findings.append(
                f"{incident_analysis['unresolved_count']} unresolved incident(s)"
            )
        
        # SLA findings
        if not sla_analysis["overall_compliance"]:
            findings.append(
                f"SLA NON-COMPLIANT with {len(sla_analysis['violations'])} violation(s)"
            )
        
        return findings
    
    def _generate_recommendations(
        self,
        service_analysis: Dict[str, Any],
        incident_analysis: Dict[str, Any],
        sla_analysis: Dict[str, Any],
        scenario: Scenario
    ) -> List[str]:
        """
        Generate actionable recommendations.
        
        Args:
            service_analysis: Service analysis results
            incident_analysis: Incident analysis results
            sla_analysis: SLA analysis results
            scenario: Scenario context
        
        Returns:
            List of recommendations
        """
        recommendations = []
        
        # Service recommendations
        if service_analysis["down_count"] > 0:
            recommendations.append(
                "Immediately escalate down services to on-call engineering team"
            )
        
        if service_analysis["degraded_count"] > 0:
            degraded_services = [
                s["name"] for s in service_analysis["services"]
                if s["status"] == "degraded"
            ]
            recommendations.append(
                f"Investigate and remediate degraded services: {', '.join(degraded_services)}"
            )
        
        # Incident recommendations
        if incident_analysis["critical_count"] > 0:
            recommendations.append(
                "Activate incident response protocol for critical incidents"
            )
        
        if incident_analysis["unresolved_count"] > 3:
            recommendations.append(
                "Increase incident response capacity to address backlog"
            )
        
        # SLA recommendations
        if not sla_analysis["overall_compliance"]:
            recommendations.append(
                "Implement corrective action plan to restore SLA compliance"
            )
            
            for violation in sla_analysis["violations"]:
                if violation["severity"] == "high":
                    recommendations.append(
                        f"Address high-severity SLA violation: {violation['description']}"
                    )
        
        # Use scenario expected outcomes as guidance
        for action in scenario.expected_outcomes.ops_actions:
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
        Generate executive summary of operational analysis.
        
        Args:
            key_findings: List of key findings
            recommendations: List of recommendations
            scenario: Scenario context
        
        Returns:
            Summary text
        """
        lines = []
        
        lines.append(f"Operational analysis for {scenario.company.name} - {scenario.context.quarter} {scenario.context.month}")
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
