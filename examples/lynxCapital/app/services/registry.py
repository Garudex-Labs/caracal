"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Mock service registry - sole entry point for all external service calls.
"""
from __future__ import annotations

import json
from pathlib import Path

import yaml

_MOCK_ROOT = Path(__file__).parent.parent.parent / "_mock"

_registry: dict[str, str] | None = None
_cases: dict[str, dict] = {}


def _load_registry() -> dict[str, str]:
    global _registry
    if _registry is None:
        raw = yaml.safe_load((_MOCK_ROOT / "registry.yaml").read_text(encoding="utf-8"))
        _registry = raw
    return _registry


def _load_cases(service_id: str) -> dict[str, object]:
    if service_id not in _cases:
        reg = _load_registry()
        if service_id not in reg:
            raise KeyError(f"Unknown service: {service_id!r}")
        path = _MOCK_ROOT / reg[service_id]
        _cases[service_id] = json.loads(path.read_text(encoding="utf-8"))
    return _cases[service_id]


def _resolve_key(match_key: str | list[str], payload: dict[str, object]) -> str:
    if isinstance(match_key, list):
        return "|".join(str(payload.get(k, "")) for k in match_key)
    return str(payload.get(match_key, ""))


def call(service_id: str, action: str, payload: dict[str, object]) -> dict[str, object]:
    spec = _load_cases(service_id)
    action_spec = spec["actions"].get(action)
    if action_spec is None:
        raise KeyError(f"Unknown action {action!r} for service {service_id!r}")

    key = _resolve_key(action_spec["match_key"], payload)
    cases = action_spec["cases"]
    result = dict(cases.get(key, cases["default"]))

    # Fill null sentinel fields from payload: result_field -> payload_field.
    _passthroughs = {
        "erp_amount":   "amount",
        "amount":       "amount",
        "total_amount": "amount",
    }
    for result_field, payload_field in _passthroughs.items():
        if result.get(result_field) is None and payload_field in payload:
            if result_field in result:
                result[result_field] = payload[payload_field]

    return result
