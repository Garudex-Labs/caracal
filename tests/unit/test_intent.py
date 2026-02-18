"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for intent handling.

Tests the Intent data class and IntentHandler for parsing, validating,
and managing intents in the authority enforcement system.
"""

import pytest
from uuid import UUID

from caracal.core.intent import Intent, IntentHandler


class TestIntent:
    """Test Intent data class."""

    def test_intent_creation(self):
        """Test creating an Intent."""
        intent = Intent(
            action="api_call",
            resource="api:openai:gpt-4",
            parameters={"model": "gpt-4", "max_tokens": 1000},
            context={"task": "summarize document"}
        )
        
        assert isinstance(intent.intent_id, UUID)
        assert intent.action == "api_call"
        assert intent.resource == "api:openai:gpt-4"
        assert intent.parameters == {"model": "gpt-4", "max_tokens": 1000}
        assert intent.context == {"task": "summarize document"}

    def test_intent_validation_success(self):
        """Test intent validation with valid data."""
        intent = Intent(
            action="database_query",
            resource="database:users:read"
        )
        
        # Should not raise exception
        intent.validate()

    def test_intent_validation_missing_action(self):
        """Test intent validation fails with missing action."""
        intent = Intent(
            action="",
            resource="api:openai:gpt-4"
        )
        
        with pytest.raises(ValueError, match="Intent must have an action"):
            intent.validate()

    def test_intent_validation_missing_resource(self):
        """Test intent validation fails with missing resource."""
        intent = Intent(
            action="api_call",
            resource=""
        )
        
        with pytest.raises(ValueError, match="Intent must have a resource"):
            intent.validate()

    def test_intent_validation_invalid_action_type(self):
        """Test intent validation fails with non-string action."""
        intent = Intent(
            action=123,  # Invalid type
            resource="api:openai:gpt-4"
        )
        
        with pytest.raises(ValueError, match="Intent action must be a string"):
            intent.validate()

    def test_intent_validation_invalid_resource_type(self):
        """Test intent validation fails with non-string resource."""
        intent = Intent(
            action="api_call",
            resource=["invalid"]  # Invalid type
        )
        
        with pytest.raises(ValueError, match="Intent resource must be a string"):
            intent.validate()

    def test_intent_validation_invalid_parameters_type(self):
        """Test intent validation fails with non-dict parameters."""
        intent = Intent(
            action="api_call",
            resource="api:openai:gpt-4",
            parameters="invalid"  # Invalid type
        )
        
        with pytest.raises(ValueError, match="Intent parameters must be a dictionary"):
            intent.validate()

    def test_intent_validation_invalid_context_type(self):
        """Test intent validation fails with non-dict context."""
        intent = Intent(
            action="api_call",
            resource="api:openai:gpt-4",
            context=["invalid"]  # Invalid type
        )
        
        with pytest.raises(ValueError, match="Intent context must be a dictionary"):
            intent.validate()

    def test_intent_hash_generation(self):
        """Test intent hash generation."""
        intent = Intent(
            action="api_call",
            resource="api:openai:gpt-4",
            parameters={"model": "gpt-4"}
        )
        
        hash1 = intent.generate_hash()
        
        # Hash should be 64 characters (SHA-256 hex)
        assert len(hash1) == 64
        assert all(c in '0123456789abcdef' for c in hash1)
        
        # Same intent should generate same hash
        hash2 = intent.generate_hash()
        assert hash1 == hash2

    def test_intent_hash_deterministic(self):
        """Test intent hash is deterministic for same content."""
        intent1 = Intent(
            action="api_call",
            resource="api:openai:gpt-4",
            parameters={"model": "gpt-4", "max_tokens": 1000}
        )
        
        intent2 = Intent(
            action="api_call",
            resource="api:openai:gpt-4",
            parameters={"model": "gpt-4", "max_tokens": 1000}
        )
        
        # Different intent_id but same content should produce same hash
        assert intent1.intent_id != intent2.intent_id
        assert intent1.generate_hash() == intent2.generate_hash()

    def test_intent_hash_different_for_different_content(self):
        """Test intent hash differs for different content."""
        intent1 = Intent(
            action="api_call",
            resource="api:openai:gpt-4"
        )
        
        intent2 = Intent(
            action="api_call",
            resource="api:openai:gpt-3.5"
        )
        
        assert intent1.generate_hash() != intent2.generate_hash()

    def test_intent_hash_ignores_context(self):
        """Test intent hash ignores context field."""
        intent1 = Intent(
            action="api_call",
            resource="api:openai:gpt-4",
            context={"task": "task1"}
        )
        
        intent2 = Intent(
            action="api_call",
            resource="api:openai:gpt-4",
            context={"task": "task2"}
        )
        
        # Different context should not affect hash
        assert intent1.generate_hash() == intent2.generate_hash()

    def test_intent_to_dict(self):
        """Test converting Intent to dictionary."""
        intent = Intent(
            action="api_call",
            resource="api:openai:gpt-4",
            parameters={"model": "gpt-4"},
            context={"task": "summarize"}
        )
        
        data = intent.to_dict()
        
        assert data["action"] == "api_call"
        assert data["resource"] == "api:openai:gpt-4"
        assert data["parameters"] == {"model": "gpt-4"}
        assert data["context"] == {"task": "summarize"}
        assert "intent_id" in data


class TestIntentHandler:
    """Test IntentHandler class."""

    def test_parse_intent_success(self):
        """Test parsing valid intent data."""
        handler = IntentHandler()
        
        intent_data = {
            "action": "api_call",
            "resource": "api:openai:gpt-4",
            "parameters": {"model": "gpt-4"},
            "context": {"task": "summarize"}
        }
        
        intent = handler.parse_intent(intent_data)
        
        assert intent.action == "api_call"
        assert intent.resource == "api:openai:gpt-4"
        assert intent.parameters == {"model": "gpt-4"}
        assert intent.context == {"task": "summarize"}

    def test_parse_intent_minimal(self):
        """Test parsing intent with only required fields."""
        handler = IntentHandler()
        
        intent_data = {
            "action": "database_query",
            "resource": "database:users:read"
        }
        
        intent = handler.parse_intent(intent_data)
        
        assert intent.action == "database_query"
        assert intent.resource == "database:users:read"
        assert intent.parameters == {}
        assert intent.context == {}

    def test_parse_intent_invalid_type(self):
        """Test parsing fails with non-dict input."""
        handler = IntentHandler()
        
        with pytest.raises(ValueError, match="Intent data must be a dictionary"):
            handler.parse_intent("invalid")

    def test_parse_intent_missing_action(self):
        """Test parsing fails with missing action."""
        handler = IntentHandler()
        
        intent_data = {
            "resource": "api:openai:gpt-4"
        }
        
        with pytest.raises(ValueError, match="Intent must have an 'action' field"):
            handler.parse_intent(intent_data)

    def test_parse_intent_missing_resource(self):
        """Test parsing fails with missing resource."""
        handler = IntentHandler()
        
        intent_data = {
            "action": "api_call"
        }
        
        with pytest.raises(ValueError, match="Intent must have a 'resource' field"):
            handler.parse_intent(intent_data)

    def test_parse_intent_invalid_parameters_type(self):
        """Test parsing fails with non-dict parameters."""
        handler = IntentHandler()
        
        intent_data = {
            "action": "api_call",
            "resource": "api:openai:gpt-4",
            "parameters": "invalid"
        }
        
        with pytest.raises(ValueError, match="Intent 'parameters' must be a dictionary"):
            handler.parse_intent(intent_data)

    def test_parse_intent_invalid_context_type(self):
        """Test parsing fails with non-dict context."""
        handler = IntentHandler()
        
        intent_data = {
            "action": "api_call",
            "resource": "api:openai:gpt-4",
            "context": ["invalid"]
        }
        
        with pytest.raises(ValueError, match="Intent 'context' must be a dictionary"):
            handler.parse_intent(intent_data)


class MockMandate:
    """Mock ExecutionMandate for testing."""
    
    def __init__(self, action_scope, resource_scope):
        self.action_scope = action_scope
        self.resource_scope = resource_scope


class TestIntentHandlerValidation:
    """Test IntentHandler validation methods."""

    def test_validate_intent_against_mandate_success(self):
        """Test intent validation succeeds with matching mandate."""
        handler = IntentHandler()
        
        intent = Intent(
            action="api_call",
            resource="api:openai:gpt-4"
        )
        
        mandate = MockMandate(
            action_scope=["api_call", "database_query"],
            resource_scope=["api:openai:*", "database:users:*"]
        )
        
        result = handler.validate_intent_against_mandate(intent, mandate)
        assert result is True

    def test_validate_intent_against_mandate_exact_match(self):
        """Test intent validation with exact resource match."""
        handler = IntentHandler()
        
        intent = Intent(
            action="database_query",
            resource="database:users:read"
        )
        
        mandate = MockMandate(
            action_scope=["database_query"],
            resource_scope=["database:users:read"]
        )
        
        result = handler.validate_intent_against_mandate(intent, mandate)
        assert result is True

    def test_validate_intent_against_mandate_action_not_in_scope(self):
        """Test intent validation fails when action not in scope."""
        handler = IntentHandler()
        
        intent = Intent(
            action="file_write",
            resource="file:reports/report.pdf"
        )
        
        mandate = MockMandate(
            action_scope=["api_call", "database_query"],
            resource_scope=["file:*"]
        )
        
        result = handler.validate_intent_against_mandate(intent, mandate)
        assert result is False

    def test_validate_intent_against_mandate_resource_not_in_scope(self):
        """Test intent validation fails when resource not in scope."""
        handler = IntentHandler()
        
        intent = Intent(
            action="api_call",
            resource="api:anthropic:claude"
        )
        
        mandate = MockMandate(
            action_scope=["api_call"],
            resource_scope=["api:openai:*"]
        )
        
        result = handler.validate_intent_against_mandate(intent, mandate)
        assert result is False

    def test_validate_intent_against_mandate_invalid_intent(self):
        """Test intent validation fails with invalid intent."""
        handler = IntentHandler()
        
        intent = Intent(
            action="",  # Invalid
            resource="api:openai:gpt-4"
        )
        
        mandate = MockMandate(
            action_scope=["api_call"],
            resource_scope=["api:openai:*"]
        )
        
        result = handler.validate_intent_against_mandate(intent, mandate)
        assert result is False

    def test_match_resource_pattern_wildcard(self):
        """Test resource pattern matching with wildcards."""
        handler = IntentHandler()
        
        # Test wildcard at end
        assert handler._match_resource_pattern(
            "api:openai:gpt-4",
            ["api:openai:*"]
        ) is True
        
        # Test wildcard in middle
        assert handler._match_resource_pattern(
            "database:users:read",
            ["database:*:read"]
        ) is True
        
        # Test full wildcard
        assert handler._match_resource_pattern(
            "anything:here",
            ["*"]
        ) is True

    def test_match_resource_pattern_no_match(self):
        """Test resource pattern matching with no match."""
        handler = IntentHandler()
        
        assert handler._match_resource_pattern(
            "api:anthropic:claude",
            ["api:openai:*", "database:*"]
        ) is False

    def test_match_resource_pattern_exact(self):
        """Test resource pattern matching with exact match."""
        handler = IntentHandler()
        
        assert handler._match_resource_pattern(
            "api:openai:gpt-4",
            ["api:openai:gpt-4"]
        ) is True


class TestIntentHandlerMandateRequest:
    """Test IntentHandler mandate request methods."""

    def test_request_mandate_for_intent_no_manager(self):
        """Test mandate request fails without mandate manager."""
        handler = IntentHandler()
        
        intent = Intent(
            action="api_call",
            resource="api:openai:gpt-4"
        )
        
        from uuid import uuid4
        
        with pytest.raises(ValueError, match="mandate_manager must be provided"):
            handler.request_mandate_for_intent(
                intent=intent,
                subject_id=uuid4(),
                issuer_id=uuid4(),
                mandate_manager=None
            )

    def test_request_mandate_for_intent_invalid_intent(self):
        """Test mandate request fails with invalid intent."""
        handler = IntentHandler()
        
        intent = Intent(
            action="",  # Invalid
            resource="api:openai:gpt-4"
        )
        
        from uuid import uuid4
        
        # Should fail validation before checking mandate_manager
        with pytest.raises(ValueError, match="Intent must have an action"):
            handler.request_mandate_for_intent(
                intent=intent,
                subject_id=uuid4(),
                issuer_id=uuid4(),
                mandate_manager=None
            )
