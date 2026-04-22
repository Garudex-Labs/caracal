"""Caveat-chain primitives for task-token restriction integrity.

Provides append-only caveat-chain construction plus cumulative HMAC
verification and typed restriction evaluation.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
import hashlib
import hmac
import json
from typing import Any, Optional


class CaveatChainError(ValueError):
    """Raised when caveat-chain parsing or integrity verification fails."""


class CaveatType(str, Enum):
    """Supported caveat restriction types."""

    ACTION = "action"
    RESOURCE = "resource"
    EXPIRY = "expiry"
    TASK_BINDING = "task_binding"


@dataclass(frozen=True)
class ParsedCaveat:
    """Canonical caveat payload used for signing and evaluation."""

    caveat_type: CaveatType
    value: str


def parse_caveat(raw: str) -> ParsedCaveat:
    """Parse a user caveat string into a typed canonical caveat."""
    value = str(raw or "").strip()
    if not value:
        raise CaveatChainError("Caveat value cannot be empty")

    lowered = value.lower()
    if lowered.startswith("action:"):
        action_value = value.split(":", 1)[1].strip()
        if not action_value:
            raise CaveatChainError("Action caveat must include an action value")
        return ParsedCaveat(CaveatType.ACTION, action_value)

    if lowered.startswith("resource:"):
        resource_value = value.split(":", 1)[1].strip()
        if not resource_value:
            raise CaveatChainError("Resource caveat must include a resource value")
        return ParsedCaveat(CaveatType.RESOURCE, resource_value)

    if lowered.startswith("task-binding:"):
        binding_value = value.split(":", 1)[1].strip()
        if not binding_value:
            raise CaveatChainError("Task binding caveat must include a task identifier")
        return ParsedCaveat(CaveatType.TASK_BINDING, binding_value)

    if lowered.startswith("task_binding:"):
        binding_value = value.split(":", 1)[1].strip()
        if not binding_value:
            raise CaveatChainError("Task binding caveat must include a task identifier")
        return ParsedCaveat(CaveatType.TASK_BINDING, binding_value)

    if lowered.startswith("expiry:"):
        expiry_text = value.split(":", 1)[1].strip()
        if not expiry_text:
            raise CaveatChainError("Expiry caveat must include a timestamp value")
        return ParsedCaveat(CaveatType.EXPIRY, _normalize_expiry_value(expiry_text))

    # Unprefixed caveats are treated as resource restrictions for backward compatibility.
    return ParsedCaveat(CaveatType.RESOURCE, value)


def build_caveat_chain(
    *,
    hmac_key: str,
    parent_chain: Optional[list[dict[str, Any]]],
    append_caveats: list[str],
) -> list[dict[str, Any]]:
    """Build an append-only caveat chain from a validated parent chain."""
    key_bytes = _normalize_hmac_key(hmac_key)
    base_chain = verify_caveat_chain(hmac_key=hmac_key, chain=parent_chain or [])
    chain: list[dict[str, Any]] = [dict(node) for node in base_chain]

    previous_hmac = chain[-1]["hmac"] if chain else ""
    for raw in append_caveats:
        parsed = parse_caveat(raw)
        payload = {
            "index": len(chain),
            "type": parsed.caveat_type.value,
            "value": parsed.value,
            "raw": str(raw).strip(),
            "previous_hmac": previous_hmac,
        }
        digest = _sign_node(payload, key_bytes)
        node = dict(payload)
        node["hmac"] = digest
        chain.append(node)
        previous_hmac = digest

    return chain


def verify_caveat_chain(*, hmac_key: str, chain: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Verify cumulative HMAC integrity for all caveat-chain entries."""
    key_bytes = _normalize_hmac_key(hmac_key)
    verified: list[dict[str, Any]] = []
    previous_hmac = ""

    for expected_index, raw_node in enumerate(chain):
        node = _normalize_node(raw_node)
        node_index = int(node.get("index", -1))
        if node_index != expected_index:
            raise CaveatChainError("Caveat chain index sequence is invalid")

        node_type = str(node.get("type") or "").strip().lower()
        if node_type not in {t.value for t in CaveatType}:
            raise CaveatChainError(f"Unsupported caveat type '{node_type}'")

        previous = str(node.get("previous_hmac") or "").strip()
        if previous != previous_hmac:
            raise CaveatChainError("Caveat chain previous_hmac linkage is invalid")

        expected_digest = _sign_node(
            {
                "index": node_index,
                "type": node_type,
                "value": str(node.get("value") or "").strip(),
                "raw": str(node.get("raw") or "").strip(),
                "previous_hmac": previous,
            },
            key_bytes,
        )
        observed_digest = str(node.get("hmac") or "").strip()
        if not hmac.compare_digest(expected_digest, observed_digest):
            raise CaveatChainError("Caveat chain HMAC integrity check failed")

        normalized = {
            "index": node_index,
            "type": node_type,
            "value": str(node.get("value") or "").strip(),
            "raw": str(node.get("raw") or "").strip(),
            "previous_hmac": previous,
            "hmac": observed_digest,
        }
        verified.append(normalized)
        previous_hmac = observed_digest

    return verified


def evaluate_caveat_chain(
    *,
    verified_chain: list[dict[str, Any]],
    requested_action: Optional[str] = None,
    requested_resource: Optional[str] = None,
    task_id: Optional[str] = None,
    current_time: Optional[datetime] = None,
) -> None:
    """Evaluate typed caveat restrictions against a boundary request."""
    now = current_time or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    else:
        now = now.astimezone(timezone.utc)

    action_constraints: list[str] = []
    resource_constraints: list[str] = []
    expiry_constraints: list[datetime] = []
    task_bindings: list[str] = []

    for node in verified_chain:
        node_type = str(node.get("type") or "").strip().lower()
        node_value = str(node.get("value") or "").strip()
        if node_type == CaveatType.ACTION.value:
            action_constraints.append(node_value)
        elif node_type == CaveatType.RESOURCE.value:
            resource_constraints.append(node_value)
        elif node_type == CaveatType.EXPIRY.value:
            expiry_constraints.append(_parse_expiry_datetime(node_value))
        elif node_type == CaveatType.TASK_BINDING.value:
            task_bindings.append(node_value)

    if action_constraints:
        requested = str(requested_action or "").strip()
        if not requested:
            raise CaveatChainError("Action-constrained caveat chain requires requested_action")
        if requested not in action_constraints:
            raise CaveatChainError("Requested action is denied by caveat chain")

    if resource_constraints:
        requested = str(requested_resource or "").strip()
        if not requested:
            raise CaveatChainError("Resource-constrained caveat chain requires requested_resource")
        if not _resource_allowed(requested_resource=requested, allowed=resource_constraints):
            raise CaveatChainError("Requested resource is denied by caveat chain")

    if expiry_constraints:
        earliest_expiry = min(expiry_constraints)
        if now > earliest_expiry:
            raise CaveatChainError("Caveat chain has expired")

    if task_bindings:
        normalized_task_id = str(task_id or "").strip()
        if not normalized_task_id:
            raise CaveatChainError("Task-bound caveat chain requires task_id")
        if normalized_task_id not in set(task_bindings):
            raise CaveatChainError("Task binding restriction denied by caveat chain")


def caveat_strings_from_chain(verified_chain: list[dict[str, Any]]) -> list[str]:
    """Render chain entries into stable string caveat representations."""
    rendered: list[str] = []
    for node in verified_chain:
        raw_value = str(node.get("raw") or "").strip()
        if raw_value:
            rendered.append(raw_value)
            continue

        node_type = str(node.get("type") or "").strip().lower()
        node_value = str(node.get("value") or "").strip()
        if not node_value:
            continue
        if node_type == CaveatType.TASK_BINDING.value:
            rendered.append(f"task-binding:{node_value}")
        else:
            rendered.append(f"{node_type}:{node_value}")
    return rendered


def _normalize_hmac_key(raw_key: str) -> bytes:
    key = str(raw_key or "").encode("utf-8")
    if not key:
        raise CaveatChainError("Caveat chain HMAC key cannot be empty")
    return key


def _normalize_expiry_value(raw_value: str) -> str:
    raw = str(raw_value or "").strip()
    if not raw:
        raise CaveatChainError("Expiry caveat must not be empty")

    if raw.isdigit():
        return raw

    expiry_dt = _parse_expiry_datetime(raw)
    return str(int(expiry_dt.timestamp()))


def _parse_expiry_datetime(raw_value: str) -> datetime:
    raw = str(raw_value or "").strip()
    if raw.isdigit():
        return datetime.fromtimestamp(int(raw), tz=timezone.utc)

    normalized = raw.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise CaveatChainError(f"Invalid expiry caveat value '{raw}'") from exc

    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _sign_node(payload: dict[str, Any], key_bytes: bytes) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hmac.new(key_bytes, canonical, hashlib.sha256).hexdigest()


def _normalize_node(raw_node: Any) -> dict[str, Any]:
    if not isinstance(raw_node, dict):
        raise CaveatChainError("Caveat chain node must be an object")
    return raw_node


def _resource_allowed(*, requested_resource: str, allowed: list[str]) -> bool:
    from fnmatch import fnmatchcase

    for pattern in allowed:
        normalized = str(pattern or "").strip()
        if not normalized:
            continue
        if fnmatchcase(requested_resource, normalized):
            return True
    return False
