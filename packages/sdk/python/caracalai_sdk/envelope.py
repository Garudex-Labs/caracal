"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Wire envelope constants and codec for transport-neutral identity propagation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Mapping

HEADER_SUBJECT_TOKEN = "caracal-subject-token"
HEADER_AGENT_SESSION = "caracal-agent-session"
HEADER_DELEGATION_EDGE = "caracal-delegation-edge"
HEADER_PARENT_EDGE = "caracal-parent-edge"
HEADER_TRACE = "caracal-trace"
HEADER_HOP = "caracal-hop"

MAX_HOP = 32


@dataclass
class Envelope:
    subject_token: str | None = None
    agent_session_id: str | None = None
    delegation_edge_id: str | None = None
    parent_edge_id: str | None = None
    trace_id: str | None = None
    hop: int = 0


HeaderGetter = Callable[[str], str | None]
HeaderSetter = Callable[[str, str], None]


def _get_ci(headers: Mapping[str, str | list[str]], name: str) -> str | None:
    lower = name.lower()
    for k, v in headers.items():
        if k.lower() == lower:
            return v[0] if isinstance(v, list) else v
    return None


def decode_envelope(get: HeaderGetter) -> Envelope:
    hop_raw = get(HEADER_HOP)
    try:
        hop = max(0, min(MAX_HOP, int(hop_raw))) if hop_raw else 0
    except (ValueError, TypeError):
        hop = 0
    return Envelope(
        subject_token=get(HEADER_SUBJECT_TOKEN),
        agent_session_id=get(HEADER_AGENT_SESSION),
        delegation_edge_id=get(HEADER_DELEGATION_EDGE),
        parent_edge_id=get(HEADER_PARENT_EDGE),
        trace_id=get(HEADER_TRACE),
        hop=hop,
    )


def encode_envelope(env: Envelope, set_header: HeaderSetter) -> None:
    if env.subject_token:
        set_header(HEADER_SUBJECT_TOKEN, env.subject_token)
    if env.agent_session_id:
        set_header(HEADER_AGENT_SESSION, env.agent_session_id)
    if env.delegation_edge_id:
        set_header(HEADER_DELEGATION_EDGE, env.delegation_edge_id)
    if env.parent_edge_id:
        set_header(HEADER_PARENT_EDGE, env.parent_edge_id)
    if env.trace_id:
        set_header(HEADER_TRACE, env.trace_id)
    set_header(HEADER_HOP, str(env.hop))


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
