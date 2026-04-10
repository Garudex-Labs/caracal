"""Governed workflow runner for the Caracal track."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

from ..acceptance import attach_acceptance
from .client import GovernedClientConfig, GovernedToolClient
from .runtime_bridge import (
    finance_governed_handler,
    ops_governed_handler,
    orchestrator_governed_handler,
)

TOOL_SCOPE_MAP: dict[str, tuple[str, str]] = {
    "demo:swarm:logic:finance:analyze": (
        "provider:swarm-internal:resource:finance",
        "provider:swarm-internal:action:read",
    ),
    "demo:swarm:logic:ops:analyze": (
        "provider:swarm-internal:resource:ops",
        "provider:swarm-internal:action:read",
    ),
    "demo:swarm:logic:orchestrator:summarize": (
        "provider:swarm-internal:resource:orchestrator",
        "provider:swarm-internal:action:summarize",
    ),
}


@dataclass(frozen=True)
class GovernedRunConfig:
    api_key: str
    base_url: str
    organization_id: Optional[str]
    workspace_id: Optional[str]
    project_id: Optional[str]
    mandates: dict[str, str]
    tool_ids: dict[str, str]
    allow_mock_fallback: bool
    revocation_enabled: bool = False
    revoker_id: Optional[str] = None
    revocation_reason: str = "Demo live revocation check"
    require_revocation_denial: bool = False


@dataclass
class _MockMandate:
    mandate_id: str
    role: str
    parent_mandate_id: Optional[str]
    resource_scope: set[str]
    action_scope: set[str]
    revoked: bool = False


class _MockAuthorityModel:
    """Deterministic local authority model for demo-only delegation/revocation behavior."""

    def __init__(self) -> None:
        self._mandates: dict[str, _MockMandate] = {}
        self.events: list[dict[str, Any]] = []

    def issue_source_mandate(
        self,
        *,
        role: str,
        resource_scope: set[str],
        action_scope: set[str],
    ) -> str:
        mandate_id = f"mock-mandate-source-{uuid4()}"
        self._mandates[mandate_id] = _MockMandate(
            mandate_id=mandate_id,
            role=role,
            parent_mandate_id=None,
            resource_scope=set(resource_scope),
            action_scope=set(action_scope),
        )
        self.events.append(
            {
                "event": "source_issued",
                "mandate_id": mandate_id,
                "role": role,
                "timestamp": _iso_now(),
            }
        )
        return mandate_id

    def delegate(
        self,
        *,
        source_mandate_id: str,
        target_role: str,
        resource_scope: set[str],
        action_scope: set[str],
    ) -> str:
        source = self._mandates.get(source_mandate_id)
        if source is None:
            raise PermissionError(f"Unknown source mandate: {source_mandate_id}")

        if source.revoked:
            raise PermissionError(f"Source mandate revoked: {source_mandate_id}")

        if not set(resource_scope).issubset(source.resource_scope):
            raise PermissionError("Delegation resource scope exceeds source mandate")

        if not set(action_scope).issubset(source.action_scope):
            raise PermissionError("Delegation action scope exceeds source mandate")

        mandate_id = f"mock-mandate-delegated-{target_role}-{uuid4()}"
        self._mandates[mandate_id] = _MockMandate(
            mandate_id=mandate_id,
            role=target_role,
            parent_mandate_id=source_mandate_id,
            resource_scope=set(resource_scope),
            action_scope=set(action_scope),
        )

        self.events.append(
            {
                "event": "delegated",
                "mandate_id": mandate_id,
                "source_mandate_id": source_mandate_id,
                "target_role": target_role,
                "timestamp": _iso_now(),
            }
        )
        return mandate_id

    def revoke(self, *, mandate_id: str, revoker_role: str, reason: str) -> None:
        mandate = self._mandates.get(mandate_id)
        if mandate is None:
            raise PermissionError(f"Cannot revoke unknown mandate: {mandate_id}")

        mandate.revoked = True
        self.events.append(
            {
                "event": "revoked",
                "mandate_id": mandate_id,
                "revoker_role": revoker_role,
                "reason": reason,
                "timestamp": _iso_now(),
            }
        )

    def validate(
        self,
        *,
        mandate_id: str,
        requested_resource: str,
        requested_action: str,
    ) -> None:
        mandate = self._mandates.get(mandate_id)
        if mandate is None:
            raise PermissionError(f"Authority denied: unknown mandate {mandate_id}")
        if mandate.revoked:
            raise PermissionError(f"Authority denied: revoked mandate {mandate_id}")
        if requested_resource not in mandate.resource_scope:
            raise PermissionError(
                f"Authority denied: resource scope mismatch for mandate {mandate_id}"
            )
        if requested_action not in mandate.action_scope:
            raise PermissionError(
                f"Authority denied: action scope mismatch for mandate {mandate_id}"
            )

        self.events.append(
            {
                "event": "validated",
                "mandate_id": mandate_id,
                "requested_resource": requested_resource,
                "requested_action": requested_action,
                "timestamp": _iso_now(),
            }
        )

    def parent_mandate_id(self, mandate_id: str) -> Optional[str]:
        mandate = self._mandates.get(mandate_id)
        return mandate.parent_mandate_id if mandate else None


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _timeline_entry(step: int, role: str, tool_id: str, mandate_id: str, output: Any) -> dict[str, Any]:
    return {
        "step": step,
        "role": role,
        "tool_id": tool_id,
        "mandate_id": mandate_id,
        "output": output,
    }


def _tool_scopes(tool_id: str) -> tuple[str, str]:
    try:
        return TOOL_SCOPE_MAP[tool_id]
    except KeyError as exc:
        raise KeyError(f"Unknown governed tool scope for {tool_id}") from exc


def run_mock_governed_workflow(scenario: dict[str, Any]) -> dict[str, Any]:
    authority = _MockAuthorityModel()

    all_resources = {
        "provider:swarm-internal:resource:finance",
        "provider:swarm-internal:resource:ops",
        "provider:swarm-internal:resource:orchestrator",
    }
    all_actions = {
        "provider:swarm-internal:action:read",
        "provider:swarm-internal:action:summarize",
    }

    source_mandate_id = authority.issue_source_mandate(
        role="orchestrator",
        resource_scope=all_resources,
        action_scope=all_actions,
    )

    finance_resource, finance_action = _tool_scopes("demo:swarm:logic:finance:analyze")
    ops_resource, ops_action = _tool_scopes("demo:swarm:logic:ops:analyze")
    orchestrator_resource, orchestrator_action = _tool_scopes("demo:swarm:logic:orchestrator:summarize")

    finance_mandate_id = authority.delegate(
        source_mandate_id=source_mandate_id,
        target_role="finance",
        resource_scope={finance_resource},
        action_scope={finance_action},
    )
    ops_mandate_id = authority.delegate(
        source_mandate_id=source_mandate_id,
        target_role="ops",
        resource_scope={ops_resource},
        action_scope={ops_action},
    )
    orchestrator_mandate_id = authority.delegate(
        source_mandate_id=source_mandate_id,
        target_role="orchestrator",
        resource_scope={orchestrator_resource},
        action_scope={orchestrator_action},
    )

    authority.validate(
        mandate_id=finance_mandate_id,
        requested_resource=finance_resource,
        requested_action=finance_action,
    )
    finance_output = finance_governed_handler(
        {
            "scenario": scenario,
            "overrun_threshold_percent": 3.0,
            "mock": True,
        }
    )

    authority.validate(
        mandate_id=ops_mandate_id,
        requested_resource=ops_resource,
        requested_action=ops_action,
    )
    ops_output = ops_governed_handler(
        {
            "scenario": scenario,
            "incident_hours": 24,
            "mock": True,
        }
    )

    authority.validate(
        mandate_id=orchestrator_mandate_id,
        requested_resource=orchestrator_resource,
        requested_action=orchestrator_action,
    )
    orchestrator_output = orchestrator_governed_handler(
        {
            "scenario": scenario,
            "finance_report": finance_output,
            "ops_report": ops_output,
            "mock": True,
        }
    )

    authority.revoke(
        mandate_id=finance_mandate_id,
        revoker_role="orchestrator",
        reason="Demo revocation check",
    )

    denial_evidence: dict[str, Any]
    try:
        authority.validate(
            mandate_id=finance_mandate_id,
            requested_resource=finance_resource,
            requested_action=finance_action,
        )
        denial_evidence = {
            "denied": False,
            "reason": "revocation validation unexpectedly allowed",
            "timestamp": _iso_now(),
        }
    except PermissionError as exc:
        denial_evidence = {
            "denied": True,
            "reason": str(exc),
            "timestamp": _iso_now(),
            "mandate_id": finance_mandate_id,
        }

    timeline = [
        _timeline_entry(1, "finance", "demo:swarm:logic:finance:analyze", finance_mandate_id, finance_output),
        _timeline_entry(2, "ops", "demo:swarm:logic:ops:analyze", ops_mandate_id, ops_output),
        _timeline_entry(
            3,
            "orchestrator",
            "demo:swarm:logic:orchestrator:summarize",
            orchestrator_mandate_id,
            orchestrator_output,
        ),
        {
            "step": 4,
            "role": "orchestrator",
            "event": "revocation",
            "revoked_mandate_id": finance_mandate_id,
            "denial_evidence": denial_evidence,
        },
    ]

    delegation_edges = [
        {
            "source_mandate_id": source_mandate_id,
            "target_role": "finance",
            "target_mandate_id": finance_mandate_id,
        },
        {
            "source_mandate_id": source_mandate_id,
            "target_role": "ops",
            "target_mandate_id": ops_mandate_id,
        },
        {
            "source_mandate_id": source_mandate_id,
            "target_role": "orchestrator",
            "target_mandate_id": orchestrator_mandate_id,
        },
    ]

    delegation_verified = all(
        authority.parent_mandate_id(edge["target_mandate_id"]) == source_mandate_id
        for edge in delegation_edges
    )

    summary = str(orchestrator_output.get("summary", ""))
    if denial_evidence.get("denied"):
        summary = summary + " Revocation check: subsequent finance call denied as expected."

    result = {
        "mode": "mock-governed",
        "provider": "caracal-mock",
        "timestamp": _iso_now(),
        "input_prompt": scenario.get("user_prompt", ""),
        "timeline": timeline,
        "business_outcomes": orchestrator_output.get("business_outcomes"),
        "final_summary": summary,
        "delegation": {
            "source_mandate_id": source_mandate_id,
            "edges": delegation_edges,
            "verified": delegation_verified,
        },
        "revocation": {
            "executed": True,
            "revoked_mandate_id": finance_mandate_id,
            "denial_captured": bool(denial_evidence.get("denied")),
            "denial_evidence": denial_evidence,
        },
        "authority_evidence": authority.events,
    }
    return attach_acceptance(result, scenario)


async def _run_live_workflow(
    scenario: dict[str, Any],
    config: GovernedRunConfig,
) -> dict[str, Any]:
    client = GovernedToolClient(
        GovernedClientConfig(
            api_key=config.api_key,
            base_url=config.base_url,
            organization_id=config.organization_id,
            workspace_id=config.workspace_id,
            project_id=config.project_id,
        )
    )

    try:
        authority_events: list[dict[str, Any]] = []

        finance_output = await client.call_tool(
            tool_id=config.tool_ids["finance"],
            mandate_id=config.mandates["finance"],
            tool_args={
                "scenario": scenario,
                "overrun_threshold_percent": 3.0,
                "mock": False,
            },
            correlation_id="swarm-finance-001",
        )
        authority_events.append(
            {
                "event": "validated",
                "role": "finance",
                "mandate_id": config.mandates["finance"],
                "timestamp": _iso_now(),
            }
        )

        ops_output = await client.call_tool(
            tool_id=config.tool_ids["ops"],
            mandate_id=config.mandates["ops"],
            tool_args={
                "scenario": scenario,
                "incident_hours": 24,
                "mock": False,
            },
            correlation_id="swarm-ops-001",
        )
        authority_events.append(
            {
                "event": "validated",
                "role": "ops",
                "mandate_id": config.mandates["ops"],
                "timestamp": _iso_now(),
            }
        )

        orchestrator_output = await client.call_tool(
            tool_id=config.tool_ids["orchestrator"],
            mandate_id=config.mandates["orchestrator"],
            tool_args={
                "scenario": scenario,
                "finance_report": finance_output,
                "ops_report": ops_output,
                "mock": False,
            },
            correlation_id="swarm-orchestrator-001",
        )
        authority_events.append(
            {
                "event": "validated",
                "role": "orchestrator",
                "mandate_id": config.mandates["orchestrator"],
                "timestamp": _iso_now(),
            }
        )

        timeline = [
            _timeline_entry(1, "finance", config.tool_ids["finance"], config.mandates["finance"], finance_output),
            _timeline_entry(2, "ops", config.tool_ids["ops"], config.mandates["ops"], ops_output),
            _timeline_entry(
                3,
                "orchestrator",
                config.tool_ids["orchestrator"],
                config.mandates["orchestrator"],
                orchestrator_output,
            ),
        ]

        source_mandate_id = config.mandates.get("orchestrator")
        delegation_edges = [
            {
                "source_mandate_id": source_mandate_id,
                "target_role": "finance",
                "target_mandate_id": config.mandates.get("finance"),
            },
            {
                "source_mandate_id": source_mandate_id,
                "target_role": "ops",
                "target_mandate_id": config.mandates.get("ops"),
            },
        ]
        delegation_verified = bool(source_mandate_id) and all(
            bool(edge.get("target_mandate_id")) for edge in delegation_edges
        )

        revocation_details: dict[str, Any] = {
            "executed": False,
            "revoked_mandate_id": None,
            "denial_captured": False,
            "denial_evidence": None,
        }

        if config.revocation_enabled:
            finance_mandate_id = str(config.mandates.get("finance") or "").strip()
            revoker_id = str(config.revoker_id or "").strip()

            if not finance_mandate_id:
                revocation_details["denial_evidence"] = {
                    "denied": False,
                    "reason": "finance mandate ID missing for live revocation check",
                    "timestamp": _iso_now(),
                }
                if config.require_revocation_denial:
                    raise RuntimeError("Live revocation check failed: missing finance mandate ID")
            elif not revoker_id:
                revocation_details["denial_evidence"] = {
                    "denied": False,
                    "reason": "revoker_id is required for live revocation check",
                    "timestamp": _iso_now(),
                }
                if config.require_revocation_denial:
                    raise RuntimeError("Live revocation check failed: missing revoker_id")
            else:
                revocation_details["executed"] = True
                revocation_details["revoked_mandate_id"] = finance_mandate_id
                try:
                    # CARACAL_MARKER: REVOCABLE_CALL.
                    revoke_result = await asyncio.to_thread(
                        client.revoke_mandate,
                        mandate_id=finance_mandate_id,
                        revoker_id=revoker_id,
                        reason=config.revocation_reason,
                        cascade=True,
                    )
                    revocation_details["revoke_result"] = revoke_result
                    authority_events.append(
                        {
                            "event": "revoked",
                            "role": "orchestrator",
                            "mandate_id": finance_mandate_id,
                            "timestamp": _iso_now(),
                        }
                    )

                    finance_resource, finance_action = _tool_scopes(config.tool_ids["finance"])

                    validate_response = await asyncio.to_thread(
                        client.validate_mandate,
                        mandate_id=finance_mandate_id,
                        requested_action=finance_action,
                        requested_resource=finance_resource,
                    )
                    if bool(validate_response.get("allowed")):
                        revocation_details["denial_evidence"] = {
                            "denied": False,
                            "reason": "post-revocation mandate validation unexpectedly allowed",
                            "timestamp": _iso_now(),
                            "validation_response": validate_response,
                        }
                        if config.require_revocation_denial:
                            raise RuntimeError(
                                "Live revocation check failed: post-revocation validation allowed"
                            )
                    else:
                        revocation_details["denial_captured"] = True
                        revocation_details["denial_evidence"] = {
                            "denied": True,
                            "reason": str(validate_response.get("denial_reason") or "validation denied"),
                            "timestamp": _iso_now(),
                            "validation_response": validate_response,
                        }
                        authority_events.append(
                            {
                                "event": "denied_after_revoke",
                                "role": "finance",
                                "mandate_id": finance_mandate_id,
                                "timestamp": _iso_now(),
                            }
                        )
                except Exception as exc:
                    revocation_details["denial_evidence"] = {
                        "denied": False,
                        "reason": f"live revocation path failed: {exc}",
                        "timestamp": _iso_now(),
                    }
                    if config.require_revocation_denial:
                        raise

                timeline.append(
                    {
                        "step": len(timeline) + 1,
                        "role": "orchestrator",
                        "event": "revocation",
                        "revoked_mandate_id": revocation_details.get("revoked_mandate_id"),
                        "denial_evidence": revocation_details.get("denial_evidence"),
                    }
                )

        final_summary = str(orchestrator_output.get("summary") or json.dumps(orchestrator_output))
        if revocation_details.get("denial_captured"):
            final_summary = final_summary + " Revocation check: subsequent finance call denied as expected."

        result = {
            "mode": "caracal-governed",
            "provider": "caracal-live",
            "timestamp": _iso_now(),
            "input_prompt": scenario.get("user_prompt", ""),
            "timeline": timeline,
            "business_outcomes": orchestrator_output.get("business_outcomes"),
            "final_summary": final_summary,
            "delegation": {
                "source_mandate_id": source_mandate_id,
                "edges": delegation_edges,
                "verified": delegation_verified,
            },
            "revocation": revocation_details,
            "authority_evidence": authority_events,
        }
        return attach_acceptance(result, scenario)
    finally:
        client.close()


def run_governed_workflow(
    scenario: dict[str, Any],
    config: GovernedRunConfig,
) -> dict[str, Any]:
    try:
        return asyncio.run(_run_live_workflow(scenario, config))
    except Exception as exc:
        if not config.allow_mock_fallback:
            raise

        fallback = run_mock_governed_workflow(scenario)
        fallback["mode"] = "mock-governed-fallback"
        fallback["fallback_reason"] = str(exc)
        return fallback


def write_output(path: str, payload: dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
