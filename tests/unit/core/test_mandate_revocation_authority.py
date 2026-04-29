"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for mandate revocation authority enforcement.
"""

from unittest.mock import Mock
from uuid import uuid4

import pytest

from caracal.core.mandate import MandateManager


def test_has_revocation_authority_accepts_scoped_revoke_policy() -> None:
    revoker_id = uuid4()
    mandate = Mock(mandate_id=uuid4(), issuer_id=uuid4(), subject_id=uuid4())
    policy = Mock(
        allowed_actions=["revoke_mandate"],
        allowed_resource_patterns=[f"mandate:{mandate.mandate_id}"],
    )
    manager = MandateManager(Mock(), signing_service=Mock())
    manager._get_active_policy = Mock(return_value=policy)

    assert manager._has_revocation_authority(revoker_id, mandate) is True


def test_has_revocation_authority_rejects_policy_without_revoke_action() -> None:
    revoker_id = uuid4()
    mandate = Mock(mandate_id=uuid4(), issuer_id=uuid4(), subject_id=uuid4())
    policy = Mock(
        allowed_actions=["write:mandates"],
        allowed_resource_patterns=[f"mandate:{mandate.mandate_id}"],
    )
    manager = MandateManager(Mock(), signing_service=Mock())
    manager._get_active_policy = Mock(return_value=policy)

    assert manager._has_revocation_authority(revoker_id, mandate) is False


def test_revoke_mandate_accepts_explicit_revocation_authority() -> None:
    mandate_id = uuid4()
    revoker_id = uuid4()
    mandate = Mock(
        mandate_id=mandate_id,
        issuer_id=uuid4(),
        subject_id=uuid4(),
        revoked=False,
    )
    session = Mock()
    query = Mock()
    query.filter.return_value.first.return_value = mandate
    session.query.return_value = query
    manager = MandateManager(session, signing_service=Mock())
    manager._has_revocation_authority = Mock(return_value=True)
    manager._record_ledger_event = Mock()

    manager.revoke_mandate(mandate_id, revoker_id, "operator request", cascade=False)

    assert mandate.revoked is True
    assert mandate.revoked_at is not None
    assert mandate.revocation_reason == "operator request"
    session.flush.assert_called_once()
    manager._record_ledger_event.assert_called_once()


def test_revoke_mandate_rejects_policy_without_revocation_authority() -> None:
    mandate_id = uuid4()
    revoker_id = uuid4()
    mandate = Mock(
        mandate_id=mandate_id,
        issuer_id=uuid4(),
        subject_id=uuid4(),
        revoked=False,
    )
    session = Mock()
    query = Mock()
    query.filter.return_value.first.return_value = mandate
    session.query.return_value = query
    manager = MandateManager(session, signing_service=Mock())
    manager._has_revocation_authority = Mock(return_value=False)

    with pytest.raises(ValueError, match="explicit revocation authority"):
        manager.revoke_mandate(mandate_id, revoker_id, "operator request", cascade=False)

    assert mandate.revoked is False
    session.flush.assert_not_called()
