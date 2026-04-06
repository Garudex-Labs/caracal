"""Redis-backed principal TTL tracking and expiry reconciliation."""

from __future__ import annotations

import asyncio
import inspect
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Iterable, Optional, Protocol
from uuid import UUID

from caracal.core.lifecycle import PrincipalLifecycleStateMachine
from caracal.core.revocation import PrincipalRevocationOrchestrator
from caracal.db.models import (
    AuthorityLedgerEvent,
    ExecutionMandate,
    Principal,
    PrincipalAttestationStatus,
    PrincipalLifecycleStatus,
)
from caracal.exceptions import PrincipalNotFoundError
from caracal.logging_config import get_logger
from caracal.redis.client import RedisClient

logger = get_logger(__name__)


class PrincipalTTLValidationError(RuntimeError):
    """Raised when principal TTL inputs or lease metadata are invalid."""


class PrincipalTTLLeaseExpiredError(PrincipalTTLValidationError):
    """Raised when a principal lease has already elapsed."""


class _DbSessionManager(Protocol):
    def session_scope(self): ...


@dataclass(frozen=True)
class PrincipalTTLLease:
    """TTL lease metadata for a principal lifecycle entry."""

    principal_id: str
    lease_kind: str
    ttl_seconds: int
    active_ttl_seconds: int
    expires_at: datetime
    lease_token: str
    parent_principal_id: Optional[str] = None


@dataclass(frozen=True)
class ChildTTLDecision:
    """Decision returned when a child principal TTL is capped."""

    requested_ttl_seconds: int
    effective_ttl_seconds: int
    parent_remaining_ttl_seconds: Optional[int]

    @property
    def truncated(self) -> bool:
        return self.effective_ttl_seconds != self.requested_ttl_seconds


@dataclass(frozen=True)
class PrincipalTTLExpiryWorkItem:
    """Work item emitted by expiry listeners or startup reconciliation."""

    principal_id: str
    lease_kind: str
    lease_token: str
    active_ttl_seconds: int
    expired_at: datetime
    parent_principal_id: Optional[str] = None


class PrincipalTTLManager:
    """Owns Redis TTL leases for spawned principals."""

    _TTL_PREFIX = "caracal:identity:principal_ttl"
    _META_PREFIX = "caracal:identity:principal_ttl_meta"
    _HANDLED_PREFIX = "caracal:identity:principal_ttl_handled"
    _INDEX_KEY = "caracal:identity:principal_ttl_index"
    _LEASE_KIND_PENDING = "pending_attestation"
    _LEASE_KIND_ACTIVE = "active"
    _KEYSPACE_PATTERN = "__keyevent@*__:expired"

    def __init__(self, redis_client: RedisClient) -> None:
        self._redis = redis_client

    def lease_key(self, principal_id: str) -> str:
        normalized = self._normalize_principal_id(principal_id)
        return f"{self._TTL_PREFIX}:{normalized}"

    def metadata_key(self, principal_id: str) -> str:
        normalized = self._normalize_principal_id(principal_id)
        return f"{self._META_PREFIX}:{normalized}"

    def _handled_key(self, principal_id: str, lease_token: str) -> str:
        normalized = self._normalize_principal_id(principal_id)
        normalized_token = str(lease_token or "").strip()
        if not normalized_token:
            raise PrincipalTTLValidationError("lease_token cannot be empty")
        return f"{self._HANDLED_PREFIX}:{normalized}:{normalized_token}"

    @staticmethod
    def _normalize_principal_id(principal_id: str) -> str:
        normalized = str(principal_id or "").strip()
        if not normalized:
            raise PrincipalTTLValidationError("principal_id cannot be empty")
        return normalized

    @staticmethod
    def _normalize_ttl(ttl_seconds: int) -> int:
        resolved = int(ttl_seconds)
        if resolved <= 0:
            raise PrincipalTTLValidationError("ttl_seconds must be greater than zero")
        return resolved

    @staticmethod
    def _utcnow() -> datetime:
        return datetime.now(timezone.utc)

    def remaining_ttl_seconds(self, principal_id: str) -> Optional[int]:
        ttl_seconds = int(self._redis.ttl(self.lease_key(principal_id)))
        if ttl_seconds < 0:
            return None
        return ttl_seconds

    def constrain_child_ttl(
        self,
        *,
        requested_ttl_seconds: int,
        parent_principal_id: Optional[str],
    ) -> ChildTTLDecision:
        requested = self._normalize_ttl(requested_ttl_seconds)
        normalized_parent = str(parent_principal_id or "").strip() or None
        if normalized_parent is None:
            return ChildTTLDecision(
                requested_ttl_seconds=requested,
                effective_ttl_seconds=requested,
                parent_remaining_ttl_seconds=None,
            )

        parent_remaining = self.remaining_ttl_seconds(normalized_parent)
        if parent_remaining is None:
            return ChildTTLDecision(
                requested_ttl_seconds=requested,
                effective_ttl_seconds=requested,
                parent_remaining_ttl_seconds=None,
            )

        effective = requested if requested <= parent_remaining else parent_remaining
        if effective <= 0:
            raise PrincipalTTLLeaseExpiredError(
                f"parent principal '{normalized_parent}' has no remaining TTL"
            )

        return ChildTTLDecision(
            requested_ttl_seconds=requested,
            effective_ttl_seconds=effective,
            parent_remaining_ttl_seconds=parent_remaining,
        )

    def register_pending_principal(
        self,
        *,
        principal_id: str,
        pending_ttl_seconds: int,
        active_ttl_seconds: int,
        parent_principal_id: Optional[str] = None,
        now: Optional[datetime] = None,
    ) -> PrincipalTTLLease:
        normalized_principal = self._normalize_principal_id(principal_id)
        pending_ttl = self._normalize_ttl(pending_ttl_seconds)
        active_ttl = self._normalize_ttl(active_ttl_seconds)
        issued_at = now or self._utcnow()
        lease_expires_at = issued_at + timedelta(seconds=pending_ttl)
        lease_token = self._lease_token(self._LEASE_KIND_PENDING, lease_expires_at)

        self._redis.set(
            self.lease_key(normalized_principal),
            self._LEASE_KIND_PENDING,
            ex=pending_ttl,
        )
        metadata = {
            "principal_id": normalized_principal,
            "lease_kind": self._LEASE_KIND_PENDING,
            "active_ttl_seconds": str(active_ttl),
            "pending_ttl_seconds": str(pending_ttl),
            "issued_at": issued_at.isoformat(),
            "expires_at": lease_expires_at.isoformat(),
            "lease_token": lease_token,
            "parent_principal_id": str(parent_principal_id or "").strip(),
        }
        self._write_metadata(normalized_principal, metadata)
        self._redis.zadd(self._INDEX_KEY, {normalized_principal: lease_expires_at.timestamp()})

        return PrincipalTTLLease(
            principal_id=normalized_principal,
            lease_kind=self._LEASE_KIND_PENDING,
            ttl_seconds=pending_ttl,
            active_ttl_seconds=active_ttl,
            expires_at=lease_expires_at,
            lease_token=lease_token,
            parent_principal_id=metadata["parent_principal_id"] or None,
        )

    def activate_principal(
        self,
        principal_id: str,
        *,
        now: Optional[datetime] = None,
    ) -> PrincipalTTLLease:
        normalized_principal = self._normalize_principal_id(principal_id)
        metadata = self._read_metadata(normalized_principal)
        if metadata is None:
            raise PrincipalTTLValidationError(
                f"principal TTL lease metadata is missing for {normalized_principal}"
            )

        issued_at = self._parse_timestamp(metadata.get("issued_at"))
        active_ttl_seconds = self._normalize_ttl(int(metadata.get("active_ttl_seconds", "0")))
        activated_at = now or self._utcnow()
        elapsed_seconds = int(max((activated_at - issued_at).total_seconds(), 0))
        remaining_ttl = active_ttl_seconds - elapsed_seconds
        if remaining_ttl <= 0:
            raise PrincipalTTLLeaseExpiredError(
                f"principal TTL already elapsed for {normalized_principal}"
            )

        expires_at = activated_at + timedelta(seconds=remaining_ttl)
        lease_token = self._lease_token(self._LEASE_KIND_ACTIVE, expires_at)

        self._redis.set(
            self.lease_key(normalized_principal),
            self._LEASE_KIND_ACTIVE,
            ex=remaining_ttl,
        )
        metadata.update(
            {
                "lease_kind": self._LEASE_KIND_ACTIVE,
                "activated_at": activated_at.isoformat(),
                "expires_at": expires_at.isoformat(),
                "lease_token": lease_token,
            }
        )
        self._write_metadata(normalized_principal, metadata)
        self._redis.zadd(self._INDEX_KEY, {normalized_principal: expires_at.timestamp()})

        return PrincipalTTLLease(
            principal_id=normalized_principal,
            lease_kind=self._LEASE_KIND_ACTIVE,
            ttl_seconds=remaining_ttl,
            active_ttl_seconds=active_ttl_seconds,
            expires_at=expires_at,
            lease_token=lease_token,
            parent_principal_id=metadata.get("parent_principal_id") or None,
        )

    def clear_principal(self, principal_id: str) -> None:
        """Best-effort cleanup for leases created during failed spawn orchestration."""
        normalized_principal = self._normalize_principal_id(principal_id)
        self._redis.delete(self.lease_key(normalized_principal))
        self._redis.delete(self.metadata_key(normalized_principal))
        self._redis.zrem(self._INDEX_KEY, normalized_principal)

    def build_expiry_work_item(self, principal_id: str) -> Optional[PrincipalTTLExpiryWorkItem]:
        normalized_principal = self._normalize_principal_id(principal_id)
        metadata = self._read_metadata(normalized_principal)
        if metadata is None:
            return None

        lease_kind = str(metadata.get("lease_kind") or "").strip()
        lease_token = str(metadata.get("lease_token") or "").strip()
        if lease_kind not in {self._LEASE_KIND_PENDING, self._LEASE_KIND_ACTIVE} or not lease_token:
            return None

        expired_at = self._parse_timestamp(metadata.get("expires_at"))
        active_ttl_seconds = self._normalize_ttl(int(metadata.get("active_ttl_seconds", "0")))
        return PrincipalTTLExpiryWorkItem(
            principal_id=normalized_principal,
            lease_kind=lease_kind,
            lease_token=lease_token,
            active_ttl_seconds=active_ttl_seconds,
            expired_at=expired_at,
            parent_principal_id=str(metadata.get("parent_principal_id") or "").strip() or None,
        )

    def claim_expired_work_item(self, principal_id: str) -> Optional[PrincipalTTLExpiryWorkItem]:
        work_item = self.build_expiry_work_item(principal_id)
        if work_item is None:
            return None

        claimed = self._redis.set(
            self._handled_key(work_item.principal_id, work_item.lease_token),
            "1",
            ex=86400,
            nx=True,
        )
        if not claimed:
            return None
        return work_item

    def ack_expired_work_item(self, work_item: PrincipalTTLExpiryWorkItem) -> None:
        self._redis.zremrangebyscore(
            self._INDEX_KEY,
            work_item.expired_at.timestamp(),
            work_item.expired_at.timestamp(),
        )
        self._redis.delete(self.metadata_key(work_item.principal_id))

    def reconcile_expired_principals(
        self,
        *,
        now: Optional[datetime] = None,
    ) -> list[PrincipalTTLExpiryWorkItem]:
        cutoff = (now or self._utcnow()).timestamp()
        expired_principal_ids = self._redis.zrangebyscore(self._INDEX_KEY, float("-inf"), cutoff)
        items: list[PrincipalTTLExpiryWorkItem] = []
        for principal_id in expired_principal_ids:
            if self.remaining_ttl_seconds(principal_id) is not None:
                continue
            claimed = self.claim_expired_work_item(principal_id)
            if claimed is not None:
                items.append(claimed)
        return items

    def iter_expiry_messages(self, *, poll_timeout_seconds: float = 1.0) -> Iterable[dict]:
        client = getattr(self._redis, "_client", None)
        if client is None or not hasattr(client, "pubsub"):
            raise PrincipalTTLValidationError("Redis client does not expose pubsub support")

        pubsub = client.pubsub(ignore_subscribe_messages=True)
        pubsub.psubscribe(self._KEYSPACE_PATTERN)
        while True:
            message = pubsub.get_message(timeout=poll_timeout_seconds)
            if message is None:
                continue
            yield message

    def claim_expiry_message(self, message: dict) -> Optional[PrincipalTTLExpiryWorkItem]:
        payload = str(message.get("data") or "").strip()
        if not payload.startswith(f"{self._TTL_PREFIX}:"):
            return None
        principal_id = payload.rsplit(":", 1)[-1]
        return self.claim_expired_work_item(principal_id)

    def _write_metadata(self, principal_id: str, values: dict[str, str]) -> None:
        metadata_key = self.metadata_key(principal_id)
        self._redis.delete(metadata_key)
        for key, value in values.items():
            self._redis.hset(metadata_key, key, value)

    def _read_metadata(self, principal_id: str) -> Optional[dict[str, str]]:
        values = self._redis.hgetall(self.metadata_key(principal_id))
        return values or None

    @staticmethod
    def _parse_timestamp(raw_value: Optional[str]) -> datetime:
        normalized = str(raw_value or "").strip()
        if not normalized:
            raise PrincipalTTLValidationError("lease timestamp metadata is missing")
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    @staticmethod
    def _lease_token(lease_kind: str, expires_at: datetime) -> str:
        return f"{lease_kind}:{int(expires_at.timestamp())}"


class PrincipalTTLExpiryProcessor:
    """Processes claimed TTL expiries into lifecycle and revocation changes."""

    def __init__(
        self,
        *,
        db_manager: _DbSessionManager,
        lifecycle_state_machine: Optional[PrincipalLifecycleStateMachine] = None,
        revocation_orchestrator_factory: Optional[Callable[[object], PrincipalRevocationOrchestrator]] = None,
    ) -> None:
        self._db_manager = db_manager
        self._lifecycle_state_machine = lifecycle_state_machine or PrincipalLifecycleStateMachine()
        self._revocation_orchestrator_factory = revocation_orchestrator_factory

    def process(self, work_item: PrincipalTTLExpiryWorkItem) -> str:
        if work_item.lease_kind == PrincipalTTLManager._LEASE_KIND_PENDING:
            return self._expire_pending_attestation(work_item)
        return self._revoke_expired_principal(work_item)

    def _expire_pending_attestation(self, work_item: PrincipalTTLExpiryWorkItem) -> str:
        normalized_principal = work_item.principal_id
        with self._db_manager.session_scope() as session:
            principal = (
                session.query(Principal)
                .filter(Principal.principal_id == UUID(normalized_principal))
                .first()
            )
            if principal is None:
                raise PrincipalNotFoundError(f"Principal {normalized_principal} not found")

            if principal.lifecycle_status != PrincipalLifecycleStatus.PENDING_ATTESTATION.value:
                return "noop"

            self._lifecycle_state_machine.assert_transition_allowed(
                principal_kind=str(principal.principal_kind),
                from_status=str(principal.lifecycle_status),
                to_status=PrincipalLifecycleStatus.EXPIRED.value,
                attestation_status=str(principal.attestation_status),
            )
            principal.lifecycle_status = PrincipalLifecycleStatus.EXPIRED.value
            principal.attestation_status = PrincipalAttestationStatus.FAILED.value

            metadata = dict(principal.principal_metadata or {})
            metadata["lifecycle_status"] = PrincipalLifecycleStatus.EXPIRED.value
            metadata["attestation_status"] = PrincipalAttestationStatus.FAILED.value
            metadata["attestation_timeout_expired_at"] = work_item.expired_at.isoformat()
            metadata["principal_ttl_lease_kind"] = work_item.lease_kind
            principal.principal_metadata = metadata

            now = datetime.utcnow()
            for mandate in self._list_active_mandates(session, UUID(normalized_principal)):
                mandate.revoked = True
                mandate.revoked_at = now
                mandate.revocation_reason = "attestation_nonce_timeout"

            session.add(
                AuthorityLedgerEvent(
                    event_type="principal_expired",
                    timestamp=now,
                    principal_id=UUID(normalized_principal),
                    mandate_id=None,
                    decision="allowed",
                    denial_reason=None,
                    requested_action="principal_expired",
                    requested_resource=f"principal:{normalized_principal}",
                    correlation_id=None,
                    event_metadata={
                        "lease_kind": work_item.lease_kind,
                        "expired_at": work_item.expired_at.isoformat(),
                        "reason": "attestation_nonce_timeout",
                    },
                )
            )
            session.flush()
        return "expired"

    def _revoke_expired_principal(self, work_item: PrincipalTTLExpiryWorkItem) -> str:
        with self._db_manager.session_scope() as session:
            orchestrator = (
                self._revocation_orchestrator_factory(session)
                if self._revocation_orchestrator_factory is not None
                else PrincipalRevocationOrchestrator(db_session=session)
            )
            result = orchestrator.revoke_principal(
                principal_id=work_item.principal_id,
                reason="principal_ttl_expired",
                actor_principal_id=work_item.principal_id,
            )
            if inspect.isawaitable(result):
                asyncio.run(result)
        return "revoked"

    @staticmethod
    def _list_active_mandates(session, principal_id: UUID) -> list[ExecutionMandate]:
        return (
            session.query(ExecutionMandate)
            .filter(ExecutionMandate.revoked.is_(False))
            .filter(ExecutionMandate.subject_id == principal_id)
            .all()
        )


def serialize_ttl_decision(decision: ChildTTLDecision) -> str:
    """Stable JSON payload for structured logs and audit metadata."""
    return json.dumps(
        {
            "requested_ttl_seconds": decision.requested_ttl_seconds,
            "effective_ttl_seconds": decision.effective_ttl_seconds,
            "parent_remaining_ttl_seconds": decision.parent_remaining_ttl_seconds,
            "truncated": decision.truncated,
        },
        sort_keys=True,
    )
