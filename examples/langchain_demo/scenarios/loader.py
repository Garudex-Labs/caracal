"""
Scenario loader for loading scenarios from JSON files.

Provides functionality to load scenario definitions from JSON files and
convert them into Scenario objects.
"""

import json
import logging
from pathlib import Path
from typing import Dict, List, Optional

from .base import (
    CompanyInfo,
    ScenarioContext,
    FinanceData,
    OpsData,
    ExpectedOutcomes,
    Scenario,
    Department,
    Invoice,
    Service,
    Incident,
)

logger = logging.getLogger(__name__)


class ScenarioLoadError(Exception):
    """Raised when a scenario fails to load."""
    pass


class ScenarioLoader:
    """
    Loads scenarios from JSON files.
    
    Handles parsing JSON scenario definitions and converting them into
    strongly-typed Scenario objects.
    """
    
    def __init__(self, scenarios_dir: Optional[Path] = None):
        """
        Initialize the scenario loader.
        
        Args:
            scenarios_dir: Directory containing scenario JSON files.
                          Defaults to scenarios/definitions/ relative to this file.
        """
        if scenarios_dir is None:
            scenarios_dir = Path(__file__).parent / "definitions"
        
        self.scenarios_dir = Path(scenarios_dir)
        self._cache: Dict[str, Scenario] = {}
    
    def load_scenario(self, scenario_id: str) -> Scenario:
        """
        Load a scenario by ID.
        
        Args:
            scenario_id: The scenario ID (e.g., "default", "budget_crisis")
        
        Returns:
            Loaded Scenario object
        
        Raises:
            ScenarioLoadError: If scenario cannot be loaded
        """
        # Check cache first
        if scenario_id in self._cache:
            logger.debug(f"Loading scenario '{scenario_id}' from cache")
            return self._cache[scenario_id]
        
        # Load from file
        scenario_path = self.scenarios_dir / f"{scenario_id}.json"
        
        if not scenario_path.exists():
            raise ScenarioLoadError(
                f"Scenario file not found: {scenario_path}"
            )
        
        try:
            with open(scenario_path, "r") as f:
                data = json.load(f)
            
            scenario = self._parse_scenario(data)
            
            # Cache the loaded scenario
            self._cache[scenario_id] = scenario
            
            logger.info(f"Loaded scenario '{scenario_id}' from {scenario_path}")
            return scenario
            
        except json.JSONDecodeError as e:
            raise ScenarioLoadError(
                f"Invalid JSON in scenario file {scenario_path}: {e}"
            )
        except Exception as e:
            raise ScenarioLoadError(
                f"Failed to load scenario '{scenario_id}': {e}"
            )
    
    def load_all_scenarios(self) -> Dict[str, Scenario]:
        """
        Load all scenarios from the scenarios directory.
        
        Returns:
            Dictionary mapping scenario IDs to Scenario objects
        """
        scenarios = {}
        
        if not self.scenarios_dir.exists():
            logger.warning(f"Scenarios directory not found: {self.scenarios_dir}")
            return scenarios
        
        for scenario_file in self.scenarios_dir.glob("*.json"):
            scenario_id = scenario_file.stem
            try:
                scenario = self.load_scenario(scenario_id)
                scenarios[scenario_id] = scenario
            except ScenarioLoadError as e:
                logger.error(f"Failed to load scenario '{scenario_id}': {e}")
        
        logger.info(f"Loaded {len(scenarios)} scenarios")
        return scenarios
    
    def list_available_scenarios(self) -> List[str]:
        """
        List all available scenario IDs.
        
        Returns:
            List of scenario IDs
        """
        if not self.scenarios_dir.exists():
            return []
        
        return [f.stem for f in self.scenarios_dir.glob("*.json")]
    
    def _parse_scenario(self, data: Dict) -> Scenario:
        """
        Parse scenario data from dictionary.
        
        Args:
            data: Dictionary containing scenario data
        
        Returns:
            Parsed Scenario object
        
        Raises:
            ScenarioLoadError: If required fields are missing or invalid
        """
        try:
            # Parse company info
            company_data = data.get("company", {})
            company = CompanyInfo(
                name=company_data.get("name", "Unknown Company"),
                industry=company_data.get("industry", "Unknown"),
                size=company_data.get("size", "Unknown"),
                fiscal_year=company_data.get("fiscal_year", "2026"),
            )
            
            # Parse context
            context_data = data.get("context", {})
            context = ScenarioContext(
                quarter=context_data.get("quarter", "Q1"),
                month=context_data.get("month", "January"),
                trigger_event=context_data.get("trigger_event", "Routine review"),
                additional_context=context_data.get("additional_context", {}),
            )
            
            # Parse finance data
            finance_data_raw = data.get("finance_data", {})
            departments = [
                Department(
                    name=d.get("name", "Unknown"),
                    budget=float(d.get("budget", 0)),
                    spent=float(d.get("spent", 0)),
                    variance_percent=float(d.get("variance_percent", 0)),
                    status=d.get("status", "unknown"),
                    notes=d.get("notes"),
                )
                for d in finance_data_raw.get("departments", [])
            ]
            
            invoices = [
                Invoice(
                    invoice_id=i.get("invoice_id", ""),
                    vendor=i.get("vendor", "Unknown"),
                    amount=float(i.get("amount", 0)),
                    due_date=i.get("due_date", ""),
                    department=i.get("department", "Unknown"),
                    status=i.get("status", "pending"),
                    notes=i.get("notes"),
                )
                for i in finance_data_raw.get("pending_invoices", [])
            ]
            
            finance_data = FinanceData(
                departments=departments,
                pending_invoices=invoices,
                total_budget=finance_data_raw.get("total_budget"),
                total_spent=finance_data_raw.get("total_spent"),
                additional_metrics=finance_data_raw.get("additional_metrics", {}),
            )
            
            # Parse ops data
            ops_data_raw = data.get("ops_data", {})
            services = [
                Service(
                    name=s.get("name", "Unknown"),
                    status=s.get("status", "unknown"),
                    uptime_percent=float(s.get("uptime_percent", 0)),
                    incidents_24h=int(s.get("incidents_24h", 0)),
                    notes=s.get("notes"),
                )
                for s in ops_data_raw.get("services", [])
            ]
            
            incidents = [
                Incident(
                    incident_id=inc.get("incident_id", ""),
                    severity=inc.get("severity", "unknown"),
                    service=inc.get("service", "Unknown"),
                    description=inc.get("description", ""),
                    status=inc.get("status", "investigating"),
                    created_at=inc.get("created_at"),
                    resolved_at=inc.get("resolved_at"),
                )
                for inc in ops_data_raw.get("incidents", [])
            ]
            
            ops_data = OpsData(
                services=services,
                incidents=incidents,
                sla_compliance=ops_data_raw.get("sla_compliance"),
                additional_metrics=ops_data_raw.get("additional_metrics", {}),
            )
            
            # Parse expected outcomes
            outcomes_data = data.get("expected_outcomes", {})
            expected_outcomes = ExpectedOutcomes(
                finance_actions=outcomes_data.get("finance_actions", []),
                ops_actions=outcomes_data.get("ops_actions", []),
                executive_summary=outcomes_data.get("executive_summary", ""),
                success_criteria=outcomes_data.get("success_criteria", []),
            )
            
            # Create scenario
            scenario = Scenario(
                scenario_id=data.get("scenario_id", "unknown"),
                name=data.get("name", "Unknown Scenario"),
                description=data.get("description", ""),
                company=company,
                context=context,
                finance_data=finance_data,
                ops_data=ops_data,
                expected_outcomes=expected_outcomes,
                version=data.get("version", "1.0"),
                metadata=data.get("metadata", {}),
            )
            
            return scenario
            
        except KeyError as e:
            raise ScenarioLoadError(f"Missing required field: {e}")
        except (ValueError, TypeError) as e:
            raise ScenarioLoadError(f"Invalid data format: {e}")
    
    def clear_cache(self):
        """Clear the scenario cache."""
        self._cache.clear()
        logger.debug("Scenario cache cleared")
