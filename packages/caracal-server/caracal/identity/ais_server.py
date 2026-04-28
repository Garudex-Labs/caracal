"""AIS HTTP server module with local-transport enforcement helpers."""

from __future__ import annotations

from dataclasses import dataclass, field as dataclass_field
import ipaddress
import os
import socket
from typing import Callable, Optional

from fastapi import APIRouter, FastAPI, Header, HTTPException
from pydantic import Field

from caracal.types import JsonObject, StrictAPIModel


class AISBindTargetError(RuntimeError):
    """Raised when AIS is configured to listen on a non-local bind target."""


def _default_unix_socket_path() -> str:
    ccl_home = os.environ.get("CCL_HOME", "").strip()
    home = ccl_home if ccl_home else os.path.join(os.path.expanduser("~"), ".caracal")
    return os.path.join(home, "run", "caracal-ais.sock")


@dataclass(frozen=True)
class AISServerConfig:
    """Configuration surface for AIS app construction and bind policy."""

    api_prefix: str = "/v1/ais"
    unix_socket_path: str = dataclass_field(default_factory=_default_unix_socket_path)
    listen_host: str = "127.0.0.1"
    listen_port: int = 7079
    allow_tcp_transport: bool = False


@dataclass(frozen=True)
class AISListenTarget:
    """Resolved bind target for AIS runtime startup wiring."""

    transport: str
    host: Optional[str] = None
    port: Optional[int] = None
    unix_socket_path: Optional[str] = None


@dataclass
class AISHandlers:
    """Handler callbacks used by AIS endpoints.

    Each callback intentionally keeps interface-level payloads simple so runtime
    integration can wire concrete services (identity, session, signing, spawn)
    without leaking transport concerns into core logic.
    """

    get_identity: Callable[[str, str], JsonObject | None]
    issue_token: Callable[["TokenIssueRequest", Optional[str]], JsonObject]
    sign_payload: Callable[["SignRequest", str], JsonObject]
    spawn_principal: Callable[["SpawnRequest", str], JsonObject]
    derive_task_token: Callable[["TaskTokenDeriveRequest", str], JsonObject]
    issue_handoff_token: Callable[["HandoffRequest", str], JsonObject]
    refresh_session: Callable[["RefreshRequest", str], JsonObject]


class TokenIssueRequest(StrictAPIModel):
    principal_id: str = Field(..., min_length=1)
    workspace_id: str = Field(..., min_length=1)
    tenant_id: str = Field(..., min_length=1)
    session_kind: str = Field(default="automation")
    directory_scope: Optional[str] = None
    include_refresh: bool = True
    attestation_nonce: Optional[str] = None
    extra_claims: JsonObject | None = None


class SignRequest(StrictAPIModel):
    principal_id: str = Field(..., min_length=1)
    payload: JsonObject


class SpawnRequest(StrictAPIModel):
    issuer_principal_id: str = Field(..., min_length=1)
    principal_name: str = Field(..., min_length=1)
    principal_kind: str = Field(..., min_length=1)
    owner: str = Field(..., min_length=1)
    resource_scope: list[str]
    action_scope: list[str]
    validity_seconds: int = Field(..., ge=1)
    idempotency_key: str = Field(..., min_length=1)
    source_mandate_id: Optional[str] = None
    network_distance: Optional[int] = None


class TaskTokenDeriveRequest(StrictAPIModel):
    parent_access_token: str = Field(..., min_length=1)
    task_id: str = Field(..., min_length=1)
    caveats: list[str] = Field(default_factory=list)
    ttl_seconds: int = Field(default=300, ge=1)


class HandoffRequest(StrictAPIModel):
    source_access_token: str = Field(..., min_length=1)
    target_subject_id: str = Field(..., min_length=1)
    caveats: Optional[list[str]] = None
    ttl_seconds: int = Field(default=120, ge=1)


class RefreshRequest(StrictAPIModel):
    refresh_token: str = Field(..., min_length=1)


def _extract_required_bearer(authorization: Optional[str]) -> str:
    raw = str(authorization or "").strip()
    if not raw:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    parts = raw.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        raise HTTPException(
            status_code=401,
            detail="Invalid Authorization header format; expected Bearer token",
        )
    return raw


def _is_loopback_host(host: str) -> bool:
    normalized = str(host or "").strip().lower()
    if normalized in {"localhost", "127.0.0.1", "::1"}:
        return True

    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def validate_ais_bind_host(host: str) -> None:
    """Fail closed when AIS bind host is not local-only."""
    normalized = str(host or "").strip()
    if not normalized:
        raise AISBindTargetError("AIS listen host cannot be empty")
    if not _is_loopback_host(normalized):
        raise AISBindTargetError(
            f"AIS listen host {normalized!r} is not local-only; use loopback or Unix socket"
        )


def resolve_ais_listen_target(config: AISServerConfig) -> AISListenTarget:
    """Resolve preferred bind target: Unix socket by default, explicit dev TCP only."""
    if config.unix_socket_path and hasattr(socket, "AF_UNIX") and os.name != "nt":
        return AISListenTarget(
            transport="unix",
            unix_socket_path=config.unix_socket_path,
        )

    if not config.allow_tcp_transport:
        raise AISBindTargetError(
            "AIS TCP transport is disabled by default; configure a Unix socket or explicitly enable dev TCP"
        )
    validate_ais_bind_host(config.listen_host)
    return AISListenTarget(
        transport="tcp",
        host=config.listen_host,
        port=config.listen_port,
    )


def create_ais_app(
    handlers: AISHandlers,
    config: AISServerConfig = AISServerConfig(),
) -> FastAPI:
    """Create AIS FastAPI app with versioned endpoint contract."""
    # Validate target at app-construction time so startup wiring can fail fast.
    resolve_ais_listen_target(config)

    app = FastAPI(title="Caracal AIS", version="1.0.0")
    router = APIRouter(prefix=config.api_prefix)

    @router.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @router.get("/identity/{principal_id}")
    def identity(
        principal_id: str,
        authorization: Optional[str] = Header(default=None),
    ) -> JsonObject:
        payload = handlers.get_identity(principal_id, _extract_required_bearer(authorization))
        if payload is None:
            raise HTTPException(status_code=404, detail="principal not found")
        return payload

    @router.post("/token")
    def token(
        request: TokenIssueRequest,
        authorization: Optional[str] = Header(default=None),
    ) -> JsonObject:
        return handlers.issue_token(request, authorization)

    @router.post("/sign")
    def sign(
        request: SignRequest,
        authorization: Optional[str] = Header(default=None),
    ) -> JsonObject:
        return handlers.sign_payload(request, _extract_required_bearer(authorization))

    @router.post("/spawn")
    def spawn(
        request: SpawnRequest,
        authorization: Optional[str] = Header(default=None),
    ) -> JsonObject:
        return handlers.spawn_principal(request, _extract_required_bearer(authorization))

    @router.post("/task-token/derive")
    def task_token_derive(
        request: TaskTokenDeriveRequest,
        authorization: Optional[str] = Header(default=None),
    ) -> JsonObject:
        return handlers.derive_task_token(request, _extract_required_bearer(authorization))

    @router.post("/handoff")
    def handoff(
        request: HandoffRequest,
        authorization: Optional[str] = Header(default=None),
    ) -> JsonObject:
        return handlers.issue_handoff_token(request, _extract_required_bearer(authorization))

    @router.post("/refresh")
    def refresh(
        request: RefreshRequest,
        authorization: Optional[str] = Header(default=None),
    ) -> JsonObject:
        return handlers.refresh_session(request, _extract_required_bearer(authorization))

    app.include_router(router)
    return app
