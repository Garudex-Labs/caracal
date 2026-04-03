"""Principal lifecycle state-machine rules for hard-cut identity flows."""

from __future__ import annotations

from dataclasses import dataclass

from caracal.db.models import PrincipalKind, PrincipalLifecycleStatus


class LifecycleTransitionError(RuntimeError):
    """Raised when a lifecycle transition violates hard-cut policy rules."""


@dataclass(frozen=True)
class LifecycleTransitionDecision:
    """Decision metadata for a requested lifecycle transition."""

    allowed: bool
    reason: str
    principal_kind: str
    from_status: str
    to_status: str


class PrincipalLifecycleStateMachine:
    """Typed lifecycle transition rules per principal kind."""

    _ACTIVE = PrincipalLifecycleStatus.ACTIVE.value
    _SUSPENDED = PrincipalLifecycleStatus.SUSPENDED.value
    _DEACTIVATED = PrincipalLifecycleStatus.DEACTIVATED.value
    _REVOKED = PrincipalLifecycleStatus.REVOKED.value

    _DEFAULT_TRANSITIONS: dict[str, set[str]] = {
        _ACTIVE: {_SUSPENDED, _DEACTIVATED, _REVOKED},
        _SUSPENDED: {_ACTIVE, _DEACTIVATED, _REVOKED},
        _DEACTIVATED: {_ACTIVE, _REVOKED},
        _REVOKED: set(),
    }

    _NON_REACTIVATING_TRANSITIONS: dict[str, set[str]] = {
        _ACTIVE: {_SUSPENDED, _DEACTIVATED, _REVOKED},
        _SUSPENDED: {_DEACTIVATED, _REVOKED},
        _DEACTIVATED: {_REVOKED},
        _REVOKED: set(),
    }

    _KIND_RULES: dict[str, dict[str, set[str]]] = {
        PrincipalKind.HUMAN.value: _DEFAULT_TRANSITIONS,
        PrincipalKind.SERVICE.value: _DEFAULT_TRANSITIONS,
        PrincipalKind.ORCHESTRATOR.value: _NON_REACTIVATING_TRANSITIONS,
        PrincipalKind.WORKER.value: _NON_REACTIVATING_TRANSITIONS,
    }

    _VALID_STATUSES = {
        PrincipalLifecycleStatus.ACTIVE.value,
        PrincipalLifecycleStatus.SUSPENDED.value,
        PrincipalLifecycleStatus.DEACTIVATED.value,
        PrincipalLifecycleStatus.REVOKED.value,
    }

    _VALID_KINDS = {
        PrincipalKind.HUMAN.value,
        PrincipalKind.ORCHESTRATOR.value,
        PrincipalKind.WORKER.value,
        PrincipalKind.SERVICE.value,
    }

    def validate_transition(
        self,
        *,
        principal_kind: str,
        from_status: str,
        to_status: str,
    ) -> LifecycleTransitionDecision:
        """Evaluate whether a lifecycle transition is allowed."""
        kind = str(principal_kind or "").strip().lower()
        source = str(from_status or "").strip().lower()
        target = str(to_status or "").strip().lower()

        if kind not in self._VALID_KINDS:
            return LifecycleTransitionDecision(
                allowed=False,
                reason=f"Unknown principal kind: {principal_kind!r}",
                principal_kind=kind,
                from_status=source,
                to_status=target,
            )

        if source not in self._VALID_STATUSES:
            return LifecycleTransitionDecision(
                allowed=False,
                reason=f"Unknown source lifecycle status: {from_status!r}",
                principal_kind=kind,
                from_status=source,
                to_status=target,
            )

        if target not in self._VALID_STATUSES:
            return LifecycleTransitionDecision(
                allowed=False,
                reason=f"Unknown target lifecycle status: {to_status!r}",
                principal_kind=kind,
                from_status=source,
                to_status=target,
            )

        if source == target:
            return LifecycleTransitionDecision(
                allowed=True,
                reason="No-op transition is allowed",
                principal_kind=kind,
                from_status=source,
                to_status=target,
            )

        allowed_targets = self._KIND_RULES[kind].get(source, set())
        if target in allowed_targets:
            return LifecycleTransitionDecision(
                allowed=True,
                reason="Transition allowed",
                principal_kind=kind,
                from_status=source,
                to_status=target,
            )

        if (
            kind in {PrincipalKind.ORCHESTRATOR.value, PrincipalKind.WORKER.value}
            and target in {self._ACTIVE, self._SUSPENDED}
            and source in {self._DEACTIVATED, self._REVOKED, self._SUSPENDED}
        ):
            return LifecycleTransitionDecision(
                allowed=False,
                reason=(
                    f"{kind} principals are non-reactivating in hard-cut mode; "
                    f"cannot transition from {source} to {target}"
                ),
                principal_kind=kind,
                from_status=source,
                to_status=target,
            )

        return LifecycleTransitionDecision(
            allowed=False,
            reason=f"Lifecycle transition {source} -> {target} is not allowed for {kind}",
            principal_kind=kind,
            from_status=source,
            to_status=target,
        )

    def assert_transition_allowed(
        self,
        *,
        principal_kind: str,
        from_status: str,
        to_status: str,
    ) -> None:
        """Raise when a lifecycle transition is invalid for the principal kind."""
        decision = self.validate_transition(
            principal_kind=principal_kind,
            from_status=from_status,
            to_status=to_status,
        )
        if not decision.allowed:
            raise LifecycleTransitionError(decision.reason)
