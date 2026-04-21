"""Shared runtime for the Caracal-backed LangChain demo.

This runtime uses the same governed Caracal flow in both mock and real modes:
- SDK tool calls with Bearer token authentication
- Authority validated internally by Caracal (principal → mandate → policy)
- Provider routing handled by Caracal tool registry
- Mock vs real determined by which tools/providers are registered

The ONLY difference between modes is which tool IDs are used. Mock tools
route to mock providers (deterministic responses). Real tools route to
real providers (actual API calls). Caracal itself is always real.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .acceptance import attach_acceptance
from .caracal.client import GovernedClientConfig, GovernedToolClient
from .demo_contract import TOOL_IDS, TOOL_SCOPE_MAP, llm_tool_key
from .runtime_config import load_demo_runtime_config
from .scenario_analysis import business_outcomes, format_mock_summary


ROLE_ORDER = ("finance", "ops", "orchestrator")


@dataclass(frozen=True)
class DemoRunConfig:
    mode: str = "mock"
    provider_strategy: str = "mixed"


def _iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _scope_pair(tool_id: str) -> tuple[str, str]:
    try:
        return TOOL_SCOPE_MAP[tool_id]
    except KeyError as exc:
        raise RuntimeError(f"Missing scope mapping for tool_id '{tool_id}'") from exc


def _provider_from_resource_scope(resource_scope: str) -> str:
    parts = str(resource_scope or "").split(":")
    if len(parts) >= 3:
        return parts[1]
    return "unknown-provider"


def _normalize_tool_result(response: dict[str, Any]) -> dict[str, Any]:
    raw = response.get("result")
    if isinstance(raw, dict) and isinstance(raw.get("content"), dict):
        return dict(raw.get("content") or {})
    if isinstance(raw, dict):
        return dict(raw)
    return {"value": raw}


def _response_success(response: dict[str, Any]) -> bool:
    if "success" in response:
        return bool(response.get("success"))
    return "error" not in response


def _response_error_text(response: dict[str, Any]) -> str:
    error = response.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or error)
    return str(error or "unknown error")


async def _call_governed_tool(
    client: GovernedToolClient,
    *,
    mode: str,
    role: str,
    tool_key: str,
    tool_args: dict[str, Any],
    step: int,
    trace_id: str,
    timeline: list[dict[str, Any]],
    authority_decisions: list[dict[str, Any]],
    provider_counts: dict[str, int],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Call a tool through Caracal and record the result.

    Authority validation happens inside Caracal. We observe the outcome:
    - success=True means authority was granted and the tool executed
    - success=False means authority was denied or tool execution failed
    """
    tool_id = TOOL_IDS[mode][tool_key]
    resource_scope, action_scope = _scope_pair(tool_id)

    response = await client.call_tool(
        tool_id=tool_id,
        tool_args=tool_args,
        correlation_id=trace_id,
    )

    metadata = dict(response.get("metadata") or {})
    success = _response_success(response)
    provider_name = str(
        metadata.get("provider_name") or _provider_from_resource_scope(resource_scope)
    )

    authority_decisions.append({
        "timestamp": _iso_now(),
        "role": role,
        "tool_id": tool_id,
        "resource_scope": resource_scope,
        "action_scope": action_scope,
        "allowed": success,
        "reason": (
            "Authority granted by Caracal"
            if success
            else _response_error_text(response)
        ),
        "provider_name": provider_name,
    })

    if not success:
        raise RuntimeError(
            f"Tool call denied or failed for {tool_id}: {_response_error_text(response)}"
        )

    provider_counts[provider_name] = provider_counts.get(provider_name, 0) + 1

    content = _normalize_tool_result(response)
    timeline.append({
        "step": step,
        "role": role,
        "tool_id": tool_id,
        "tool_key": tool_key,
        "execution_mode": metadata.get("execution_mode"),
        "provider_name": provider_name,
        "output": content,
    })
    return content, response


async def run_demo_workflow_async(
    scenario: dict[str, Any],
    config: DemoRunConfig,
) -> dict[str, Any]:
    """Execute the full governed workflow through Caracal.

    Steps:
    1. Finance data retrieval (via Caracal → mock/real finance API)
    2. Finance LLM brief (via Caracal → mock/real OpenAI/Gemini)
    3. Ops data retrieval (via Caracal → mock/real ops API)
    4. Ops LLM brief (via Caracal → mock/real OpenAI/Gemini)
    5. Orchestrator assembly (via Caracal → control-plane handler)
    6. Ticket creation (via Caracal → mock/real ticketing API)

    All calls go through Caracal's authority enforcement pipeline.
    """
    runtime_config = load_demo_runtime_config(require_api_key=True)
    mode_config = runtime_config.modes[config.mode]
    mode_tools = TOOL_IDS[config.mode]

    finance_llm_key = llm_tool_key("finance", config.provider_strategy)
    ops_llm_key = llm_tool_key("ops", config.provider_strategy)

    client = GovernedToolClient(
        GovernedClientConfig(
            api_key=runtime_config.caracal.api_key,
            base_url=runtime_config.caracal.base_url,
            organization_id=runtime_config.caracal.organization_id,
            workspace_id=runtime_config.caracal.workspace_id,
            project_id=runtime_config.caracal.project_id,
        )
    )

    timeline: list[dict[str, Any]] = []
    authority_decisions: list[dict[str, Any]] = []
    provider_counts: dict[str, int] = {}

    try:
        finance_data, finance_data_response = await _call_governed_tool(
            client,
            mode=config.mode,
            role="finance",
            tool_key="finance_data",
            tool_args={"scenario": scenario},
            step=1,
            trace_id="finance-data",
            timeline=timeline,
            authority_decisions=authority_decisions,
            provider_counts=provider_counts,
        )

        finance_brief, finance_brief_response = await _call_governed_tool(
            client,
            mode=config.mode,
            role="finance",
            tool_key=finance_llm_key,
            tool_args={
                "analysis_kind": "finance",
                "prompt": (
                    "Review this finance package and provide a concise specialist brief.\n\n"
                    + str(finance_data)
                ),
            },
            step=2,
            trace_id="finance-brief",
            timeline=timeline,
            authority_decisions=authority_decisions,
            provider_counts=provider_counts,
        )

        ops_data, ops_data_response = await _call_governed_tool(
            client,
            mode=config.mode,
            role="ops",
            tool_key="ops_data",
            tool_args={"scenario": scenario},
            step=3,
            trace_id="ops-data",
            timeline=timeline,
            authority_decisions=authority_decisions,
            provider_counts=provider_counts,
        )

        ops_brief, ops_brief_response = await _call_governed_tool(
            client,
            mode=config.mode,
            role="ops",
            tool_key=ops_llm_key,
            tool_args={
                "analysis_kind": "ops",
                "prompt": (
                    "Review this operations package and provide a concise specialist brief.\n\n"
                    + str(ops_data)
                ),
            },
            step=4,
            trace_id="ops-brief",
            timeline=timeline,
            authority_decisions=authority_decisions,
            provider_counts=provider_counts,
        )

        assembled, assemble_response = await _call_governed_tool(
            client,
            mode=config.mode,
            role="orchestrator",
            tool_key="orchestrator_assemble",
            tool_args={
                "scenario": scenario,
                "finance_data": finance_data,
                "finance_brief": finance_brief,
                "ops_data": ops_data,
                "ops_brief": ops_brief,
                "mode_label": config.mode,
            },
            step=5,
            trace_id="orchestrator-assemble",
            timeline=timeline,
            authority_decisions=authority_decisions,
            provider_counts=provider_counts,
        )

        ticket_payload = {
            "title": f"{scenario.get('company', 'company')}: governed action plan",
            "owner": "orchestrator",
            "summary": str(assembled.get("summary") or "").strip()[:300],
        }
        ticket_result, ticket_response = await _call_governed_tool(
            client,
            mode=config.mode,
            role="orchestrator",
            tool_key="ticket_create",
            tool_args=ticket_payload,
            step=6,
            trace_id="orchestrator-ticket",
            timeline=timeline,
            authority_decisions=authority_decisions,
            provider_counts=provider_counts,
        )

        outcomes = assembled.get("business_outcomes") if isinstance(assembled, dict) else None
        if not isinstance(outcomes, dict):
            outcomes = business_outcomes(scenario)

        summary = str(
            (assembled.get("summary") if isinstance(assembled, dict) else "")
            or format_mock_summary(outcomes, governed=True)
        ).strip()

        identities = []
        principal_ids = mode_config.principal_ids or {}
        for role in ROLE_ORDER:
            identities.append({
                "role": role,
                "principal_id": principal_ids.get(role, "(from Bearer token)"),
            })

        result = {
            "mode": f"caracal-demo-{config.mode}",
            "provider_strategy": config.provider_strategy,
            "timestamp": _iso_now(),
            "input_prompt": scenario.get("user_prompt", ""),
            "final_summary": summary,
            "timeline": timeline,
            "business_outcomes": outcomes,
            "ticket": ticket_result,
            "identities": identities,
            "authority_decisions": authority_decisions,
            "provider_usage": [
                {"provider_name": name, "call_count": count}
                for name, count in sorted(provider_counts.items())
            ],
            "execution_contract": {
                "mode": config.mode,
                "tools": {
                    "finance_data": mode_tools["finance_data"],
                    "finance_brief": mode_tools[finance_llm_key],
                    "ops_data": mode_tools["ops_data"],
                    "ops_brief": mode_tools[ops_llm_key],
                    "orchestrator_assemble": mode_tools["orchestrator_assemble"],
                    "ticket_create": mode_tools["ticket_create"],
                },
            },
            "caracal_runtime": {
                "sdk_endpoint": runtime_config.caracal.base_url.rstrip("/") + "/mcp/tool/call",
                "workspace_id": runtime_config.caracal.workspace_id,
                "organization_id": runtime_config.caracal.organization_id,
                "project_id": runtime_config.caracal.project_id,
                "config_path": str(runtime_config.path),
            },
        }
        return attach_acceptance(result, scenario)
    finally:
        client.close()


def run_demo_workflow(scenario: dict[str, Any], config: DemoRunConfig) -> dict[str, Any]:
    return asyncio.run(run_demo_workflow_async(scenario, config))
