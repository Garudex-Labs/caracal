"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Coverage-targeted tests for caveat chain logic not covered by unit tests.
"""
from __future__ import annotations

import pytest
from datetime import datetime, timezone

from caracal.core.caveat_chain import (
    CaveatChainError,
    CaveatType,
    ParsedCaveat,
    build_caveat_chain,
    caveat_strings_from_chain,
    evaluate_caveat_chain,
    parse_caveat,
    verify_caveat_chain,
)


HMAC_KEY = "coverage-test-key-32bytes-padded!"


@pytest.mark.coverage
class TestParseTypes:
    """Coverage for all caveat type parsing paths."""

    def test_action_type(self) -> None:
        c = parse_caveat("action:invoke")
        assert c.caveat_type == CaveatType.ACTION
        assert c.value == "invoke"

    def test_resource_type(self) -> None:
        c = parse_caveat("resource:api/endpoint")
        assert c.caveat_type == CaveatType.RESOURCE

    def test_expiry_iso_format(self) -> None:
        c = parse_caveat("expiry:2099-01-01T00:00:00Z")
        assert c.caveat_type == CaveatType.EXPIRY

    def test_expiry_unix_timestamp(self) -> None:
        c = parse_caveat("expiry:9999999999")
        assert c.caveat_type == CaveatType.EXPIRY

    def test_task_binding_hyphen(self) -> None:
        c = parse_caveat("task-binding:job-1")
        assert c.caveat_type == CaveatType.TASK_BINDING

    def test_task_binding_underscore(self) -> None:
        c = parse_caveat("task_binding:job-1")
        assert c.caveat_type == CaveatType.TASK_BINDING

    def test_raw_string_is_resource(self) -> None:
        c = parse_caveat("bare-value")
        assert c.caveat_type == CaveatType.RESOURCE
        assert c.value == "bare-value"


@pytest.mark.coverage
class TestChainRendering:
    """Coverage for caveat_strings_from_chain."""

    def _verified(self, caveats: list[str]) -> list[dict]:
        raw = build_caveat_chain(parent_chain=None, append_caveats=caveats, hmac_key=HMAC_KEY)
        return verify_caveat_chain(hmac_key=HMAC_KEY, chain=raw)

    def test_renders_all_caveats(self) -> None:
        chain = self._verified(["action:read", "resource:test/*"])
        rendered = caveat_strings_from_chain(chain)
        assert len(rendered) == 2

    def test_returns_empty_for_empty_chain(self) -> None:
        assert caveat_strings_from_chain([]) == []


@pytest.mark.coverage
class TestMultipleCaveats:
    """Coverage for multi-caveat evaluation paths."""

    def _chain(self, caveats: list[str]) -> list[dict]:
        raw = build_caveat_chain(parent_chain=None, append_caveats=caveats, hmac_key=HMAC_KEY)
        return verify_caveat_chain(hmac_key=HMAC_KEY, chain=raw)

    def test_multi_constraint_all_satisfied(self) -> None:
        chain = self._chain(["action:read", "resource:test/*"])
        evaluate_caveat_chain(
            verified_chain=chain,
            requested_action="read",
            requested_resource="test/resource",
        )

    def test_multi_constraint_partial_failure(self) -> None:
        chain = self._chain(["action:read", "resource:test/*"])
        with pytest.raises(CaveatChainError):
            evaluate_caveat_chain(
                verified_chain=chain,
                requested_action="write",
                requested_resource="test/resource",
            )

    def test_resource_glob_match_allowed(self) -> None:
        chain = self._chain(["resource:secret/*"])
        evaluate_caveat_chain(
            verified_chain=chain,
            requested_resource="secret/key1",
        )

    def test_resource_exact_mismatch_denied(self) -> None:
        chain = self._chain(["resource:secret/key1"])
        with pytest.raises(CaveatChainError):
            evaluate_caveat_chain(
                verified_chain=chain,
                requested_resource="secret/key2",
            )
