"""Runnable workflow for baseline LangChain swarm demo."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, List

from ..acceptance import attach_acceptance
from ..scenario_analysis import business_outcomes, format_mock_summary
from .agents import build_langchain_agents
from .tools import (
    assess_budget_risk,
    check_vendor_sla_breaches,
    get_finance_snapshot,
    get_ops_snapshot,
    list_unreconciled_invoices,
    set_scenario_context,
    summarize_recent_incidents,
)


def _extract_message_text(message: Any) -> str:
    if isinstance(message, dict):
        content = message.get("content")
        return str(content) if content is not None else str(message)

    content = getattr(message, "content", None)
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text", "")))
            else:
                parts.append(str(item))
        return "\n".join(part for part in parts if part)

    if content is not None:
        return str(content)

    text = getattr(message, "text", None)
    if text is not None:
        return str(text)

    return str(message)


def _extract_tool_call_names(message: Any) -> list[str]:
    names: list[str] = []
    tool_calls = getattr(message, "tool_calls", None)
    if isinstance(tool_calls, list):
        for entry in tool_calls:
            if isinstance(entry, dict):
                name = entry.get("name")
                if name:
                    names.append(str(name))
    return names


def _summarize_tool_invocations(invocations: list[str]) -> Dict[str, Any]:
    by_tool: Dict[str, int] = {}
    for name in invocations:
        by_tool[name] = by_tool.get(name, 0) + 1
    return {
        "total": len(invocations),
        "by_tool": by_tool,
    }


def run_mock_workflow(scenario: Dict[str, Any]) -> Dict[str, Any]:
    """Deterministic fallback path when provider credentials are absent."""
    set_scenario_context(scenario)

    finance_snapshot = get_finance_snapshot.invoke({})
    pending_invoices = list_unreconciled_invoices.invoke({})
    budget_risk = assess_budget_risk.invoke({"overrun_threshold_percent": 3.0})

    ops_snapshot = get_ops_snapshot.invoke({})
    incidents = summarize_recent_incidents.invoke({"hours": 24})
    sla_breaches = check_vendor_sla_breaches.invoke({})

    timeline = [
        {"step": 1, "actor": "finance", "action": "snapshot", "output": finance_snapshot},
        {"step": 2, "actor": "finance", "action": "invoices", "output": pending_invoices},
        {"step": 3, "actor": "finance", "action": "risk", "output": budget_risk},
        {"step": 4, "actor": "ops", "action": "snapshot", "output": ops_snapshot},
        {"step": 5, "actor": "ops", "action": "incidents", "output": incidents},
        {"step": 6, "actor": "ops", "action": "sla", "output": sla_breaches},
    ]
    mock_invocations = [
        "get_finance_snapshot",
        "list_unreconciled_invoices",
        "assess_budget_risk",
        "get_ops_snapshot",
        "summarize_recent_incidents",
        "check_vendor_sla_breaches",
    ]
    outcomes = business_outcomes(scenario)

    result = {
        "mode": "mock",
        "provider": "mock",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "input_prompt": scenario.get("user_prompt", ""),
        "timeline": timeline,
        "tool_invocation_summary": _summarize_tool_invocations(mock_invocations),
        "business_outcomes": outcomes,
        "final_summary": format_mock_summary(outcomes),
    }
    return attach_acceptance(result, scenario)


def run_langchain_workflow(
    scenario: Dict[str, Any],
    *,
    provider: str,
    model_id: str | None = None,
) -> Dict[str, Any]:
    set_scenario_context(scenario)
    agents = build_langchain_agents(provider=provider, model_id=model_id)

    user_prompt = str(scenario.get("user_prompt", "")).strip()
    payload = {"messages": [{"role": "user", "content": user_prompt}]}

    timeline: List[Dict[str, Any]] = []
    observed_tool_calls: list[str] = []
    final_summary = ""

    for idx, chunk in enumerate(agents.supervisor_agent.stream(payload, stream_mode="values"), start=1):
        messages = chunk.get("messages") if isinstance(chunk, dict) else None
        if not messages:
            continue

        last_message = messages[-1]
        rendered = _extract_message_text(last_message)
        role = getattr(last_message, "type", None) or getattr(last_message, "role", None) or "assistant"
        timeline.append(
            {
                "step": idx,
                "role": str(role),
                "message": rendered,
            }
        )
        observed_tool_calls.extend(_extract_tool_call_names(last_message))
        if rendered:
            final_summary = rendered

    if not final_summary:
        result = agents.supervisor_agent.invoke(payload)
        messages = result.get("messages", []) if isinstance(result, dict) else []
        if messages:
            final_summary = _extract_message_text(messages[-1])

    result = {
        "mode": "langchain",
        "provider": provider,
        "model_id": model_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "input_prompt": user_prompt,
        "timeline": timeline,
        "tool_invocation_summary": _summarize_tool_invocations(observed_tool_calls),
        "business_outcomes": business_outcomes(scenario),
        "final_summary": final_summary,
    }
    return attach_acceptance(result, scenario)


def write_output(path: str, payload: Dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
