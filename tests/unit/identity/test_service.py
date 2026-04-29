"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for identity service facade behavior.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from caracal.identity.service import IdentityService


@pytest.mark.unit
def test_register_principal_delegates_to_registry() -> None:
    registry = Mock()
    spawn_manager = Mock()
    expected = SimpleNamespace(principal_id="p-1")
    registry.register_principal.return_value = expected

    service = IdentityService(principal_registry=registry, spawn_manager=spawn_manager)

    result = service.register_principal(
        name="orchestrator-1",
        owner="ops",
        principal_kind="orchestrator",
        metadata={"team": "ops"},
        generate_keys=True,
    )

    assert result is expected
    registry.register_principal.assert_called_once()


@pytest.mark.unit
def test_spawn_principal_delegates_to_spawn_manager() -> None:
    registry = Mock()
    spawn_manager = Mock()
    expected = SimpleNamespace(principal_id="p-2", attestation_nonce="nonce-1")
    spawn_manager.spawn_principal.return_value = expected

    service = IdentityService(principal_registry=registry, spawn_manager=spawn_manager)

    result = service.spawn_principal(
        issuer_principal_id="issuer-1",
        principal_name="worker-2",
        principal_kind="worker",
        owner="ops",
        resource_scope=["provider:openai"],
        action_scope=["infer"],
        validity_seconds=300,
        idempotency_key="idemp-1",
    )

    assert result is expected
    spawn_manager.spawn_principal.assert_called_once()


@pytest.mark.unit
def test_spawn_principal_raises_when_spawn_manager_not_configured() -> None:
    registry = Mock()
    service = IdentityService(principal_registry=registry)

    with pytest.raises(RuntimeError, match="spawn manager"):
        service.spawn_principal(
            issuer_principal_id="issuer-1",
            principal_name="worker-2",
            principal_kind="worker",
            owner="ops",
            resource_scope=["provider:openai"],
            action_scope=["infer"],
            validity_seconds=300,
            idempotency_key="idemp-1",
        )


@pytest.mark.unit
def test_get_and_list_delegate_to_registry() -> None:
    registry = Mock()
    spawn_manager = Mock()
    identity = SimpleNamespace(principal_id="p-3")
    registry.get_principal.return_value = identity
    registry.list_principals.return_value = [identity]

    service = IdentityService(principal_registry=registry, spawn_manager=spawn_manager)

    assert service.get_principal("p-3") is identity
    assert service.list_principals() == [identity]

    registry.get_principal.assert_called_once_with("p-3")
    registry.list_principals.assert_called_once()
