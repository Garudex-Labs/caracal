"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Orchestrator-led demo runtime using scope.tools.call() and SpawnManager.
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID, uuid4

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ec import (
    SECP256R1,
    generate_private_key,
)
from cryptography.hazmat.backends import default_backend
from sqlalchemy.orm import Session

from caracal_sdk.client import CaracalClient
from caracal_sdk.hooks import HookRegistry
from caracal_sdk.adapters.http import HttpAdapter

from .trace_store import TraceEvent, TraceStore, now_iso


_ORCHESTRATOR_TOOL = "demo:ops:recommendation:write"
_WORKER_TOOLS = [
    "demo:ops:incidents:read",
    "demo:ops:deployments:read",
    "demo:ops:logs:read",
    # 4th worker: intentional enforcement denial — incidents-only scope vs deployments tool
    "demo:ops:deployments:read",
]
_WORKER_RESOURCE_SCOPES = [
    "resource:ops-api:incidents",
    "resource:ops-api:deployments",
    "resource:ops-api:logs",
    "resource:ops-api:incidents",  # restricted: incidents only, but tool needs deployments
]
_WORKER_ACTION_SCOPES = [
    "action:ops-api:incidents:read",
    "action:ops-api:deployments:read",
    "action:ops-api:logs:read",
    "action:ops-api:incidents:read",  # restricted: incidents only → enforcement denial
]
_WORKER_LABELS = [
    "incidents-reader",
    "deployments-reader",
    "logs-reader",
    "denial-demo",
]
_ORCH_RESOURCE_SCOPES = [
    "resource:ops-api:incidents",
    "resource:ops-api:deployments",
    "resource:ops-api:logs",
    "resource:ops-api:recommendation",
]
_ORCH_ACTION_SCOPES = [
    "action:ops-api:incidents:read",
    "action:ops-api:deployments:read",
    "action:ops-api:logs:read",
    "action:ops-api:recommendation:write",
]
_WORKER_VALIDITY_SECONDS = 900
_RUN_TENANT = "demo"


@dataclass
class RunConfig:
    mode: str = "mock"
    workspace_id: str = ""


@dataclass
class WorkerResult:
    worker_name: str
    principal_id: str
    tool_id: str
    success: bool
    result: Any
    error: Optional[str]
    latency_ms: float
    mandate_id: str = ""
    denial_reason: str = ""
    result_type: str = "allowed"
    lifecycle_events: list[str] = field(default_factory=list)


@dataclass
class RunResult:
    run_id: str
    workspace_id: str
    mode: str
    orchestrator_principal_id: str
    workers: list[WorkerResult]
    recommendation: dict
    trace_events: list[TraceEvent]
    error: Optional[str] = None


class _StaticJwtSigner:
    """SessionTokenSigner backed by an in-process ECDSA P-256 private key."""

    def __init__(self, private_key_pem: bytes) -> None:
        self._private_key_pem = private_key_pem

    def sign_token(self, *, claims: dict, algorithm: str) -> str:
        return jwt.encode(claims, self._private_key_pem, algorithm=algorithm)


def _generate_keypair() -> tuple[bytes, bytes]:
    """Return (private_key_pem, public_key_pem) for ES256 signing."""
    key = generate_private_key(SECP256R1(), default_backend())
    priv_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    pub_pem = key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return priv_pem, pub_pem


def _build_session_manager(private_pem: bytes, public_pem: bytes):
    from caracal.core.session_manager import SessionManager

    signer = _StaticJwtSigner(private_pem)
    return SessionManager(
        token_signer=signer,
        algorithm="ES256",
        verify_key=public_pem.decode(),
    )


def _issue_token(session_manager, *, subject_id: str, workspace_id: str) -> str:
    from caracal.core.session_manager import SessionKind

    issued = session_manager.issue_session(
        subject_id=subject_id,
        workspace_id=workspace_id,
        tenant_id=_RUN_TENANT,
        session_kind=SessionKind.TASK,
        include_refresh=False,
    )
    return issued.access_token


class DemoRuntime:
    """Orchestrate the demo run: spawn workers, fan out, aggregate, cleanup."""

    def __init__(
        self,
        *,
        db_session: Session,
        workspace_id: str,
        mcp_base_url: str,
        trace_store: TraceStore,
        redis_url: str = "redis://localhost:6379/0",
    ) -> None:
        self._db = db_session
        self._workspace_id = workspace_id
        self._mcp_base_url = mcp_base_url.rstrip("/")
        self._trace_store = trace_store
        self._redis_url = redis_url
        self._private_pem, self._public_pem = _generate_keypair()
        self._session_manager = _build_session_manager(self._private_pem, self._public_pem)
        self._spawned: list[str] = []

    def _redis_client(self):
        from caracal.redis.client import RedisClient

        host, port = "localhost", 6379
        if self._redis_url:
            try:
                from urllib.parse import urlparse
                parsed = urlparse(self._redis_url)
                host = parsed.hostname or host
                port = parsed.port or port
            except Exception:
                pass
        return RedisClient(host=host, port=port)

    def _nonce_manager(self):
        from caracal.identity.attestation_nonce import AttestationNonceManager

        return AttestationNonceManager(self._redis_client(), ttl_seconds=600)

    def _spawn_manager(self):
        from caracal.core.spawn import SpawnManager

        return SpawnManager(
            db_session=self._db,
            attestation_nonce_manager=self._nonce_manager(),
        )

    def _activate_principal(self, principal_id: str, actor_id: str) -> None:
        from caracal.core.identity import PrincipalRegistry
        from caracal.db.models import Principal, PrincipalAttestationStatus
        from uuid import UUID

        principal = (
            self._db.query(Principal)
            .filter(Principal.principal_id == UUID(principal_id))
            .first()
        )
        if principal is None:
            raise RuntimeError(f"Principal not found: {principal_id}")
        principal.attestation_status = PrincipalAttestationStatus.ATTESTED.value
        self._db.flush()
        PrincipalRegistry(self._db).transition_lifecycle_status(
            principal_id, "active", actor_principal_id=actor_id
        )

    def _deactivate_principal(self, principal_id: str, actor_id: str) -> None:
        from caracal.core.identity import PrincipalRegistry

        PrincipalRegistry(self._db).transition_lifecycle_status(
            principal_id, "deactivated", actor_principal_id=actor_id
        )

    def _lookup_orchestrator(self) -> Optional[Any]:
        """Return the first active orchestrator principal row."""
        from caracal.db.models import Principal, PrincipalKind, PrincipalLifecycleStatus

        return (
            self._db.query(Principal)
            .filter_by(
                principal_kind=PrincipalKind.ORCHESTRATOR.value,
                lifecycle_status=PrincipalLifecycleStatus.ACTIVE.value,
            )
            .first()
        )

    def _lookup_orchestrator_mandate(self, orchestrator_id: UUID):
        """Return a valid non-revoked mandate where the orchestrator is the subject."""
        from caracal.db.models import ExecutionMandate

        now = datetime.utcnow()
        return (
            self._db.query(ExecutionMandate)
            .filter(ExecutionMandate.subject_id == orchestrator_id)
            .filter(ExecutionMandate.revoked.is_(False))
            .filter(
                (ExecutionMandate.valid_until == None)  # noqa: E711
                | (ExecutionMandate.valid_until > now)
            )
            .first()
        )

    def _sdk_client(self, bearer_token: str) -> CaracalClient:
        return CaracalClient(api_key=bearer_token, base_url=self._mcp_base_url)

    def _record(
        self,
        *,
        run_id: str,
        principal_id: str,
        principal_kind: str,
        tool_id: str,
        result_type: str,
        mode: str,
        group_id: str = "",
        parent_principal_id: Optional[str] = None,
        lifecycle_event: Optional[str] = None,
        latency_ms: float = 0.0,
        detail: Optional[str] = None,
    ) -> TraceEvent:
        evt = TraceEvent(
            timestamp=now_iso(),
            run_id=run_id,
            correlation_id=str(uuid4()),
            workspace=self._workspace_id,
            principal_id=principal_id,
            principal_kind=principal_kind,
            tool_id=tool_id,
            result_type=result_type,
            mode=mode,
            parent_principal_id=parent_principal_id,
            group_id=group_id,
            lifecycle_event=lifecycle_event,
            latency_ms=latency_ms,
            resource_scope=None,
            action_scope=None,
            provider_name="ops-api",
            execution_mode="local",
            detail=detail,
        )
        self._trace_store.record(evt)
        return evt

    def _classify_result(
        self, success: bool, error: Optional[str]
    ) -> tuple[str, str]:
        """Return (result_type, denial_reason) from a tool call outcome."""
        if success:
            return "allowed", ""
        err = str(error or "")
        if "authority denied" in err.lower() or "denied" in err.lower():
            return "enforcement_deny", err
        return "provider_error", err

    async def _call_worker_tool(
        self,
        *,
        run_id: str,
        group_id: str,
        worker_name: str,
        principal_id: str,
        tool_id: str,
        mandate_id: str,
        bearer_token: str,
        orchestrator_id: str,
        mode: str,
    ) -> WorkerResult:
        client = self._sdk_client(bearer_token)
        scope = client.context.checkout(workspace_id=self._workspace_id)
        t0 = time.monotonic()
        try:
            raw = await scope.tools.call(
                tool_id=tool_id,
                tool_args={},
                correlation_id=f"{run_id}:{worker_name}",
            )
            latency_ms = (time.monotonic() - t0) * 1000
            result = raw if isinstance(raw, dict) else {"result": raw}
            success = bool(result.get("success", True))
            error = result.get("error") if not success else None
            result_type, denial_reason = self._classify_result(success, error)
            self._record(
                run_id=run_id,
                principal_id=principal_id,
                principal_kind="worker",
                tool_id=tool_id,
                result_type=result_type,
                mode=mode,
                group_id=group_id,
                parent_principal_id=orchestrator_id,
                lifecycle_event="executing",
                latency_ms=latency_ms,
                detail=denial_reason or None,
            )
            return WorkerResult(
                worker_name=worker_name,
                principal_id=principal_id,
                tool_id=tool_id,
                success=success,
                result=result,
                error=error,
                latency_ms=latency_ms,
                mandate_id=mandate_id,
                denial_reason=denial_reason,
                result_type=result_type,
            )
        except Exception as exc:
            latency_ms = (time.monotonic() - t0) * 1000
            err = str(exc)
            result_type, denial_reason = self._classify_result(False, err)
            self._record(
                run_id=run_id,
                principal_id=principal_id,
                principal_kind="worker",
                tool_id=tool_id,
                result_type=result_type,
                mode=mode,
                group_id=group_id,
                parent_principal_id=orchestrator_id,
                lifecycle_event="executing",
                latency_ms=latency_ms,
                detail=err,
            )
            return WorkerResult(
                worker_name=worker_name,
                principal_id=principal_id,
                tool_id=tool_id,
                success=False,
                result=None,
                error=err,
                latency_ms=latency_ms,
                mandate_id=mandate_id,
                denial_reason=denial_reason,
                result_type=result_type,
            )
        finally:
            client.close()

    async def execute(self, config: RunConfig) -> RunResult:
        run_id = uuid4().hex
        mode = config.mode
        workspace_id = config.workspace_id or self._workspace_id
        trace_events: list[TraceEvent] = []

        orch_row = self._lookup_orchestrator()
        if orch_row is None:
            return RunResult(
                run_id=run_id,
                workspace_id=workspace_id,
                mode=mode,
                orchestrator_principal_id="",
                workers=[],
                recommendation={},
                trace_events=trace_events,
                error="No active orchestrator principal found. Run preflight and register one.",
            )

        orchestrator_id = str(orch_row.principal_id)
        orch_mandate = self._lookup_orchestrator_mandate(orch_row.principal_id)
        if orch_mandate is None:
            return RunResult(
                run_id=run_id,
                workspace_id=workspace_id,
                mode=mode,
                orchestrator_principal_id=orchestrator_id,
                workers=[],
                recommendation={},
                trace_events=trace_events,
                error="No active mandate for orchestrator. Issue one via: caracal authority mandate.",
            )

        orch_mandate_id = str(orch_mandate.mandate_id)
        orch_token = _issue_token(
            self._session_manager,
            subject_id=orchestrator_id,
            workspace_id=workspace_id,
        )

        self._record(
            run_id=run_id,
            principal_id=orchestrator_id,
            principal_kind="orchestrator",
            tool_id="",
            result_type="allowed",
            mode=mode,
            lifecycle_event="executing",
        )

        spawn_mgr = self._spawn_manager()
        group_id = f"fanout-{run_id[:8]}"
        worker_configs = []
        for idx, (tool_id, res_scope, act_scope) in enumerate(
            zip(_WORKER_TOOLS, _WORKER_RESOURCE_SCOPES, _WORKER_ACTION_SCOPES)
        ):
            label = _WORKER_LABELS[idx] if idx < len(_WORKER_LABELS) else str(idx + 1)
            worker_name = f"demo-worker-{label}-{run_id[:6]}"
            try:
                spawn_result = spawn_mgr.spawn_principal(
                    issuer_principal_id=orchestrator_id,
                    principal_name=worker_name,
                    principal_kind="worker",
                    owner=orchestrator_id,
                    resource_scope=[res_scope],
                    action_scope=[act_scope],
                    validity_seconds=_WORKER_VALIDITY_SECONDS,
                    idempotency_key=f"{run_id}-{idx}",
                    source_mandate_id=orch_mandate_id,
                )
                self._db.commit()
                self._activate_principal(spawn_result.principal_id, orchestrator_id)
                self._spawned.append(spawn_result.principal_id)
                worker_token = _issue_token(
                    self._session_manager,
                    subject_id=spawn_result.principal_id,
                    workspace_id=workspace_id,
                )
                worker_configs.append({
                    "worker_name": worker_name,
                    "principal_id": spawn_result.principal_id,
                    "tool_id": tool_id,
                    "mandate_id": spawn_result.mandate_id,
                    "bearer_token": worker_token,
                })
                self._record(
                    run_id=run_id,
                    principal_id=spawn_result.principal_id,
                    principal_kind="worker",
                    tool_id="",
                    result_type="allowed",
                    mode=mode,
                    group_id=group_id,
                    parent_principal_id=orchestrator_id,
                    lifecycle_event="spawned",
                )
            except Exception as exc:
                return RunResult(
                    run_id=run_id,
                    workspace_id=workspace_id,
                    mode=mode,
                    orchestrator_principal_id=orchestrator_id,
                    workers=[],
                    recommendation={},
                    trace_events=self._trace_store.get_by_run(run_id),
                    error=f"Worker spawn failed: {exc}",
                )

        worker_tasks = [
            self._call_worker_tool(
                run_id=run_id,
                group_id=group_id,
                worker_name=wc["worker_name"],
                principal_id=wc["principal_id"],
                tool_id=wc["tool_id"],
                mandate_id=wc["mandate_id"],
                bearer_token=wc["bearer_token"],
                orchestrator_id=orchestrator_id,
                mode=mode,
            )
            for wc in worker_configs
        ]
        worker_results: list[WorkerResult] = list(await asyncio.gather(*worker_tasks))

        for wc in worker_configs:
            try:
                self._deactivate_principal(wc["principal_id"], orchestrator_id)
                self._db.commit()
                self._record(
                    run_id=run_id,
                    principal_id=wc["principal_id"],
                    principal_kind="worker",
                    tool_id="",
                    result_type="allowed",
                    mode=mode,
                    group_id=group_id,
                    parent_principal_id=orchestrator_id,
                    lifecycle_event="cleaned_up",
                )
            except Exception:
                pass

        successful = [r for r in worker_results if r.success]
        findings: dict = {}
        for r in successful:
            if isinstance(r.result, dict):
                findings[r.tool_id] = r.result

        orch_client = self._sdk_client(orch_token)
        orch_scope = orch_client.context.checkout(workspace_id=workspace_id)
        t0 = time.monotonic()
        recommendation: dict = {}
        try:
            recommendation = await orch_scope.tools.call(
                tool_id=_ORCHESTRATOR_TOOL,
                tool_args={
                    "summary": f"Governed demo run {run_id[:8]}: {len(successful)}/{len(worker_results)} workers succeeded.",
                    "findings": findings,
                    "run_id": run_id,
                },
                correlation_id=f"{run_id}:orchestrator",
            )
            result_type = "allowed" if recommendation.get("success", True) else "denied"
        except Exception as exc:
            recommendation = {"error": str(exc)}
            result_type = "internal_error"
        finally:
            latency_ms = (time.monotonic() - t0) * 1000
            orch_client.close()
            self._record(
                run_id=run_id,
                principal_id=orchestrator_id,
                principal_kind="orchestrator",
                tool_id=_ORCHESTRATOR_TOOL,
                result_type=result_type,
                mode=mode,
                lifecycle_event="completed",
                latency_ms=latency_ms,
            )

        return RunResult(
            run_id=run_id,
            workspace_id=workspace_id,
            mode=mode,
            orchestrator_principal_id=orchestrator_id,
            workers=worker_results,
            recommendation=recommendation,
            trace_events=self._trace_store.get_by_run(run_id),
        )
