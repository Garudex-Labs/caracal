"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for enterprise sync payload schema validation.
"""

from __future__ import annotations

import pytest

from caracal.deployment.enterprise_sync_payload import _validate_schema


@pytest.mark.unit
class TestValidateSchema:
    def test_valid_simple_name(self) -> None:
        assert _validate_schema("ws_default") == "ws_default"

    def test_valid_alphabetic(self) -> None:
        assert _validate_schema("myschema") == "myschema"

    def test_valid_with_numbers(self) -> None:
        assert _validate_schema("ws_123") == "ws_123"

    def test_underscore_prefix_allowed(self) -> None:
        assert _validate_schema("_schema") == "_schema"

    def test_rejects_hyphen(self) -> None:
        with pytest.raises(ValueError, match="Invalid schema"):
            _validate_schema("my-schema")

    def test_rejects_starts_with_digit(self) -> None:
        with pytest.raises(ValueError, match="Invalid schema"):
            _validate_schema("1schema")

    def test_rejects_space(self) -> None:
        with pytest.raises(ValueError, match="Invalid schema"):
            _validate_schema("my schema")

    def test_rejects_empty_string(self) -> None:
        with pytest.raises(ValueError, match="Invalid schema"):
            _validate_schema("")

    def test_rejects_dot(self) -> None:
        with pytest.raises(ValueError, match="Invalid schema"):
            _validate_schema("my.schema")

    def test_rejects_sql_injection_attempt(self) -> None:
        with pytest.raises(ValueError, match="Invalid schema"):
            _validate_schema("schema; DROP TABLE principals--")
