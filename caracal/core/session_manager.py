"""Unified session issuance and validation for OSS and Enterprise.

Provides a single manager for access/refresh session tokens with explicit
session kinds and deny-list integration.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Optional, Protocol
from uuid import uuid4

import jwt


class SessionError(RuntimeError):
    """Base session manager error."""


class SessionValidationError(SessionError):
    """Raised when a token is invalid or malformed."""


class SessionRevokedError(SessionValidationError):
    """Raised when a token is present in deny-list storage."""


class SessionKind(str, Enum):
    """Supported logical session kinds."""

    INTERACTIVE = "interactive"
    AUTOMATION = "automation"
    TASK = "task"


@dataclass
class IssuedSession:
    """Issued access/refresh token bundle."""

    access_token: str
    access_expires_at: datetime
    session_id: str
    token_jti: str
    refresh_token: Optional[str] = None
    refresh_expires_at: Optional[datetime] = None
    refresh_jti: Optional[str] = None


class SessionDenylistBackend(Protocol):
    """Protocol for async deny-list stores."""

    async def add(self, token_jti: str, expires_at: datetime) -> None:
        """Record token JTI with TTL."""

    async def contains(self, token_jti: str) -> bool:
        """Return True if token JTI is deny-listed."""


class SessionAuditSink(Protocol):
    """Sink for session-level audit events (task/handoff lifecycle)."""

    def record_event(
        self,
        *,
        event_type: str,
        principal_id: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        """Persist or forward a session audit event."""


class RedisSessionDenylistBackend:
    """Redis-backed deny-list implementation."""

    def __init__(
        self,
        redis_url: str,
        key_prefix: str = "caracal:",
        token_prefix: str = "session_denylist:",
    ) -> None:
        self._redis_url = redis_url
        self._key_prefix = key_prefix
        self._token_prefix = token_prefix
        self._client = None

    def _key(self, token_jti: str) -> str:
        return f"{self._key_prefix}{self._token_prefix}{token_jti}"

    async def _get_client(self):
        if self._client is None:
            try:
                from redis import asyncio as redis
            except Exception as exc:  # pragma: no cover - dependency error
                raise SessionError("redis async client is required for deny-list backend") from exc
            self._client = redis.from_url(self._redis_url, decode_responses=True)
        return self._client

    async def add(self, token_jti: str, expires_at: datetime) -> None:
        token_jti = (token_jti or "").strip()
        if not token_jti:
            return

        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)

        ttl_seconds = int((expires_at - datetime.now(timezone.utc)).total_seconds())
        if ttl_seconds <= 0:
            return

        client = await self._get_client()
        await client.set(self._key(token_jti), "1", ex=ttl_seconds)

    async def contains(self, token_jti: str) -> bool:
        token_jti = (token_jti or "").strip()
        if not token_jti:
            return False
        client = await self._get_client()
        return bool(await client.exists(self._key(token_jti)))


class SessionManager:
    """Unified session manager for access and refresh token flows."""

    def __init__(
        self,
        *,
        signing_key: str,
        algorithm: str = "HS256",
        verify_key: Optional[str] = None,
        access_ttl: timedelta = timedelta(hours=1),
        refresh_ttl: timedelta = timedelta(days=14),
        denylist_backend: Optional[SessionDenylistBackend] = None,
        audit_sink: Optional[SessionAuditSink] = None,
        issuer: Optional[str] = None,
        audience: Optional[str] = None,
    ) -> None:
        self._signing_key = signing_key
        self._verify_key = verify_key or signing_key
        self._algorithm = algorithm
        self._access_ttl = access_ttl
        self._refresh_ttl = refresh_ttl
        self._denylist = denylist_backend
        self._audit_sink = audit_sink
        self._issuer = issuer
        self._audience = audience

    def issue_session(
        self,
        *,
        subject_id: str,
        organization_id: str,
        tenant_id: str,
        session_kind: SessionKind | str,
        workspace_id: Optional[str] = None,
        directory_scope: Optional[str] = None,
        extra_claims: Optional[dict[str, Any]] = None,
        include_refresh: bool = True,
        access_ttl: Optional[timedelta] = None,
        refresh_ttl: Optional[timedelta] = None,
    ) -> IssuedSession:
        """Issue a new session with access token and optional refresh token."""
        now = datetime.now(timezone.utc)
        if isinstance(session_kind, SessionKind):
            resolved_kind = session_kind
        else:
            resolved_kind = SessionKind(str(session_kind).strip().lower())
        session_id = uuid4().hex
        access_jti = uuid4().hex
        access_exp = now + (access_ttl or self._access_ttl)

        access_claims = self._build_claims(
            token_type="access",
            token_jti=access_jti,
            session_id=session_id,
            subject_id=subject_id,
            organization_id=organization_id,
            tenant_id=tenant_id,
            session_kind=resolved_kind,
            issued_at=now,
            expires_at=access_exp,
            workspace_id=workspace_id,
            directory_scope=directory_scope,
            extra_claims=extra_claims,
        )
        access_token = jwt.encode(access_claims, self._signing_key, algorithm=self._algorithm)

        refresh_token: Optional[str] = None
        refresh_exp: Optional[datetime] = None
        refresh_jti: Optional[str] = None

        if resolved_kind == SessionKind.TASK:
            include_refresh = False

        if include_refresh:
            refresh_jti = uuid4().hex
            refresh_exp = now + (refresh_ttl or self._refresh_ttl)
            refresh_claims = self._build_claims(
                token_type="refresh",
                token_jti=refresh_jti,
                session_id=session_id,
                subject_id=subject_id,
                organization_id=organization_id,
                tenant_id=tenant_id,
                session_kind=resolved_kind,
                issued_at=now,
                expires_at=refresh_exp,
                workspace_id=workspace_id,
                directory_scope=directory_scope,
                extra_claims=extra_claims,
            )
            refresh_token = jwt.encode(refresh_claims, self._signing_key, algorithm=self._algorithm)

        return IssuedSession(
            access_token=access_token,
            access_expires_at=access_exp,
            session_id=session_id,
            token_jti=access_jti,
            refresh_token=refresh_token,
            refresh_expires_at=refresh_exp,
            refresh_jti=refresh_jti,
        )

    def issue_task_token(
        self,
        *,
        parent_access_token: str,
        task_id: str,
        caveats: list[str],
        ttl: timedelta = timedelta(minutes=5),
    ) -> IssuedSession:
        """Issue a short-lived task token with strict caveat attenuation.

        Task tokens are non-principal artifacts and must never mint refresh
        tokens. Delegated re-issuance from task-token holders is forbidden.
        """
        parent_claims = self._decode_verified(parent_access_token)
        self._assert_token_type(parent_claims, expected="access")
        parent_kind = self._claim_session_kind(parent_claims)

        if parent_kind == SessionKind.TASK:
            raise SessionValidationError(
                "Task token holders are not allowed to issue delegated task tokens"
            )

        max_ttl = timedelta(minutes=5)
        resolved_ttl = ttl if ttl <= max_ttl else max_ttl
        if resolved_ttl <= timedelta(seconds=0):
            raise SessionValidationError("Task token TTL must be greater than zero")

        requested_caveats = self._normalize_caveats(caveats)
        parent_caveats = self._normalize_caveats(
            parent_claims.get("task_caveats") or parent_claims.get("caveats")
        )
        if parent_caveats and not set(requested_caveats).issubset(set(parent_caveats)):
            raise SessionValidationError(
                "Task token caveats must be an attenuated subset of parent caveats"
            )

        effective_caveats = requested_caveats or parent_caveats

        issued = self.issue_session(
            subject_id=str(parent_claims.get("sub")),
            organization_id=str(parent_claims.get("org")),
            tenant_id=str(parent_claims.get("tenant")),
            session_kind=SessionKind.TASK,
            workspace_id=parent_claims.get("workspace_id"),
            directory_scope=parent_claims.get("dir_scope"),
            include_refresh=False,
            access_ttl=resolved_ttl,
            extra_claims={
                "task_token": True,
                "task_id": str(task_id),
                "issued_from_kind": parent_kind.value,
                "parent_session_id": str(parent_claims.get("sid") or ""),
                "task_caveats": effective_caveats,
                "can_delegate_task_tokens": False,
            },
        )
        self._record_audit_event(
            event_type="task_token_issued",
            principal_id=str(parent_claims.get("sub")),
            metadata={
                "task_id": str(task_id),
                "issued_session_id": issued.session_id,
                "task_caveats": effective_caveats,
                "issued_from_kind": parent_kind.value,
            },
        )
        return issued

    def issue_handoff_token(
        self,
        *,
        source_access_token: str,
        target_subject_id: str,
        caveats: Optional[list[str]] = None,
        ttl: timedelta = timedelta(minutes=2),
    ) -> str:
        """Issue a one-time handoff token for immediate scope transfer."""
        source_claims = self._decode_verified(source_access_token)
        self._assert_token_type(source_claims, expected="access")

        source_caveats = self._normalize_caveats(
            source_claims.get("task_caveats") or source_claims.get("caveats")
        )
        requested_caveats = self._normalize_caveats(caveats)
        if source_caveats and requested_caveats and not set(requested_caveats).issubset(set(source_caveats)):
            raise SessionValidationError(
                "Handoff token caveats must be an attenuated subset of source caveats"
            )
        effective_caveats = requested_caveats or source_caveats

        max_ttl = timedelta(minutes=2)
        resolved_ttl = ttl if ttl <= max_ttl else max_ttl
        if resolved_ttl <= timedelta(seconds=0):
            raise SessionValidationError("Handoff token TTL must be greater than zero")

        now = datetime.now(timezone.utc)
        exp = now + resolved_ttl
        handoff_claims = self._build_claims(
            token_type="handoff",
            token_jti=uuid4().hex,
            session_id=uuid4().hex,
            subject_id=str(target_subject_id),
            organization_id=str(source_claims.get("org")),
            tenant_id=str(source_claims.get("tenant")),
            session_kind=SessionKind.TASK,
            issued_at=now,
            expires_at=exp,
            workspace_id=source_claims.get("workspace_id"),
            directory_scope=source_claims.get("dir_scope"),
            extra_claims={
                "handoff_token": True,
                "source_subject_id": str(source_claims.get("sub")),
                "source_token_jti": str(source_claims.get("jti") or ""),
                "task_caveats": effective_caveats,
                "can_delegate_task_tokens": False,
            },
        )
        token = jwt.encode(handoff_claims, self._signing_key, algorithm=self._algorithm)
        self._record_audit_event(
            event_type="handoff_token_issued",
            principal_id=str(source_claims.get("sub")),
            metadata={
                "target_subject_id": str(target_subject_id),
                "handoff_jti": str(handoff_claims.get("jti") or ""),
                "task_caveats": effective_caveats,
            },
        )
        return token

    async def consume_handoff_token(self, handoff_token: str) -> IssuedSession:
        """Consume a one-time handoff token and mint a replacement task token.

        Replay prevention is enforced by deny-listing the handoff token JTI and
        source access token JTI before returning the new task token.
        """
        claims = self._decode_verified(handoff_token)
        self._assert_token_type(claims, expected="handoff")

        if not bool(claims.get("handoff_token")):
            raise SessionValidationError("Session token is not a handoff token")

        if self._denylist is None:
            raise SessionValidationError(
                "Handoff token replay prevention requires a deny-list backend"
            )

        await self._assert_not_revoked(claims)

        exp_dt = self._claim_expiry_datetime(claims)
        handoff_jti = str(claims.get("jti") or "").strip()
        source_jti = str(claims.get("source_token_jti") or "").strip()

        if handoff_jti:
            await self._denylist.add(handoff_jti, exp_dt)
        if source_jti:
            await self._denylist.add(source_jti, exp_dt)

        remaining_ttl = exp_dt - datetime.now(timezone.utc)
        if remaining_ttl <= timedelta(seconds=0):
            raise SessionValidationError("Handoff token has expired")

        task_ttl = remaining_ttl if remaining_ttl <= timedelta(minutes=5) else timedelta(minutes=5)
        issued = self.issue_session(
            subject_id=str(claims.get("sub")),
            organization_id=str(claims.get("org")),
            tenant_id=str(claims.get("tenant")),
            session_kind=SessionKind.TASK,
            workspace_id=claims.get("workspace_id"),
            directory_scope=claims.get("dir_scope"),
            include_refresh=False,
            access_ttl=task_ttl,
            extra_claims={
                "task_token": True,
                "issued_from_kind": "handoff",
                "task_caveats": self._normalize_caveats(claims.get("task_caveats")),
                "handoff_source_subject_id": str(claims.get("source_subject_id") or ""),
                "can_delegate_task_tokens": False,
            },
        )
        self._record_audit_event(
            event_type="handoff_token_consumed",
            principal_id=str(claims.get("sub")),
            metadata={
                "source_subject_id": str(claims.get("source_subject_id") or ""),
                "source_token_jti": source_jti,
                "consumed_handoff_jti": handoff_jti,
                "issued_session_id": issued.session_id,
                "task_caveats": self._normalize_caveats(claims.get("task_caveats")),
            },
        )
        return issued

    async def validate_task_token(
        self,
        token: str,
        *,
        required_caveats: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        """Validate task token claims and required caveat subset."""
        claims = await self.validate_access_token(
            token,
            required_kinds={SessionKind.TASK},
        )

        if not bool(claims.get("task_token")):
            raise SessionValidationError("Session token is not a task token")

        if claims.get("can_delegate_task_tokens") not in {False, None}:
            raise SessionValidationError(
                "Task token unexpectedly allows delegated token minting"
            )

        required = self._normalize_caveats(required_caveats)
        token_caveats = self._normalize_caveats(claims.get("task_caveats"))
        if required and not set(required).issubset(set(token_caveats)):
            raise SessionValidationError(
                "Task token caveats do not satisfy required caveat subset"
            )

        return claims

    async def validate_access_token(
        self,
        token: str,
        *,
        required_kinds: Optional[set[SessionKind]] = None,
    ) -> dict[str, Any]:
        """Validate access token signature, claims, and deny-list state."""
        claims = self._decode_verified(token)
        self._assert_token_type(claims, expected="access")
        kind = self._claim_session_kind(claims)
        if required_kinds and kind not in required_kinds:
            raise SessionValidationError(
                f"Session kind {kind.value!r} is not allowed for this endpoint"
            )
        await self._assert_not_revoked(claims)
        return claims

    async def validate_refresh_token(self, token: str) -> dict[str, Any]:
        """Validate refresh token signature, claims, and deny-list state."""
        claims = self._decode_verified(token)
        self._assert_token_type(claims, expected="refresh")
        await self._assert_not_revoked(claims)
        return claims

    async def refresh_session(
        self,
        refresh_token: str,
        *,
        rotate_refresh_token: bool = True,
        extra_claims: Optional[dict[str, Any]] = None,
    ) -> IssuedSession:
        """Issue a new session from a valid refresh token."""
        claims = await self.validate_refresh_token(refresh_token)

        if rotate_refresh_token:
            await self.revoke_token(refresh_token)

        carry_claims: dict[str, Any] = {}
        for key, value in claims.items():
            if key in {
                "sub", "org", "tenant", "sid", "kind", "jti", "exp", "iat", "nbf", "typ",
                "workspace_id", "dir_scope", "iss", "aud",
            }:
                continue
            carry_claims[key] = value

        if extra_claims:
            carry_claims.update(extra_claims)

        return self.issue_session(
            subject_id=str(claims.get("sub")),
            organization_id=str(claims.get("org")),
            tenant_id=str(claims.get("tenant")),
            session_kind=self._claim_session_kind(claims),
            workspace_id=claims.get("workspace_id"),
            directory_scope=claims.get("dir_scope"),
            extra_claims=carry_claims,
            include_refresh=True,
        )

    async def revoke_token(self, token: str) -> None:
        """Revoke a token by storing its JTI in deny-list storage."""
        if self._denylist is None:
            return

        claims = self.decode_unverified(token)
        jti = str(claims.get("jti") or "").strip()
        if not jti:
            return

        exp_dt = self._claim_expiry_datetime(claims)
        await self._denylist.add(jti, exp_dt)

    def decode_unverified(self, token: str) -> dict[str, Any]:
        """Decode token payload without signature verification."""
        try:
            claims = jwt.decode(
                token,
                options={
                    "verify_signature": False,
                    "verify_exp": False,
                    "verify_nbf": False,
                    "verify_iat": False,
                    "verify_aud": False,
                    "verify_iss": False,
                },
                algorithms=[self._algorithm],
            )
        except Exception as exc:
            raise SessionValidationError("Token is malformed") from exc

        if not isinstance(claims, dict):
            raise SessionValidationError("Token payload is malformed")
        return claims

    def _decode_verified(self, token: str) -> dict[str, Any]:
        options = {
            "verify_signature": True,
            "verify_exp": True,
            "verify_nbf": True,
            "verify_iat": True,
            "require": ["exp", "iat", "sub", "org", "tenant", "kind", "jti", "typ", "sid"],
        }

        kwargs: dict[str, Any] = {
            "algorithms": [self._algorithm],
            "options": options,
        }
        if self._issuer:
            kwargs["issuer"] = self._issuer
        else:
            kwargs["options"]["verify_iss"] = False

        if self._audience:
            kwargs["audience"] = self._audience
        else:
            kwargs["options"]["verify_aud"] = False

        try:
            claims = jwt.decode(token, self._verify_key, **kwargs)
        except jwt.ExpiredSignatureError as exc:
            raise SessionValidationError("Session token has expired") from exc
        except jwt.InvalidTokenError as exc:
            raise SessionValidationError("Session token is invalid") from exc
        except Exception as exc:
            raise SessionValidationError("Session token validation failed") from exc

        if not isinstance(claims, dict):
            raise SessionValidationError("Session token payload is malformed")

        self._claim_session_kind(claims)
        return claims

    async def _assert_not_revoked(self, claims: dict[str, Any]) -> None:
        if self._denylist is None:
            return
        token_jti = str(claims.get("jti") or "").strip()
        if token_jti and await self._denylist.contains(token_jti):
            raise SessionRevokedError("Session token has been revoked")

    def _assert_token_type(self, claims: dict[str, Any], *, expected: str) -> None:
        token_type = str(claims.get("typ") or "").strip().lower()
        if token_type != expected:
            raise SessionValidationError(f"Expected {expected!r} token, received {token_type!r}")

    def _claim_expiry_datetime(self, claims: dict[str, Any]) -> datetime:
        exp = claims.get("exp")
        if isinstance(exp, datetime):
            if exp.tzinfo is None:
                return exp.replace(tzinfo=timezone.utc)
            return exp
        if isinstance(exp, (int, float)):
            return datetime.fromtimestamp(exp, tz=timezone.utc)
        return datetime.now(timezone.utc)

    def _claim_session_kind(self, claims: dict[str, Any]) -> SessionKind:
        raw_kind = str(claims.get("kind") or "").strip().lower()
        try:
            return SessionKind(raw_kind)
        except Exception as exc:
            raise SessionValidationError("Session token has invalid session kind") from exc

    def _normalize_caveats(self, caveats: Any) -> list[str]:
        if caveats is None:
            return []
        if isinstance(caveats, str):
            normalized = caveats.strip()
            return [normalized] if normalized else []

        result: list[str] = []
        if isinstance(caveats, (list, tuple, set)):
            for item in caveats:
                value = str(item).strip()
                if value and value not in result:
                    result.append(value)
            return result

        value = str(caveats).strip()
        return [value] if value else []

    def _record_audit_event(
        self,
        *,
        event_type: str,
        principal_id: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        if self._audit_sink is None:
            return
        self._audit_sink.record_event(
            event_type=event_type,
            principal_id=principal_id,
            metadata=metadata or {},
        )

    def _build_claims(
        self,
        *,
        token_type: str,
        token_jti: str,
        session_id: str,
        subject_id: str,
        organization_id: str,
        tenant_id: str,
        session_kind: SessionKind,
        issued_at: datetime,
        expires_at: datetime,
        workspace_id: Optional[str],
        directory_scope: Optional[str],
        extra_claims: Optional[dict[str, Any]],
    ) -> dict[str, Any]:
        claims: dict[str, Any] = {
            "sub": str(subject_id),
            "org": str(organization_id),
            "tenant": str(tenant_id),
            "kind": session_kind.value,
            "sid": session_id,
            "jti": token_jti,
            "typ": token_type,
            "iat": issued_at,
            "nbf": issued_at,
            "exp": expires_at,
        }

        if workspace_id:
            claims["workspace_id"] = str(workspace_id)
        if directory_scope:
            claims["dir_scope"] = str(directory_scope)
        if self._issuer:
            claims["iss"] = self._issuer
        if self._audience:
            claims["aud"] = self._audience

        if extra_claims:
            for key, value in extra_claims.items():
                if key in {"sub", "org", "tenant", "kind", "sid", "jti", "typ", "iat", "nbf", "exp", "iss", "aud"}:
                    continue
                claims[key] = value

        return claims
