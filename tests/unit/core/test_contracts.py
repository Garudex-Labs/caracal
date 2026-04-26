"""Contract tests for canonical lifecycle control-path declarations."""

from __future__ import annotations

from unittest.mock import Mock

import pytest

from caracal.core import authority as authority_module
from caracal.core import identity as identity_module
from caracal.core import mandate as mandate_module
from caracal.core.identity import PrincipalRegistry
from caracal.core.mandate import MandateManager


@pytest.mark.unit
def test_core_modules_declare_canonical_lifecycle_methods() -> None:
    assert identity_module.CANONICAL_PRINCIPAL_LIFECYCLE_METHODS == (
        "register_principal",
        "list_principals",
        "get_principal",
        "update_principal",
    )
    assert mandate_module.CANONICAL_MANDATE_LIFECYCLE_METHODS == (
        "issue_mandate",
        "validate_mandate",
        "revoke_mandate",
    )
    assert authority_module.CANONICAL_AUTHORITY_VALIDATION_METHODS == ("validate_mandate",)


@pytest.mark.unit
def test_principal_registry_exposes_declared_methods() -> None:
    for method_name in identity_module.CANONICAL_PRINCIPAL_LIFECYCLE_METHODS:
        assert callable(getattr(PrincipalRegistry, method_name, None)), method_name


@pytest.mark.unit
def test_mandate_manager_validate_delegates_to_authority_evaluator() -> None:
    db_session = Mock()
    evaluator = Mock()
    decision = Mock(allowed=True)
    evaluator.validate_mandate.return_value = decision

    manager = MandateManager(
        db_session=db_session,
        authority_evaluator=evaluator,
        signing_service=Mock(),
    )

    mandate = Mock()
    result = manager.validate_mandate(
        mandate=mandate,
        requested_action="provider:endframe:action:invoke",
        requested_resource="provider:endframe:resource:deployments",
        caller_principal_id="caller-1",
    )

    assert result is decision
    evaluator.validate_mandate.assert_called_once_with(
        mandate=mandate,
        requested_action="provider:endframe:action:invoke",
        requested_resource="provider:endframe:resource:deployments",
        current_time=None,
        caveat_chain=None,
        caveat_hmac_key=None,
        caveat_task_id=None,
        caller_principal_id="caller-1",
    )
