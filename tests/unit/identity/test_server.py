"""Unit tests for AIS server module and local transport policy."""

from __future__ import annotations

from fastapi.testclient import TestClient
from pydantic import ValidationError
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
        get_identity=lambda principal_id, _authorization: {"principal_id": principal_id},
        issue_token=lambda req, _authorization=None: {"access_token": f"token:{req.principal_id}"},
        sign_payload=lambda req, _authorization: {"signature": f"sig:{req.principal_id}"},
        spawn_principal=lambda req, _authorization: {
            "principal_id": "spawned-1",
            "attestation_nonce": "nonce-1",
            "request_name": req.principal_name,
        },
        derive_task_token=lambda req, _authorization: {"access_token": f"task:{req.task_id}"},
        issue_handoff_token=lambda req, _authorization: {"handoff_token": f"handoff:{req.target_subject_id}"},
        refresh_session=lambda req, _authorization: {"access_token": f"refresh:{req.refresh_token}"},
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
def test_resolve_ais_listen_target_requires_explicit_loopback_tcp() -> None:
    with pytest.raises(AISBindTargetError, match="disabled by default"):
        resolve_ais_listen_target(
            AISServerConfig(unix_socket_path="", listen_host="127.0.0.1", listen_port=7777)
        )

    config = AISServerConfig(
        unix_socket_path="",
        listen_host="127.0.0.1",
        listen_port=7777,
        allow_tcp_transport=True,
    )

    target = resolve_ais_listen_target(config)

    assert target.transport == "tcp"
    assert target.host == "127.0.0.1"
    assert target.port == 7777


@pytest.mark.unit
def test_create_ais_app_registers_required_routes() -> None:
    app = create_ais_app(
        _handlers(),
        AISServerConfig(unix_socket_path="", listen_host="127.0.0.1", allow_tcp_transport=True),
    )

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
    app = create_ais_app(
        _handlers(),
        AISServerConfig(unix_socket_path="", listen_host="127.0.0.1", allow_tcp_transport=True),
    )
    client = TestClient(app)
    auth_headers = {"Authorization": "Bearer caller-token"}

    identity_resp = client.get("/v1/ais/identity/p-1", headers=auth_headers)
    assert identity_resp.status_code == 200
    assert identity_resp.json()["principal_id"] == "p-1"

    token_resp = client.post(
        "/v1/ais/token",
        json=TokenIssueRequest(
            principal_id="p-1",
            workspace_id="org-1",
            tenant_id="tenant-1",
        ).model_dump(),
    )
    assert token_resp.status_code == 200
    assert token_resp.json()["access_token"] == "token:p-1"

    sign_resp = client.post(
        "/v1/ais/sign",
        json=SignRequest(principal_id="p-1", payload={"a": 1}).model_dump(),
        headers=auth_headers,
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
        headers=auth_headers,
    )
    assert spawn_resp.status_code == 200
    assert spawn_resp.json()["attestation_nonce"] == "nonce-1"

    task_resp = client.post(
        "/v1/ais/task-token/derive",
        json=TaskTokenDeriveRequest(parent_access_token="a", task_id="task-1").model_dump(),
        headers=auth_headers,
    )
    assert task_resp.status_code == 200
    assert task_resp.json()["access_token"] == "task:task-1"

    handoff_resp = client.post(
        "/v1/ais/handoff",
        json=HandoffRequest(source_access_token="a", target_subject_id="p-2").model_dump(),
        headers=auth_headers,
    )
    assert handoff_resp.status_code == 200
    assert handoff_resp.json()["handoff_token"] == "handoff:p-2"

    refresh_resp = client.post(
        "/v1/ais/refresh",
        json=RefreshRequest(refresh_token="r-1").model_dump(),
        headers=auth_headers,
    )
    assert refresh_resp.status_code == 200
    assert refresh_resp.json()["access_token"] == "refresh:r-1"


@pytest.mark.unit
def test_ais_token_endpoint_forwards_authorization_header() -> None:
    seen: dict[str, str | None] = {}

    app = create_ais_app(
        AISHandlers(
            get_identity=lambda principal_id, _authorization: {"principal_id": principal_id},
            issue_token=lambda req, authorization=None: (
                seen.update({"authorization": authorization})
                or {"access_token": f"token:{req.principal_id}"}
            ),
            sign_payload=lambda req, _authorization: {"signature": f"sig:{req.principal_id}"},
            spawn_principal=lambda req, _authorization: {"principal_id": "spawned-1", "attestation_nonce": "nonce-1"},
            derive_task_token=lambda req, _authorization: {"access_token": f"task:{req.task_id}"},
            issue_handoff_token=lambda req, _authorization: {"handoff_token": f"handoff:{req.target_subject_id}"},
            refresh_session=lambda req, _authorization: {"access_token": f"refresh:{req.refresh_token}"},
        ),
        AISServerConfig(unix_socket_path="", listen_host="127.0.0.1", allow_tcp_transport=True),
    )
    client = TestClient(app)

    response = client.post(
        "/v1/ais/token",
        json=TokenIssueRequest(
            principal_id="p-1",
            workspace_id="org-1",
            tenant_id="tenant-1",
        ).model_dump(),
        headers={"Authorization": "Bearer caller-token"},
    )

    assert response.status_code == 200
    assert seen["authorization"] == "Bearer caller-token"


@pytest.mark.unit
def test_spawn_request_rejects_forbidden_fields() -> None:
    app = create_ais_app(
        _handlers(),
        AISServerConfig(unix_socket_path="", listen_host="127.0.0.1", allow_tcp_transport=True),
    )
    client = TestClient(app)

    response = client.post(
        "/v1/ais/spawn",
        json={
            "issuer_principal_id": "issuer-1",
            "principal_name": "worker-1",
            "principal_kind": "worker",
            "owner": "ops",
            "resource_scope": ["provider:openai"],
            "action_scope": ["infer"],
            "validity_seconds": 300,
            "idempotency_key": "idemp-1",
            "source_principal_id": "principal-manual",
            "public_key_pem": "must-not-be-accepted",
            "private_key_pem": "must-not-be-accepted",
        },
    )

    assert response.status_code == 422
    detail = response.json()["detail"]
    fields = {tuple(item["loc"]) for item in detail}
    assert ("body", "source_principal_id") in fields
    assert ("body", "public_key_pem") in fields
    assert ("body", "private_key_pem") in fields


@pytest.mark.unit
def test_other_ais_request_models_reject_extra_fields() -> None:
    with pytest.raises(ValidationError):
        TokenIssueRequest(
            principal_id="p-1",
            workspace_id="org-1",
            tenant_id="tenant-1",
            authority_sources=["m-1"],
        )

    with pytest.raises(ValidationError):
        HandoffRequest(
            source_access_token="tok-1",
            target_subject_id="p-2",
            authority_sources=["m-1"],
        )
