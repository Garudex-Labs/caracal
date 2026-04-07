"""Unit tests for provider catalog record construction."""

from caracal.provider.catalog import build_provider_record


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
