"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for Intent dataclass and IntentHandler in core/intent.py.
"""

from __future__ import annotations

from unittest.mock import MagicMock
from uuid import UUID

import pytest

from caracal.core.intent import Intent, IntentHandler


@pytest.mark.unit
class TestIntentValidate:
    def test_valid_intent_passes(self):
        intent = Intent(action="api_call", resource="api:openai:gpt-4")
        intent.validate()

    def test_empty_action_raises(self):
        intent = Intent(action="", resource="api:openai:gpt-4")
        with pytest.raises(ValueError, match="action"):
            intent.validate()

    def test_empty_resource_raises(self):
        intent = Intent(action="api_call", resource="")
        with pytest.raises(ValueError, match="resource"):
            intent.validate()

    def test_non_dict_parameters_raises(self):
        intent = Intent(action="api_call", resource="api:x", parameters=["bad"])
        with pytest.raises(ValueError, match="parameters"):
            intent.validate()

    def test_non_dict_context_raises(self):
        intent = Intent(action="api_call", resource="api:x", context="bad")
        with pytest.raises(ValueError, match="context"):
            intent.validate()


@pytest.mark.unit
class TestIntentGenerateHash:
    def test_hash_is_hex_string(self):
        intent = Intent(action="api_call", resource="api:openai:gpt-4")
        h = intent.generate_hash()
        assert isinstance(h, str)
        int(h, 16)  # valid hex

    def test_hash_is_64_chars(self):
        intent = Intent(action="api_call", resource="api:openai:gpt-4")
        assert len(intent.generate_hash()) == 64

    def test_hash_is_deterministic(self):
        intent = Intent(action="api_call", resource="api:openai:gpt-4", parameters={"model": "gpt-4"})
        assert intent.generate_hash() == intent.generate_hash()

    def test_hash_differs_by_action(self):
        a = Intent(action="api_call", resource="api:x")
        b = Intent(action="db_query", resource="api:x")
        assert a.generate_hash() != b.generate_hash()

    def test_hash_differs_by_resource(self):
        a = Intent(action="api_call", resource="api:x")
        b = Intent(action="api_call", resource="api:y")
        assert a.generate_hash() != b.generate_hash()

    def test_hash_differs_by_parameters(self):
        a = Intent(action="api_call", resource="api:x", parameters={"k": "v1"})
        b = Intent(action="api_call", resource="api:x", parameters={"k": "v2"})
        assert a.generate_hash() != b.generate_hash()

    def test_hash_excludes_context(self):
        a = Intent(action="api_call", resource="api:x", context={"c": "1"})
        b = Intent(action="api_call", resource="api:x", context={"c": "2"})
        assert a.generate_hash() == b.generate_hash()

    def test_hash_excludes_intent_id(self):
        a = Intent(action="api_call", resource="api:x")
        b = Intent(action="api_call", resource="api:x")
        assert a.intent_id != b.intent_id
        assert a.generate_hash() == b.generate_hash()


@pytest.mark.unit
class TestIntentToDict:
    def test_returns_dict(self):
        intent = Intent(action="api_call", resource="api:x")
        result = intent.to_dict()
        assert isinstance(result, dict)

    def test_intent_id_is_string(self):
        intent = Intent(action="api_call", resource="api:x")
        result = intent.to_dict()
        assert isinstance(result["intent_id"], str)
        UUID(result["intent_id"])  # parseable UUID

    def test_all_fields_present(self):
        intent = Intent(action="api_call", resource="api:x", parameters={"k": "v"}, context={"c": "1"})
        result = intent.to_dict()
        assert result["action"] == "api_call"
        assert result["resource"] == "api:x"
        assert result["parameters"] == {"k": "v"}
        assert result["context"] == {"c": "1"}


@pytest.mark.unit
class TestIntentHandlerParseIntent:
    def setup_method(self):
        self.handler = IntentHandler()

    def test_valid_minimal(self):
        intent = self.handler.parse_intent({"action": "api_call", "resource": "api:x"})
        assert intent.action == "api_call"
        assert intent.resource == "api:x"

    def test_with_parameters_and_context(self):
        intent = self.handler.parse_intent({
            "action": "api_call",
            "resource": "api:x",
            "parameters": {"k": "v"},
            "context": {"c": "1"},
        })
        assert intent.parameters == {"k": "v"}
        assert intent.context == {"c": "1"}

    def test_non_dict_input_raises(self):
        with pytest.raises(ValueError, match="dictionary"):
            self.handler.parse_intent("not a dict")

    def test_missing_action_raises(self):
        with pytest.raises(ValueError, match="action"):
            self.handler.parse_intent({"resource": "api:x"})

    def test_missing_resource_raises(self):
        with pytest.raises(ValueError, match="resource"):
            self.handler.parse_intent({"action": "api_call"})

    def test_empty_action_raises(self):
        with pytest.raises(ValueError, match="action"):
            self.handler.parse_intent({"action": "", "resource": "api:x"})

    def test_non_dict_parameters_raises(self):
        with pytest.raises(ValueError, match="parameters"):
            self.handler.parse_intent({"action": "api_call", "resource": "api:x", "parameters": "bad"})

    def test_non_dict_context_raises(self):
        with pytest.raises(ValueError, match="context"):
            self.handler.parse_intent({"action": "api_call", "resource": "api:x", "context": ["bad"]})

    def test_returns_intent_with_uuid(self):
        intent = self.handler.parse_intent({"action": "api_call", "resource": "api:x"})
        assert isinstance(intent.intent_id, UUID)


@pytest.mark.unit
class TestIntentHandlerValidateAgainstMandate:
    def setup_method(self):
        self.handler = IntentHandler()

    def _mandate(self, action_scope=None, resource_scope=None):
        m = MagicMock()
        m.action_scope = action_scope if action_scope is not None else ["api_call"]
        m.resource_scope = resource_scope if resource_scope is not None else ["api:openai:*"]
        return m

    def test_valid_intent_returns_true(self):
        intent = Intent(action="api_call", resource="api:openai:gpt-4")
        assert self.handler.validate_intent_against_mandate(intent, self._mandate()) is True

    def test_action_not_in_scope_returns_false(self):
        intent = Intent(action="db_query", resource="api:openai:gpt-4")
        assert self.handler.validate_intent_against_mandate(intent, self._mandate()) is False

    def test_resource_not_matching_returns_false(self):
        intent = Intent(action="api_call", resource="db:users:read")
        assert self.handler.validate_intent_against_mandate(intent, self._mandate()) is False

    def test_invalid_intent_empty_action_returns_false(self):
        intent = Intent(action="", resource="api:openai:gpt-4")
        assert self.handler.validate_intent_against_mandate(intent, self._mandate()) is False

    def test_exact_resource_match(self):
        intent = Intent(action="api_call", resource="api:openai:gpt-4")
        mandate = self._mandate(resource_scope=["api:openai:gpt-4"])
        assert self.handler.validate_intent_against_mandate(intent, mandate) is True

    def test_no_resource_scope_returns_false(self):
        intent = Intent(action="api_call", resource="api:openai:gpt-4")
        mandate = self._mandate(resource_scope=[])
        assert self.handler.validate_intent_against_mandate(intent, mandate) is False


@pytest.mark.unit
class TestMatchResourcePattern:
    def setup_method(self):
        self.handler = IntentHandler()

    def test_exact_match(self):
        assert self.handler._match_resource_pattern("api:openai:gpt-4", ["api:openai:gpt-4"]) is True

    def test_wildcard_match(self):
        assert self.handler._match_resource_pattern("api:openai:gpt-4", ["api:openai:*"]) is True

    def test_wildcard_no_match(self):
        assert self.handler._match_resource_pattern("db:users:read", ["api:openai:*"]) is False

    def test_empty_patterns_returns_false(self):
        assert self.handler._match_resource_pattern("api:openai:gpt-4", []) is False

    def test_multiple_patterns_first_matches(self):
        assert self.handler._match_resource_pattern("api:openai:gpt-4", ["api:openai:gpt-4", "db:*"]) is True

    def test_multiple_patterns_second_matches(self):
        assert self.handler._match_resource_pattern("db:users:read", ["api:openai:*", "db:*"]) is True

    def test_prefix_wildcard_match(self):
        assert self.handler._match_resource_pattern("database:users:read", ["database:users:*"]) is True

    def test_broad_wildcard(self):
        assert self.handler._match_resource_pattern("anything:here", ["*"]) is True
