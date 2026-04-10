"""Shared runtime for the Caracal-backed LangChain demo application."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, Iterator
from uuid import UUID, uuid4

import httpx
from fastapi import FastAPI, HTTPException, Request

from caracal.core.metering import MeteringEvent
from caracal.mcp.adapter import MCPAdapter
from caracal.mcp.service import MCPAdapterService, MCPServerConfig, MCPServiceConfig

from caracal_sdk.adapters.http import HttpAdapter
from caracal_sdk.context import ScopeContext
from caracal_sdk.hooks import HookRegistry

from .acceptance import attach_acceptance
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


DEFAULT_WORKSPACE_ID = "default"
CARACAL_HOST = "caracal.demo"
UPSTREAM_HOST = "upstream.demo"

TOOL_IDS = {
    "finance_data": "demo:swarm:internal:finance:read",
    "ops_data": "demo:swarm:internal:ops:read",
    "openai_finance": "demo:swarm:openai:finance:brief",
    "openai_ops": "demo:swarm:openai:ops:brief",
    "gemini_finance": "demo:swarm:gemini:finance:brief",
    "gemini_ops": "demo:swarm:gemini:ops:brief",
    "assemble": "demo:swarm:logic:orchestrator:assemble",
}

TOOL_SCOPE_MAP = {
    TOOL_IDS["finance_data"]: (
        "provider:swarm-internal:resource:finance",
        "provider:swarm-internal:action:read",
    ),
    TOOL_IDS["ops_data"]: (
        "provider:swarm-internal:resource:ops",
        "provider:swarm-internal:action:read",
    ),
    TOOL_IDS["openai_finance"]: (
        "provider:swarm-openai:resource:chat.completions",
        "provider:swarm-openai:action:invoke",
    ),
    TOOL_IDS["openai_ops"]: (
        "provider:swarm-openai:resource:chat.completions",
        "provider:swarm-openai:action:invoke",
    ),
    TOOL_IDS["gemini_finance"]: (
        "provider:swarm-gemini:resource:generateContent",
        "provider:swarm-gemini:action:invoke",
    ),
    TOOL_IDS["gemini_ops"]: (
        "provider:swarm-gemini:resource:generateContent",
        "provider:swarm-gemini:action:invoke",
    ),
    TOOL_IDS["assemble"]: (
        "provider:swarm-internal:resource:orchestrator",
        "provider:swarm-internal:action:assemble",
    ),
}


def _iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _mask_token(token: str) -> str:
    if len(token) <= 8:
        return token
    return token[:6] + "..." + token[-4:]


def _scope_pair(tool_id: str) -> tuple[str, str]:
    try:
        return TOOL_SCOPE_MAP[tool_id]
    except KeyError as exc:
        raise RuntimeError(f"Unknown tool scope mapping for {tool_id}") from exc


def _serialize_metering_event(event: MeteringEvent) -> dict[str, Any]:
    return {
        "principal_id": str(getattr(event, "principal_id", "")),
        "resource_type": str(getattr(event, "resource_type", "")),
        "quantity": str(getattr(event, "quantity", "")),
        "timestamp": getattr(event, "timestamp", None).isoformat()
        if getattr(event, "timestamp", None)
        else None,
        "metadata": dict(getattr(event, "metadata", {}) or {}),
        "correlation_id": getattr(event, "correlation_id", None),
        "source_event_id": getattr(event, "source_event_id", None),
        "tags": list(getattr(event, "tags", []) or []),
    }


class _Query:
    def __init__(self, rows: list[Any]) -> None:
        self._rows = list(rows)

    def filter_by(self, **kwargs: Any) -> "_Query":
        rows = [
            row
            for row in self._rows
            if all(getattr(row, key, None) == value for key, value in kwargs.items())
        ]
        return _Query(rows)

    def first(self) -> Any:
        return self._rows[0] if self._rows else None

    def all(self) -> list[Any]:
        return list(self._rows)

    def order_by(self, *_args: Any, **_kwargs: Any) -> "_Query":
        return self


class _SessionStub:
    def __init__(self, tool_rows: list[Any], provider_rows: list[Any]) -> None:
        self._tool_rows = tool_rows
        self._provider_rows = provider_rows

    def query(self, model: Any) -> _Query:
        model_name = getattr(model, "__name__", str(model))
        if model_name == "RegisteredTool":
            return _Query(self._tool_rows)
        if model_name == "GatewayProvider":
            return _Query(self._provider_rows)
        raise AssertionError(f"Unsupported model query: {model_name}")


class _DbConnectionManagerStub:
    def health_check(self) -> bool:
        return True


@dataclass(frozen=True)
class DemoPrincipal:
    role: str
    principal_id: str
    access_token: str


@dataclass
class DemoMandate:
    mandate_id: UUID
    role: str
    subject_id: str
    parent_mandate_id: UUID | None
    resource_scope: set[str]
    action_scope: set[str]
    revoked: bool = False


@dataclass(frozen=True)
class DemoRunConfig:
    mode: str = "mock"
    provider_strategy: str = "mixed"
    include_revocation_check: bool = True


class DemoAuthorityBackend:
    """Stateful authority model used by the local demo runtime."""

    def __init__(self, principals: dict[str, DemoPrincipal]) -> None:
        self.principals = principals
        self.db_session: _SessionStub | None = None
        self.events: list[dict[str, Any]] = []
        self.validation_records: list[dict[str, Any]] = []
        self._mandates: dict[UUID, DemoMandate] = {}

    def issue_source_mandate(
        self,
        *,
        role: str,
        subject_id: str,
        resource_scope: set[str],
        action_scope: set[str],
    ) -> str:
        mandate_id = uuid4()
        self._mandates[mandate_id] = DemoMandate(
            mandate_id=mandate_id,
            role=role,
            subject_id=subject_id,
            parent_mandate_id=None,
            resource_scope=set(resource_scope),
            action_scope=set(action_scope),
        )
        self.events.append(
            {
                "event": "source_issued",
                "timestamp": _iso_now(),
                "role": role,
                "subject_id": subject_id,
                "mandate_id": str(mandate_id),
                "resource_scope": sorted(resource_scope),
                "action_scope": sorted(action_scope),
            }
        )
        return str(mandate_id)

    def delegate(
        self,
        *,
        source_mandate_id: str,
        target_role: str,
        target_subject_id: str,
        resource_scope: set[str],
        action_scope: set[str],
    ) -> str:
        source_uuid = UUID(str(source_mandate_id))
        source = self._mandates.get(source_uuid)
        if source is None:
            raise RuntimeError(f"Unknown source mandate: {source_mandate_id}")
        if source.revoked:
            raise RuntimeError(f"Source mandate is revoked: {source_mandate_id}")
        if not set(resource_scope).issubset(source.resource_scope):
            raise RuntimeError("Delegated resource scope exceeds source mandate")
        if not set(action_scope).issubset(source.action_scope):
            raise RuntimeError("Delegated action scope exceeds source mandate")

        target_uuid = uuid4()
        self._mandates[target_uuid] = DemoMandate(
            mandate_id=target_uuid,
            role=target_role,
            subject_id=target_subject_id,
            parent_mandate_id=source_uuid,
            resource_scope=set(resource_scope),
            action_scope=set(action_scope),
        )
        self.events.append(
            {
                "event": "delegated",
                "timestamp": _iso_now(),
                "source_mandate_id": str(source_uuid),
                "target_mandate_id": str(target_uuid),
                "target_role": target_role,
                "target_subject_id": target_subject_id,
                "resource_scope": sorted(resource_scope),
                "action_scope": sorted(action_scope),
            }
        )
        return str(target_uuid)

    def revoke(self, *, mandate_id: str, revoker_role: str, reason: str) -> None:
        mandate_uuid = UUID(str(mandate_id))
        mandate = self._mandates.get(mandate_uuid)
        if mandate is None:
            raise RuntimeError(f"Unknown mandate: {mandate_id}")
        mandate.revoked = True
        self.events.append(
            {
                "event": "revoked",
                "timestamp": _iso_now(),
                "mandate_id": str(mandate_uuid),
                "revoker_role": revoker_role,
                "reason": reason,
            }
        )

    def _get_mandate_with_cache(self, mandate_id: UUID) -> Any:
        mandate = self._mandates.get(mandate_id)
        if mandate is None:
            return None
        return SimpleNamespace(
            mandate_id=mandate.mandate_id,
            subject_id=mandate.subject_id,
            revoked=mandate.revoked,
            valid_until=datetime.utcnow() + timedelta(hours=1),
            resource_scope=sorted(mandate.resource_scope),
            action_scope=sorted(mandate.action_scope),
        )

    def validate_mandate(
        self,
        *,
        mandate: Any,
        requested_action: str,
        requested_resource: str,
        caller_principal_id: str,
        **_kwargs: Any,
    ) -> Any:
        mandate_uuid = UUID(str(getattr(mandate, "mandate_id")))
        mandate_state = self._mandates.get(mandate_uuid)
        reason = ""
        allowed = True

        if mandate_state is None:
            allowed = False
            reason = "Unknown mandate"
        elif mandate_state.revoked:
            allowed = False
            reason = "Mandate has been revoked"
        elif str(mandate_state.subject_id) != str(caller_principal_id):
            allowed = False
            reason = "Caller identity does not match mandate subject"
        elif str(requested_resource) not in mandate_state.resource_scope:
            allowed = False
            reason = "Requested resource scope not delegated"
        elif str(requested_action) not in mandate_state.action_scope:
            allowed = False
            reason = "Requested action scope not delegated"

        self.validation_records.append(
            {
                "timestamp": _iso_now(),
                "mandate_id": str(mandate_uuid),
                "caller_principal_id": str(caller_principal_id),
                "requested_action": str(requested_action),
                "requested_resource": str(requested_resource),
                "allowed": allowed,
                "reason": reason or "Authority granted",
            }
        )

        self.events.append(
            {
                "event": "validated",
                "timestamp": _iso_now(),
                "mandate_id": str(mandate_uuid),
                "caller_principal_id": str(caller_principal_id),
                "requested_action": str(requested_action),
                "requested_resource": str(requested_resource),
                "allowed": allowed,
                "reason": reason or "Authority granted",
            }
        )
        return SimpleNamespace(allowed=allowed, reason=reason or "Authority granted")

    def parent_mandate_id(self, mandate_id: str) -> str | None:
        mandate = self._mandates.get(UUID(str(mandate_id)))
        if mandate is None or mandate.parent_mandate_id is None:
            return None
        return str(mandate.parent_mandate_id)


class DemoSessionManager:
    def __init__(self, principals: dict[str, DemoPrincipal]) -> None:
        self._subject_by_token = {
            principal.access_token: principal.principal_id for principal in principals.values()
        }

    async def validate_access_token(self, token: str) -> dict[str, Any]:
        subject = self._subject_by_token.get(str(token))
        if not subject:
            raise HTTPException(status_code=401, detail="Unknown demo access token")
        return {"sub": subject, "token_type": "demo-local"}


class DemoMeteringCollector:
    def __init__(self) -> None:
        self.events: list[MeteringEvent] = []

    def collect_event(self, event: MeteringEvent) -> None:
        self.events.append(event)


class DemoEnvironment:
    def __init__(self, scenario: dict[str, Any], config: DemoRunConfig) -> None:
        self.scenario = scenario
        self.config = config
        self.principals = {
            "orchestrator": DemoPrincipal(
                role="orchestrator",
                principal_id="principal-orchestrator-demo",
                access_token="demo-orchestrator-token",
            ),
            "finance": DemoPrincipal(
                role="finance",
                principal_id="principal-finance-demo",
                access_token="demo-finance-token",
            ),
            "ops": DemoPrincipal(
                role="ops",
                principal_id="principal-ops-demo",
                access_token="demo-ops-token",
            ),
        }
        self.authority = DemoAuthorityBackend(self.principals)
        self.metering = DemoMeteringCollector()
        self.upstream_requests: list[dict[str, Any]] = []

        provider_rows = self._build_provider_rows()
        tool_rows = self._build_tool_rows()
        self.authority.db_session = _SessionStub(tool_rows=tool_rows, provider_rows=provider_rows)

        self.mcp_adapter = MCPAdapter(
            authority_evaluator=self.authority,
            metering_collector=self.metering,
            mcp_server_url=f"http://{UPSTREAM_HOST}",
            mcp_server_urls={"demo-upstream": f"http://{UPSTREAM_HOST}"},
        )
        self.upstream_app = self._build_upstream_app()
        service = MCPAdapterService(
            config=MCPServiceConfig(
                listen_address="127.0.0.1:0",
                mcp_servers=[MCPServerConfig(name="demo-upstream", url=f"http://{UPSTREAM_HOST}")],
            ),
            mcp_adapter=self.mcp_adapter,
            authority_evaluator=self.authority,
            metering_collector=self.metering,
            db_connection_manager=_DbConnectionManagerStub(),
            session_manager=DemoSessionManager(self.principals),
        )
        self.caracal_app = service.app

    def _provider_definition(
        self,
        *,
        provider_id: str,
        service_type: str,
        base_url: str,
        resource_id: str,
        action_id: str,
        action_method: str,
        action_path_prefix: str,
    ) -> dict[str, Any]:
        return {
            "definition_id": provider_id,
            "service_type": service_type,
            "display_name": provider_id,
            "auth_scheme": "none",
            "default_base_url": base_url,
            "resources": {
                resource_id: {
                    "description": resource_id,
                    "actions": {
                        action_id: {
                            "description": action_id,
                            "method": action_method,
                            "path_prefix": action_path_prefix,
                        }
                    },
                }
            },
            "metadata": {},
        }

    def _build_provider_rows(self) -> list[Any]:
        return [
            SimpleNamespace(
                provider_id="swarm-openai",
                enabled=True,
                definition=self._provider_definition(
                    provider_id="swarm-openai",
                    service_type="ai",
                    base_url="https://api.openai.com",
                    resource_id="chat.completions",
                    action_id="invoke",
                    action_method="POST",
                    action_path_prefix="/v1/chat/completions",
                ),
                provider_definition="swarm-openai",
                service_type="ai",
                name="swarm-openai",
                auth_scheme="api-key",
                base_url="https://api.openai.com",
                credential_ref=None,
            ),
            SimpleNamespace(
                provider_id="swarm-gemini",
                enabled=True,
                definition=self._provider_definition(
                    provider_id="swarm-gemini",
                    service_type="ai",
                    base_url="https://generativelanguage.googleapis.com",
                    resource_id="generateContent",
                    action_id="invoke",
                    action_method="POST",
                    action_path_prefix="/v1beta/models",
                ),
                provider_definition="swarm-gemini",
                service_type="ai",
                name="swarm-gemini",
                auth_scheme="api-key",
                base_url="https://generativelanguage.googleapis.com",
                credential_ref=None,
            ),
            SimpleNamespace(
                provider_id="swarm-internal",
                enabled=True,
                definition={
                    "definition_id": "swarm-internal",
                    "service_type": "internal",
                    "display_name": "swarm-internal",
                    "auth_scheme": "none",
                    "default_base_url": "http://internal.demo.local",
                    "resources": {
                        "finance": {
                            "description": "Finance data",
                            "actions": {"read": {"description": "read", "method": "GET", "path_prefix": "/finance"}},
                        },
                        "ops": {
                            "description": "Ops data",
                            "actions": {"read": {"description": "read", "method": "GET", "path_prefix": "/ops"}},
                        },
                        "orchestrator": {
                            "description": "Orchestrator assembly",
                            "actions": {
                                "assemble": {
                                    "description": "assemble",
                                    "method": "POST",
                                    "path_prefix": "/orchestrator/assemble",
                                }
                            },
                        },
                    },
                    "metadata": {},
                },
                provider_definition="swarm-internal",
                service_type="internal",
                name="swarm-internal",
                auth_scheme="none",
                base_url="http://internal.demo.local",
                credential_ref=None,
            ),
        ]

    def _build_tool_rows(self) -> list[Any]:
        rows = []
        for tool_id, (resource_scope, action_scope) in TOOL_SCOPE_MAP.items():
            provider_name = resource_scope.split(":")[1]
            execution_mode = "local" if tool_id == TOOL_IDS["assemble"] else "mcp_forward"
            tool_type = "logic" if tool_id == TOOL_IDS["assemble"] else "direct_api"
            rows.append(
                SimpleNamespace(
                    tool_id=tool_id,
                    active=True,
                    provider_name=provider_name,
                    resource_scope=resource_scope,
                    action_scope=action_scope,
                    provider_definition_id=provider_name,
                    tool_type=tool_type,
                    handler_ref=(
                        "examples.langchain_demo.caracal.runtime_bridge:assemble_governed_briefing"
                        if tool_id == TOOL_IDS["assemble"]
                        else None
                    ),
                    execution_mode=execution_mode,
                    mcp_server_name="demo-upstream" if execution_mode == "mcp_forward" else None,
                    workspace_name=DEFAULT_WORKSPACE_ID,
                    allowed_downstream_scopes=[],
                    mapping_version="demo-v2",
                )
            )
        return rows

    def role_scope(self, role: str) -> ScopeContext:
        principal = self.principals[role]
        return ScopeContext(
            adapter=HttpAdapter(base_url=f"http://{CARACAL_HOST}", api_key=principal.access_token),
            hooks=HookRegistry(),
            workspace_id=DEFAULT_WORKSPACE_ID,
        )

    @contextlib.contextmanager
    def routed_httpx(self) -> Iterator[None]:
        app_by_host = {
            CARACAL_HOST: self.caracal_app,
            UPSTREAM_HOST: self.upstream_app,
        }
        real_async_client = httpx.AsyncClient

        class _RoutedAsyncClient:
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                self._args = args
                self._kwargs = dict(kwargs)
                self._inner: httpx.AsyncClient | None = None
                self._base_url = str(self._kwargs.get("base_url") or "").rstrip("/")

            def _host_for_url(self, url: str) -> str:
                normalized = str(url or "").strip()
                if not normalized and self._base_url:
                    normalized = self._base_url
                if not normalized:
                    return ""
                return normalized.replace("http://", "").replace("https://", "").split("/", 1)[0]

            def _build_client(self, host: str) -> httpx.AsyncClient:
                if host in app_by_host:
                    routed_kwargs = dict(self._kwargs)
                    headers = routed_kwargs.pop("headers", None)
                    timeout = routed_kwargs.pop("timeout", None)
                    follow_redirects = routed_kwargs.pop("follow_redirects", False)
                    base_url = self._base_url or f"http://{host}"
                    routed_kwargs.pop("base_url", None)
                    return real_async_client(
                        base_url=base_url,
                        headers=headers,
                        timeout=timeout,
                        follow_redirects=follow_redirects,
                        transport=httpx.ASGITransport(app=app_by_host[host]),
                    )
                return real_async_client(*self._args, **self._kwargs)

            async def _ensure_client(self, url: str = "") -> httpx.AsyncClient:
                host = self._host_for_url(url)
                if self._inner is None or self._inner.is_closed:
                    self._inner = self._build_client(host)
                return self._inner

            async def request(self, *args: Any, **kwargs: Any) -> Any:
                url = kwargs.get("url")
                if len(args) >= 2:
                    url = args[1]
                client = await self._ensure_client(str(url or ""))
                return await client.request(*args, **kwargs)

            async def post(self, *args: Any, **kwargs: Any) -> Any:
                url = kwargs.get("url")
                if args:
                    url = args[0]
                client = await self._ensure_client(str(url or ""))
                return await client.post(*args, **kwargs)

            async def aclose(self) -> None:
                if self._inner is not None:
                    await self._inner.aclose()

            @property
            def is_closed(self) -> bool:
                if self._inner is None:
                    return False
                return self._inner.is_closed

        httpx.AsyncClient = _RoutedAsyncClient
        try:
            yield
        finally:
            httpx.AsyncClient = real_async_client

    def _mock_brief(self, role: str) -> str:
        outcomes = business_outcomes(self.scenario)
        if role == "finance":
            departments = [
                item["department"]
                for item in outcomes.get("over_budget_departments", [])
                if item.get("department")
            ]
            invoices = outcomes.get("pending_invoice_ids", [])
            department_text = ", ".join(departments) if departments else "no departments"
            invoice_text = ", ".join(invoices) if invoices else "no pending invoices"
            return (
                "Finance brief: focus on "
                f"{department_text}; pending invoices requiring attention: {invoice_text}."
            )

        services = outcomes.get("degraded_services", [])
        breaches = outcomes.get("vendor_sla_breaches", [])
        service_text = ", ".join(services) if services else "no degraded services"
        breach_text = ", ".join(breaches) if breaches else "no SLA breaches"
        return (
            "Ops brief: stabilize "
            f"{service_text}; vendor escalation target: {breach_text}."
        )

    async def _call_openai(self, prompt: str) -> dict[str, Any]:
        api_key = str(os.environ.get("OPENAI_API_KEY") or "").strip()
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY is required for real mode")

        model = os.environ.get("LANGCHAIN_DEMO_OPENAI_MODEL", "gpt-4.1-mini")
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
                            "content": (
                                "You are an AI employee in a governed enterprise workflow. "
                                "Return a concise operational brief with findings and next actions."
                            ),
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

    async def _call_gemini(self, prompt: str) -> dict[str, Any]:
        api_key = str(os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY") or "").strip()
        if not api_key:
            raise RuntimeError("GOOGLE_API_KEY or GEMINI_API_KEY is required for real mode")

        model = os.environ.get("LANGCHAIN_DEMO_GEMINI_MODEL", "gemini-2.0-flash")
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}",
                json={
                    "contents": [
                        {
                            "parts": [
                                {
                                    "text": (
                                        "You are an AI employee in a governed enterprise workflow. "
                                        "Return a concise operational brief with findings and next actions.\n\n"
                                        + prompt
                                    )
                                }
                            ]
                        }
                    ]
                },
            )
            response.raise_for_status()
            payload = response.json()
        candidates = payload.get("candidates", [])
        first = candidates[0] if candidates else {}
        content = first.get("content", {})
        parts = content.get("parts", [])
        rendered = "\n".join(str(part.get("text", "")).strip() for part in parts if part.get("text"))
        return {
            "provider_family": "gemini",
            "model": model,
            "summary_text": rendered.strip(),
            "usage": payload.get("usageMetadata"),
        }

    def _finance_prompt(self, finance_data: dict[str, Any]) -> str:
        return (
            "Review this finance package and produce a short brief with risks and next actions.\n\n"
            + json.dumps(finance_data, indent=2)
        )

    def _ops_prompt(self, ops_data: dict[str, Any]) -> str:
        return (
            "Review this ops package and produce a short brief with risks and next actions.\n\n"
            + json.dumps(ops_data, indent=2)
        )

    def _build_upstream_app(self) -> FastAPI:
        app = FastAPI(title="LangChain Demo Upstream")

        @app.post("/tool/call")
        async def tool_call(request: Request) -> dict[str, Any]:
            payload = await request.json()
            provider_name = str(payload.get("provider_name") or "").strip()
            resource_scope = str(payload.get("resource_scope") or "").strip()
            action_scope = str(payload.get("action_scope") or "").strip()
            tool_args = dict(payload.get("tool_args") or {})
            self.upstream_requests.append(
                {
                    "timestamp": _iso_now(),
                    "provider_name": provider_name,
                    "resource_scope": resource_scope,
                    "action_scope": action_scope,
                    "tool_args": tool_args,
                }
            )

            if provider_name == "swarm-internal" and resource_scope.endswith(":finance"):
                return {
                    "provider_name": provider_name,
                    "resource_scope": resource_scope,
                    "action_scope": action_scope,
                    "content": {
                        "department_snapshot": finance_snapshot(self.scenario),
                        "pending_invoices": pending_invoices(self.scenario),
                        "risk_flags": finance_risk_flags(self.scenario, overrun_threshold_percent=3.0),
                    },
                }

            if provider_name == "swarm-internal" and resource_scope.endswith(":ops"):
                return {
                    "provider_name": provider_name,
                    "resource_scope": resource_scope,
                    "action_scope": action_scope,
                    "content": {
                        "service_summary": ops_service_summary(self.scenario),
                        "recent_incidents": recent_incidents(self.scenario, incident_hours=24),
                        "vendor_sla_breaches": vendor_sla_breaches(self.scenario),
                    },
                }

            analysis_kind = str(tool_args.get("analysis_kind") or "unknown").strip().lower()
            prompt = str(tool_args.get("prompt") or "").strip()

            if provider_name == "swarm-openai":
                content = (
                    {
                        "provider_family": "openai",
                        "model": "mock-openai-finance",
                        "summary_text": self._mock_brief(analysis_kind or "finance"),
                    }
                    if self.config.mode == "mock"
                    else await self._call_openai(prompt)
                )
                return {
                    "provider_name": provider_name,
                    "resource_scope": resource_scope,
                    "action_scope": action_scope,
                    "content": content,
                }

            if provider_name == "swarm-gemini":
                content = (
                    {
                        "provider_family": "gemini",
                        "model": "mock-gemini-ops",
                        "summary_text": self._mock_brief(analysis_kind or "ops"),
                    }
                    if self.config.mode == "mock"
                    else await self._call_gemini(prompt)
                )
                return {
                    "provider_name": provider_name,
                    "resource_scope": resource_scope,
                    "action_scope": action_scope,
                    "content": content,
                }

            raise HTTPException(status_code=400, detail=f"Unsupported upstream provider: {provider_name}")

        return app


def _resolve_role_provider(strategy: str, role: str) -> str:
    normalized = str(strategy or "mixed").strip().lower()
    if normalized == "openai":
        return "openai"
    if normalized == "gemini":
        return "gemini"
    if role == "finance":
        return "openai"
    if role == "ops":
        return "gemini"
    return "openai"


def _role_brief_tool_id(strategy: str, role: str) -> str:
    provider = _resolve_role_provider(strategy, role)
    if provider == "openai":
        return TOOL_IDS["openai_finance"] if role == "finance" else TOOL_IDS["openai_ops"]
    return TOOL_IDS["gemini_finance"] if role == "finance" else TOOL_IDS["gemini_ops"]


async def _call_tool(
    scope: ScopeContext,
    *,
    tool_id: str,
    mandate_id: str,
    tool_args: dict[str, Any],
    trace_id: str,
) -> dict[str, Any]:
    response = await scope.tools.call(
        tool_id=tool_id,
        mandate_id=mandate_id,
        tool_args=tool_args,
        metadata={"trace_id": trace_id},
    )
    if not bool(response.get("success")):
        raise RuntimeError(str(response.get("error") or f"Tool call failed for {tool_id}"))
    return response


async def run_demo_workflow_async(
    scenario: dict[str, Any],
    config: DemoRunConfig,
) -> dict[str, Any]:
    env = DemoEnvironment(scenario, config)

    all_resources = {
        "provider:swarm-internal:resource:finance",
        "provider:swarm-internal:resource:ops",
        "provider:swarm-internal:resource:orchestrator",
        "provider:swarm-openai:resource:chat.completions",
        "provider:swarm-gemini:resource:generateContent",
    }
    all_actions = {
        "provider:swarm-internal:action:read",
        "provider:swarm-internal:action:assemble",
        "provider:swarm-openai:action:invoke",
        "provider:swarm-gemini:action:invoke",
    }

    source_mandate_id = env.authority.issue_source_mandate(
        role="orchestrator",
        subject_id=env.principals["orchestrator"].principal_id,
        resource_scope=all_resources,
        action_scope=all_actions,
    )

    finance_brief_tool = _role_brief_tool_id(config.provider_strategy, "finance")
    ops_brief_tool = _role_brief_tool_id(config.provider_strategy, "ops")
    finance_resource, finance_action = _scope_pair(TOOL_IDS["finance_data"])
    finance_ai_resource, finance_ai_action = _scope_pair(finance_brief_tool)
    ops_resource, ops_action = _scope_pair(TOOL_IDS["ops_data"])
    ops_ai_resource, ops_ai_action = _scope_pair(ops_brief_tool)
    orchestrator_resource, orchestrator_action = _scope_pair(TOOL_IDS["assemble"])

    finance_mandate_id = env.authority.delegate(
        source_mandate_id=source_mandate_id,
        target_role="finance",
        target_subject_id=env.principals["finance"].principal_id,
        resource_scope={finance_resource, finance_ai_resource},
        action_scope={finance_action, finance_ai_action},
    )
    ops_mandate_id = env.authority.delegate(
        source_mandate_id=source_mandate_id,
        target_role="ops",
        target_subject_id=env.principals["ops"].principal_id,
        resource_scope={ops_resource, ops_ai_resource},
        action_scope={ops_action, ops_ai_action},
    )
    orchestrator_mandate_id = env.authority.delegate(
        source_mandate_id=source_mandate_id,
        target_role="orchestrator",
        target_subject_id=env.principals["orchestrator"].principal_id,
        resource_scope={orchestrator_resource},
        action_scope={orchestrator_action},
    )

    orchestrator_scope = env.role_scope("orchestrator")
    finance_scope = env.role_scope("finance")
    ops_scope = env.role_scope("ops")

    with env.routed_httpx():
        try:
            finance_data_response = await _call_tool(
                finance_scope,
                tool_id=TOOL_IDS["finance_data"],
                mandate_id=finance_mandate_id,
                tool_args={"scenario": scenario},
                trace_id="finance-data",
            )
            finance_data = dict(finance_data_response["result"].get("content") or {})

            finance_brief_response = await _call_tool(
                finance_scope,
                tool_id=finance_brief_tool,
                mandate_id=finance_mandate_id,
                tool_args={
                    "analysis_kind": "finance",
                    "prompt": env._finance_prompt(finance_data),
                },
                trace_id="finance-brief",
            )
            finance_brief = dict(finance_brief_response["result"].get("content") or {})

            ops_data_response = await _call_tool(
                ops_scope,
                tool_id=TOOL_IDS["ops_data"],
                mandate_id=ops_mandate_id,
                tool_args={"scenario": scenario},
                trace_id="ops-data",
            )
            ops_data = dict(ops_data_response["result"].get("content") or {})

            ops_brief_response = await _call_tool(
                ops_scope,
                tool_id=ops_brief_tool,
                mandate_id=ops_mandate_id,
                tool_args={
                    "analysis_kind": "ops",
                    "prompt": env._ops_prompt(ops_data),
                },
                trace_id="ops-brief",
            )
            ops_brief = dict(ops_brief_response["result"].get("content") or {})

            assemble_response = await _call_tool(
                orchestrator_scope,
                tool_id=TOOL_IDS["assemble"],
                mandate_id=orchestrator_mandate_id,
                tool_args={
                    "scenario": scenario,
                    "finance_data": finance_data,
                    "finance_brief": finance_brief,
                    "ops_data": ops_data,
                    "ops_brief": ops_brief,
                    "mode_label": config.mode,
                },
                trace_id="orchestrator-assemble",
            )
            assembled = dict(assemble_response.get("result") or {})

            timeline = [
                {
                    "step": 1,
                    "role": "finance",
                    "tool_id": TOOL_IDS["finance_data"],
                    "mandate_id": finance_mandate_id,
                    "execution_mode": finance_data_response.get("metadata", {}).get("execution_mode"),
                    "provider_name": finance_data_response.get("metadata", {}).get("provider_name"),
                    "output": finance_data,
                },
                {
                    "step": 2,
                    "role": "finance",
                    "tool_id": finance_brief_tool,
                    "mandate_id": finance_mandate_id,
                    "execution_mode": finance_brief_response.get("metadata", {}).get("execution_mode"),
                    "provider_name": finance_brief_response.get("metadata", {}).get("provider_name"),
                    "output": finance_brief,
                },
                {
                    "step": 3,
                    "role": "ops",
                    "tool_id": TOOL_IDS["ops_data"],
                    "mandate_id": ops_mandate_id,
                    "execution_mode": ops_data_response.get("metadata", {}).get("execution_mode"),
                    "provider_name": ops_data_response.get("metadata", {}).get("provider_name"),
                    "output": ops_data,
                },
                {
                    "step": 4,
                    "role": "ops",
                    "tool_id": ops_brief_tool,
                    "mandate_id": ops_mandate_id,
                    "execution_mode": ops_brief_response.get("metadata", {}).get("execution_mode"),
                    "provider_name": ops_brief_response.get("metadata", {}).get("provider_name"),
                    "output": ops_brief,
                },
                {
                    "step": 5,
                    "role": "orchestrator",
                    "tool_id": TOOL_IDS["assemble"],
                    "mandate_id": orchestrator_mandate_id,
                    "execution_mode": assemble_response.get("metadata", {}).get("execution_mode"),
                    "provider_name": assemble_response.get("metadata", {}).get("provider_name"),
                    "output": assembled,
                },
            ]

            revocation = {
                "executed": False,
                "revoked_mandate_id": None,
                "denial_captured": False,
                "denial_evidence": None,
            }
            if config.include_revocation_check:
                env.authority.revoke(
                    mandate_id=finance_mandate_id,
                    revoker_role="orchestrator",
                    reason="Demo runtime revocation check",
                )
                revocation["executed"] = True
                revocation["revoked_mandate_id"] = finance_mandate_id
                denied_response = await finance_scope.tools.call(
                    tool_id=TOOL_IDS["finance_data"],
                    mandate_id=finance_mandate_id,
                    tool_args={"scenario": scenario},
                    metadata={"trace_id": "finance-denied-after-revoke"},
                )
                denied = not bool(denied_response.get("success"))
                revocation["denial_captured"] = denied
                revocation["denial_evidence"] = {
                    "timestamp": _iso_now(),
                    "denied": denied,
                    "response": denied_response,
                }
                timeline.append(
                    {
                        "step": 6,
                        "role": "orchestrator",
                        "event": "revocation",
                        "revoked_mandate_id": finance_mandate_id,
                        "denial_evidence": revocation["denial_evidence"],
                    }
                )

            summary = str(assembled.get("summary") or format_mock_summary(business_outcomes(scenario), governed=True))
            if revocation.get("denial_captured"):
                summary += " Revocation check: subsequent finance call denied as expected."

            result = {
                "mode": "caracal-demo-mock" if config.mode == "mock" else "caracal-demo-real",
                "provider_strategy": config.provider_strategy,
                "timestamp": _iso_now(),
                "input_prompt": scenario.get("user_prompt", ""),
                "final_summary": summary,
                "timeline": timeline,
                "business_outcomes": assembled.get("business_outcomes") or business_outcomes(scenario),
                "delegation": {
                    "source_mandate_id": source_mandate_id,
                    "edges": [
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
                    ],
                    "verified": (
                        env.authority.parent_mandate_id(finance_mandate_id) == source_mandate_id
                        and env.authority.parent_mandate_id(ops_mandate_id) == source_mandate_id
                        and env.authority.parent_mandate_id(orchestrator_mandate_id) == source_mandate_id
                    ),
                },
                "revocation": revocation,
                "identities": [
                    {
                        "role": principal.role,
                        "principal_id": principal.principal_id,
                        "access_token": _mask_token(principal.access_token),
                        "mandate_id": {
                            "orchestrator": orchestrator_mandate_id,
                            "finance": finance_mandate_id,
                            "ops": ops_mandate_id,
                        }[principal.role],
                    }
                    for principal in env.principals.values()
                ],
                "authority_evidence": list(env.authority.events),
                "authority_validations": list(env.authority.validation_records),
                "metering_events": [_serialize_metering_event(event) for event in env.metering.events],
                "upstream_requests": list(env.upstream_requests),
                "caracal_runtime": {
                    "sdk_endpoint": f"http://{CARACAL_HOST}/mcp/tool/call",
                    "upstream_endpoint": f"http://{UPSTREAM_HOST}/tool/call",
                    "workspace_id": DEFAULT_WORKSPACE_ID,
                },
            }
            return attach_acceptance(result, scenario)
        finally:
            orchestrator_scope._adapter.close()
            finance_scope._adapter.close()
            ops_scope._adapter.close()


def run_demo_workflow(scenario: dict[str, Any], config: DemoRunConfig) -> dict[str, Any]:
    return asyncio.run(run_demo_workflow_async(scenario, config))
