"""Shared runtime for the Caracal-backed LangChain demo application.

This runtime intentionally uses the same governed Caracal flow in both modes:
- SDK tool calls through the current thin SDK
- provider/tool mapping in the Caracal registry
- token-scoped execution with runtime-owned authority enforcement

Mock mode differs only in which providers/tools are selected. The configured
mock providers return deterministic payloads and do not require real API keys.
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
    include_revocation_check: bool = True


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


def _authority_validation_record(
    *,
    role: str,
    tool_id: str,
    mandate_id: str,
    principal_id: str | None,
    resource_scope: str,
    action_scope: str,
    response: dict[str, Any],
) -> dict[str, Any]:
    metadata = dict(response.get("metadata") or {})
    success = _response_success(response)
    reason = (
        "Tool execution accepted by the Caracal runtime."
        if success
        else _response_error_text(response)
    )
    return {
        "timestamp": _iso_now(),
        "role": role,
        "tool_id": tool_id,
        "configured_mandate_id": mandate_id,
        "caller_principal_id": principal_id,
        "requested_resource": resource_scope,
        "requested_action": action_scope,
        "allowed": success,
        "reason": reason,
        "validation_source": "mcp.tool.call",
        "provider_name": metadata.get("provider_name"),
        "execution_mode": metadata.get("execution_mode"),
    }


async def _call_governed_tool(
    client: GovernedToolClient,
    *,
    mode: str,
    role: str,
    tool_key: str,
    mandate_id: str,
    tool_args: dict[str, Any],
    step: int,
    trace_id: str,
    timeline: list[dict[str, Any]],
    authority_validations: list[dict[str, Any]],
    provider_counts: dict[str, int],
) -> tuple[dict[str, Any], dict[str, Any]]:
    tool_id = TOOL_IDS[mode][tool_key]
    resource_scope, action_scope = _scope_pair(tool_id)

    response = await client.call_tool(
        tool_id=tool_id,
        tool_args=tool_args,
        correlation_id=trace_id,
    )
    authority_validations.append(
        _authority_validation_record(
            role=role,
            tool_id=tool_id,
            mandate_id=mandate_id,
            principal_id=None,
            resource_scope=resource_scope,
            action_scope=action_scope,
            response=response,
        )
    )
    if not _response_success(response):
        raise RuntimeError(
            f"Tool call failed for {tool_id}: {_response_error_text(response)}"
        )

    metadata = dict(response.get("metadata") or {})
    provider_name = str(metadata.get("provider_name") or _provider_from_resource_scope(resource_scope))
    provider_counts[provider_name] = provider_counts.get(provider_name, 0) + 1

    content = _normalize_tool_result(response)
    timeline.append(
        {
            "step": step,
            "role": role,
            "tool_id": tool_id,
            "tool_key": tool_key,
            "mandate_id": mandate_id,
            "execution_mode": metadata.get("execution_mode"),
            "provider_name": provider_name,
            "output": content,
        }
    )
    return content, response


async def run_demo_workflow_async(
    scenario: dict[str, Any],
    config: DemoRunConfig,
) -> dict[str, Any]:
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
    authority_validations: list[dict[str, Any]] = []
    provider_counts: dict[str, int] = {}

    finance_mandate = mode_config.mandates["finance"]
    ops_mandate = mode_config.mandates["ops"]
    orchestrator_mandate = mode_config.mandates["orchestrator"]
    principal_ids = mode_config.principal_ids or {}

    try:
        finance_data, finance_data_response = await _call_governed_tool(
            client,
            mode=config.mode,
            role="finance",
            tool_key="finance_data",
            mandate_id=finance_mandate,
            tool_args={"scenario": scenario},
            step=1,
            trace_id="finance-data",
            timeline=timeline,
            authority_validations=authority_validations,
            provider_counts=provider_counts,
        )
        authority_validations[-1]["caller_principal_id"] = principal_ids.get("finance")

        finance_brief, finance_brief_response = await _call_governed_tool(
            client,
            mode=config.mode,
            role="finance",
            tool_key=finance_llm_key,
            mandate_id=finance_mandate,
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
            authority_validations=authority_validations,
            provider_counts=provider_counts,
        )
        authority_validations[-1]["caller_principal_id"] = principal_ids.get("finance")

        ops_data, ops_data_response = await _call_governed_tool(
            client,
            mode=config.mode,
            role="ops",
            tool_key="ops_data",
            mandate_id=ops_mandate,
            tool_args={"scenario": scenario},
            step=3,
            trace_id="ops-data",
            timeline=timeline,
            authority_validations=authority_validations,
            provider_counts=provider_counts,
        )
        authority_validations[-1]["caller_principal_id"] = principal_ids.get("ops")

        ops_brief, ops_brief_response = await _call_governed_tool(
            client,
            mode=config.mode,
            role="ops",
            tool_key=ops_llm_key,
            mandate_id=ops_mandate,
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
            authority_validations=authority_validations,
            provider_counts=provider_counts,
        )
        authority_validations[-1]["caller_principal_id"] = principal_ids.get("ops")

        assembled, assemble_response = await _call_governed_tool(
            client,
            mode=config.mode,
            role="orchestrator",
            tool_key="orchestrator_assemble",
            mandate_id=orchestrator_mandate,
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
            authority_validations=authority_validations,
            provider_counts=provider_counts,
        )
        authority_validations[-1]["caller_principal_id"] = principal_ids.get("orchestrator")

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
            mandate_id=orchestrator_mandate,
            tool_args=ticket_payload,
            step=6,
            trace_id="orchestrator-ticket",
            timeline=timeline,
            authority_validations=authority_validations,
            provider_counts=provider_counts,
        )
        authority_validations[-1]["caller_principal_id"] = principal_ids.get("orchestrator")

        revocation: dict[str, Any] = {
            "executed": False,
            "revoked_mandate_id": None,
            "denial_captured": False,
            "denial_evidence": None,
            "revoke_response": None,
            "skipped_reason": None,
        }
        if config.include_revocation_check:
            revocation["skipped_reason"] = (
                "The current SDK is execution-only. Revoke mandates via Caracal CLI/Flow "
                "and rerun the demo to observe denial through the runtime."
            )

        authority_ledger_events = [
            {
                "event_type": "tool_call",
                "role": validation["role"],
                "tool_id": validation["tool_id"],
                "mandate_id": validation["configured_mandate_id"],
                "principal_id": validation["caller_principal_id"],
                "provider_name": validation.get("provider_name"),
                "execution_mode": validation.get("execution_mode"),
                "allowed": validation["allowed"],
                "reason": validation["reason"],
                "timestamp": validation["timestamp"],
            }
            for validation in authority_validations
        ]

        outcomes = assembled.get("business_outcomes") if isinstance(assembled, dict) else None
        if not isinstance(outcomes, dict):
            outcomes = business_outcomes(scenario)

        summary = str(
            (assembled.get("summary") if isinstance(assembled, dict) else "")
            or format_mock_summary(outcomes, governed=True)
        ).strip()
        if revocation.get("denial_captured"):
            summary += " Revocation check: subsequent finance call denied as expected."

        delegation_edges: list[dict[str, Any]] = []
        if mode_config.source_mandate_id:
            for role in ROLE_ORDER:
                delegation_edges.append(
                    {
                        "source_mandate_id": mode_config.source_mandate_id,
                        "target_role": role,
                        "target_mandate_id": mode_config.mandates[role],
                    }
                )

        result = {
            "mode": "caracal-demo-mock" if config.mode == "mock" else "caracal-demo-real",
            "provider_strategy": config.provider_strategy,
            "timestamp": _iso_now(),
            "input_prompt": scenario.get("user_prompt", ""),
            "final_summary": summary,
            "timeline": timeline,
            "business_outcomes": outcomes,
            "ticket": ticket_result,
            "delegation": {
                "source_mandate_id": mode_config.source_mandate_id,
                "edges": delegation_edges,
                "verified": bool(mode_config.source_mandate_id),
            },
            "revocation": revocation,
            "identities": [
                {
                    "role": role,
                    "principal_id": principal_ids.get(role),
                    "mandate_id": mode_config.mandates[role],
                    "access_token": "managed-by-CARACAL_API_KEY",
                }
                for role in ROLE_ORDER
            ],
            "authority_validations": authority_validations,
            "authority_ledger_events": authority_ledger_events,
            "authority_evidence": authority_ledger_events,
            "metering_events": [],
            "upstream_requests": [],
            "provider_usage": [
                {
                    "provider_name": provider_name,
                    "call_count": call_count,
                }
                for provider_name, call_count in sorted(provider_counts.items())
            ],
            "execution_contract": {
                "mode": config.mode,
                "mandates": dict(mode_config.mandates),
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
            "raw_tool_responses": {
                "finance_data": finance_data_response,
                "finance_brief": finance_brief_response,
                "ops_data": ops_data_response,
                "ops_brief": ops_brief_response,
                "orchestrator_assemble": assemble_response,
                "ticket_create": ticket_response,
            },
        }
        return attach_acceptance(result, scenario)
    finally:
        client.close()


def run_demo_workflow(scenario: dict[str, Any], config: DemoRunConfig) -> dict[str, Any]:
    return asyncio.run(run_demo_workflow_async(scenario, config))
