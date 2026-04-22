"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

MCP (Model Context Protocol) adapter for Caracal Core.

This module provides integration between Caracal authority enforcement
and the Model Context Protocol ecosystem.
"""

from typing import TYPE_CHECKING

from caracal.mcp.adapter import MCPAdapter, MCPContext, MCPResult

if TYPE_CHECKING:
    from caracal.mcp.service import MCPAdapterService, MCPServiceConfig, MCPServerConfig

__all__ = [
    "MCPAdapter",
    "MCPContext",
    "MCPResult",
    "MCPAdapterService",
    "MCPServiceConfig",
    "MCPServerConfig",
]


def __getattr__(name: str):
    if name in {"MCPAdapterService", "MCPServiceConfig", "MCPServerConfig"}:
        from caracal.mcp import service as _service

        return getattr(_service, name)
    raise AttributeError(f"module 'caracal.mcp' has no attribute '{name}'")

