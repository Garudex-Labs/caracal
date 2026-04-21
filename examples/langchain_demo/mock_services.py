"""Bundled mock providers and upstream MCP router for the demo app."""

from __future__ import annotations

import os
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query, Request

from .baseline.scenario import load_scenario
from .demo_contract import PROVIDERS
from .scenario_analysis import (
    business_outcomes,
    finance_risk_flags,
    finance_snapshot,
    format_mock_summary,
    ops_service_summary,
    pending_invoices,
    recent_incidents,
    vendor_sla_breaches,
)


router = APIRouter()


def _scenario() -> dict[str, Any]:
    return load_scenario()


def _mock_key(name: str, default: str) -> str:
    return str(os.environ.get(name) or default).strip()


def _require_bearer(auth_header: str | None, expected: str, label: str) -> None:
    normalized = str(auth_header or "").strip()
    if normalized != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail=f"{label} bearer token is invalid")


def _require_api_key(header_value: str | None, expected: str, label: str) -> None:
    normalized = str(header_value or "").strip()
    if normalized != expected:
        raise HTTPException(status_code=401, detail=f"{label} API key is invalid")


def _prompt_summary(prompt: str) -> str:
    outcomes = business_outcomes(_scenario())
    prompt_lower = str(prompt or "").lower()
    if "finance" in prompt_lower or "invoice" in prompt_lower or "budget" in prompt_lower:
        departments = ", ".join(
            entry["department"]
            for entry in outcomes.get("over_budget_departments", [])
            if entry.get("department")
        ) or "no over-budget departments"
        invoices = ", ".join(outcomes.get("pending_invoice_ids", [])) or "no pending invoices"
        return (
            "Finance specialist brief: focus on "
            f"{departments}; reconcile {invoices}; recommend controlled spend approvals."
        )
    degraded = ", ".join(outcomes.get("degraded_services", [])) or "no degraded services"
    vendors = ", ".join(outcomes.get("vendor_sla_breaches", [])) or "no vendor escalations"
    return (
        "Operations specialist brief: stabilize "
        f"{degraded}; escalate {vendors}; keep incident watch active."
    )


@router.post("/providers/mock/openai/v1/chat/completions")
async def mock_openai_chat(request: Request) -> dict[str, Any]:
    expected = _mock_key("LANGCHAIN_DEMO_MOCK_OPENAI_KEY", "mock-openai-key")
    _require_bearer(request.headers.get("authorization"), expected, "Mock OpenAI")
    payload = await request.json()
    messages = payload.get("messages") or []
    prompt = "\n".join(str(message.get("content") or "") for message in messages if isinstance(message, dict))
    summary = _prompt_summary(prompt)
    return {
        "id": "chatcmpl-demo-mock",
        "object": "chat.completion",
        "model": str(payload.get("model") or "gpt-4.1-mini"),
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": summary,
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 128,
            "completion_tokens": 46,
            "total_tokens": 174,
        },
    }


@router.post("/providers/mock/gemini/v1beta/models/{model_name}:generateContent")
async def mock_gemini_generate(
    model_name: str,
    request: Request,
    key: str = Query(default=""),
) -> dict[str, Any]:
    expected = _mock_key("LANGCHAIN_DEMO_MOCK_GEMINI_KEY", "mock-gemini-key")
    if str(key or "").strip() != expected:
        raise HTTPException(status_code=401, detail="Mock Gemini API key is invalid")

    payload = await request.json()
    contents = payload.get("contents") or []
    prompt_parts: list[str] = []
    for content in contents:
        for part in (content or {}).get("parts") or []:
            if isinstance(part, dict) and part.get("text"):
                prompt_parts.append(str(part["text"]))
    summary = _prompt_summary("\n".join(prompt_parts))
    return {
        "candidates": [
            {
                "content": {
                    "parts": [{"text": summary}],
                    "role": "model",
                },
                "finishReason": "STOP",
            }
        ],
        "usageMetadata": {
            "promptTokenCount": 120,
            "candidatesTokenCount": 44,
            "totalTokenCount": 164,
        },
        "modelVersion": model_name,
    }


@router.get("/providers/mock/finance/v1/budget-summary")
async def mock_finance_summary(request: Request) -> dict[str, Any]:
    expected = _mock_key("LANGCHAIN_DEMO_MOCK_FINANCE_KEY", "mock-finance-key")
    _require_api_key(request.headers.get("x-api-key"), expected, "Mock finance")
    scenario = _scenario()
    return {
        "case_id": "northstar-quarter-close",
        "department_snapshot": finance_snapshot(scenario),
        "pending_invoices": pending_invoices(scenario),
        "risk_flags": finance_risk_flags(scenario, overrun_threshold_percent=3.0),
    }


@router.get("/providers/mock/ops/v1/incident-overview")
async def mock_ops_overview(request: Request) -> dict[str, Any]:
    expected = _mock_key("LANGCHAIN_DEMO_MOCK_OPS_KEY", "mock-ops-key")
    _require_api_key(request.headers.get("x-api-key"), expected, "Mock ops")
    scenario = _scenario()
    return {
        "case_id": "northstar-quarter-close",
        "service_summary": ops_service_summary(scenario),
        "recent_incidents": recent_incidents(scenario, incident_hours=24),
        "vendor_sla_breaches": vendor_sla_breaches(scenario),
    }


@router.post("/providers/mock/ticketing/v1/tickets")
async def mock_ticket_create(request: Request) -> dict[str, Any]:
    expected = _mock_key("LANGCHAIN_DEMO_MOCK_TICKETING_KEY", "mock-ticketing-key")
    _require_api_key(request.headers.get("x-api-key"), expected, "Mock ticketing")
    payload = await request.json()
    return {
        "ticket_id": "TICKET-1001",
        "status": "created",
        "queue": "governed-demo",
        "title": payload.get("title"),
        "owner": payload.get("owner", "orchestrator"),
    }


async def _self_call(request: Request, method: str, path: str, *, headers: dict[str, str] | None = None, json_body: dict[str, Any] | None = None) -> dict[str, Any]:
    base_url = str(request.base_url).rstrip("/")
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.request(
            method,
            f"{base_url}{path}",
            headers=headers,
            json=json_body,
        )
        response.raise_for_status()
        return response.json()


def _real_env(name: str) -> str:
    value = str(os.environ.get(name) or "").strip()
    if not value:
        raise HTTPException(status_code=500, detail=f"Missing required environment variable: {name}")
    return value


async def _call_real_openai(prompt: str) -> dict[str, Any]:
    api_key = _real_env("OPENAI_API_KEY")
    model = str(os.environ.get("LANGCHAIN_DEMO_OPENAI_MODEL") or "gpt-4.1-mini").strip()
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "temperature": 0.2,
                "messages": [
                    {
                        "role": "system",
                        "content": "Return a concise enterprise specialist brief with concrete actions.",
                    },
                    {"role": "user", "content": prompt},
                ],
            },
        )
        response.raise_for_status()
        payload = response.json()
    return {
        "provider_family": "openai",
        "model": model,
        "summary_text": str(payload["choices"][0]["message"]["content"]).strip(),
        "usage": payload.get("usage"),
    }


async def _call_real_gemini(prompt: str) -> dict[str, Any]:
    api_key = _real_env("GOOGLE_API_KEY") if os.environ.get("GOOGLE_API_KEY") else _real_env("GEMINI_API_KEY")
    model = str(os.environ.get("LANGCHAIN_DEMO_GEMINI_MODEL") or "gemini-2.0-flash").strip()
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}",
            json={
                "contents": [
                    {
                        "parts": [{"text": prompt}],
                    }
                ]
            },
        )
        response.raise_for_status()
        payload = response.json()
    parts = ((payload.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
    summary = "\n".join(str(part.get("text") or "").strip() for part in parts if part.get("text"))
    return {
        "provider_family": "gemini",
        "model": model,
        "summary_text": summary,
        "usage": payload.get("usageMetadata"),
    }


async def _call_real_json_api(
    *,
    base_url_env: str,
    api_key_env: str,
    method: str,
    path: str,
    json_body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    base_url = _real_env(base_url_env).rstrip("/")
    api_key = _real_env(api_key_env)
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.request(
            method,
            f"{base_url}{path}",
            headers={"X-API-Key": api_key},
            json=json_body,
        )
        response.raise_for_status()
        return response.json()


@router.post("/upstream/tool/call")
@router.post("/tool/call")
async def upstream_tool_call(request: Request) -> dict[str, Any]:
    payload = await request.json()
    provider_name = str(payload.get("provider_name") or "").strip()
    resource_scope = str(payload.get("resource_scope") or "").strip()
    action_scope = str(payload.get("action_scope") or "").strip()
    tool_args = dict(payload.get("tool_args") or {})

    if provider_name == PROVIDERS["mock"]["finance_api"]:
        content = await _self_call(
            request,
            "GET",
            "/providers/mock/finance/v1/budget-summary",
            headers={"X-API-Key": _mock_key("LANGCHAIN_DEMO_MOCK_FINANCE_KEY", "mock-finance-key")},
        )
    elif provider_name == PROVIDERS["mock"]["ops_api"]:
        content = await _self_call(
            request,
            "GET",
            "/providers/mock/ops/v1/incident-overview",
            headers={"X-API-Key": _mock_key("LANGCHAIN_DEMO_MOCK_OPS_KEY", "mock-ops-key")},
        )
    elif provider_name == PROVIDERS["mock"]["ticketing_api"]:
        content = await _self_call(
            request,
            "POST",
            "/providers/mock/ticketing/v1/tickets",
            headers={"X-API-Key": _mock_key("LANGCHAIN_DEMO_MOCK_TICKETING_KEY", "mock-ticketing-key")},
            json_body=tool_args,
        )
    elif provider_name == PROVIDERS["mock"]["openai"]:
        downstream = await _self_call(
            request,
            "POST",
            "/providers/mock/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {_mock_key('LANGCHAIN_DEMO_MOCK_OPENAI_KEY', 'mock-openai-key')}"},
            json_body={
                "model": "gpt-4.1-mini",
                "messages": [
                    {"role": "user", "content": str(tool_args.get('prompt') or '')},
                ],
            },
        )
        content = {
            "provider_family": "openai",
            "model": downstream.get("model"),
            "summary_text": str(((downstream.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip(),
            "usage": downstream.get("usage"),
        }
    elif provider_name == PROVIDERS["mock"]["gemini"]:
        downstream = await _self_call(
            request,
            "POST",
            f"/providers/mock/gemini/v1beta/models/{tool_args.get('model', 'gemini-2.0-flash')}:generateContent?key={_mock_key('LANGCHAIN_DEMO_MOCK_GEMINI_KEY', 'mock-gemini-key')}",
            json_body={
                "contents": [
                    {"parts": [{"text": str(tool_args.get("prompt") or "")}]},
                ]
            },
        )
        parts = ((downstream.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
        content = {
            "provider_family": "gemini",
            "model": tool_args.get("model", "gemini-2.0-flash"),
            "summary_text": "\n".join(str(part.get("text") or "").strip() for part in parts if part.get("text")),
            "usage": downstream.get("usageMetadata"),
        }
    elif provider_name == PROVIDERS["real"]["openai"]:
        content = await _call_real_openai(str(tool_args.get("prompt") or ""))
    elif provider_name == PROVIDERS["real"]["gemini"]:
        content = await _call_real_gemini(str(tool_args.get("prompt") or ""))
    elif provider_name == PROVIDERS["real"]["finance_api"]:
        content = await _call_real_json_api(
            base_url_env="LANGCHAIN_DEMO_REAL_FINANCE_BASE_URL",
            api_key_env="LANGCHAIN_DEMO_REAL_FINANCE_API_KEY",
            method="GET",
            path="/v1/budget-summary",
        )
    elif provider_name == PROVIDERS["real"]["ops_api"]:
        content = await _call_real_json_api(
            base_url_env="LANGCHAIN_DEMO_REAL_OPS_BASE_URL",
            api_key_env="LANGCHAIN_DEMO_REAL_OPS_API_KEY",
            method="GET",
            path="/v1/incident-overview",
        )
    elif provider_name == PROVIDERS["real"]["ticketing_api"]:
        content = await _call_real_json_api(
            base_url_env="LANGCHAIN_DEMO_REAL_TICKETING_BASE_URL",
            api_key_env="LANGCHAIN_DEMO_REAL_TICKETING_API_KEY",
            method="POST",
            path="/v1/tickets",
            json_body=tool_args,
        )
    elif provider_name == PROVIDERS["mock"]["control"] or provider_name == PROVIDERS["real"]["control"]:
        scenario = tool_args.get("scenario") or _scenario()
        outcomes = business_outcomes(scenario)
        summary = format_mock_summary(outcomes, governed=True)
        content = {
            "summary": summary,
            "business_outcomes": outcomes,
            "finance_brief": tool_args.get("finance_brief"),
            "ops_brief": tool_args.get("ops_brief"),
            "mode_label": tool_args.get("mode_label", "unknown"),
        }
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported provider for demo upstream router: {provider_name}",
        )

    return {
        "provider_name": provider_name,
        "resource_scope": resource_scope,
        "action_scope": action_scope,
        "content": content,
    }
