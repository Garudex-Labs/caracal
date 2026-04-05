"""Principal-centric revocation orchestration for hard-cut lifecycle enforcement."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from collections import deque
from typing import Any, Optional, Protocol
from uuid import UUID

from sqlalchemy import or_
from sqlalchemy.orm import Session

from caracal.core.lifecycle import PrincipalLifecycleStateMachine
from caracal.db.models import (
    AuthorityLedgerEvent,
    ExecutionMandate,
    Principal,
    PrincipalLifecycleStatus,
)
from caracal.exceptions import PrincipalNotFoundError
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class CascadeJobDispatcher(Protocol):
    """Asynchronous dispatcher for revocation cascade jobs."""

    async def enqueue_principal_revocation(
        self,
        *,
        principal_id: str,
        reason: str,
        actor_principal_id: Optional[str],
    ) -> None:
        """Queue an asynchronous principal revocation job."""


class SessionDenylistBackend(Protocol):
    """Minimal deny-list backend contract used by revocation orchestration."""

    async def add(self, token_jti: str, expires_at: datetime) -> None:
        """Add a token JTI to deny-list storage."""


class RevocationEventPublisher(Protocol):
    """Publisher contract for principal-scoped revocation lifecycle events."""

    async def publish_principal_revocation_event(
        self,
        *,
        event_type: str,
        principal_id: str,
        reason: str,
        actor_principal_id: Optional[str],
        root_principal_id: Optional[str],
        revoked_mandate_ids: Optional[list[str]] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        """Publish a principal revocation event."""


@dataclass
class PrincipalRevocationResult:
    """Outcome metadata for revocation orchestration calls."""

    principal_id: str
    revoked_principal_ids: list[str]
    revoked_mandate_ids: list[str]
    denylisted_session_jtis: int
    cache_invalidations: int
    cascade_jobs_enqueued: int
    leaves_first_order: bool


@dataclass
class _PrincipalRevocationUnit:
    principal_id: UUID
    mandate_ids: list[UUID]


class PrincipalRevocationOrchestrator:
    """Apply principal revocation across session, cache, and durable state layers."""

    def __init__(
        self,
        *,
        db_session: Session,
        lifecycle_state_machine: Optional[PrincipalLifecycleStateMachine] = None,
        denylist_backend: Optional[SessionDenylistBackend] = None,
        mandate_cache=None,
        cascade_job_dispatcher: Optional[CascadeJobDispatcher] = None,
        revocation_event_publisher: Optional[RevocationEventPublisher] = None,
        default_session_ttl: timedelta = timedelta(days=14),
    ) -> None:
        self.db_session = db_session
        self.lifecycle_state_machine = lifecycle_state_machine or PrincipalLifecycleStateMachine()
        self.denylist_backend = denylist_backend
        self.mandate_cache = mandate_cache
        self.cascade_job_dispatcher = cascade_job_dispatcher
        self.revocation_event_publisher = revocation_event_publisher
        self.default_session_ttl = default_session_ttl

    async def revoke_principal(
        self,
        *,
        principal_id: str,
        reason: str,
        actor_principal_id: Optional[str] = None,
        session_token_jtis: Optional[list[str]] = None,
        session_expires_at: Optional[datetime] = None,
        cascade_async_threshold: int = 250,
    ) -> PrincipalRevocationResult:
        """Revoke principal authority with leaves-first cascade semantics."""
        principal_uuid = UUID(str(principal_id))
        ordered_ids = self._resolve_leaves_first_order(principal_uuid)

        denylisted_count = await self._denylist_sessions(
            session_token_jtis=session_token_jtis,
            session_expires_at=session_expires_at,
        )

        sync_targets = ordered_ids
        cascade_jobs_enqueued = 0
        if (
            self.cascade_job_dispatcher is not None
            and len(ordered_ids) > cascade_async_threshold
        ):
            descendants = self._resolve_breadth_first_descendants(principal_uuid)
            for descendant_id in descendants:
                await self.cascade_job_dispatcher.enqueue_principal_revocation(
                    principal_id=str(descendant_id),
                    reason=reason,
                    actor_principal_id=actor_principal_id,
                )
                self._record_authority_event(
                    event_type="revocation_enqueued",
                    principal_id=descendant_id,
                    mandate_id=None,
                    metadata={
                        "reason": reason,
                        "actor_principal_id": actor_principal_id,
                        "root_principal_id": str(principal_uuid),
                        "execution_mode": "async_cascade",
                    },
                )
                await self._publish_revocation_event(
                    event_type="revocation_enqueued",
                    principal_id=descendant_id,
                    reason=reason,
                    actor_principal_id=actor_principal_id,
                    root_principal_id=principal_uuid,
                    revoked_mandate_ids=None,
                    metadata={
                        "execution_mode": "async_cascade",
                    },
                )
            cascade_jobs_enqueued = len(descendants)
            sync_targets = [ordered_ids[-1]]

        revoked_units: list[_PrincipalRevocationUnit] = []
        cache_invalidations = 0
        try:
            for target_id in sync_targets:
                if self.mandate_cache is not None:
                    cache_invalidations += self._invalidate_mandate_cache_for_principal(target_id)

                unit = self._revoke_single_principal(
                    principal_id=target_id,
                    reason=reason,
                    actor_principal_id=actor_principal_id,
                )
                revoked_units.append(unit)

            self.db_session.flush()
            self.db_session.commit()
        except Exception:
            self.db_session.rollback()
            raise

        for unit in revoked_units:
            await self._publish_revocation_event(
                event_type="principal_revoked",
                principal_id=unit.principal_id,
                reason=reason,
                actor_principal_id=actor_principal_id,
                root_principal_id=principal_uuid,
                revoked_mandate_ids=[str(mandate_id) for mandate_id in unit.mandate_ids],
                metadata={
                    "leaves_first_order": True,
                    "cascade_async_threshold": cascade_async_threshold,
                },
            )

        revoked_principal_ids = [str(unit.principal_id) for unit in revoked_units]
        revoked_mandate_ids = [str(mid) for unit in revoked_units for mid in unit.mandate_ids]
        return PrincipalRevocationResult(
            principal_id=str(principal_uuid),
            revoked_principal_ids=revoked_principal_ids,
            revoked_mandate_ids=revoked_mandate_ids,
            denylisted_session_jtis=denylisted_count,
            cache_invalidations=cache_invalidations,
            cascade_jobs_enqueued=cascade_jobs_enqueued,
            leaves_first_order=True,
        )

    async def _denylist_sessions(
        self,
        *,
        session_token_jtis: Optional[list[str]],
        session_expires_at: Optional[datetime],
    ) -> int:
        if self.denylist_backend is None:
            return 0

        expires_at = session_expires_at or (datetime.now(timezone.utc) + self.default_session_ttl)
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)

        count = 0
        for token_jti in session_token_jtis or []:
            value = (token_jti or "").strip()
            if not value:
                continue
            await self.denylist_backend.add(value, expires_at)
            count += 1
        return count

    def _invalidate_mandate_cache_for_principal(self, principal_id: UUID) -> int:
        if self.mandate_cache is None:
            return 0

        invalidations = 0
        for mandate in self._list_active_mandates_for_principal(principal_id):
            self.mandate_cache.invalidate_mandate(mandate.mandate_id)
            invalidations += 1

        invalidations += int(self.mandate_cache.invalidate_mandates_by_subject(principal_id))
        return invalidations

    async def _publish_revocation_event(
        self,
        *,
        event_type: str,
        principal_id: UUID,
        reason: str,
        actor_principal_id: Optional[str],
        root_principal_id: Optional[UUID],
        revoked_mandate_ids: Optional[list[str]],
        metadata: Optional[dict[str, Any]],
    ) -> None:
        if self.revocation_event_publisher is None:
            return

        try:
            await self.revocation_event_publisher.publish_principal_revocation_event(
                event_type=event_type,
                principal_id=str(principal_id),
                reason=reason,
                actor_principal_id=actor_principal_id,
                root_principal_id=str(root_principal_id) if root_principal_id is not None else None,
                revoked_mandate_ids=revoked_mandate_ids,
                metadata=metadata or {},
            )
        except Exception as exc:
            # Publisher failures are non-fatal after durable revocation state transitions.
            logger.warning(
                "Revocation publisher emit failed; continuing without rollback",
                extra={
                    "event_type": event_type,
                    "principal_id": str(principal_id),
                    "root_principal_id": str(root_principal_id) if root_principal_id else None,
                    "error": str(exc),
                },
                exc_info=True,
            )

    def _resolve_leaves_first_order(self, principal_id: UUID) -> list[UUID]:
        root = self._get_principal_row(principal_id)
        if root is None:
            raise PrincipalNotFoundError(f"Principal {principal_id} not found")

        children = self._build_child_map()

        visited: set[UUID] = set()
        stack: list[tuple[UUID, int]] = [(principal_id, 0)]
        order: list[tuple[UUID, int]] = []

        while stack:
            node_id, depth = stack.pop()
            if node_id in visited:
                continue
            visited.add(node_id)
            order.append((node_id, depth))
            for child_id in children.get(node_id, []):
                stack.append((child_id, depth + 1))

        order.sort(key=lambda item: item[1], reverse=True)
        return [node_id for node_id, _ in order]

    def _resolve_breadth_first_descendants(self, principal_id: UUID) -> list[UUID]:
        root = self._get_principal_row(principal_id)
        if root is None:
            raise PrincipalNotFoundError(f"Principal {principal_id} not found")

        children = self._build_child_map()
        queue: deque[UUID] = deque(children.get(principal_id, []))
        ordered: list[UUID] = []
        while queue:
            node_id = queue.popleft()
            ordered.append(node_id)
            queue.extend(children.get(node_id, []))
        return ordered

    def _build_child_map(self) -> dict[UUID, list[UUID]]:
        rows = self.db_session.query(Principal).all()
        children: dict[UUID, list[UUID]] = {}
        for row in rows:
            if row.source_principal_id is None:
                continue
            children.setdefault(row.source_principal_id, []).append(row.principal_id)
        return children

    def _get_principal_row(self, principal_id: UUID) -> Optional[Principal]:
        return (
            self.db_session.query(Principal)
            .filter(Principal.principal_id == principal_id)
            .first()
        )

    def _list_active_mandates_for_principal(self, principal_id: UUID) -> list[ExecutionMandate]:
        return (
            self.db_session.query(ExecutionMandate)
            .filter(ExecutionMandate.revoked.is_(False))
            .filter(
                or_(
                    ExecutionMandate.subject_id == principal_id,
                    ExecutionMandate.issuer_id == principal_id,
                )
            )
            .all()
        )

    def _revoke_single_principal(
        self,
        *,
        principal_id: UUID,
        reason: str,
        actor_principal_id: Optional[str],
    ) -> _PrincipalRevocationUnit:
        principal = self._get_principal_row(principal_id)
        if principal is None:
            raise PrincipalNotFoundError(f"Principal {principal_id} not found")

        current_status = str(principal.lifecycle_status or PrincipalLifecycleStatus.ACTIVE.value)
        if current_status != PrincipalLifecycleStatus.REVOKED.value:
            self.lifecycle_state_machine.assert_transition_allowed(
                principal_kind=str(principal.principal_kind),
                from_status=current_status,
                to_status=PrincipalLifecycleStatus.REVOKED.value,
            )
            principal.lifecycle_status = PrincipalLifecycleStatus.REVOKED.value

        metadata = dict(principal.principal_metadata or {})
        metadata["lifecycle_status"] = PrincipalLifecycleStatus.REVOKED.value
        metadata["revocation_reason"] = reason
        metadata["revoked_at"] = datetime.utcnow().isoformat() + "Z"
        if actor_principal_id:
            metadata["revoked_by"] = actor_principal_id
        principal.principal_metadata = metadata

        self._record_authority_event(
            event_type="principal_revoked",
            principal_id=principal.principal_id,
            mandate_id=None,
            metadata={
                "reason": reason,
                "actor_principal_id": actor_principal_id,
                "principal_kind": principal.principal_kind,
            },
        )

        mandate_ids: list[UUID] = []
        now = datetime.utcnow()
        for mandate in self._list_active_mandates_for_principal(principal_id):
            mandate.revoked = True
            mandate.revoked_at = now
            mandate.revocation_reason = reason
            mandate_ids.append(mandate.mandate_id)
            self._record_authority_event(
                event_type="revoked",
                principal_id=principal.principal_id,
                mandate_id=mandate.mandate_id,
                metadata={
                    "reason": reason,
                    "actor_principal_id": actor_principal_id,
                    "source": "principal_revocation_orchestrator",
                },
            )

        return _PrincipalRevocationUnit(
            principal_id=principal.principal_id,
            mandate_ids=mandate_ids,
        )

    def _record_authority_event(
        self,
        *,
        event_type: str,
        principal_id: UUID,
        mandate_id: Optional[UUID],
        metadata: Optional[dict],
    ) -> None:
        self.db_session.add(
            AuthorityLedgerEvent(
                event_type=event_type,
                timestamp=datetime.utcnow(),
                principal_id=principal_id,
                mandate_id=mandate_id,
                decision="allowed",
                denial_reason=None,
                requested_action=event_type,
                requested_resource=f"principal:{principal_id}",
                correlation_id=None,
                event_metadata=metadata or {},
            )
        )
