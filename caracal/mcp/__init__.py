"""
MCP (Model Context Protocol) adapter for Caracal Core.

This module provides integration between Caracal budget enforcement
and the Model Context Protocol ecosystem.
"""

from caracal.mcp.adapter import MCPAdapter, MCPContext, MCPResult
from caracal.mcp.cost_calculator import MCPCostCalculator
from caracal.mcp.service import (
    MCPAdapterService,
    MCPServiceConfig,
    MCPServerConfig,
    load_config_from_yaml,
    load_config_from_env,
)

__all__ = [
    "MCPAdapter",
    "MCPContext",
    "MCPResult",
    "MCPCostCalculator",
    "MCPAdapterService",
    "MCPServiceConfig",
    "MCPServerConfig",
    "load_config_from_yaml",
    "load_config_from_env",
]

