"""
MCP (Model Context Protocol) adapter for Caracal Core.

This module provides integration between Caracal authority enforcement
and the Model Context Protocol ecosystem.
"""

from caracal.mcp.adapter import MCPAdapter, MCPContext, MCPResult
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
    "MCPAdapterService",
    "MCPServiceConfig",
    "MCPServerConfig",
    "load_config_from_yaml",
    "load_config_from_env",
]

