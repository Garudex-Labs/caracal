"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for mandate authority evaluation.
"""
import pytest
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from unittest.mock import Mock, MagicMock, patch

from caracal.core.authority import AuthorityEvaluator, AuthorityDecision
from caracal.core.caveat_chain import build_caveat_chain
from caracal.db.models import ExecutionMandate, Principal, PrincipalAttestationStatus, PrincipalKind


@pytest.mark.unit
class TestAuthorityEvaluator:
    """Test suite for AuthorityEvaluator class."""
    
    def setup_method(self):
        """Set up test fixtures before each test method."""
        self.mock_db_session = Mock()
        self.evaluator = AuthorityEvaluator(self.mock_db_session)
    
    def test_validate_mandate_with_none_mandate(self):
        """Test authority validation with None mandate."""
        # Act
        decision = self.evaluator.validate_mandate(
            mandate=None,
            requested_action="read:secrets",
            requested_resource="secret/test"
        )
        
        # Assert
        assert decision.allowed is False
        assert "No mandate provided" in decision.reason or "None" in decision.reason
        assert decision.reason_code == "AUTH_MANDATE_MISSING"
        assert decision.boundary_stage == "mandate_state_validation"
        assert decision.requested_action == "read:secrets"
        assert decision.requested_resource == "secret/test"
    
    def test_validate_mandate_revoked(self):
        """Test authority validation with revoked mandate."""
        # Arrange
        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=uuid4(),
            subject_id=uuid4(),
            valid_from=datetime.utcnow() - timedelta(hours=1),
            valid_until=datetime.utcnow() + timedelta(hours=1),
            resource_scope=["secret/*"],
            action_scope=["read:secrets"],
            signature="test_signature",
            revoked=True,
            revocation_reason="Test revocation"
        )
        
        # Act
        decision = self.evaluator.validate_mandate(
            mandate=mandate,
            requested_action="read:secrets",
            requested_resource="secret/test"
        )
        
        # Assert
        assert decision.allowed is False
        assert "revoked" in decision.reason.lower()
        assert decision.reason_code == "AUTH_MANDATE_REVOKED"
        assert decision.boundary_stage == "mandate_state_validation"
        assert decision.mandate_id == mandate.mandate_id

    def test_validate_mandate_denies_unattested_worker(self):
        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=uuid4(),
            subject_id=uuid4(),
            valid_from=datetime.utcnow() - timedelta(hours=1),
            valid_until=datetime.utcnow() + timedelta(hours=1),
            resource_scope=["secret/*"],
            action_scope=["read:secrets"],
            signature="test_signature",
            revoked=False,
        )
        principal = Principal(
            principal_id=mandate.subject_id,
            name="worker",
            principal_kind=PrincipalKind.WORKER.value,
            owner="test",
            lifecycle_status="active",
            attestation_status=PrincipalAttestationStatus.PENDING.value,
        )

        with patch.object(self.evaluator, "_get_principal", return_value=principal):
            decision = self.evaluator._validate_mandate_state(
                mandate,
                "read:secrets",
                "secret/test",
                datetime.utcnow(),
            )

        assert decision is not None
        assert decision.allowed is False
        assert decision.reason_code == "AUTH_PRINCIPAL_NOT_ATTESTED"

    def test_validate_mandate_denies_subject_binding_mismatch(self):
        """Caller identity must match mandate subject when caller context is provided."""
        issuer_id = uuid4()
        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=issuer_id,
            subject_id=uuid4(),
            valid_from=datetime.utcnow() - timedelta(hours=1),
            valid_until=datetime.utcnow() + timedelta(hours=1),
            resource_scope=["secret/*"],
            action_scope=["read:secrets"],
            signature="test_signature",
            revoked=False,
        )

        self.mock_db_session.query.return_value.filter.return_value.first.return_value = Mock(
            lifecycle_status="active"
        )

        decision = self.evaluator.validate_mandate(
            mandate=mandate,
            requested_action="read:secrets",
            requested_resource="secret/test",
            caller_principal_id=str(uuid4()),
        )

        assert decision.allowed is False
        assert "does not match mandate subject" in decision.reason.lower()
        assert decision.reason_code == "AUTH_SUBJECT_BINDING_DENIED"
        assert decision.boundary_stage == "subject_binding_validation"
    
    def test_validate_mandate_not_yet_valid(self):
        """Test authority validation with mandate not yet valid."""
        # Arrange
        future_time = datetime.utcnow() + timedelta(hours=1)
        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=uuid4(),
            subject_id=uuid4(),
            valid_from=future_time,
            valid_until=future_time + timedelta(hours=2),
            resource_scope=["secret/*"],
            action_scope=["read:secrets"],
            signature="test_signature",
            revoked=False
        )
        
        # Act
        decision = self.evaluator.validate_mandate(
            mandate=mandate,
            requested_action="read:secrets",
            requested_resource="secret/test"
        )
        
        # Assert
        assert decision.allowed is False
        assert "not yet valid" in decision.reason.lower()
    
    def test_validate_mandate_expired(self):
        """Test authority validation with expired mandate."""
        # Arrange
        past_time = datetime.utcnow() - timedelta(hours=2)
        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=uuid4(),
            subject_id=uuid4(),
            valid_from=past_time,
            valid_until=past_time + timedelta(hours=1),
            resource_scope=["secret/*"],
            action_scope=["read:secrets"],
            signature="test_signature",
            revoked=False
        )
        
        # Act
        decision = self.evaluator.validate_mandate(
            mandate=mandate,
            requested_action="read:secrets",
            requested_resource="secret/test"
        )
        
        # Assert
        assert decision.allowed is False
        assert "expired" in decision.reason.lower()
    
    def test_validate_mandate_action_not_in_scope(self):
        """Test authority validation with action not in scope."""
        # Arrange
        issuer_id = uuid4()
        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=issuer_id,
            subject_id=uuid4(),
            valid_from=datetime.utcnow() - timedelta(hours=1),
            valid_until=datetime.utcnow() + timedelta(hours=1),
            resource_scope=["secret/*"],
            action_scope=["read:secrets"],
            signature="test_signature",
            revoked=False
        )
        
        # Mock issuer principal
        issuer = Principal(
            principal_id=issuer_id,
            name="test-issuer",
            principal_kind="human",
            owner="test",
            public_key_pem="test_public_key",
            lifecycle_status="active",
        )
        
        # Mock database query
        mock_query = Mock()
        mock_query.filter.return_value.first.return_value = issuer
        self.mock_db_session.query.return_value = mock_query
        
        # Mock signature verification
        with patch('caracal.core.authority.verify_mandate_signature', return_value=True):
            # Mock delegation graph check
            with patch.object(self.evaluator, 'check_delegation_path', return_value=True):
                # Act
                decision = self.evaluator.validate_mandate(
                    mandate=mandate,
                    requested_action="write:secrets",  # Not in action_scope
                    requested_resource="secret/test"
                )
        
        # Assert
        assert decision.allowed is False
        assert "not in mandate scope" in decision.reason.lower()
        assert "action" in decision.reason.lower()
        assert decision.reason_code == "AUTH_ACTION_SCOPE_DENIED"
        assert decision.boundary_stage == "action_resource_authorization_checks"
    
    def test_validate_mandate_resource_not_in_scope(self):
        """Test authority validation with resource not in scope."""
        # Arrange
        issuer_id = uuid4()
        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=issuer_id,
            subject_id=uuid4(),
            valid_from=datetime.utcnow() - timedelta(hours=1),
            valid_until=datetime.utcnow() + timedelta(hours=1),
            resource_scope=["secret/test/*"],
            action_scope=["read:secrets"],
            signature="test_signature",
            revoked=False
        )
        
        # Mock issuer principal
        issuer = Principal(
            principal_id=issuer_id,
            name="test-issuer",
            principal_kind="human",
            owner="test",
            public_key_pem="test_public_key",
            lifecycle_status="active",
        )
        
        # Mock database query
        mock_query = Mock()
        mock_query.filter.return_value.first.return_value = issuer
        self.mock_db_session.query.return_value = mock_query
        
        # Mock signature verification
        with patch('caracal.core.authority.verify_mandate_signature', return_value=True):
            # Mock delegation graph check
            with patch.object(self.evaluator, 'check_delegation_path', return_value=True):
                # Act
                decision = self.evaluator.validate_mandate(
                    mandate=mandate,
                    requested_action="read:secrets",
                    requested_resource="other/resource"  # Not in resource_scope
                )
        
        # Assert
        assert decision.allowed is False
        assert "not in mandate scope" in decision.reason.lower()
        assert "resource" in decision.reason.lower()

    def test_validate_mandate_denies_invalid_caveat_chain(self):
        """Test authority validation fails closed on tampered caveat chain."""
        issuer_id = uuid4()
        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=issuer_id,
            subject_id=uuid4(),
            valid_from=datetime.utcnow() - timedelta(hours=1),
            valid_until=datetime.utcnow() + timedelta(hours=1),
            resource_scope=["tool/*"],
            action_scope=["execute"],
            signature="test_signature",
            revoked=False,
        )

        issuer = Principal(
            principal_id=issuer_id,
            name="test-issuer",
            principal_kind="human",
            owner="test",
            public_key_pem="test_public_key",
            lifecycle_status="active",
        )
        mock_query = Mock()
        mock_query.filter.return_value.first.return_value = issuer
        self.mock_db_session.query.return_value = mock_query

        valid_chain = build_caveat_chain(
            hmac_key="authority-chain-test-key",
            parent_chain=None,
            append_caveats=["action:execute"],
        )
        tampered_chain = [dict(node) for node in valid_chain]
        tampered_chain[0]["value"] = "delete"

        with patch("caracal.core.authority.verify_mandate_signature", return_value=True):
            with patch.object(self.evaluator, "check_delegation_path", return_value=True):
                decision = self.evaluator.validate_mandate(
                    mandate=mandate,
                    requested_action="execute",
                    requested_resource="tool/list",
                    caveat_chain=tampered_chain,
                    caveat_hmac_key="authority-chain-test-key",
                )

        assert decision.allowed is False
        assert decision.reason_code == "AUTH_CAVEAT_CHAIN_DENIED"
        assert decision.boundary_stage == "caveat_chain_validation"

    def test_validate_mandate_allows_valid_caveat_chain(self):
        """Test authority validation allows requests satisfying caveat chain."""
        issuer_id = uuid4()
        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=issuer_id,
            subject_id=uuid4(),
            valid_from=datetime.utcnow() - timedelta(hours=1),
            valid_until=datetime.utcnow() + timedelta(hours=1),
            resource_scope=["tool/*"],
            action_scope=["execute"],
            signature="test_signature",
            revoked=False,
        )

        issuer = Principal(
            principal_id=issuer_id,
            name="test-issuer",
            principal_kind="human",
            owner="test",
            public_key_pem="test_public_key",
            lifecycle_status="active",
        )
        mock_query = Mock()
        mock_query.filter.return_value.first.return_value = issuer
        self.mock_db_session.query.return_value = mock_query

        valid_chain = build_caveat_chain(
            hmac_key="authority-chain-test-key",
            parent_chain=None,
            append_caveats=[
                "action:execute",
                "resource:tool/*",
                "task-binding:task-123",
                f"expiry:{int((datetime.now(timezone.utc) + timedelta(minutes=5)).timestamp())}",
            ],
        )

        with patch("caracal.core.authority.verify_mandate_signature", return_value=True):
            with patch.object(self.evaluator, "check_delegation_path", return_value=True):
                decision = self.evaluator.validate_mandate(
                    mandate=mandate,
                    requested_action="execute",
                    requested_resource="tool/list",
                    caveat_chain=valid_chain,
                    caveat_hmac_key="authority-chain-test-key",
                    caveat_task_id="task-123",
                )

        assert decision.allowed is True
    
    def test_match_pattern_exact(self):
        """Test pattern matching with exact match."""
        # Act & Assert
        assert self.evaluator._match_pattern("read:secrets", "read:secrets") is True
        assert self.evaluator._match_pattern("read:secrets", "write:secrets") is False
    
    def test_match_pattern_wildcard(self):
        """Test pattern matching with wildcard."""
        # Act & Assert
        assert self.evaluator._match_pattern("read:secrets", "read:*") is True
        assert self.evaluator._match_pattern("read:secrets", "*:secrets") is True
        assert self.evaluator._match_pattern("read:secrets", "*") is True
        assert self.evaluator._match_pattern("write:secrets", "read:*") is False

    def test_match_pattern_provider_scope_requires_exact_match(self):
        """Canonical provider scopes must not be widened with wildcard patterns."""
        resource_scope = "provider:endframe:resource:deployments"
        wildcard_pattern = "provider:endframe:resource:*"

        assert self.evaluator._match_pattern(resource_scope, resource_scope) is True
        assert self.evaluator._match_pattern(resource_scope, wildcard_pattern) is False

    def test_match_pattern_provider_action_scope_requires_exact_match(self):
        """Canonical provider action scopes must use strict equality."""
        action_scope = "provider:endframe:action:deployments_invoke"
        wildcard_pattern = "provider:endframe:action:*"

        assert self.evaluator._match_pattern(action_scope, action_scope) is True
        assert self.evaluator._match_pattern(action_scope, wildcard_pattern) is False

    def test_validate_mandate_records_caller_subject_metadata_on_deny(self):
        """Denied validations should record caller and mandate subject metadata."""
        ledger_writer = Mock()
        evaluator = AuthorityEvaluator(self.mock_db_session, ledger_writer=ledger_writer)

        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=uuid4(),
            subject_id=uuid4(),
            valid_from=datetime.utcnow() - timedelta(hours=1),
            valid_until=datetime.utcnow() + timedelta(hours=1),
            resource_scope=["secret/*"],
            action_scope=["read:secrets"],
            signature="test_signature",
            revoked=True,
        )

        evaluator.validate_mandate(
            mandate=mandate,
            requested_action="read:secrets",
            requested_resource="secret/test",
            caller_principal_id="caller-agent-1",
        )

        assert ledger_writer.record_validation.called
        metadata = ledger_writer.record_validation.call_args.kwargs["metadata"]
        assert metadata["caller_principal_id"] == "caller-agent-1"
        assert metadata["mandate_subject_id"] == str(mandate.subject_id)

    def test_validate_mandate_records_caller_subject_metadata_on_allow(self):
        """Allowed validations should record caller and mandate subject metadata."""
        ledger_writer = Mock()
        evaluator = AuthorityEvaluator(self.mock_db_session, ledger_writer=ledger_writer)

        issuer_id = uuid4()
        mandate = ExecutionMandate(
            mandate_id=uuid4(),
            issuer_id=issuer_id,
            subject_id=uuid4(),
            valid_from=datetime.utcnow() - timedelta(hours=1),
            valid_until=datetime.utcnow() + timedelta(hours=1),
            resource_scope=["secret/*"],
            action_scope=["read:secrets"],
            signature="test_signature",
            revoked=False,
        )
        issuer = Principal(
            principal_id=issuer_id,
            name="issuer",
            principal_kind="human",
            owner="test",
            public_key_pem="test_public_key",
        )
        mock_query = Mock()
        mock_query.filter.return_value.first.return_value = issuer
        self.mock_db_session.query.return_value = mock_query

        with patch("caracal.core.authority.verify_mandate_signature", return_value=True):
            with patch.object(evaluator, "check_delegation_path", return_value=True):
                evaluator.validate_mandate(
                    mandate=mandate,
                    requested_action="read:secrets",
                    requested_resource="secret/test",
                    caller_principal_id="caller-agent-2",
                )

        assert ledger_writer.record_validation.called
        metadata = ledger_writer.record_validation.call_args.kwargs["metadata"]
        assert metadata["caller_principal_id"] == "caller-agent-2"
        assert metadata["mandate_subject_id"] == str(mandate.subject_id)


@pytest.mark.unit
class TestAuthorityDecision:
    """Test suite for AuthorityDecision dataclass."""
    
    def test_authority_decision_creation(self):
        """Test AuthorityDecision creation with valid data."""
        # Arrange & Act
        decision = AuthorityDecision(
            allowed=True,
            reason="Valid mandate",
            mandate_id=uuid4(),
            principal_id=uuid4(),
            requested_action="read:secrets",
            requested_resource="secret/test"
        )
        
        # Assert
        assert decision.allowed is True
        assert decision.reason == "Valid mandate"
        assert decision.mandate_id is not None
        assert decision.principal_id is not None
        assert decision.timestamp is not None
    
    def test_authority_decision_auto_timestamp(self):
        """Test AuthorityDecision automatically sets timestamp."""
        # Arrange & Act
        before = datetime.utcnow()
        decision = AuthorityDecision(
            allowed=False,
            reason="Test reason"
        )
        after = datetime.utcnow()
        
        # Assert
        assert decision.timestamp is not None
        assert before <= decision.timestamp <= after


@pytest.mark.unit
def test_normalize_principal_id_propagates_unexpected_uuid_failures(monkeypatch):
    class _ExplodingUUID:
        def __init__(self, _value):
            raise RuntimeError("uuid internals failed")

    monkeypatch.setattr("caracal.core.authority.UUID", _ExplodingUUID)

    with pytest.raises(RuntimeError, match="uuid internals failed"):
        AuthorityEvaluator._normalize_principal_id("11111111-2222-3333-4444-555555555555")


@pytest.mark.unit
def test_is_canonical_provider_scope_propagates_unexpected_parser_failures(monkeypatch):
    def _explode(_scope: str) -> None:
        raise RuntimeError("parser internals failed")

    monkeypatch.setattr("caracal.core.authority.parse_provider_scope", _explode)

    with pytest.raises(RuntimeError, match="parser internals failed"):
        AuthorityEvaluator._is_canonical_provider_scope("provider:demo:resource:item")
