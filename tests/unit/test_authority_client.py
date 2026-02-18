"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for AuthorityClient SDK.

Tests the synchronous authority client implementation.
"""

import pytest
from unittest.mock import Mock, patch, MagicMock
from datetime import datetime, timedelta

from caracal.sdk.authority_client import AuthorityClient
from caracal.exceptions import ConnectionError, SDKConfigurationError


class TestAuthorityClientInitialization:
    """Test AuthorityClient initialization."""

    def test_init_with_base_url(self):
        """Test client initialization with base URL."""
        client = AuthorityClient(base_url="http://localhost:8000")
        assert client.base_url == "http://localhost:8000"
        assert client.api_key is None
        assert client.timeout == 30
        client.close()

    def test_init_with_api_key(self):
        """Test client initialization with API key."""
        client = AuthorityClient(
            base_url="http://localhost:8000",
            api_key="test-key"
        )
        assert client.api_key == "test-key"
        assert "Authorization" in client.session.headers
        assert client.session.headers["Authorization"] == "Bearer test-key"
        client.close()

    def test_init_without_base_url(self):
        """Test client initialization fails without base URL."""
        with pytest.raises(SDKConfigurationError):
            AuthorityClient(base_url="")

    def test_context_manager(self):
        """Test client works as context manager."""
        with AuthorityClient(base_url="http://localhost:8000") as client:
            assert client.base_url == "http://localhost:8000"


class TestAuthorityClientRequestMandate:
    """Test request_mandate method."""

    @patch('caracal.sdk.authority_client.AuthorityClient._make_request')
    def test_request_mandate_success(self, mock_request):
        """Test successful mandate request."""
        mock_request.return_value = {
            "mandate_id": "test-mandate-id",
            "issuer_id": "issuer-id",
            "subject_id": "subject-id",
            "valid_from": "2024-01-01T00:00:00Z",
            "valid_until": "2024-01-01T01:00:00Z",
            "resource_scope": ["api:openai:*"],
            "action_scope": ["api_call"],
            "signature": "test-signature",
        }

        client = AuthorityClient(base_url="http://localhost:8000")
        result = client.request_mandate(
            issuer_id="issuer-id",
            subject_id="subject-id",
            resource_scope=["api:openai:*"],
            action_scope=["api_call"],
            validity_seconds=3600
        )

        assert result["mandate_id"] == "test-mandate-id"
        mock_request.assert_called_once()
        client.close()

    def test_request_mandate_missing_issuer(self):
        """Test request_mandate fails without issuer_id."""
        client = AuthorityClient(base_url="http://localhost:8000")
        with pytest.raises(SDKConfigurationError):
            client.request_mandate(
                issuer_id="",
                subject_id="subject-id",
                resource_scope=["api:openai:*"],
                action_scope=["api_call"],
                validity_seconds=3600
            )
        client.close()

    def test_request_mandate_empty_scope(self):
        """Test request_mandate fails with empty resource scope."""
        client = AuthorityClient(base_url="http://localhost:8000")
        with pytest.raises(SDKConfigurationError):
            client.request_mandate(
                issuer_id="issuer-id",
                subject_id="subject-id",
                resource_scope=[],
                action_scope=["api_call"],
                validity_seconds=3600
            )
        client.close()


class TestAuthorityClientValidateMandate:
    """Test validate_mandate method."""

    @patch('caracal.sdk.authority_client.AuthorityClient._make_request')
    def test_validate_mandate_allowed(self, mock_request):
        """Test successful mandate validation."""
        mock_request.return_value = {
            "allowed": True,
            "mandate_id": "test-mandate-id",
            "principal_id": "subject-id",
            "requested_action": "api_call",
            "requested_resource": "api:openai:gpt-4",
            "decision_timestamp": "2024-01-01T00:00:00Z",
        }

        client = AuthorityClient(base_url="http://localhost:8000")
        result = client.validate_mandate(
            mandate_id="test-mandate-id",
            requested_action="api_call",
            requested_resource="api:openai:gpt-4"
        )

        assert result["allowed"] is True
        mock_request.assert_called_once()
        client.close()

    @patch('caracal.sdk.authority_client.AuthorityClient._make_request')
    def test_validate_mandate_denied(self, mock_request):
        """Test denied mandate validation."""
        mock_request.return_value = {
            "allowed": False,
            "mandate_id": "test-mandate-id",
            "denial_reason": "Mandate expired",
        }

        client = AuthorityClient(base_url="http://localhost:8000")
        result = client.validate_mandate(
            mandate_id="test-mandate-id",
            requested_action="api_call",
            requested_resource="api:openai:gpt-4"
        )

        assert result["allowed"] is False
        assert "denial_reason" in result
        client.close()


class TestAuthorityClientRevokeMandate:
    """Test revoke_mandate method."""

    @patch('caracal.sdk.authority_client.AuthorityClient._make_request')
    def test_revoke_mandate_success(self, mock_request):
        """Test successful mandate revocation."""
        mock_request.return_value = {
            "mandate_id": "test-mandate-id",
            "revoked": True,
            "revoked_at": "2024-01-01T00:00:00Z",
            "revocation_reason": "Security incident",
            "revoked_count": 1,
        }

        client = AuthorityClient(base_url="http://localhost:8000")
        result = client.revoke_mandate(
            mandate_id="test-mandate-id",
            revoker_id="admin-id",
            reason="Security incident"
        )

        assert result["revoked"] is True
        assert result["revoked_count"] == 1
        client.close()

    @patch('caracal.sdk.authority_client.AuthorityClient._make_request')
    def test_revoke_mandate_with_cascade(self, mock_request):
        """Test mandate revocation with cascade."""
        mock_request.return_value = {
            "mandate_id": "test-mandate-id",
            "revoked": True,
            "cascade": True,
            "revoked_count": 5,
        }

        client = AuthorityClient(base_url="http://localhost:8000")
        result = client.revoke_mandate(
            mandate_id="test-mandate-id",
            revoker_id="admin-id",
            reason="Security incident",
            cascade=True
        )

        assert result["revoked_count"] == 5
        client.close()


class TestAuthorityClientQueryLedger:
    """Test query_ledger method."""

    @patch('caracal.sdk.authority_client.AuthorityClient._make_request')
    def test_query_ledger_success(self, mock_request):
        """Test successful ledger query."""
        mock_request.return_value = {
            "events": [
                {
                    "event_id": 1,
                    "event_type": "issued",
                    "timestamp": "2024-01-01T00:00:00Z",
                    "principal_id": "principal-id",
                    "mandate_id": "mandate-id",
                }
            ],
            "total_count": 1,
            "limit": 100,
            "offset": 0,
        }

        client = AuthorityClient(base_url="http://localhost:8000")
        result = client.query_ledger(
            principal_id="principal-id",
            limit=100
        )

        assert len(result["events"]) == 1
        assert result["total_count"] == 1
        client.close()

    def test_query_ledger_invalid_limit(self):
        """Test query_ledger fails with invalid limit."""
        client = AuthorityClient(base_url="http://localhost:8000")
        with pytest.raises(SDKConfigurationError):
            client.query_ledger(limit=0)
        client.close()


class TestAuthorityClientDelegateMandate:
    """Test delegate_mandate method."""

    @patch('caracal.sdk.authority_client.AuthorityClient._make_request')
    def test_delegate_mandate_success(self, mock_request):
        """Test successful mandate delegation."""
        mock_request.return_value = {
            "mandate_id": "child-mandate-id",
            "parent_mandate_id": "parent-mandate-id",
            "subject_id": "child-subject-id",
            "delegation_depth": 1,
        }

        client = AuthorityClient(base_url="http://localhost:8000")
        result = client.delegate_mandate(
            parent_mandate_id="parent-mandate-id",
            child_subject_id="child-subject-id",
            resource_scope=["api:openai:gpt-3.5"],
            action_scope=["api_call"],
            validity_seconds=1800
        )

        assert result["delegation_depth"] == 1
        assert result["parent_mandate_id"] == "parent-mandate-id"
        client.close()
