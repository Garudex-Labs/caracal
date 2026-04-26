"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Dynamic mock builders for constructing test objects without DB dependencies.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid4


def mandate(
    *,
    issuer_id: UUID | None = None,
    subject_id: UUID | None = None,
    resource_scope: list[str] | None = None,
    action_scope: list[str] | None = None,
    valid_from: datetime | None = None,
    valid_until: datetime | None = None,
    signature: str = "fake-sig",
    revoked: bool = False,
    delegation_type: str = "directed",
    network_distance: int = 0,
) -> SimpleNamespace:
    """Build a minimal ExecutionMandate-like namespace for unit tests."""
    now = datetime.utcnow()
    return SimpleNamespace(
        mandate_id=uuid4(),
        issuer_id=issuer_id or uuid4(),
        subject_id=subject_id or uuid4(),
        resource_scope=resource_scope or ["test:*"],
        action_scope=action_scope or ["read"],
        valid_from=valid_from or (now - timedelta(hours=1)),
        valid_until=valid_until or (now + timedelta(hours=1)),
        signature=signature,
        revoked=revoked,
        revocation_reason=None,
        delegation_type=delegation_type,
        network_distance=network_distance,
        caveat_chain=None,
        caveat_hmac_key=None,
        intent_hash=None,
    )


def principal(
    *,
    principal_kind: str = "worker",
    name: str = "test-principal",
    owner: str = "test",
    public_key_pem: str = "fake-public-key",
    private_key_pem: str | None = None,
) -> SimpleNamespace:
    """Build a minimal Principal-like namespace for unit tests."""
    return SimpleNamespace(
        principal_id=uuid4(),
        principal_kind=principal_kind,
        name=name,
        owner=owner,
        public_key_pem=public_key_pem,
        private_key_pem=private_key_pem,
        lifecycle_status="active",
        attestation_status="unattested",
        metadata={},
    )


def mandate_data(
    *,
    mandate_id: str | None = None,
    issuer_id: str | None = None,
    subject_id: str | None = None,
    resource_scope: list[str] | None = None,
    action_scope: list[str] | None = None,
    valid_from: str | None = None,
    valid_until: str | None = None,
) -> dict[str, Any]:
    """Build a raw mandate data dict for signing tests."""
    now = datetime.utcnow()
    return {
        "mandate_id": mandate_id or str(uuid4()),
        "issuer_id": issuer_id or str(uuid4()),
        "subject_id": subject_id or str(uuid4()),
        "valid_from": valid_from or now.isoformat(),
        "valid_until": valid_until or (now + timedelta(hours=1)).isoformat(),
        "resource_scope": resource_scope or ["test:*"],
        "action_scope": action_scope or ["read"],
        "delegation_type": "directed",
        "intent_hash": None,
    }
