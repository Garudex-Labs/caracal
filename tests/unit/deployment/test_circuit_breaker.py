"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for broker RateLimit and CircuitBreaker components.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta

import pytest

from caracal.deployment.broker import (
    CircuitBreaker,
    CircuitState,
    RateLimit,
)
from caracal.deployment.exceptions import CircuitBreakerOpenError


@pytest.mark.unit
class TestRateLimit:
    def test_initial_tokens_zero(self) -> None:
        rl = RateLimit(requests_per_minute=60)
        assert rl.tokens == 0.0

    def test_consume_without_tokens_denied(self) -> None:
        rl = RateLimit(requests_per_minute=60, tokens=0.0)
        assert rl.consume(1) is False

    def test_consume_with_tokens_allowed(self) -> None:
        rl = RateLimit(requests_per_minute=60, tokens=5.0)
        assert rl.consume(1) is True
        assert rl.tokens == 4.0

    def test_consume_multiple_tokens(self) -> None:
        rl = RateLimit(requests_per_minute=60, tokens=10.0)
        assert rl.consume(5) is True
        assert rl.tokens == 5.0

    def test_consume_exact_tokens_allowed(self) -> None:
        rl = RateLimit(requests_per_minute=60, tokens=3.0)
        assert rl.consume(3) is True

    def test_consume_more_than_available_denied(self) -> None:
        rl = RateLimit(requests_per_minute=60, tokens=2.0)
        assert rl.consume(5) is False

    def test_refill_increases_tokens(self) -> None:
        past = datetime.now() - timedelta(seconds=60)
        rl = RateLimit(requests_per_minute=60, tokens=0.0, last_refill=past)
        rl._refill()
        assert rl.tokens > 0.0

    def test_refill_capped_at_requests_per_minute(self) -> None:
        past = datetime.now() - timedelta(seconds=3600)
        rl = RateLimit(requests_per_minute=60, tokens=0.0, last_refill=past)
        rl._refill()
        assert rl.tokens <= 60.0

    def test_refill_called_on_consume(self) -> None:
        past = datetime.now() - timedelta(seconds=60)
        rl = RateLimit(requests_per_minute=60, tokens=0.0, last_refill=past)
        assert rl.consume(1) is True

    def test_refill_noop_for_zero_elapsed(self) -> None:
        now = datetime.now()
        rl = RateLimit(requests_per_minute=60, tokens=0.0, last_refill=now)
        rl._refill()
        assert rl.tokens == 0.0


@pytest.mark.unit
class TestCircuitBreakerClosed:
    def test_successful_call_returns_result(self) -> None:
        cb = CircuitBreaker()
        result = cb.call(lambda: "ok")
        assert result == "ok"

    def test_failed_calls_increment_failure_count(self) -> None:
        cb = CircuitBreaker(failure_threshold=5)
        for _ in range(4):
            try:
                cb.call(lambda: (_ for _ in ()).throw(ValueError("err")))
            except ValueError:
                pass
        assert cb.failure_count == 4
        assert cb.state == CircuitState.CLOSED

    def test_reaching_threshold_opens_circuit(self) -> None:
        cb = CircuitBreaker(failure_threshold=3)
        for _ in range(3):
            try:
                cb.call(lambda: (_ for _ in ()).throw(RuntimeError("fail")))
            except RuntimeError:
                pass
        assert cb.state == CircuitState.OPEN

    def test_success_resets_failure_count(self) -> None:
        cb = CircuitBreaker(failure_threshold=5)
        try:
            cb.call(lambda: (_ for _ in ()).throw(ValueError("err")))
        except ValueError:
            pass
        assert cb.failure_count == 1
        cb.call(lambda: None)
        assert cb.failure_count == 0


@pytest.mark.unit
class TestCircuitBreakerOpen:
    def _open_cb(self, timeout_seconds: int = 30) -> CircuitBreaker:
        cb = CircuitBreaker(failure_threshold=1, timeout_seconds=timeout_seconds)
        try:
            cb.call(lambda: (_ for _ in ()).throw(RuntimeError("fail")))
        except RuntimeError:
            pass
        assert cb.state == CircuitState.OPEN
        return cb

    def test_open_circuit_raises_immediately(self) -> None:
        cb = self._open_cb(timeout_seconds=9999)
        with pytest.raises(CircuitBreakerOpenError):
            cb.call(lambda: None)

    def test_open_circuit_transitions_to_half_open_after_timeout(self) -> None:
        cb = self._open_cb(timeout_seconds=0)
        cb.opened_at = datetime.now() - timedelta(seconds=60)
        cb.call(lambda: None)
        assert cb.state == CircuitState.CLOSED

    def test_half_open_success_closes_circuit(self) -> None:
        cb = CircuitBreaker(failure_threshold=1, timeout_seconds=0, half_open_max_calls=1)
        cb.state = CircuitState.HALF_OPEN
        cb.half_open_calls = 0
        cb.call(lambda: None)
        assert cb.state == CircuitState.CLOSED

    def test_half_open_failure_reopens_circuit(self) -> None:
        cb = CircuitBreaker(failure_threshold=1, timeout_seconds=0, half_open_max_calls=1)
        cb.state = CircuitState.HALF_OPEN
        cb.half_open_calls = 0
        cb.opened_at = datetime.now()
        try:
            cb.call(lambda: (_ for _ in ()).throw(RuntimeError("fail")))
        except RuntimeError:
            pass
        assert cb.state == CircuitState.OPEN

    def test_half_open_call_limit_raises(self) -> None:
        cb = CircuitBreaker(failure_threshold=1, half_open_max_calls=1)
        cb.state = CircuitState.HALF_OPEN
        cb.half_open_calls = 1
        with pytest.raises(CircuitBreakerOpenError, match="half-open call limit"):
            cb.call(lambda: None)


@pytest.mark.unit
@pytest.mark.asyncio
class TestCircuitBreakerAsync:
    async def test_async_successful_call(self) -> None:
        cb = CircuitBreaker()

        async def succeed():
            return "async-ok"

        result = await cb.call_async(succeed)
        assert result == "async-ok"

    async def test_async_failure_opens_circuit(self) -> None:
        cb = CircuitBreaker(failure_threshold=1)

        async def fail():
            raise ValueError("async-fail")

        try:
            await cb.call_async(fail)
        except ValueError:
            pass
        assert cb.state == CircuitState.OPEN

    async def test_async_open_raises_immediately(self) -> None:
        cb = CircuitBreaker(failure_threshold=1, timeout_seconds=9999)
        cb.state = CircuitState.OPEN
        cb.opened_at = datetime.now()

        async def ok():
            return "ok"

        with pytest.raises(CircuitBreakerOpenError):
            await cb.call_async(ok)

    async def test_async_half_open_success_closes(self) -> None:
        cb = CircuitBreaker(half_open_max_calls=1, timeout_seconds=0)
        cb.state = CircuitState.HALF_OPEN
        cb.half_open_calls = 0

        async def ok():
            return "ok"

        await cb.call_async(ok)
        assert cb.state == CircuitState.CLOSED

    async def test_async_half_open_failure_reopens(self) -> None:
        cb = CircuitBreaker(half_open_max_calls=1, timeout_seconds=0)
        cb.state = CircuitState.HALF_OPEN
        cb.half_open_calls = 0
        cb.opened_at = datetime.now()

        async def fail():
            raise RuntimeError("fail")

        try:
            await cb.call_async(fail)
        except RuntimeError:
            pass
        assert cb.state == CircuitState.OPEN

    async def test_async_half_open_limit_raises(self) -> None:
        cb = CircuitBreaker(half_open_max_calls=1)
        cb.state = CircuitState.HALF_OPEN
        cb.half_open_calls = 1

        async def ok():
            return "ok"

        with pytest.raises(CircuitBreakerOpenError):
            await cb.call_async(ok)


@pytest.mark.unit
class TestShouldAttemptReset:
    def test_opened_at_none_returns_false(self) -> None:
        cb = CircuitBreaker()
        cb.opened_at = None
        assert cb._should_attempt_reset() is False

    def test_timeout_not_elapsed(self) -> None:
        cb = CircuitBreaker(timeout_seconds=9999)
        cb.opened_at = datetime.now()
        assert cb._should_attempt_reset() is False

    def test_timeout_elapsed(self) -> None:
        cb = CircuitBreaker(timeout_seconds=1)
        cb.opened_at = datetime.now() - timedelta(seconds=10)
        assert cb._should_attempt_reset() is True
