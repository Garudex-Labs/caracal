"""Unit tests for provider catalog record construction."""

import pytest

from caracal.provider.catalog import build_provider_record, workspace_to_gateway_sync_record


def test_build_provider_record_with_definition_enables_scoped_requests() -> None:
    record = build_provider_record(
        name="openai-main",
        service_type="ai",
        definition_id="openai.chat.api",
        auth_scheme="bearer",
        base_url="https://api.openai.com",
        definition={
            "resources": {
                "models": {
                    "description": "Model listing",
                    "actions": {
                        "list": {
                            "description": "List models",
                            "method": "GET",
                            "path_prefix": "/v1/models",
                        }
                    },
                }
            }
        },
        credential_ref="workspace/provider/openai-main",
    )

    assert record["definition"]["definition_id"] == "openai.chat.api"
    assert record["credential_ref"] == "workspace/provider/openai-main"
    assert record["resources"] == ["models"]
    assert record["actions"] == ["list"]
    assert record["enforce_scoped_requests"] is True
    assert "provider_definition_data" not in record


def test_build_provider_record_without_definition_supports_passthrough_provider() -> None:
    record = build_provider_record(
        name="webhook-relay",
        service_type="internal",
        definition_id="webhook-relay",
        auth_scheme="none",
        base_url="https://relay.example.com",
    )

    assert record["definition"] is None
    assert record["resources"] == []
    assert record["actions"] == []
    assert record["enforce_scoped_requests"] is False


def test_build_provider_record_rejects_scoped_mode_without_definition() -> None:
    with pytest.raises(ValueError, match="Scoped providers require"):
        build_provider_record(
            name="broken-scoped",
            service_type="application",
            definition_id="broken-scoped",
            auth_scheme="bearer",
            base_url="https://api.example.com",
            enforce_scoped_requests=True,
        )


def test_workspace_to_gateway_sync_record_strips_workspace_runtime_state() -> None:
    record = workspace_to_gateway_sync_record(
        provider_name="openai-main",
        entry={
            "name": "openai-main",
            "service_type": "ai",
            "provider_definition": "openai.responses",
            "auth_scheme": "bearer",
            "base_url": "https://api.openai.com",
            "credential_ref": "caracal:default/providers/openai-main/credential",
            "credential_storage": "workspace_vault",
            "template_id": "oss-starter-openai",
            "managed_by": "workspace-template",
            "metadata": {"owner": "workspace"},
        },
        workspace_id="org-123",
    )

    assert record["workspace_id"] == "org-123"
    assert record["credential_ref"] is None
    assert record["credential_storage"] == "gateway_vault"
    assert record["template_id"] is None
    assert record["managed_by"] is None
    assert record["definition"] is None
    assert record["enforce_scoped_requests"] is False


def test_workspace_to_gateway_sync_record_keeps_shared_definition_metadata_only() -> None:
    record = workspace_to_gateway_sync_record(
        provider_name="github-rest",
        entry={
            "service_type": "application",
            "provider_definition": "github.rest",
            "auth_scheme": "bearer",
            "base_url": "https://api.github.com",
            "definition": {
                "resources": {
                    "repos": {
                        "description": "Repositories",
                        "actions": {
                            "list": {
                                "description": "List repos",
                                "method": "GET",
                                "path_prefix": "/user/repos",
                            }
                        },
                    }
                }
            },
        },
        workspace_id="org-456",
    )

    assert record["provider_definition"] == "github.rest"
    assert record["resources"] == ["repos"]
    assert record["actions"] == ["list"]
    assert record["enforce_scoped_requests"] is True
