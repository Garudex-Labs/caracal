"""
Scenario validator for validating scenario structure and data.

Provides comprehensive validation of scenario definitions to ensure they
meet the required schema and contain valid data.
"""

import logging
from typing import List, Optional

from .base import Scenario

logger = logging.getLogger(__name__)


class ValidationError(Exception):
    """Raised when scenario validation fails."""
    pass


class ScenarioValidator:
    """
    Validates scenario definitions.
    
    Ensures scenarios have all required fields, valid data types,
    and logical consistency.
    """
    
    def __init__(self, strict: bool = True):
        """
        Initialize the validator.
        
        Args:
            strict: If True, raise exceptions on validation errors.
                   If False, log warnings instead.
        """
        self.strict = strict
        self.errors: List[str] = []
        self.warnings: List[str] = []
    
    def validate(self, scenario: Scenario) -> bool:
        """
        Validate a scenario.
        
        Args:
            scenario: Scenario to validate
        
        Returns:
            True if validation passes, False otherwise
        
        Raises:
            ValidationError: If strict mode is enabled and validation fails
        """
        self.errors = []
        self.warnings = []
        
        # Validate basic fields
        self._validate_basic_fields(scenario)
        
        # Validate company info
        self._validate_company(scenario)
        
        # Validate context
        self._validate_context(scenario)
        
        # Validate finance data
        self._validate_finance_data(scenario)
        
        # Validate ops data
        self._validate_ops_data(scenario)
        
        # Validate expected outcomes
        self._validate_expected_outcomes(scenario)
        
        # Check for errors
        if self.errors:
            error_msg = f"Scenario validation failed with {len(self.errors)} error(s):\n"
            error_msg += "\n".join(f"  - {e}" for e in self.errors)
            
            if self.strict:
                raise ValidationError(error_msg)
            else:
                logger.error(error_msg)
                return False
        
        # Log warnings
        if self.warnings:
            warning_msg = f"Scenario validation completed with {len(self.warnings)} warning(s):\n"
            warning_msg += "\n".join(f"  - {w}" for w in self.warnings)
            logger.warning(warning_msg)
        
        logger.info(f"Scenario '{scenario.scenario_id}' validation passed")
        return True
    
    def _validate_basic_fields(self, scenario: Scenario):
        """Validate basic scenario fields."""
        if not scenario.scenario_id:
            self.errors.append("scenario_id is required")
        
        if not scenario.name:
            self.errors.append("name is required")
        
        if not scenario.description:
            self.warnings.append("description is empty")
        
        if not scenario.version:
            self.warnings.append("version is not specified")
    
    def _validate_company(self, scenario: Scenario):
        """Validate company information."""
        company = scenario.company
        
        if not company.name:
            self.errors.append("company.name is required")
        
        if not company.industry:
            self.warnings.append("company.industry is not specified")
        
        if not company.size:
            self.warnings.append("company.size is not specified")
        
        if not company.fiscal_year:
            self.warnings.append("company.fiscal_year is not specified")
    
    def _validate_context(self, scenario: Scenario):
        """Validate scenario context."""
        context = scenario.context
        
        if not context.quarter:
            self.warnings.append("context.quarter is not specified")
        
        if not context.month:
            self.warnings.append("context.month is not specified")
        
        if not context.trigger_event:
            self.warnings.append("context.trigger_event is not specified")
        
        # Validate quarter format
        valid_quarters = ["Q1", "Q2", "Q3", "Q4"]
        if context.quarter and context.quarter not in valid_quarters:
            self.warnings.append(
                f"context.quarter '{context.quarter}' is not a standard quarter (Q1-Q4)"
            )
    
    def _validate_finance_data(self, scenario: Scenario):
        """Validate finance data."""
        finance = scenario.finance_data
        
        # Validate departments
        if not finance.departments:
            self.warnings.append("finance_data.departments is empty")
        
        for i, dept in enumerate(finance.departments):
            if not dept.name:
                self.errors.append(f"finance_data.departments[{i}].name is required")
            
            if dept.budget < 0:
                self.errors.append(
                    f"finance_data.departments[{i}].budget cannot be negative"
                )
            
            if dept.spent < 0:
                self.errors.append(
                    f"finance_data.departments[{i}].spent cannot be negative"
                )
            
            # Validate status
            valid_statuses = ["on_budget", "over_budget", "under_budget"]
            if dept.status not in valid_statuses:
                self.warnings.append(
                    f"finance_data.departments[{i}].status '{dept.status}' "
                    f"is not a standard status ({', '.join(valid_statuses)})"
                )
            
            # Check variance calculation
            if dept.budget > 0:
                calculated_variance = ((dept.spent - dept.budget) / dept.budget) * 100
                if abs(calculated_variance - dept.variance_percent) > 0.1:
                    self.warnings.append(
                        f"finance_data.departments[{i}].variance_percent "
                        f"({dept.variance_percent}%) does not match calculated "
                        f"variance ({calculated_variance:.2f}%)"
                    )
        
        # Validate invoices
        for i, invoice in enumerate(finance.pending_invoices):
            if not invoice.invoice_id:
                self.errors.append(
                    f"finance_data.pending_invoices[{i}].invoice_id is required"
                )
            
            if not invoice.vendor:
                self.errors.append(
                    f"finance_data.pending_invoices[{i}].vendor is required"
                )
            
            if invoice.amount <= 0:
                self.errors.append(
                    f"finance_data.pending_invoices[{i}].amount must be positive"
                )
            
            if not invoice.due_date:
                self.warnings.append(
                    f"finance_data.pending_invoices[{i}].due_date is not specified"
                )
            
            if not invoice.department:
                self.warnings.append(
                    f"finance_data.pending_invoices[{i}].department is not specified"
                )
        
        # Validate totals if provided
        if finance.total_budget is not None:
            if finance.total_budget < 0:
                self.errors.append("finance_data.total_budget cannot be negative")
            
            # Check if total matches sum of departments
            dept_total = sum(d.budget for d in finance.departments)
            if dept_total > 0 and abs(dept_total - finance.total_budget) > 0.01:
                self.warnings.append(
                    f"finance_data.total_budget ({finance.total_budget}) does not "
                    f"match sum of department budgets ({dept_total})"
                )
        
        if finance.total_spent is not None:
            if finance.total_spent < 0:
                self.errors.append("finance_data.total_spent cannot be negative")
    
    def _validate_ops_data(self, scenario: Scenario):
        """Validate operations data."""
        ops = scenario.ops_data
        
        # Validate services
        if not ops.services:
            self.warnings.append("ops_data.services is empty")
        
        for i, service in enumerate(ops.services):
            if not service.name:
                self.errors.append(f"ops_data.services[{i}].name is required")
            
            # Validate status
            valid_statuses = ["healthy", "degraded", "down", "unknown"]
            if service.status not in valid_statuses:
                self.warnings.append(
                    f"ops_data.services[{i}].status '{service.status}' "
                    f"is not a standard status ({', '.join(valid_statuses)})"
                )
            
            # Validate uptime
            if not (0 <= service.uptime_percent <= 100):
                self.errors.append(
                    f"ops_data.services[{i}].uptime_percent must be between 0 and 100"
                )
            
            if service.incidents_24h < 0:
                self.errors.append(
                    f"ops_data.services[{i}].incidents_24h cannot be negative"
                )
        
        # Validate incidents
        for i, incident in enumerate(ops.incidents):
            if not incident.incident_id:
                self.errors.append(f"ops_data.incidents[{i}].incident_id is required")
            
            # Validate severity
            valid_severities = ["low", "medium", "high", "critical"]
            if incident.severity not in valid_severities:
                self.warnings.append(
                    f"ops_data.incidents[{i}].severity '{incident.severity}' "
                    f"is not a standard severity ({', '.join(valid_severities)})"
                )
            
            if not incident.service:
                self.warnings.append(
                    f"ops_data.incidents[{i}].service is not specified"
                )
            
            if not incident.description:
                self.warnings.append(
                    f"ops_data.incidents[{i}].description is empty"
                )
            
            # Validate status
            valid_statuses = ["investigating", "identified", "resolved", "closed"]
            if incident.status not in valid_statuses:
                self.warnings.append(
                    f"ops_data.incidents[{i}].status '{incident.status}' "
                    f"is not a standard status ({', '.join(valid_statuses)})"
                )
        
        # Validate SLA compliance if provided
        if ops.sla_compliance is not None:
            if not (0 <= ops.sla_compliance <= 100):
                self.errors.append(
                    "ops_data.sla_compliance must be between 0 and 100"
                )
    
    def _validate_expected_outcomes(self, scenario: Scenario):
        """Validate expected outcomes."""
        outcomes = scenario.expected_outcomes
        
        if not outcomes.finance_actions:
            self.warnings.append("expected_outcomes.finance_actions is empty")
        
        if not outcomes.ops_actions:
            self.warnings.append("expected_outcomes.ops_actions is empty")
        
        if not outcomes.executive_summary:
            self.warnings.append("expected_outcomes.executive_summary is empty")
        
        if not outcomes.success_criteria:
            self.warnings.append("expected_outcomes.success_criteria is empty")
    
    def get_validation_report(self) -> str:
        """
        Get a formatted validation report.
        
        Returns:
            Formatted string with validation results
        """
        report = []
        
        if self.errors:
            report.append(f"Errors ({len(self.errors)}):")
            for error in self.errors:
                report.append(f"  ✗ {error}")
        
        if self.warnings:
            report.append(f"Warnings ({len(self.warnings)}):")
            for warning in self.warnings:
                report.append(f"  ⚠ {warning}")
        
        if not self.errors and not self.warnings:
            report.append("✓ Validation passed with no errors or warnings")
        
        return "\n".join(report)
