from caracal.flow.screens.provider_manager import (
    _PROVIDER_PATTERNS,
    _build_resources_from_pattern,
    _masked_secret_summary,
    _suggest_identifier,
    _validate_identifier_value,
)


def test_validate_identifier_value_accepts_scope_safe_identifier():
    assert _validate_identifier_value("Provider name", "openai-main") == (True, "")


def test_validate_identifier_value_suggests_normalized_identifier():
    valid, message = _validate_identifier_value("Provider name", "OpenAI Main/Prod")

    assert valid is False
    assert "openai-main-prod" in message


def test_build_resources_from_pattern_preserves_actions():
    pattern = _PROVIDER_PATTERNS["ai"][0]

    resources = _build_resources_from_pattern(pattern)

    assert set(resources.keys()) == {"responses", "embeddings", "models"}
    assert resources["responses"]["actions"]["create"]["method"] == "POST"
    assert resources["embeddings"]["actions"]["embed"]["path_prefix"] == "/v1/embeddings"


def test_masked_secret_summary_reports_multiline_size_without_content():
    summary = _masked_secret_summary("line-1\nline-2\nline-3")

    assert summary == "**** (20 chars across 3 lines)"


def test_suggest_identifier_removes_invalid_characters():
    assert _suggest_identifier("  Azure OpenAI / Main  ") == "azure-openai-main"
