"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Deterministic fault, latency, and rate-limit engine driven by faults/profile.yaml.
"""
from __future__ import annotations

import hashlib
import json
import os
import struct
import time
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock

import yaml

_PROFILE_PATH = Path(__file__).parent / "profile.yaml"
_FAST = os.getenv("LYNX_MOCK_FAST", "0") == "1"


def _load_profile() -> dict:
    return yaml.safe_load(_PROFILE_PATH.read_text(encoding="utf-8"))


_PROFILE = _load_profile()
_DEFAULTS = _PROFILE["defaults"]
_PROVIDERS = _PROFILE["providers"]


def profile_for(provider: str) -> dict:
    base = dict(_DEFAULTS)
    spec = _PROVIDERS.get(provider, {})
    merged = {**base, **spec}
    for k, v in _DEFAULTS.items():
        if isinstance(v, dict) and k in spec and isinstance(spec[k], dict):
            merged[k] = {**v, **spec[k]}
    return merged


def _seed(provider: str, action: str, payload: dict, attempt: int, salt: str) -> int:
    h = hashlib.sha256()
    h.update(provider.encode())
    h.update(b"\0")
    h.update(action.encode())
    h.update(b"\0")
    h.update(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())
    h.update(b"\0")
    h.update(str(attempt).encode())
    h.update(b"\0")
    h.update(salt.encode())
    return struct.unpack(">Q", h.digest()[:8])[0]


def _u01(seed: int, salt: str) -> float:
    h = hashlib.sha256(f"{seed}:{salt}".encode()).digest()
    return struct.unpack(">Q", h[:8])[0] / 2**64


def _draw_latency(seed: int, lat: dict) -> float:
    if _FAST:
        return 0.0
    u = _u01(seed, "lat")
    if u < 0.5:
        ms = lat["p50_ms"]
    elif u < 0.95:
        ms = lat["p50_ms"] + (lat["p95_ms"] - lat["p50_ms"]) * ((u - 0.5) / 0.45)
    else:
        ms = lat["p95_ms"] + (lat["p99_ms"] - lat["p95_ms"]) * ((u - 0.95) / 0.05)
    j = lat.get("jitter_ms", 0)
    if j:
        ms += (_u01(seed, "jit") - 0.5) * 2 * j
    return max(0.0, ms / 1000.0)


def _pick_error(seed: int, errors: list[dict]) -> int:
    total = sum(e.get("weight", 1) for e in errors)
    u = _u01(seed, "errpick") * total
    acc = 0
    for e in errors:
        acc += e.get("weight", 1)
        if u < acc:
            return int(e["status"])
    return int(errors[-1]["status"])


@dataclass
class Bucket:
    capacity: float
    refill_per_s: float
    tokens: float = field(init=False)
    last: float = field(init=False)
    lock: Lock = field(default_factory=Lock)

    def __post_init__(self) -> None:
        self.tokens = self.capacity
        self.last = time.monotonic()

    def take(self, n: float = 1.0) -> tuple[bool, float]:
        with self.lock:
            now = time.monotonic()
            self.tokens = min(self.capacity, self.tokens + (now - self.last) * self.refill_per_s)
            self.last = now
            if self.tokens >= n:
                self.tokens -= n
                return True, 0.0
            deficit = n - self.tokens
            return False, deficit / self.refill_per_s


_buckets: dict[tuple[str, str], Bucket] = {}
_buckets_lock = Lock()


def bucket(provider: str, key: str) -> Bucket:
    rl = profile_for(provider).get("rate_limit", _DEFAULTS["rate_limit"])
    bk = (provider, key)
    with _buckets_lock:
        if bk not in _buckets:
            _buckets[bk] = Bucket(float(rl["capacity"]), float(rl["refill_per_s"]))
        return _buckets[bk]


@dataclass
class FaultDecision:
    delay_s: float
    error_status: int | None
    error_body: dict | None
    rate_limited: bool
    retry_after_s: float


def evaluate(
    provider: str,
    action: str,
    payload: dict,
    attempt: int,
    api_key: str | None,
) -> FaultDecision:
    p = profile_for(provider)
    seed = _seed(provider, action, payload, attempt, "fault")

    bk_key = api_key or "anon"
    ok, retry_after = bucket(provider, bk_key).take()
    if not ok:
        return FaultDecision(delay_s=0.0, error_status=429, error_body={
            "error": "rate_limited",
            "message": f"{provider}: rate limit exceeded",
            "retry_after_s": round(retry_after, 3),
        }, rate_limited=True, retry_after_s=retry_after)

    delay = _draw_latency(seed, p["latency"])

    er = float(p.get("error_rate", 0.0))
    if er > 0 and _u01(seed, "errchk") < er:
        status = _pick_error(seed, p.get("errors", _DEFAULTS["errors"]))
        return FaultDecision(delay_s=delay, error_status=status, error_body={
            "error": "transient",
            "message": f"{provider}: upstream {status}",
            "attempt": attempt,
        }, rate_limited=False, retry_after_s=0.0)

    return FaultDecision(delay, None, None, False, 0.0)
