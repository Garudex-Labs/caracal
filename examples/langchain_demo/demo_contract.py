"""Static provider/tool contract for the LangChain demo."""

from __future__ import annotations

from typing import Literal

ModeName = Literal["mock", "real"]
StrategyName = Literal["mixed", "openai", "gemini"]


PROVIDERS: dict[ModeName, dict[str, str]] = {
    "mock": {
        "finance_api": "demo-finance-api-mock",
        "ops_api": "demo-ops-api-mock",
        "ticketing_api": "demo-ticketing-api-mock",
        "openai": "demo-openai-mock",
        "gemini": "demo-gemini-mock",
        "control": "demo-control-plane",
    },
    "real": {
        "finance_api": "demo-finance-api-real",
        "ops_api": "demo-ops-api-real",
        "ticketing_api": "demo-ticketing-api-real",
        "openai": "demo-openai-real",
        "gemini": "demo-gemini-real",
        "control": "demo-control-plane",
    },
}

TOOL_IDS: dict[ModeName, dict[str, str]] = {
    "mock": {
        "finance_data": "demo:employee:mock:finance:data",
        "finance_brief_openai": "demo:employee:mock:finance:llm:openai",
        "finance_brief_gemini": "demo:employee:mock:finance:llm:gemini",
        "ops_data": "demo:employee:mock:ops:data",
        "ops_brief_openai": "demo:employee:mock:ops:llm:openai",
        "ops_brief_gemini": "demo:employee:mock:ops:llm:gemini",
        "ticket_create": "demo:employee:mock:ticket:create",
        "orchestrator_assemble": "demo:employee:orchestrator:assemble",
    },
    "real": {
        "finance_data": "demo:employee:real:finance:data",
        "finance_brief_openai": "demo:employee:real:finance:llm:openai",
        "finance_brief_gemini": "demo:employee:real:finance:llm:gemini",
        "ops_data": "demo:employee:real:ops:data",
        "ops_brief_openai": "demo:employee:real:ops:llm:openai",
        "ops_brief_gemini": "demo:employee:real:ops:llm:gemini",
        "ticket_create": "demo:employee:real:ticket:create",
        "orchestrator_assemble": "demo:employee:orchestrator:assemble",
    },
}

TOOL_SCOPE_MAP: dict[str, tuple[str, str]] = {
    TOOL_IDS["mock"]["finance_data"]: (
        "provider:demo-finance-api-mock:resource:budgets",
        "provider:demo-finance-api-mock:action:read",
    ),
    TOOL_IDS["mock"]["finance_brief_openai"]: (
        "provider:demo-openai-mock:resource:chat.completions",
        "provider:demo-openai-mock:action:invoke",
    ),
    TOOL_IDS["mock"]["finance_brief_gemini"]: (
        "provider:demo-gemini-mock:resource:generateContent",
        "provider:demo-gemini-mock:action:invoke",
    ),
    TOOL_IDS["mock"]["ops_data"]: (
        "provider:demo-ops-api-mock:resource:incidents",
        "provider:demo-ops-api-mock:action:read",
    ),
    TOOL_IDS["mock"]["ops_brief_openai"]: (
        "provider:demo-openai-mock:resource:chat.completions",
        "provider:demo-openai-mock:action:invoke",
    ),
    TOOL_IDS["mock"]["ops_brief_gemini"]: (
        "provider:demo-gemini-mock:resource:generateContent",
        "provider:demo-gemini-mock:action:invoke",
    ),
    TOOL_IDS["mock"]["ticket_create"]: (
        "provider:demo-ticketing-api-mock:resource:tickets",
        "provider:demo-ticketing-api-mock:action:create",
    ),
    TOOL_IDS["real"]["finance_data"]: (
        "provider:demo-finance-api-real:resource:budgets",
        "provider:demo-finance-api-real:action:read",
    ),
    TOOL_IDS["real"]["finance_brief_openai"]: (
        "provider:demo-openai-real:resource:chat.completions",
        "provider:demo-openai-real:action:invoke",
    ),
    TOOL_IDS["real"]["finance_brief_gemini"]: (
        "provider:demo-gemini-real:resource:generateContent",
        "provider:demo-gemini-real:action:invoke",
    ),
    TOOL_IDS["real"]["ops_data"]: (
        "provider:demo-ops-api-real:resource:incidents",
        "provider:demo-ops-api-real:action:read",
    ),
    TOOL_IDS["real"]["ops_brief_openai"]: (
        "provider:demo-openai-real:resource:chat.completions",
        "provider:demo-openai-real:action:invoke",
    ),
    TOOL_IDS["real"]["ops_brief_gemini"]: (
        "provider:demo-gemini-real:resource:generateContent",
        "provider:demo-gemini-real:action:invoke",
    ),
    TOOL_IDS["real"]["ticket_create"]: (
        "provider:demo-ticketing-api-real:resource:tickets",
        "provider:demo-ticketing-api-real:action:create",
    ),
    TOOL_IDS["mock"]["orchestrator_assemble"]: (
        "provider:demo-control-plane:resource:orchestrator",
        "provider:demo-control-plane:action:assemble",
    ),
}


def llm_tool_key(role: str, strategy: StrategyName) -> str:
    normalized_role = str(role or "").strip().lower()
    normalized_strategy = str(strategy or "mixed").strip().lower()
    if normalized_role not in {"finance", "ops"}:
        raise ValueError(f"Unsupported role for LLM tool resolution: {role}")

    if normalized_strategy == "openai":
        return f"{normalized_role}_brief_openai"
    if normalized_strategy == "gemini":
        return f"{normalized_role}_brief_gemini"
    if normalized_role == "finance":
        return "finance_brief_openai"
    return "ops_brief_gemini"
