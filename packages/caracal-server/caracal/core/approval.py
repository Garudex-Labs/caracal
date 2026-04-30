"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Permission approval evaluation for authority issuance flows.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from enum import Enum
from fnmatch import fnmatchcase
from typing import Any, Iterable, Optional
from uuid import UUID

from caracal.core.time_utils import now_utc
from caracal.provider.definitions import parse_provider_scope


class ApprovalMode(str, Enum):
    """Supported approval modes for authority issuance."""

    STRICT = "strict"
    PARTIAL = "partial"


class ApprovalStatus(str, Enum):
    """Approval result status."""

    FULL = "full"
    PARTIAL = "partial"
    NONE = "none"


@dataclass(frozen=True)
class Permission:
    """Atomic permission grant."""

    resource: str
    action: str

    def to_dict(self) -> dict[str, str]:
        return {"resource": self.resource, "action": self.action}


@dataclass(frozen=True)
class RejectedPermission:
    """Rejected atomic permission with constraint context."""

    resource: str
    action: str
    constraint: str
    reason: str

    def to_dict(self) -> dict[str, str]:
        return {
            "resource": self.resource,
            "action": self.action,
            "constraint": self.constraint,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class ApprovalDecision:
    """Structured approval feedback for issuance requests."""

    approval_mode: ApprovalMode
    requested_permissions: tuple[Permission, ...]
    approved_permissions: tuple[Permission, ...]
    rejected_permissions: tuple[RejectedPermission, ...]
    approval_status: ApprovalStatus
    requested_ttl: Optional[int] = None
    effective_ttl: Optional[int] = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "approval_mode": self.approval_mode.value,
            "requested_permissions": [
                permission.to_dict() for permission in self.requested_permissions
            ],
            "approved_permissions": [
                permission.to_dict() for permission in self.approved_permissions
            ],
            "rejected_permissions": [
                permission.to_dict() for permission in self.rejected_permissions
            ],
            "approval_status": self.approval_status.value,
        }
        if self.requested_ttl is not None:
            payload["requested_ttl"] = self.requested_ttl
        if self.effective_ttl is not None:
            payload["effective_ttl"] = self.effective_ttl
        return payload

    @property
    def approved_resource_scope(self) -> list[str]:
        return _ordered_unique(permission.resource for permission in self.approved_permissions)

    @property
    def approved_action_scope(self) -> list[str]:
        return _ordered_unique(permission.action for permission in self.approved_permissions)


class PermissionApprovalError(ValueError):
    """Raised when a permission request cannot be approved."""

    def __init__(self, message: str, decision: ApprovalDecision) -> None:
        super().__init__(message)
        self.decision = decision


class PermissionApprovalEvaluator:
    """Evaluate requested permissions against policy or source mandate limits."""

    def __init__(self, approval_mode: ApprovalMode | str | None = None) -> None:
        self.approval_mode = resolve_approval_mode(approval_mode)

    def evaluate_policy_request(
        self,
        *,
        resource_scope: list[str],
        action_scope: list[str],
        policy: Any,
        requested_ttl: int,
        effective_ttl: int,
    ) -> ApprovalDecision:
        requested_permissions = build_permissions(resource_scope, action_scope)
        rejected_permissions: list[RejectedPermission] = []
        approved_permissions: list[Permission] = []

        for permission in requested_permissions:
            reason = self._policy_rejection_reason(permission, policy)
            if reason is None:
                approved_permissions.append(permission)
            else:
                rejected_permissions.append(
                    RejectedPermission(
                        resource=permission.resource,
                        action=permission.action,
                        constraint="policy",
                        reason=reason,
                    )
                )

        return self._decision(
            requested_permissions=requested_permissions,
            approved_permissions=tuple(approved_permissions),
            rejected_permissions=tuple(rejected_permissions),
            requested_ttl=requested_ttl,
            effective_ttl=effective_ttl,
        )

    def evaluate_source_mandate_request(
        self,
        *,
        resource_scope: list[str],
        action_scope: list[str],
        source_mandate: Any,
        issuer_id: UUID,
        requested_ttl: int,
        effective_ttl: int,
    ) -> ApprovalDecision:
        requested_permissions = build_permissions(resource_scope, action_scope)
        global_reason = self._source_mandate_global_rejection_reason(
            source_mandate=source_mandate,
            issuer_id=issuer_id,
        )
        if global_reason is not None:
            return self._decision(
                requested_permissions=requested_permissions,
                approved_permissions=(),
                rejected_permissions=tuple(
                    RejectedPermission(
                        resource=permission.resource,
                        action=permission.action,
                        constraint="source mandate",
                        reason=global_reason,
                    )
                    for permission in requested_permissions
                ),
                requested_ttl=requested_ttl,
                effective_ttl=effective_ttl,
            )

        approved_permissions: list[Permission] = []
        rejected_permissions: list[RejectedPermission] = []
        for permission in requested_permissions:
            reason = self._source_mandate_permission_rejection_reason(
                permission, source_mandate
            )
            if reason is None:
                approved_permissions.append(permission)
            else:
                rejected_permissions.append(
                    RejectedPermission(
                        resource=permission.resource,
                        action=permission.action,
                        constraint="source mandate",
                        reason=reason,
                    )
                )

        return self._decision(
            requested_permissions=requested_permissions,
            approved_permissions=tuple(approved_permissions),
            rejected_permissions=tuple(rejected_permissions),
            requested_ttl=requested_ttl,
            effective_ttl=effective_ttl,
        )

    def _decision(
        self,
        *,
        requested_permissions: tuple[Permission, ...],
        approved_permissions: tuple[Permission, ...],
        rejected_permissions: tuple[RejectedPermission, ...],
        requested_ttl: int,
        effective_ttl: int,
    ) -> ApprovalDecision:
        if self.approval_mode is ApprovalMode.STRICT and rejected_permissions:
            approved_permissions = ()

        if not approved_permissions:
            approval_status = ApprovalStatus.NONE
        elif len(approved_permissions) == len(requested_permissions):
            approval_status = ApprovalStatus.FULL
        else:
            approval_status = ApprovalStatus.PARTIAL

        return ApprovalDecision(
            approval_mode=self.approval_mode,
            requested_permissions=requested_permissions,
            approved_permissions=approved_permissions,
            rejected_permissions=rejected_permissions,
            approval_status=approval_status,
            requested_ttl=requested_ttl,
            effective_ttl=effective_ttl,
        )

    @staticmethod
    def _policy_rejection_reason(permission: Permission, policy: Any) -> Optional[str]:
        if not _matches_any(permission.resource, getattr(policy, "allowed_resource_patterns", []) or []):
            return "Resource is outside issuer policy"
        if not _matches_any(permission.action, getattr(policy, "allowed_actions", []) or []):
            return "Action is outside issuer policy"
        return None

    @staticmethod
    def _source_mandate_global_rejection_reason(
        *, source_mandate: Any, issuer_id: UUID
    ) -> Optional[str]:
        if source_mandate is None:
            return "Source mandate was not found"
        if getattr(source_mandate, "revoked", False):
            return "Source mandate is revoked"
        if getattr(source_mandate, "subject_id", None) != issuer_id:
            return "Source mandate subject must be the delegated issuer"

        current_time = now_utc()
        valid_until = getattr(source_mandate, "valid_until", None)
        valid_from = getattr(source_mandate, "valid_from", None)
        if valid_until is not None and current_time > valid_until:
            return "Source mandate is expired"
        if valid_from is not None and current_time < valid_from:
            return "Source mandate is not yet valid"

        metadata_value = getattr(source_mandate, "mandate_metadata", None)
        metadata = metadata_value if isinstance(metadata_value, dict) else {}
        if metadata.get("allow_delegation") is not True:
            return "Source mandate does not explicitly allow delegation"
        if int(getattr(source_mandate, "network_distance", 0) or 0) <= 0:
            return "Source mandate has no remaining delegation depth"
        return None

    @staticmethod
    def _source_mandate_permission_rejection_reason(
        permission: Permission, source_mandate: Any
    ) -> Optional[str]:
        if not _matches_any(permission.resource, getattr(source_mandate, "resource_scope", []) or []):
            return "Resource is outside source mandate"
        if not _matches_any(permission.action, getattr(source_mandate, "action_scope", []) or []):
            return "Action is outside source mandate"
        return None


def resolve_approval_mode(value: ApprovalMode | str | None = None) -> ApprovalMode:
    raw_value = value.value if isinstance(value, ApprovalMode) else value
    normalized = (
        raw_value
        or os.environ.get("CCL_APPROVAL_MODE")
        or os.environ.get("approval_mode")
        or "strict"
    ).strip().lower()
    try:
        return ApprovalMode(normalized)
    except ValueError as exc:
        raise ValueError("approval_mode must be 'strict' or 'partial'") from exc


def build_permissions(resource_scope: list[str], action_scope: list[str]) -> tuple[Permission, ...]:
    return tuple(
        Permission(resource=str(resource), action=str(action))
        for resource in resource_scope
        for action in action_scope
    )


def extract_approval_feedback(source: Any) -> dict[str, Any]:
    metadata_value = getattr(source, "mandate_metadata", None)
    metadata = metadata_value if isinstance(metadata_value, dict) else {}
    feedback = metadata.get("approval")
    return feedback if isinstance(feedback, dict) else {}


def _ordered_unique(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    for value in values:
        if value not in result:
            result.append(value)
    return result


def _matches_any(value: str, patterns: list[str]) -> bool:
    return any(_match_pattern(value, pattern) for pattern in patterns)


def _is_canonical_provider_scope(scope: str) -> bool:
    try:
        parse_provider_scope(str(scope))
        return True
    except ValueError:
        return False


def _match_pattern(value: str, pattern: str) -> bool:
    if value == pattern:
        return True
    if _is_canonical_provider_scope(value) or _is_canonical_provider_scope(pattern):
        return False
    return fnmatchcase(value, pattern)

