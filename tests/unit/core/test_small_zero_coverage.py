"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for small 0%-covered modules: policy_gate, time_windows, authority_metadata.
"""

import pytest
from datetime import datetime, timedelta

pytestmark = pytest.mark.unit


class TestPolicyGatePassthrough:
    def test_returns_authorized(self):
        from caracal.mcp.policy_gate import passthrough
        result = passthrough(resource="test://endpoint", action="call")
        assert result["result"] == "authorized"

    def test_strips_principal_id(self):
        from caracal.mcp.policy_gate import passthrough
        result = passthrough(principal_id="some-id", resource="x")
        assert "principal_id" not in result

    def test_args_preserved(self):
        from caracal.mcp.policy_gate import passthrough
        result = passthrough(resource="r", action="a", extra="v")
        assert result["args"]["resource"] == "r"
        assert result["args"]["extra"] == "v"


class TestTimeWindowCalculator:
    def setup_method(self):
        from caracal.core.time_windows import TimeWindowCalculator
        self.calc = TimeWindowCalculator()

    def _ref(self):
        return datetime(2026, 4, 16, 15, 30, 45)

    def test_rolling_hourly(self):
        ref = self._ref()
        start, end = self.calc.calculate_rolling_window("hourly", ref)
        assert end == ref
        assert start == ref - timedelta(hours=1)

    def test_rolling_daily(self):
        ref = self._ref()
        start, end = self.calc.calculate_rolling_window("daily", ref)
        assert end == ref
        assert start == ref - timedelta(days=1)

    def test_rolling_weekly(self):
        ref = self._ref()
        start, end = self.calc.calculate_rolling_window("weekly", ref)
        assert start == ref - timedelta(days=7)

    def test_rolling_monthly(self):
        ref = self._ref()
        start, end = self.calc.calculate_rolling_window("monthly", ref)
        assert start == ref - timedelta(days=30)

    def test_calendar_hourly(self):
        ref = self._ref()
        start, end = self.calc.calculate_calendar_window("hourly", ref)
        assert start == datetime(2026, 4, 16, 15, 0, 0)

    def test_calendar_daily(self):
        ref = self._ref()
        start, end = self.calc.calculate_calendar_window("daily", ref)
        assert start == datetime(2026, 4, 16, 0, 0, 0)

    def test_calendar_weekly(self):
        ref = datetime(2026, 4, 16, 10, 0, 0)  # Thursday
        start, end = self.calc.calculate_calendar_window("weekly", ref)
        assert start.weekday() == 0

    def test_calendar_monthly(self):
        ref = self._ref()
        start, end = self.calc.calculate_calendar_window("monthly", ref)
        assert start == datetime(2026, 4, 1, 0, 0, 0)

    def test_calculate_window_bounds_rolling(self):
        ref = self._ref()
        start, end = self.calc.calculate_window_bounds("daily", "rolling", ref)
        assert end == ref
        assert start == ref - timedelta(days=1)

    def test_calculate_window_bounds_calendar(self):
        ref = self._ref()
        start, end = self.calc.calculate_window_bounds("monthly", "calendar", ref)
        assert start.day == 1

    def test_invalid_time_window_raises(self):
        from caracal.exceptions import InvalidPolicyError
        with pytest.raises(InvalidPolicyError):
            self.calc.calculate_window_bounds("quarterly", "rolling", self._ref())

    def test_invalid_window_type_raises(self):
        from caracal.exceptions import InvalidPolicyError
        with pytest.raises(InvalidPolicyError):
            self.calc.calculate_window_bounds("daily", "sliding", self._ref())

    def test_defaults_to_utcnow_when_no_reference(self):
        before = datetime.utcnow()
        start, end = self.calc.calculate_window_bounds("hourly", "rolling")
        assert end >= before


class TestAuthorityMetadata:
    def test_default_version(self):
        from caracal.core.authority_metadata import AuthorityMetadata
        meta = AuthorityMetadata()
        assert meta.version == "1.0.0"

    def test_timestamp_set_by_default(self):
        from caracal.core.authority_metadata import AuthorityMetadata
        before = datetime.utcnow()
        meta = AuthorityMetadata()
        assert meta.timestamp is not None
        assert meta.timestamp >= before

    def test_to_dict_version(self):
        from caracal.core.authority_metadata import AuthorityMetadata
        meta = AuthorityMetadata(version="2.0.0")
        d = meta.to_dict()
        assert d["version"] == "2.0.0"

    def test_to_dict_none_fields(self):
        from caracal.core.authority_metadata import AuthorityMetadata
        meta = AuthorityMetadata()
        d = meta.to_dict()
        assert d["principal_identity"] is None
        assert d["audit_reference"] is None

    def test_to_dict_delegation_path(self):
        from caracal.core.authority_metadata import AuthorityMetadata
        meta = AuthorityMetadata(delegation_path=["a", "b"])
        d = meta.to_dict()
        assert d["delegation_path"] == ["a", "b"]

    def test_to_dict_timestamp_is_isoformat(self):
        from caracal.core.authority_metadata import AuthorityMetadata
        ref = datetime(2026, 1, 1, 12, 0, 0)
        meta = AuthorityMetadata(timestamp=ref)
        d = meta.to_dict()
        assert "2026-01-01" in d["timestamp"]

    def test_from_dict_roundtrip(self):
        from caracal.core.authority_metadata import AuthorityMetadata
        ref = datetime(2026, 3, 15, 8, 0, 0)
        original = AuthorityMetadata(
            mandate_id="m-123",
            delegation_token="tok",
            delegation_path=["x"],
            timestamp=ref,
        )
        d = original.to_dict()
        restored = AuthorityMetadata.from_dict(d)
        assert restored.mandate_id == "m-123"
        assert restored.delegation_token == "tok"
        assert restored.delegation_path == ["x"]

    def test_from_dict_defaults_version(self):
        from caracal.core.authority_metadata import AuthorityMetadata
        restored = AuthorityMetadata.from_dict({})
        assert restored.version == "1.0.0"
