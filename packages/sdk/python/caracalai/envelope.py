"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Wire envelope using W3C Trace Context (traceparent) and W3C Baggage.

Subject token rides in Authorization. Caracal-specific cross-cutting fields
(session, agent_session, delegation_edge, parent_edge, hop) ride in Baggage under the
caracal.* namespace. Trace identifiers ride in traceparent.
"""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass
from collections.abc import Callable, Mapping
from urllib.parse import quote, unquote

HEADER_AUTHORIZATION = "authorization"
HEADER_TRACEPARENT = "traceparent"
HEADER_BAGGAGE = "baggage"

BAGGAGE_AGENT_SESSION = "caracal.agent_session"
BAGGAGE_DELEGATION_EDGE = "caracal.delegation_edge"
BAGGAGE_PARENT_EDGE = "caracal.parent_edge"
BAGGAGE_SESSION = "caracal.session"
BAGGAGE_HOP = "caracal.hop"

MAX_HOP = 32

_TRACEPARENT_RE = re.compile(r"^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$")


@dataclass
class Envelope:
    subject_token: str | None = None
    agent_session_id: str | None = None
    delegation_edge_id: str | None = None
    parent_edge_id: str | None = None
    session_id: str | None = None
    trace_id: str | None = None
    hop: int = 0


HeaderGetter = Callable[[str], str | None]
HeaderSetter = Callable[[str, str], None]


def _gen_trace_id() -> str:
    return secrets.token_hex(16)


def _gen_span_id() -> str:
    return secrets.token_hex(8)


def format_traceparent(trace_id: str) -> str:
    return f"00-{trace_id}-{_gen_span_id()}-01"


def parse_traceparent(value: str) -> str | None:
    m = _TRACEPARENT_RE.match(value.strip())
    if not m:
        return None
    if m.group(2) == "0" * 32:
        return None
    return m.group(2)


def encode_baggage(entries: Mapping[str, str | None]) -> str:
    parts: list[str] = []
    for k, v in entries.items():
        if v is None or v == "":
            continue
        parts.append(f"{k}={quote(v, safe='')}")
    return ",".join(parts)


def parse_baggage(value: str | None) -> dict[str, str]:
    out: dict[str, str] = {}
    if not value:
        return out
    for piece in value.split(","):
        eq = piece.find("=")
        if eq <= 0:
            continue
        k = piece[:eq].strip()
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
            return v[0] if isinstance(v, list) else v
    return None


def decode_envelope(get: HeaderGetter) -> Envelope:
    auth = get(HEADER_AUTHORIZATION)
    subject_token: str | None = None
    if auth and auth[:7].lower() == "bearer ":
        subject_token = auth[7:].strip() or None
    tp = get(HEADER_TRACEPARENT)
    trace_id = parse_traceparent(tp) if tp else None
    bag = parse_baggage(get(HEADER_BAGGAGE))
    hop_raw = bag.get(BAGGAGE_HOP)
    try:
        hop = max(0, min(MAX_HOP, int(hop_raw))) if hop_raw else 0
    except (ValueError, TypeError):
        hop = 0
    return Envelope(
        subject_token=subject_token,
        agent_session_id=bag.get(BAGGAGE_AGENT_SESSION) or None,
        delegation_edge_id=bag.get(BAGGAGE_DELEGATION_EDGE) or None,
        parent_edge_id=bag.get(BAGGAGE_PARENT_EDGE) or None,
        session_id=bag.get(BAGGAGE_SESSION) or None,
        trace_id=trace_id,
        hop=hop,
    )


def encode_envelope(env: Envelope, set_header: HeaderSetter) -> None:
    if env.subject_token:
        set_header(HEADER_AUTHORIZATION, f"Bearer {env.subject_token}")
    trace_id = env.trace_id if (env.trace_id and re.match(r"^[0-9a-f]{32}$", env.trace_id)) else _gen_trace_id()
    set_header(HEADER_TRACEPARENT, format_traceparent(trace_id))
    baggage = encode_baggage(
        {
            BAGGAGE_AGENT_SESSION: env.agent_session_id,
            BAGGAGE_DELEGATION_EDGE: env.delegation_edge_id,
            BAGGAGE_PARENT_EDGE: env.parent_edge_id,
            BAGGAGE_SESSION: env.session_id,
            BAGGAGE_HOP: str(env.hop),
        }
    )
    if baggage:
        set_header(HEADER_BAGGAGE, baggage)


def from_headers(headers: Mapping[str, str | list[str]]) -> Envelope:
    return decode_envelope(lambda n: _get_ci(headers, n))


def to_headers(env: Envelope) -> dict[str, str]:
    out: dict[str, str] = {}
    encode_envelope(env, lambda n, v: out.__setitem__(n, v))
    return out


def inject(env: Envelope, carrier: dict[str, str]) -> None:
    encode_envelope(env, lambda n, v: carrier.__setitem__(n, v))


def extract(carrier: Mapping[str, str | list[str]]) -> Envelope:
    return from_headers(carrier)
