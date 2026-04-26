"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Edge case tests for caveat chain parsing, building, and evaluation.
"""
from __future__ import annotations

import pytest
from datetime import datetime, timezone

from caracal.core.caveat_chain import (
    CaveatChainError,
    CaveatType,
    build_caveat_chain,
    evaluate_caveat_chain,
    parse_caveat,
    verify_caveat_chain,
)


HMAC_KEY = "edge-test-hmac-key-32bytes-padded"


@pytest.mark.edge
class TestParseCaveat:
    """Edge cases for caveat string parsing."""

    def test_empty_string_raises(self) -> None:
        with pytest.raises(CaveatChainError):
            parse_caveat("")

    def test_whitespace_only_raises(self) -> None:
        with pytest.raises(CaveatChainError):
            parse_caveat("   ")

    def test_action_missing_value_raises(self) -> None:
        with pytest.raises(CaveatChainError):
            parse_caveat("action:")

    def test_resource_missing_value_raises(self) -> None:
        with pytest.raises(CaveatChainError):
            parse_caveat("resource:")

    def test_expiry_missing_value_raises(self) -> None:
        with pytest.raises(CaveatChainError):
            parse_caveat("expiry:")

    def test_task_binding_missing_value_raises(self) -> None:
        with pytest.raises(CaveatChainError):
            parse_caveat("task-binding:")

    def test_action_caveat_parsed(self) -> None:
        c = parse_caveat("action:read")
        assert c.caveat_type == CaveatType.ACTION
        assert c.value == "read"

    def test_resource_caveat_parsed(self) -> None:
        c = parse_caveat("resource:secret/key1")
        assert c.caveat_type == CaveatType.RESOURCE
        assert c.value == "secret/key1"

    def test_task_binding_hyphen_form_parsed(self) -> None:
        c = parse_caveat("task-binding:task-abc")
        assert c.caveat_type == CaveatType.TASK_BINDING

    def test_task_binding_underscore_form_parsed(self) -> None:
        c = parse_caveat("task_binding:task-abc")
        assert c.caveat_type == CaveatType.TASK_BINDING

    def test_unprefixed_treated_as_resource(self) -> None:
        c = parse_caveat("some/resource/path")
        assert c.caveat_type == CaveatType.RESOURCE

    def test_case_insensitive_prefix(self) -> None:
        c = parse_caveat("ACTION:read")
        assert c.caveat_type == CaveatType.ACTION


@pytest.mark.edge
class TestBuildAndVerify:
    """Edge cases for chain construction and HMAC verification."""

    def test_empty_caveats_produce_empty_chain(self) -> None:
        chain = build_caveat_chain(parent_chain=None, append_caveats=[], hmac_key=HMAC_KEY)
        assert chain == []

    def test_chain_index_is_sequential(self) -> None:
        chain = build_caveat_chain(
            parent_chain=None,
            append_caveats=["action:read", "resource:test/*"],
            hmac_key=HMAC_KEY,
        )
        assert [n["index"] for n in chain] == [0, 1]

    def test_verify_detects_tampered_hmac(self) -> None:
        chain = build_caveat_chain(parent_chain=None, append_caveats=["action:read"], hmac_key=HMAC_KEY)
        chain[0]["hmac"] = "00" * 32
        with pytest.raises(CaveatChainError):
            verify_caveat_chain(hmac_key=HMAC_KEY, chain=chain)

    def test_verify_detects_wrong_key(self) -> None:
        chain = build_caveat_chain(parent_chain=None, append_caveats=["action:read"], hmac_key=HMAC_KEY)
        with pytest.raises(CaveatChainError):
            verify_caveat_chain(hmac_key="wrong-key", chain=chain)

    def test_verify_detects_reordered_nodes(self) -> None:
        chain = build_caveat_chain(
            parent_chain=None,
            append_caveats=["action:read", "resource:test/*"],
            hmac_key=HMAC_KEY,
        )
        chain[0], chain[1] = chain[1], chain[0]
        with pytest.raises(CaveatChainError):
            verify_caveat_chain(hmac_key=HMAC_KEY, chain=chain)


@pytest.mark.edge
class TestEvaluateCaveat:
    """Edge cases for caveat evaluation against boundary requests."""

    def _chain(self, caveats: list[str]) -> list[dict]:
        raw = build_caveat_chain(parent_chain=None, append_caveats=caveats, hmac_key=HMAC_KEY)
        return verify_caveat_chain(hmac_key=HMAC_KEY, chain=raw)

    def test_action_constraint_allows_matching_action(self) -> None:
        chain = self._chain(["action:read"])
        evaluate_caveat_chain(
            verified_chain=chain,
            requested_action="read",
        )

    def test_action_constraint_denies_non_matching_action(self) -> None:
        chain = self._chain(["action:read"])
        with pytest.raises(CaveatChainError):
            evaluate_caveat_chain(
                verified_chain=chain,
                requested_action="write",
            )

    def test_action_constraint_requires_requested_action(self) -> None:
        chain = self._chain(["action:read"])
        with pytest.raises(CaveatChainError):
            evaluate_caveat_chain(verified_chain=chain, requested_action=None)

    def test_resource_constraint_denies_non_matching_resource(self) -> None:
        chain = self._chain(["resource:secret/allowed"])
        with pytest.raises(CaveatChainError):
            evaluate_caveat_chain(
                verified_chain=chain,
                requested_resource="secret/denied",
            )

    def test_expired_caveat_denies(self) -> None:
        past = "2000-01-01T00:00:00Z"
        chain = self._chain([f"expiry:{past}"])
        with pytest.raises(CaveatChainError, match="expired"):
            evaluate_caveat_chain(
                verified_chain=chain,
                current_time=datetime.now(timezone.utc),
            )

    def test_future_expiry_allows(self) -> None:
        future = "2099-12-31T23:59:59Z"
        chain = self._chain([f"expiry:{future}"])
        evaluate_caveat_chain(
            verified_chain=chain,
            current_time=datetime.now(timezone.utc),
        )

    def test_task_binding_denies_wrong_id(self) -> None:
        chain = self._chain(["task-binding:task-correct"])
        with pytest.raises(CaveatChainError):
            evaluate_caveat_chain(verified_chain=chain, task_id="task-wrong")

    def test_task_binding_requires_task_id(self) -> None:
        chain = self._chain(["task-binding:task-abc"])
        with pytest.raises(CaveatChainError):
            evaluate_caveat_chain(verified_chain=chain, task_id=None)

    def test_empty_chain_allows_anything(self) -> None:
        evaluate_caveat_chain(
            verified_chain=[],
            requested_action="write",
            requested_resource="anything",
        )
