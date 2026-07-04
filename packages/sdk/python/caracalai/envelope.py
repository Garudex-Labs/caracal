"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Wire envelope using W3C Trace Context (traceparent/tracestate) and W3C Baggage.

Caracal correlation fields (session, agent_session, delegation_edge,
parent_edge, hop) ride in Baggage under the caracal.* namespace alongside
pass-through third-party entries; trace identity rides in traceparent and
tracestate. Decoding reads the subject token from Authorization, but encoding
never writes it: credential emission is an explicit client-layer decision.
Baggage is unsigned routing metadata; verifiers must treat signed token claims
as the only authoritative source of delegation state.
"""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass, field
from collections.abc import Callable, Mapping
from typing import NamedTuple
from urllib.parse import quote, unquote

HEADER_AUTHORIZATION = "authorization"
HEADER_TRACEPARENT = "traceparent"
HEADER_TRACESTATE = "tracestate"
HEADER_BAGGAGE = "baggage"

BAGGAGE_AGENT_SESSION = "caracal.agent_session"
BAGGAGE_DELEGATION_EDGE = "caracal.delegation_edge"
BAGGAGE_PARENT_EDGE = "caracal.parent_edge"
BAGGAGE_SESSION = "caracal.session"
BAGGAGE_HOP = "caracal.hop"

MAX_HOP = 10

_MAX_BAGGAGE_BYTES = 8192
_MAX_BAGGAGE_MEMBERS = 64

_CARACAL_BAGGAGE_KEYS = (
    BAGGAGE_AGENT_SESSION,
    BAGGAGE_DELEGATION_EDGE,
    BAGGAGE_PARENT_EDGE,
    BAGGAGE_SESSION,
    BAGGAGE_HOP,
)

_BEARER_RE = re.compile(r"bearer +(.+)", re.IGNORECASE)
_HEX2_RE = re.compile(r"[0-9a-f]{2}")
_HEX16_RE = re.compile(r"[0-9a-f]{16}")
_HEX32_RE = re.compile(r"[0-9a-f]{32}")
_HOP_RE = re.compile(r"[0-9]+")


@dataclass
class Envelope:
    subject_token: str | None = None
    agent_session_id: str | None = None
    delegation_edge_id: str | None = None
    parent_edge_id: str | None = None
    session_id: str | None = None
    trace_id: str | None = None
    trace_flags: str | None = None
    trace_state: str | None = None
    baggage: dict[str, str] = field(default_factory=dict)
    hop: int = 0


class Traceparent(NamedTuple):
    trace_id: str
    flags: str


HeaderGetter = Callable[[str], str | None]
HeaderSetter = Callable[[str, str], None]


def _gen_trace_id() -> str:
    return secrets.token_hex(16)


def _gen_span_id() -> str:
    return secrets.token_hex(8)


def format_traceparent(trace_id: str, flags: str | None = None) -> str:
    f = flags if flags and _HEX2_RE.fullmatch(flags) else "01"
    return f"00-{trace_id}-{_gen_span_id()}-{f}"


def parse_traceparent(value: str) -> Traceparent | None:
    parts = value.strip().split("-")
    if len(parts) < 4:
        return None
    version, trace_id, span_id, flags = parts[0], parts[1], parts[2], parts[3]
    if not _HEX2_RE.fullmatch(version) or version == "ff":
        return None
    if version == "00" and len(parts) != 4:
        return None
    if not _HEX32_RE.fullmatch(trace_id) or trace_id == "0" * 32:
        return None
    if not _HEX16_RE.fullmatch(span_id) or span_id == "0" * 16:
        return None
    if not _HEX2_RE.fullmatch(flags):
        return None
    return Traceparent(trace_id=trace_id, flags=flags)


def encode_baggage(entries: Mapping[str, str | None]) -> str:
    parts: list[str] = []
    for k in sorted(entries):
        v = entries[k]
        if v is None or v == "":
            continue
        parts.append(f"{k}={quote(v, safe='')}")
    return ",".join(parts)


def parse_baggage(value: str | None) -> dict[str, str]:
    out: dict[str, str] = {}
    if not value or len(value) > _MAX_BAGGAGE_BYTES:
        return out
    pieces = value.split(",")
    if len(pieces) > _MAX_BAGGAGE_MEMBERS:
        return out
    for piece in pieces:
        eq = piece.find("=")
        if eq <= 0:
            continue
        k = piece[:eq].strip()
        if not k:
            continue
        semi = piece.find(";", eq + 1)
        raw = (piece[eq + 1:] if semi == -1 else piece[eq + 1:semi]).strip()
        try:
            out[k] = unquote(raw)
        except UnicodeDecodeError:
            out[k] = raw
    return out


def _get_ci(headers: Mapping[str, str | list[str]], name: str) -> str | None:
    lower = name.lower()
    for k, v in headers.items():
        if k.lower() == lower:
            if isinstance(v, list):
                return ",".join(v) if lower == HEADER_BAGGAGE else v[0]
            return v
    return None


def decode_envelope(get: HeaderGetter) -> Envelope:
    auth = get(HEADER_AUTHORIZATION)
    bearer = _BEARER_RE.fullmatch(auth.strip()) if auth else None
    tp = get(HEADER_TRACEPARENT)
    trace = parse_traceparent(tp) if tp else None
    trace_state = (get(HEADER_TRACESTATE) or "").strip()
    bag = parse_baggage(get(HEADER_BAGGAGE))
    extras = {k: v for k, v in bag.items() if k not in _CARACAL_BAGGAGE_KEYS}
    hop_raw = bag.get(BAGGAGE_HOP)
    hop = min(MAX_HOP, int(hop_raw)) if hop_raw and _HOP_RE.fullmatch(hop_raw) else 0
    return Envelope(
        subject_token=bearer.group(1) if bearer else None,
        agent_session_id=bag.get(BAGGAGE_AGENT_SESSION) or None,
        delegation_edge_id=bag.get(BAGGAGE_DELEGATION_EDGE) or None,
        parent_edge_id=bag.get(BAGGAGE_PARENT_EDGE) or None,
        session_id=bag.get(BAGGAGE_SESSION) or None,
        trace_id=trace.trace_id if trace else None,
        trace_flags=trace.flags if trace else None,
        trace_state=trace_state or None,
        baggage=extras,
        hop=hop,
    )


def encode_envelope(
    env: Envelope,
    set_header: HeaderSetter,
    get_header: HeaderGetter | None = None,
) -> None:
    existing_tp = get_header(HEADER_TRACEPARENT) if get_header else None
    if not existing_tp or not parse_traceparent(existing_tp):
        trace_id = (
            env.trace_id
            if env.trace_id and _HEX32_RE.fullmatch(env.trace_id)
            else _gen_trace_id()
        )
        set_header(HEADER_TRACEPARENT, format_traceparent(trace_id, env.trace_flags))
    if env.trace_state and not (get_header and get_header(HEADER_TRACESTATE)):
        set_header(HEADER_TRACESTATE, env.trace_state)
    merged = dict(env.baggage)
    if get_header:
        merged.update(parse_baggage(get_header(HEADER_BAGGAGE)))
    for key in _CARACAL_BAGGAGE_KEYS:
        merged.pop(key, None)
    if env.agent_session_id:
        merged[BAGGAGE_AGENT_SESSION] = env.agent_session_id
    if env.delegation_edge_id:
        merged[BAGGAGE_DELEGATION_EDGE] = env.delegation_edge_id
    if env.parent_edge_id:
        merged[BAGGAGE_PARENT_EDGE] = env.parent_edge_id
    if env.session_id:
        merged[BAGGAGE_SESSION] = env.session_id
    if env.hop > 0 or any(
        (env.agent_session_id, env.delegation_edge_id, env.parent_edge_id, env.session_id)
    ):
        merged[BAGGAGE_HOP] = str(env.hop)
    baggage = encode_baggage(merged)
    if baggage:
        set_header(HEADER_BAGGAGE, baggage)


def from_headers(headers: Mapping[str, str | list[str]]) -> Envelope:
    return decode_envelope(lambda n: _get_ci(headers, n))


def to_headers(env: Envelope) -> dict[str, str]:
    out: dict[str, str] = {}
    encode_envelope(env, lambda n, v: out.__setitem__(n, v))
    return out
