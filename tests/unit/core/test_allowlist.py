"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for AllowlistManager pure logic: LRUCache, pattern matching, cache stats.
"""

import time
from uuid import UUID, uuid4

import pytest

from caracal.core.allowlist import (
    AllowlistDecision,
    AllowlistManager,
    CachedAllowlistEntry,
    LRUCache,
)

pytestmark = pytest.mark.unit


class TestLRUCache:
    def test_get_missing_returns_none(self):
        cache = LRUCache(max_size=3)
        assert cache.get("missing") is None

    def test_put_and_get(self):
        cache = LRUCache(max_size=3)
        cache.put("k", "v")
        assert cache.get("k") == "v"

    def test_size_tracks_items(self):
        cache = LRUCache(max_size=5)
        cache.put("a", 1)
        cache.put("b", 2)
        assert cache.size() == 2

    def test_evicts_lru_when_full(self):
        cache = LRUCache(max_size=2)
        cache.put("first", 1)
        cache.put("second", 2)
        cache.get("first")  # make "first" most recently used
        cache.put("third", 3)  # should evict "second"
        assert cache.get("second") is None
        assert cache.get("first") == 1
        assert cache.get("third") == 3

    def test_update_existing_moves_to_end(self):
        cache = LRUCache(max_size=2)
        cache.put("a", 1)
        cache.put("b", 2)
        cache.put("a", 99)  # update "a" — "b" stays, "a" is refreshed
        cache.put("c", 3)   # evicts "b" (LRU)
        assert cache.get("b") is None
        assert cache.get("a") == 99

    def test_clear_empties_cache(self):
        cache = LRUCache(max_size=5)
        cache.put("x", 1)
        cache.clear()
        assert cache.size() == 0
        assert cache.get("x") is None


class TestAllowlistDecision:
    def test_allowed_true(self):
        decision = AllowlistDecision(allowed=True, reason="ok")
        assert decision.allowed is True

    def test_matched_pattern_default_none(self):
        decision = AllowlistDecision(allowed=False, reason="denied")
        assert decision.matched_pattern is None


class TestAllowlistManagerPatternMatching:
    def _manager(self):
        from unittest.mock import MagicMock
        session = MagicMock()
        return AllowlistManager(db_session=session)

    def test_match_regex_exact(self):
        m = self._manager()
        assert m.match_pattern(r"^https://api\.openai\.com/v1$", "regex", "https://api.openai.com/v1") is True

    def test_match_regex_no_match(self):
        m = self._manager()
        assert m.match_pattern(r"^https://api\.openai\.com/v1$", "regex", "https://other.com") is False

    def test_match_regex_cached_on_second_call(self):
        m = self._manager()
        pattern = r"^test://.+$"
        m.match_pattern(pattern, "regex", "test://anything")
        cached = m._pattern_cache.get(pattern)
        assert cached is not None

    def test_match_glob_wildcard(self):
        m = self._manager()
        assert m.match_pattern("https://api.openai.com/*", "glob", "https://api.openai.com/v1") is True

    def test_match_glob_no_match(self):
        m = self._manager()
        assert m.match_pattern("https://api.openai.com/*", "glob", "https://other.com/v1") is False

    def test_match_invalid_pattern_type_returns_false(self):
        m = self._manager()
        assert m.match_pattern("anything", "unknown", "url") is False

    def test_invalid_regex_returns_false(self):
        m = self._manager()
        assert m.match_pattern("[invalid", "regex", "url") is False


class TestAllowlistManagerValidation:
    def _manager(self):
        from unittest.mock import MagicMock
        return AllowlistManager(db_session=MagicMock())

    def test_validate_valid_regex(self):
        m = self._manager()
        m._validate_pattern(r"^https://api\.example\.com/.*$", "regex")  # no error

    def test_validate_invalid_regex_raises(self):
        from caracal.exceptions import ValidationError
        m = self._manager()
        with pytest.raises(ValidationError, match="Invalid regex"):
            m._validate_pattern("[unclosed", "regex")

    def test_validate_regex_too_long_raises(self):
        from caracal.exceptions import ValidationError
        m = self._manager()
        with pytest.raises(ValidationError, match="maximum length"):
            m._validate_pattern("a" * 501, "regex")

    def test_validate_glob_empty_raises(self):
        from caracal.exceptions import ValidationError
        m = self._manager()
        with pytest.raises(ValidationError, match="cannot be empty"):
            m._validate_pattern("", "glob")

    def test_validate_glob_valid(self):
        m = self._manager()
        m._validate_pattern("https://api.example.com/*", "glob")  # no error


class TestAllowlistManagerCacheStats:
    def _manager(self):
        from unittest.mock import MagicMock
        return AllowlistManager(db_session=MagicMock())

    def test_initial_stats_are_zero(self):
        m = self._manager()
        stats = m.get_cache_stats()
        assert stats["cache_hits"] == 0
        assert stats["cache_misses"] == 0
        assert stats["cache_invalidations"] == 0
        assert stats["hit_rate"] == 0.0

    def test_invalidate_removes_entry(self):
        m = self._manager()
        pid = uuid4()
        from unittest.mock import MagicMock
        entry = MagicMock(spec=CachedAllowlistEntry)
        m._allowlist_cache[pid] = entry
        m.invalidate_cache(pid)
        assert pid not in m._allowlist_cache
        assert m._cache_invalidations == 1

    def test_invalidate_missing_is_noop(self):
        m = self._manager()
        m.invalidate_cache(uuid4())  # should not raise

    def test_cache_stats_hit_rate_calculation(self):
        m = self._manager()
        m._cache_hits = 3
        m._cache_misses = 1
        stats = m.get_cache_stats()
        assert stats["hit_rate"] == 0.75


class TestAllowlistManagerCheckResourceNoDb:
    def _manager_with_allowlists(self, allowlists):
        from unittest.mock import MagicMock, patch
        session = MagicMock()
        m = AllowlistManager(db_session=session)
        pid = uuid4()
        import re as _re
        compiled = {
            a.resource_pattern: _re.compile(a.resource_pattern)
            for a in allowlists
            if a.pattern_type == "regex"
        }
        m._allowlist_cache[pid] = CachedAllowlistEntry(
            allowlists=allowlists,
            compiled_patterns=compiled,
            cached_at=time.time(),
        )
        return m, pid

    def _make_allowlist(self, pattern, pattern_type):
        from unittest.mock import MagicMock
        a = MagicMock()
        a.resource_pattern = pattern
        a.pattern_type = pattern_type
        return a

    def test_no_allowlists_default_deny(self):
        m, pid = self._manager_with_allowlists([])
        decision = m.check_resource(pid, "https://anywhere.com")
        assert decision.allowed is False
        assert "default deny" in decision.reason

    def test_regex_match_allowed(self):
        a = self._make_allowlist(r"https://api\.openai\.com/.*", "regex")
        m, pid = self._manager_with_allowlists([a])
        decision = m.check_resource(pid, "https://api.openai.com/v1/chat")
        assert decision.allowed is True

    def test_regex_no_match_denied(self):
        a = self._make_allowlist(r"https://api\.openai\.com/.*", "regex")
        m, pid = self._manager_with_allowlists([a])
        decision = m.check_resource(pid, "https://other.com/v1/chat")
        assert decision.allowed is False

    def test_glob_match_allowed(self):
        a = self._make_allowlist("https://api.openai.com/*", "glob")
        m, pid = self._manager_with_allowlists([a])
        decision = m.check_resource(pid, "https://api.openai.com/v1")
        assert decision.allowed is True

    def test_glob_no_match_denied(self):
        a = self._make_allowlist("https://api.openai.com/*", "glob")
        m, pid = self._manager_with_allowlists([a])
        decision = m.check_resource(pid, "https://other.com/v1")
        assert decision.allowed is False

    def test_cache_hit_increments_counter(self):
        m, pid = self._manager_with_allowlists([])
        m.check_resource(pid, "https://x.com")
        assert m._cache_hits == 1

    def test_expired_cache_triggers_miss(self, monkeypatch):
        from unittest.mock import MagicMock
        session = MagicMock()
        m = AllowlistManager(db_session=session, cache_ttl_seconds=0)
        pid = uuid4()
        m._allowlist_cache[pid] = CachedAllowlistEntry(
            allowlists=[],
            compiled_patterns={},
            cached_at=0.0,  # long expired
        )
        session.execute.return_value.scalars.return_value.all.return_value = []
        m.check_resource(pid, "https://x.com")
        assert m._cache_misses == 1
