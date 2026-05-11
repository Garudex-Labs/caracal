"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Loader for per-provider case files; sole source of canned scenario data.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

_ROOT = Path(__file__).parent
_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_cache: dict[str, dict] = {}


def case_paths() -> dict[str, Path]:
    paths: dict[str, Path] = {}
    for d in _ROOT.glob("*.mock"):
        if not d.is_dir():
            continue
        sid = d.name.removesuffix(".mock")
        if not _ID_RE.fullmatch(sid):
            continue
        f = d / "cases.json"
        if f.is_file():
            paths[sid] = f
    return paths


_PATHS = case_paths()


def load(provider: str) -> dict:
    if provider not in _cache:
        if provider not in _PATHS:
            raise KeyError(provider)
        _cache[provider] = json.loads(_PATHS[provider].read_text(encoding="utf-8"))
    return _cache[provider]


def resolve_key(match_key: str | list[str], payload: dict[str, object]) -> str:
    if isinstance(match_key, list):
        return "|".join(str(payload.get(k, "")) for k in match_key)
    return str(payload.get(match_key, ""))


def resolve(provider: str, action: str, payload: dict[str, object]) -> dict:
    spec = load(provider)
    actions = spec.get("actions") or {}
    if action not in actions:
        raise KeyError(f"{provider}.{action}")
    aspec = actions[action]
    cases = aspec["cases"]
    key = resolve_key(aspec["match_key"], payload)
    base = cases.get(key) or cases["default"]
    return dict(base)
