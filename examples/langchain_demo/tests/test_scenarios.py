"""
Unit tests for the scenario system.

Tests cover scenario data classes, loader, and validator functionality.
Target: >85% code coverage
"""

import json
import pytest
from pathlib import Path
from typing import Dict, Any

from scenarios.base import (
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
from scenarios.loader import ScenarioLoader, ScenarioLoadError
from scenarios.validator import ScenarioValidator, ValidationError


# Test fixtures

@pytest.fixture
def sample_company():
    """Sample company info for testing."""
    return CompanyInfo(
        name="Test Corp",
        industry="Technology",
        size="100 employees",
        fiscal_year="2026"
    )


@pytest.fixture
def sample_context():
    """Sample scenario context for testing."""
    return ScenarioContext(
        quarter="Q1",
        month="January",
        trigger_event="Test event",
        additional_context={"test": "data"}
    )


@pytest.fixture
def sample_department():
    """Sample department for testing."""
    return Department(
        name="Engineering",
        budget=1000000,
        spent=950000,
        variance_percent=-5.0,
        status="on_budget",
        notes="Test notes"
    )


@pytest.fixture
def sample_invoice():
    """Sample invoice for testing."""
    return Invoice(
        invoice_id="INV-001",
        vendor="Test Vendor",
        amount=5000,
        due_date="2026-01-31",
        department="Engineering",
        status="pending",
        notes="Test invoice"
    )


@pytest.fixture
def sample_service():
    """Sample service for testing."""
    return Service(
        name="API Gateway",
        status="healthy",
        uptime_percent=99.9,
        incidents_24h=0,
        notes="All good"
    )


@pytest.fixture
def sample_incident():
    """Sample incident for testing."""
    return Incident(
        incident_id="INC-001",
        severity="low",
        service="API Gateway",
        description="Test incident",
        status="resolved",
        created_at="2026-01-15T10:00:00Z",
        resolved_at="2026-01-15T11:00:00Z"
    )


@pytest.fixture
def sample_finance_data(sample_department, sample_invoice):
    """Sample finance data for testing."""
    return FinanceData(
        departments=[sample_department],
        pending_invoices=[sample_invoice],
        total_budget=1000000,
        total_spent=950000,
        additional_metrics={"test": "metric"}
    )


@pytest.fixture
def sample_ops_data(sample_service, sample_incident):
    """Sample ops data for testing."""
    return OpsData(
        services=[sample_service],
        incidents=[sample_incident],
        sla_compliance=99.5,
        additional_metrics={"test": "metric"}
    )


@pytest.fixture
def sample_expected_outcomes():
    """Sample expected outcomes for testing."""
    return ExpectedOutcomes(
        finance_actions=["Action 1", "Action 2"],
        ops_actions=["Action 3", "Action 4"],
        executive_summary="Test summary",
        success_criteria=["Criterion 1", "Criterion 2"]
    )


@pytest.fixture
def sample_scenario(
    sample_company,
    sample_context,
    sample_finance_data,
    sample_ops_data,
    sample_expected_outcomes
):
    """Complete sample scenario for testing."""
    return Scenario(
        scenario_id="test_scenario",
        name="Test Scenario",
        description="A test scenario",
        company=sample_company,
        context=sample_context,
        finance_data=sample_finance_data,
        ops_data=sample_ops_data,
        expected_outcomes=sample_expected_outcomes,
        version="1.0",
        metadata={"test": "metadata"}
    )


@pytest.fixture
def temp_scenario_dir(tmp_path):
    """Create a temporary directory for scenario files."""
    scenario_dir = tmp_path / "scenarios"
    scenario_dir.mkdir()
    return scenario_dir


@pytest.fixture
def sample_scenario_json():
    """Sample scenario JSON data."""
    return {
        "scenario_id": "test",
        "name": "Test Scenario",
        "description": "Test description",
        "version": "1.0",
        "company": {
            "name": "Test Corp",
            "industry": "Technology",
            "size": "100 employees",
            "fiscal_year": "2026"
        },
        "context": {
            "quarter": "Q1",
            "month": "January",
            "trigger_event": "Test event",
            "additional_context": {}
        },
        "finance_data": {
            "departments": [
                {
                    "name": "Engineering",
                    "budget": 1000000,
                    "spent": 950000,
                    "variance_percent": -5.0,
                    "status": "on_budget",
                    "notes": "Test"
                }
            ],
            "pending_invoices": [
                {
                    "invoice_id": "INV-001",
                    "vendor": "Test Vendor",
                    "amount": 5000,
                    "due_date": "2026-01-31",
                    "department": "Engineering",
                    "status": "pending",
                    "notes": "Test"
                }
            ],
            "total_budget": 1000000,
            "total_spent": 950000,
            "additional_metrics": {}
        },
        "ops_data": {
            "services": [
                {
                    "name": "API Gateway",
                    "status": "healthy",
                    "uptime_percent": 99.9,
                    "incidents_24h": 0,
                    "notes": "Good"
                }
            ],
            "incidents": [
                {
                    "incident_id": "INC-001",
                    "severity": "low",
                    "service": "API Gateway",
                    "description": "Test",
                    "status": "resolved",
                    "created_at": "2026-01-15T10:00:00Z",
                    "resolved_at": "2026-01-15T11:00:00Z"
                }
            ],
            "sla_compliance": 99.5,
            "additional_metrics": {}
        },
        "expected_outcomes": {
            "finance_actions": ["Action 1"],
            "ops_actions": ["Action 2"],
            "executive_summary": "Summary",
            "success_criteria": ["Criterion 1"]
        },
        "metadata": {}
    }


# Tests for base data classes

class TestDataClasses:
    """Tests for scenario data classes."""
    
    def test_company_info_creation(self, sample_company):
        """Test CompanyInfo creation."""
        assert sample_company.name == "Test Corp"
        assert sample_company.industry == "Technology"
        assert sample_company.size == "100 employees"
        assert sample_company.fiscal_year == "2026"
    
    def test_scenario_context_creation(self, sample_context):
        """Test ScenarioContext creation."""
        assert sample_context.quarter == "Q1"
        assert sample_context.month == "January"
        assert sample_context.trigger_event == "Test event"
        assert sample_context.additional_context == {"test": "data"}
    
    def test_department_creation(self, sample_department):
        """Test Department creation."""
        assert sample_department.name == "Engineering"
        assert sample_department.budget == 1000000
        assert sample_department.spent == 950000
        assert sample_department.variance_percent == -5.0
        assert sample_department.status == "on_budget"
    
    def test_invoice_creation(self, sample_invoice):
        """Test Invoice creation."""
        assert sample_invoice.invoice_id == "INV-001"
        assert sample_invoice.vendor == "Test Vendor"
        assert sample_invoice.amount == 5000
        assert sample_invoice.department == "Engineering"
    
    def test_service_creation(self, sample_service):
        """Test Service creation."""
        assert sample_service.name == "API Gateway"
        assert sample_service.status == "healthy"
        assert sample_service.uptime_percent == 99.9
        assert sample_service.incidents_24h == 0
    
    def test_incident_creation(self, sample_incident):
        """Test Incident creation."""
        assert sample_incident.incident_id == "INC-001"
        assert sample_incident.severity == "low"
        assert sample_incident.service == "API Gateway"
        assert sample_incident.status == "resolved"
    
    def test_scenario_to_dict(self, sample_scenario):
        """Test Scenario.to_dict() method."""
        scenario_dict = sample_scenario.to_dict()
        
        assert scenario_dict["scenario_id"] == "test_scenario"
        assert scenario_dict["name"] == "Test Scenario"
        assert scenario_dict["company"]["name"] == "Test Corp"
        assert len(scenario_dict["finance_data"]["departments"]) == 1
        assert len(scenario_dict["ops_data"]["services"]) == 1


# Tests for ScenarioLoader

class TestScenarioLoader:
    """Tests for ScenarioLoader."""
    
    def test_loader_initialization_default_dir(self):
        """Test loader initialization with default directory."""
        loader = ScenarioLoader()
        assert loader.scenarios_dir.name == "definitions"
    
    def test_loader_initialization_custom_dir(self, temp_scenario_dir):
        """Test loader initialization with custom directory."""
        loader = ScenarioLoader(temp_scenario_dir)
        assert loader.scenarios_dir == temp_scenario_dir
    
    def test_load_scenario_from_file(self, temp_scenario_dir, sample_scenario_json):
        """Test loading a scenario from a JSON file."""
        # Create a test scenario file
        scenario_file = temp_scenario_dir / "test.json"
        with open(scenario_file, "w") as f:
            json.dump(sample_scenario_json, f)
        
        loader = ScenarioLoader(temp_scenario_dir)
        scenario = loader.load_scenario("test")
        
        assert scenario.scenario_id == "test"
        assert scenario.name == "Test Scenario"
        assert scenario.company.name == "Test Corp"
        assert len(scenario.finance_data.departments) == 1
        assert len(scenario.ops_data.services) == 1
    
    def test_load_scenario_caching(self, temp_scenario_dir, sample_scenario_json):
        """Test that scenarios are cached after first load."""
        scenario_file = temp_scenario_dir / "test.json"
        with open(scenario_file, "w") as f:
            json.dump(sample_scenario_json, f)
        
        loader = ScenarioLoader(temp_scenario_dir)
        
        # Load twice
        scenario1 = loader.load_scenario("test")
        scenario2 = loader.load_scenario("test")
        
        # Should be the same object (cached)
        assert scenario1 is scenario2
    
    def test_load_scenario_not_found(self, temp_scenario_dir):
        """Test loading a non-existent scenario."""
        loader = ScenarioLoader(temp_scenario_dir)
        
        with pytest.raises(ScenarioLoadError, match="Scenario file not found"):
            loader.load_scenario("nonexistent")
    
    def test_load_scenario_invalid_json(self, temp_scenario_dir):
        """Test loading a scenario with invalid JSON."""
        scenario_file = temp_scenario_dir / "invalid.json"
        with open(scenario_file, "w") as f:
            f.write("{ invalid json }")
        
        loader = ScenarioLoader(temp_scenario_dir)
        
        with pytest.raises(ScenarioLoadError, match="Invalid JSON"):
            loader.load_scenario("invalid")
    
    def test_load_all_scenarios(self, temp_scenario_dir, sample_scenario_json):
        """Test loading all scenarios from directory."""
        # Create multiple scenario files
        for i in range(3):
            scenario_data = sample_scenario_json.copy()
            scenario_data["scenario_id"] = f"test{i}"
            scenario_file = temp_scenario_dir / f"test{i}.json"
            with open(scenario_file, "w") as f:
                json.dump(scenario_data, f)
        
        loader = ScenarioLoader(temp_scenario_dir)
        scenarios = loader.load_all_scenarios()
        
        assert len(scenarios) == 3
        assert "test0" in scenarios
        assert "test1" in scenarios
        assert "test2" in scenarios
    
    def test_list_available_scenarios(self, temp_scenario_dir, sample_scenario_json):
        """Test listing available scenario IDs."""
        # Create scenario files
        for i in range(2):
            scenario_file = temp_scenario_dir / f"test{i}.json"
            with open(scenario_file, "w") as f:
                json.dump(sample_scenario_json, f)
        
        loader = ScenarioLoader(temp_scenario_dir)
        scenario_ids = loader.list_available_scenarios()
        
        assert len(scenario_ids) == 2
        assert "test0" in scenario_ids
        assert "test1" in scenario_ids
    
    def test_clear_cache(self, temp_scenario_dir, sample_scenario_json):
        """Test clearing the scenario cache."""
        scenario_file = temp_scenario_dir / "test.json"
        with open(scenario_file, "w") as f:
            json.dump(sample_scenario_json, f)
        
        loader = ScenarioLoader(temp_scenario_dir)
        
        # Load and cache
        scenario1 = loader.load_scenario("test")
        
        # Clear cache
        loader.clear_cache()
        
        # Load again - should be a new object
        scenario2 = loader.load_scenario("test")
        
        assert scenario1 is not scenario2


# Tests for ScenarioValidator

class TestScenarioValidator:
    """Tests for ScenarioValidator."""
    
    def test_validator_initialization(self):
        """Test validator initialization."""
        validator = ScenarioValidator(strict=True)
        assert validator.strict is True
        assert validator.errors == []
        assert validator.warnings == []
    
    def test_validate_valid_scenario(self, sample_scenario):
        """Test validating a valid scenario."""
        validator = ScenarioValidator(strict=True)
        result = validator.validate(sample_scenario)
        
        assert result is True
        assert len(validator.errors) == 0
    
    def test_validate_missing_scenario_id(self, sample_scenario):
        """Test validation fails for missing scenario_id."""
        sample_scenario.scenario_id = ""
        
        validator = ScenarioValidator(strict=True)
        
        with pytest.raises(ValidationError, match="scenario_id is required"):
            validator.validate(sample_scenario)
    
    def test_validate_missing_name(self, sample_scenario):
        """Test validation fails for missing name."""
        sample_scenario.name = ""
        
        validator = ScenarioValidator(strict=True)
        
        with pytest.raises(ValidationError, match="name is required"):
            validator.validate(sample_scenario)
    
    def test_validate_negative_budget(self, sample_scenario):
        """Test validation fails for negative budget."""
        sample_scenario.finance_data.departments[0].budget = -1000
        
        validator = ScenarioValidator(strict=True)
        
        with pytest.raises(ValidationError, match="budget cannot be negative"):
            validator.validate(sample_scenario)
    
    def test_validate_negative_spent(self, sample_scenario):
        """Test validation fails for negative spent amount."""
        sample_scenario.finance_data.departments[0].spent = -500
        
        validator = ScenarioValidator(strict=True)
        
        with pytest.raises(ValidationError, match="spent cannot be negative"):
            validator.validate(sample_scenario)
    
    def test_validate_invalid_uptime(self, sample_scenario):
        """Test validation fails for invalid uptime percentage."""
        sample_scenario.ops_data.services[0].uptime_percent = 150
        
        validator = ScenarioValidator(strict=True)
        
        with pytest.raises(ValidationError, match="uptime_percent must be between 0 and 100"):
            validator.validate(sample_scenario)
    
    def test_validate_negative_incidents(self, sample_scenario):
        """Test validation fails for negative incident count."""
        sample_scenario.ops_data.services[0].incidents_24h = -1
        
        validator = ScenarioValidator(strict=True)
        
        with pytest.raises(ValidationError, match="incidents_24h cannot be negative"):
            validator.validate(sample_scenario)
    
    def test_validate_non_strict_mode(self, sample_scenario):
        """Test validation in non-strict mode logs warnings instead of raising."""
        sample_scenario.scenario_id = ""
        
        validator = ScenarioValidator(strict=False)
        result = validator.validate(sample_scenario)
        
        assert result is False
        assert len(validator.errors) > 0
    
    def test_validate_warnings(self, sample_scenario):
        """Test that warnings are collected."""
        sample_scenario.description = ""
        
        validator = ScenarioValidator(strict=True)
        validator.validate(sample_scenario)
        
        assert len(validator.warnings) > 0
        assert any("description is empty" in w for w in validator.warnings)
    
    def test_get_validation_report(self, sample_scenario):
        """Test getting a validation report."""
        sample_scenario.scenario_id = ""
        sample_scenario.description = ""
        
        validator = ScenarioValidator(strict=False)
        validator.validate(sample_scenario)
        
        report = validator.get_validation_report()
        
        assert "Errors" in report
        assert "Warnings" in report


# Integration tests

class TestScenarioSystemIntegration:
    """Integration tests for the complete scenario system."""
    
    def test_load_and_validate_real_scenarios(self):
        """Test loading and validating real scenario definitions."""
        # Get the actual scenarios directory
        scenarios_dir = Path(__file__).parent.parent / "scenarios" / "definitions"
        
        if not scenarios_dir.exists():
            pytest.skip("Scenarios directory not found")
        
        loader = ScenarioLoader(scenarios_dir)
        validator = ScenarioValidator(strict=False)
        
        # Load all scenarios
        scenarios = loader.load_all_scenarios()
        
        # Validate each scenario
        for scenario_id, scenario in scenarios.items():
            result = validator.validate(scenario)
            # Should pass validation (may have warnings)
            assert result is True or len(validator.errors) == 0, \
                f"Scenario {scenario_id} failed validation: {validator.errors}"
    
    def test_scenario_round_trip(self, temp_scenario_dir, sample_scenario):
        """Test converting scenario to dict and back."""
        # Convert to dict
        scenario_dict = sample_scenario.to_dict()
        
        # Save to file
        scenario_file = temp_scenario_dir / "roundtrip.json"
        with open(scenario_file, "w") as f:
            json.dump(scenario_dict, f)
        
        # Load back
        loader = ScenarioLoader(temp_scenario_dir)
        loaded_scenario = loader.load_scenario("roundtrip")
        
        # Verify key fields match
        assert loaded_scenario.scenario_id == sample_scenario.scenario_id
        assert loaded_scenario.name == sample_scenario.name
        assert loaded_scenario.company.name == sample_scenario.company.name
        assert len(loaded_scenario.finance_data.departments) == len(sample_scenario.finance_data.departments)
