"""
Agent tools for Caracal unified demo.

This package provides specialized tools for different agent types, all integrated
with Caracal SDK for governed execution with mandate-based authority validation.

# CARACAL INTEGRATION POINT
# All tools in this package are designed to be executed through Caracal's
# governed pipeline with mandate_id for authority enforcement and provider routing.

Usage:
    from examples.langchain_demo.agents.tools import FinanceTools, OpsTools, SharedTools
    
    # Initialize tools with Caracal client
    finance_tools = FinanceTools(caracal_client, mode="mock")
    ops_tools = OpsTools(caracal_client, mode="mock")
    shared_tools = SharedTools(caracal_client, mode="mock")
    
    # Call tools with mandate_id
    result = await finance_tools.get_budget_data(
        mandate_id=agent_mandate_id,
        department="Engineering"
    )
"""

from examples.langchain_demo.agents.tools.finance_tools import (
    FinanceTools,
    FINANCE_TOOL_METHODS,
    ToolCallResult,
)
from examples.langchain_demo.agents.tools.ops_tools import (
    OpsTools,
    OPS_TOOL_METHODS,
)
from examples.langchain_demo.agents.tools.shared_tools import (
    SharedTools,
    SHARED_TOOL_METHODS,
)

__all__ = [
    # Tool classes
    "FinanceTools",
    "OpsTools",
    "SharedTools",
    # Tool method registries
    "FINANCE_TOOL_METHODS",
    "OPS_TOOL_METHODS",
    "SHARED_TOOL_METHODS",
    # Result type
    "ToolCallResult",
]


def create_tool_suite(caracal_client, mode: str = "mock"):
    """
    Create a complete suite of tools for agent use.
    
    # CARACAL INTEGRATION POINT
    # This factory function creates all tool instances with the same
    # Caracal client and mode, ensuring consistent governed execution.
    
    Args:
        caracal_client: Caracal client for governed tool execution
        mode: Execution mode ("mock" or "real")
    
    Returns:
        Dictionary containing all tool instances:
            - finance: FinanceTools instance
            - ops: OpsTools instance
            - shared: SharedTools instance
    """
    return {
        "finance": FinanceTools(caracal_client, mode),
        "ops": OpsTools(caracal_client, mode),
        "shared": SharedTools(caracal_client, mode),
    }


def get_all_tool_methods():
    """
    Get a complete list of all available tool methods across all tool classes.
    
    Returns:
        Dictionary mapping tool class names to their method lists
    """
    return {
        "finance": FINANCE_TOOL_METHODS,
        "ops": OPS_TOOL_METHODS,
        "shared": SHARED_TOOL_METHODS,
    }
