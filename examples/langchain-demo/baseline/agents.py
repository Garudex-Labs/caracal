"""LangChain agent construction using built-in create_agent patterns."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

from langchain.agents import create_agent
from langchain.chat_models import init_chat_model
from langchain.tools import tool

from .tools import (
    assess_budget_risk,
    check_vendor_sla_breaches,
    get_finance_snapshot,
    get_ops_snapshot,
    list_unreconciled_invoices,
    summarize_recent_incidents,
)


@dataclass
class BaselineAgents:
    finance_agent: Any
    ops_agent: Any
    supervisor_agent: Any


def _extract_text(message: Any) -> str:
    if isinstance(message, dict):
        content = message.get("content")
        return str(content) if content is not None else str(message)

    content = getattr(message, "content", None)
    if isinstance(content, list):
        text_parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                text_parts.append(str(item.get("text", "")))
            else:
                text_parts.append(str(item))
        return "\n".join(part for part in text_parts if part)

    if content is not None:
        return str(content)

    text = getattr(message, "text", None)
    if text is not None:
        return str(text)

    return str(message)


def _extract_last_message_text(result: Any) -> str:
    if isinstance(result, dict):
        messages = result.get("messages")
        if isinstance(messages, list) and messages:
            return _extract_text(messages[-1])
    return str(result)


def _resolve_model_id(provider: str, model_id: str | None = None) -> str:
    if model_id:
        return model_id

    provider_norm = provider.strip().lower()
    if provider_norm == "openai":
        return os.getenv("BASELINE_OPENAI_MODEL", "openai:gpt-4.1-mini")
    if provider_norm == "gemini":
        return os.getenv("BASELINE_GEMINI_MODEL", "google_genai:gemini-2.0-flash")

    if ":" in provider_norm:
        return provider_norm

    raise ValueError(
        "Unsupported provider. Use openai, gemini, or a full model id like provider:model"
    )


def build_langchain_agents(provider: str, model_id: str | None = None) -> BaselineAgents:
    resolved_model = _resolve_model_id(provider=provider, model_id=model_id)
    model = init_chat_model(resolved_model)

    finance_agent = create_agent(
        model,
        tools=[get_finance_snapshot, list_unreconciled_invoices, assess_budget_risk],
        system_prompt=(
            "You are the finance specialist. Use tools first, then provide concise findings "
            "and immediate actions."
        ),
    )

    ops_agent = create_agent(
        model,
        tools=[get_ops_snapshot, summarize_recent_incidents, check_vendor_sla_breaches],
        system_prompt=(
            "You are the operations specialist. Use tools first, then provide concise findings "
            "and immediate actions."
        ),
    )

    # Tool-per-agent wrapper pattern from LangChain multi-agent docs.
    @tool
    def run_finance_specialist(request: str) -> str:
        """Delegate a request to the finance specialist sub-agent."""
        result = finance_agent.invoke({"messages": [{"role": "user", "content": request}]})
        return _extract_last_message_text(result)

    @tool
    def run_ops_specialist(request: str) -> str:
        """Delegate a request to the ops specialist sub-agent."""
        result = ops_agent.invoke({"messages": [{"role": "user", "content": request}]})
        return _extract_last_message_text(result)

    supervisor_agent = create_agent(
        model,
        tools=[run_finance_specialist, run_ops_specialist],
        system_prompt=(
            "You are the orchestrator. Gather findings from finance and operations specialists, "
            "then produce one actionable executive summary with prioritized next steps."
        ),
    )

    return BaselineAgents(
        finance_agent=finance_agent,
        ops_agent=ops_agent,
        supervisor_agent=supervisor_agent,
    )
