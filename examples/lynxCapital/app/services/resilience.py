"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Resilience primitives shared by all transport clients: retry policies,
circuit breakers, deadlines, and idempotency-key generation.
"""
from __future__ import annotations

import os
import random
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Callable, TypeVar

T = TypeVar("T")


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 4
    base_delay_s: float = 0.1
    max_delay_s: float = 4.0
    jitter: float = 0.25

    def delay(self, attempt: int) -> float:
        backoff = min(self.max_delay_s, self.base_delay_s * (2 ** (attempt - 1)))
        return backoff * (1 + random.uniform(-self.jitter, self.jitter))


class CircuitOpenError(RuntimeError):
    def __init__(self, provider: str):
        super().__init__(f"circuit open for {provider}")
        self.provider = provider


@dataclass
class CircuitBreaker:
    """Closed → fails increment count → after `threshold` failures opens for
    `cooldown_s` → half-open lets one probe through; success closes, failure reopens.
    """
    threshold: int = 5
    cooldown_s: float = 10.0
    _failures: int = 0
    _state: str = "closed"
    _opened_at: float = 0.0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def before(self, provider: str) -> None:
        with self._lock:
            if self._state == "open":
                if time.monotonic() - self._opened_at >= self.cooldown_s:
                    self._state = "half_open"
                else:
                    raise CircuitOpenError(provider)

    def on_success(self) -> None:
        with self._lock:
            self._failures = 0
            self._state = "closed"

    def on_failure(self) -> None:
        with self._lock:
            self._failures += 1
            if self._state == "half_open" or self._failures >= self.threshold:
                self._state = "open"
                self._opened_at = time.monotonic()


_BREAKERS: dict[str, CircuitBreaker] = {}
_BREAKER_LOCK = threading.Lock()


def breaker(provider: str, *, threshold: int = 5, cooldown_s: float = 10.0) -> CircuitBreaker:
    with _BREAKER_LOCK:
        b = _BREAKERS.get(provider)
        if b is None:
            b = _BREAKERS[provider] = CircuitBreaker(threshold=threshold, cooldown_s=cooldown_s)
        return b


def reset_breakers() -> None:
    """Drop all circuit breakers; primarily used by tests."""
    with _BREAKER_LOCK:
        _BREAKERS.clear()


def idempotency_key(prefix: str = "lynx") -> str:
    return f"{prefix}-{uuid.uuid4().hex}"


def with_retry(
    provider: str,
    fn: Callable[[int], T],
    *,
    policy: RetryPolicy,
    is_retryable: Callable[[BaseException], bool],
    breaker_obj: CircuitBreaker | None = None,
) -> T:
    """Run `fn(attempt)` with retries on transient errors; honors the breaker."""
    fast = os.getenv("LYNX_MOCK_FAST") == "1"
    last: BaseException | None = None
    for attempt in range(1, policy.max_attempts + 1):
        if breaker_obj is not None:
            breaker_obj.before(provider)
        try:
            result = fn(attempt)
        except BaseException as exc:
            last = exc
            retryable = is_retryable(exc)
            if breaker_obj is not None and retryable:
                breaker_obj.on_failure()
            if not retryable or attempt == policy.max_attempts:
                raise
            delay = 0.0 if fast else policy.delay(attempt)
            retry_after = getattr(exc, "retry_after_s", None)
            if retry_after and not fast:
                delay = max(delay, float(retry_after))
            time.sleep(delay)
            continue
        if breaker_obj is not None:
            breaker_obj.on_success()
        return result
    assert last is not None
    raise last
