"""Unit tests for attestation nonce issuance and single-use consumption."""

from __future__ import annotations

import pytest

from caracal.identity.attestation_nonce import (
    AttestationNonceConsumedError,
    AttestationNonceManager,
    AttestationNonceValidationError,
)


class _FakeRedisClient:
    def __init__(self) -> None:
        self.store: dict[str, str] = {}

    def set(self, key: str, value: str, ex: int | None = None, nx: bool = False, **kwargs) -> bool:
        del ex, kwargs
        if nx and key in self.store:
            return False
        self.store[key] = value
        return True

    def getdel(self, key: str):
        return self.store.pop(key, None)


@pytest.mark.unit
def test_issue_nonce_returns_bound_metadata() -> None:
    manager = AttestationNonceManager(_FakeRedisClient(), ttl_seconds=120)

    issued = manager.issue_nonce("principal-1")

    assert issued.nonce
    assert issued.principal_id == "principal-1"
    assert issued.expires_at.tzinfo is not None


@pytest.mark.unit
def test_consume_nonce_is_single_use() -> None:
    manager = AttestationNonceManager(_FakeRedisClient(), ttl_seconds=120)
    issued = manager.issue_nonce("principal-2")

    consumed_principal = manager.consume_nonce(issued.nonce)
    assert consumed_principal == "principal-2"

    with pytest.raises(AttestationNonceConsumedError):
        manager.consume_nonce(issued.nonce)


@pytest.mark.unit
def test_consume_nonce_enforces_expected_principal_binding() -> None:
    manager = AttestationNonceManager(_FakeRedisClient(), ttl_seconds=120)
    issued = manager.issue_nonce("principal-3")

    with pytest.raises(AttestationNonceValidationError, match="binding mismatch"):
        manager.consume_nonce(issued.nonce, expected_principal_id="principal-4")


@pytest.mark.unit
def test_issue_nonce_rejects_empty_principal() -> None:
    manager = AttestationNonceManager(_FakeRedisClient(), ttl_seconds=120)

    with pytest.raises(AttestationNonceValidationError, match="principal_id"):
        manager.issue_nonce("")


@pytest.mark.unit
def test_manager_rejects_non_positive_ttl() -> None:
    with pytest.raises(AttestationNonceValidationError, match="ttl_seconds"):
        AttestationNonceManager(_FakeRedisClient(), ttl_seconds=0)
