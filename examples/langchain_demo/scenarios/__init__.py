"""
Scenario system for Caracal unified demo.

This module provides a structured system for defining, loading, and validating
realistic company scenarios that demonstrate Caracal's capabilities in multi-agent
AI systems.
"""

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
from .loader import ScenarioLoader
from .validator import ScenarioValidator

__all__ = [
    "CompanyInfo",
    "ScenarioContext",
    "FinanceData",
    "OpsData",
    "ExpectedOutcomes",
    "Scenario",
    "Department",
    "Invoice",
    "Service",
    "Incident",
    "ScenarioLoader",
    "ScenarioValidator",
]
