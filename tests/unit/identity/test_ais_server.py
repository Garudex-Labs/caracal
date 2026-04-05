"""Unit tests for AIS server module and local transport policy."""

from __future__ import annotations

from fastapi.testclient import TestClient
import pytest

from caracal.identity.ais_server import (
    AISBindTargetError,
    AISHandlers,
    AISServerConfig,
    HandoffRequest,
    RefreshRequest,
    SignRequest,
    SpawnRequest,
    TaskTokenDeriveRequest,
    TokenIssueRequest,
    create_ais_app,
    resolve_ais_listen_target,
    validate_ais_bind_host,
)


def _handlers() -> AISHandlers:
    return AISHandlers(
        get_identity=lambda principal_id: {"principal_id": principal_id},
        issue_token=lambda req: {"access_token": f"token:{req.principal_id}"},
        sign_payload=lambda req: {"signature": f"sig:{req.principal_id}"},
        spawn_principal=lambda req: {
            "principal_id": "spawned-1",
            "attestation_nonce": "nonce-1",
            "request_name": req.principal_name,
        },
        derive_task_token=lambda req: {"access_token": f"task:{req.task_id}"},
        issue_handoff_token=lambda req: {"handoff_token": f"handoff:{req.target_subject_id}"},
        refresh_session=lambda req: {"access_token": f"refresh:{req.refresh_token}"},
    )


@pytest.mark.unit
def test_validate_ais_bind_host_accepts_loopback() -> None:
    validate_ais_bind_host("127.0.0.1")
    validate_ais_bind_host("localhost")


@pytest.mark.unit
def test_validate_ais_bind_host_rejects_non_local() -> None:
    with pytest.raises(AISBindTargetError, match="local-only"):
        validate_ais_bind_host("0.0.0.0")


@pytest.mark.unit
def test_resolve_ais_listen_target_falls_back_to_loopback_tcp() -> None:
    config = AISServerConfig(unix_socket_path="", listen_host="127.0.0.1", listen_port=7777)

    target = resolve_ais_listen_target(config)

    assert target.transport == "tcp"
    assert target.host == "127.0.0.1"
    assert target.port == 7777


@pytest.mark.unit
def test_create_ais_app_registers_required_routes() -> None:
    app = create_ais_app(_handlers(), AISServerConfig(unix_socket_path="", listen_host="127.0.0.1"))

    route_paths = {route.path for route in app.routes}

    assert "/v1/ais/health" in route_paths
    assert "/v1/ais/identity/{principal_id}" in route_paths
    assert "/v1/ais/token" in route_paths
    assert "/v1/ais/sign" in route_paths
    assert "/v1/ais/spawn" in route_paths
    assert "/v1/ais/task-token/derive" in route_paths
    assert "/v1/ais/handoff" in route_paths
    assert "/v1/ais/refresh" in route_paths


@pytest.mark.unit
def test_ais_endpoints_delegate_to_handlers() -> None:
    app = create_ais_app(_handlers(), AISServerConfig(unix_socket_path="", listen_host="127.0.0.1"))
    client = TestClient(app)

    identity_resp = client.get("/v1/ais/identity/p-1")
    assert identity_resp.status_code == 200
    assert identity_resp.json()["principal_id"] == "p-1"

    token_resp = client.post(
        "/v1/ais/token",
        json=TokenIssueRequest(
            principal_id="p-1",
            organization_id="org-1",
            tenant_id="tenant-1",
        ).model_dump(),
    )
    assert token_resp.status_code == 200
    assert token_resp.json()["access_token"] == "token:p-1"

    sign_resp = client.post(
        "/v1/ais/sign",
        json=SignRequest(principal_id="p-1", payload={"a": 1}).model_dump(),
    )
    assert sign_resp.status_code == 200
    assert sign_resp.json()["signature"] == "sig:p-1"

    spawn_resp = client.post(
        "/v1/ais/spawn",
        json=SpawnRequest(
            issuer_principal_id="issuer-1",
            principal_name="worker-1",
            principal_kind="worker",
            owner="ops",
            resource_scope=["provider:openai"],
            action_scope=["infer"],
            validity_seconds=300,
            idempotency_key="idemp-1",
        ).model_dump(),
    )
    assert spawn_resp.status_code == 200
    assert spawn_resp.json()["attestation_nonce"] == "nonce-1"

    task_resp = client.post(
        "/v1/ais/task-token/derive",
        json=TaskTokenDeriveRequest(parent_access_token="a", task_id="task-1").model_dump(),
    )
    assert task_resp.status_code == 200
    assert task_resp.json()["access_token"] == "task:task-1"

    handoff_resp = client.post(
        "/v1/ais/handoff",
        json=HandoffRequest(source_access_token="a", target_subject_id="p-2").model_dump(),
    )
    assert handoff_resp.status_code == 200
    assert handoff_resp.json()["handoff_token"] == "handoff:p-2"

    refresh_resp = client.post(
        "/v1/ais/refresh",
        json=RefreshRequest(refresh_token="r-1").model_dump(),
    )
    assert refresh_resp.status_code == 200
    assert refresh_resp.json()["access_token"] == "refresh:r-1"
