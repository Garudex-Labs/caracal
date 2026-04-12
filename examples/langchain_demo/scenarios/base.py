"""
Base data classes for scenario system.

Defines the core data structures used to represent realistic company scenarios
for the Caracal demo.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional


@dataclass
class CompanyInfo:
    """Information about the company in the scenario."""
    
    name: str
    industry: str
    size: str  # e.g., "500 employees"
    fiscal_year: str


@dataclass
class ScenarioContext:
    """Context information for the scenario."""
    
    quarter: str  # e.g., "Q4"
    month: str  # e.g., "November"
    trigger_event: str  # What triggered this scenario
    additional_context: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Department:
    """Department budget information."""
    
    name: str
    budget: float
    spent: float
    variance_percent: float
    status: str  # "on_budget", "over_budget", "under_budget"
    notes: Optional[str] = None


@dataclass
class Invoice:
    """Pending invoice information."""
    
    invoice_id: str
    vendor: str
    amount: float
    due_date: str
    department: str
    status: str = "pending"  # "pending", "paid", "overdue"
    notes: Optional[str] = None


@dataclass
class FinanceData:
    """Financial data for the scenario."""
    
    departments: List[Department]
    pending_invoices: List[Invoice]
    total_budget: Optional[float] = None
    total_spent: Optional[float] = None
    additional_metrics: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Service:
    """Service health information."""
    
    name: str
    status: str  # "healthy", "degraded", "down"
    uptime_percent: float
    incidents_24h: int
    notes: Optional[str] = None


@dataclass
class Incident:
    """Incident information."""
    
    incident_id: str
    severity: str  # "low", "medium", "high", "critical"
    service: str
    description: str
    status: str  # "investigating", "identified", "resolved"
    created_at: Optional[str] = None
    resolved_at: Optional[str] = None


@dataclass
class OpsData:
    """Operations data for the scenario."""
    
    services: List[Service]
    incidents: List[Incident]
    sla_compliance: Optional[float] = None
    additional_metrics: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ExpectedOutcomes:
    """Expected outcomes and actions for the scenario."""
    
    finance_actions: List[str]
    ops_actions: List[str]
    executive_summary: str
    success_criteria: List[str] = field(default_factory=list)


@dataclass
class Scenario:
    """
    Complete scenario definition.
    
    A scenario represents a realistic company situation that demonstrates
    Caracal's capabilities in a multi-agent AI system.
    """
    
    scenario_id: str
    name: str
    description: str
    company: CompanyInfo
    context: ScenarioContext
    finance_data: FinanceData
    ops_data: OpsData
    expected_outcomes: ExpectedOutcomes
    version: str = "1.0"
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert scenario to dictionary representation."""
        return {
            "scenario_id": self.scenario_id,
            "name": self.name,
            "description": self.description,
            "version": self.version,
            "company": {
                "name": self.company.name,
                "industry": self.company.industry,
                "size": self.company.size,
                "fiscal_year": self.company.fiscal_year,
            },
            "context": {
                "quarter": self.context.quarter,
                "month": self.context.month,
                "trigger_event": self.context.trigger_event,
                "additional_context": self.context.additional_context,
            },
            "finance_data": {
                "departments": [
                    {
                        "name": d.name,
                        "budget": d.budget,
                        "spent": d.spent,
                        "variance_percent": d.variance_percent,
                        "status": d.status,
                        "notes": d.notes,
                    }
                    for d in self.finance_data.departments
                ],
                "pending_invoices": [
                    {
                        "invoice_id": i.invoice_id,
                        "vendor": i.vendor,
                        "amount": i.amount,
                        "due_date": i.due_date,
                        "department": i.department,
                        "status": i.status,
                        "notes": i.notes,
                    }
                    for i in self.finance_data.pending_invoices
                ],
                "total_budget": self.finance_data.total_budget,
                "total_spent": self.finance_data.total_spent,
                "additional_metrics": self.finance_data.additional_metrics,
            },
            "ops_data": {
                "services": [
                    {
                        "name": s.name,
                        "status": s.status,
                        "uptime_percent": s.uptime_percent,
                        "incidents_24h": s.incidents_24h,
                        "notes": s.notes,
                    }
                    for s in self.ops_data.services
                ],
                "incidents": [
                    {
                        "incident_id": inc.incident_id,
                        "severity": inc.severity,
                        "service": inc.service,
                        "description": inc.description,
                        "status": inc.status,
                        "created_at": inc.created_at,
                        "resolved_at": inc.resolved_at,
                    }
                    for inc in self.ops_data.incidents
                ],
                "sla_compliance": self.ops_data.sla_compliance,
                "additional_metrics": self.ops_data.additional_metrics,
            },
            "expected_outcomes": {
                "finance_actions": self.expected_outcomes.finance_actions,
                "ops_actions": self.expected_outcomes.ops_actions,
                "executive_summary": self.expected_outcomes.executive_summary,
                "success_criteria": self.expected_outcomes.success_criteria,
            },
            "metadata": self.metadata,
        }
