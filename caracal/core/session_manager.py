"""Unified session issuance and validation for OSS and Enterprise.

Provides a single manager for access/refresh session tokens with explicit
session kinds and deny-list integration.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from contextlib import AbstractContextManager
from typing import Any, Callable, Optional, Protocol
from uuid import uuid4

import jwt
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import serialization

from caracal.core.caveat_chain import (
    CaveatChainError,
    build_caveat_chain,
    caveat_strings_from_chain,
    evaluate_caveat_chain,
    verify_caveat_chain,
)


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


class SessionDbManager(Protocol):
    """Protocol for DB transaction scope providers used by session flows."""

    def session_scope(self) -> AbstractContextManager[Any]:
        """Return a transactional context manager yielding a DB session."""


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
        algorithm: str = "RS256",
        verify_key: Optional[str] = None,
        verify_key_provider: Optional[Callable[[], str]] = None,
        verify_key_cache_ttl: timedelta = timedelta(minutes=5),
        access_ttl: timedelta = timedelta(hours=1),
        refresh_ttl: timedelta = timedelta(days=14),
        denylist_backend: Optional[SessionDenylistBackend] = None,
        audit_sink: Optional[SessionAuditSink] = None,
        db_session_manager: Optional[SessionDbManager] = None,
        caveat_mode: str = "jwt",
        caveat_chain_hmac_key: Optional[str] = None,
        issuer: Optional[str] = None,
        audience: Optional[str] = None,
    ) -> None:
        resolved_algorithm = str(algorithm or "").strip().upper()
        if resolved_algorithm.startswith("HS"):
            raise SessionError("Symmetric session signing algorithms are not supported")
        if resolved_algorithm not in {"RS256", "ES256"}:
            raise SessionError(
                "Unsupported session signing algorithm. Use RS256 or ES256."
            )
        resolved_caveat_mode = self._resolve_caveat_mode(caveat_mode)
        resolved_caveat_hmac_key = str(caveat_chain_hmac_key or signing_key or "").strip()
        if resolved_caveat_mode == "caveat_chain" and not resolved_caveat_hmac_key:
            raise SessionError("Caveat-chain mode requires a non-empty HMAC key")
        if verify_key_provider is not None and verify_key_cache_ttl <= timedelta(seconds=0):
            raise SessionError("verify_key_cache_ttl must be greater than zero")

        self._signing_key = signing_key
        self._algorithm = resolved_algorithm
        self._verify_key = verify_key or self._derive_verify_key(signing_key)
        self._verify_key_provider = verify_key_provider
        self._verify_key_cache_ttl = verify_key_cache_ttl
        self._verify_key_cache: Optional[str] = verify_key
        self._verify_key_cache_expires_at: Optional[datetime] = None
        if self._verify_key_provider is not None and self._verify_key_cache is not None:
            self._verify_key_cache_expires_at = datetime.now(timezone.utc) + self._verify_key_cache_ttl
        self._access_ttl = access_ttl
        self._refresh_ttl = refresh_ttl
        self._denylist = denylist_backend
        self._audit_sink = audit_sink
        self._db_session_manager = db_session_manager
        self._caveat_mode = resolved_caveat_mode
        self._caveat_chain_hmac_key = resolved_caveat_hmac_key
        self._issuer = issuer
        self._audience = audience

    def refresh_verify_key_cache(self) -> None:
        """Force-refresh verify key cache from provider when configured."""
        if self._verify_key_provider is None:
            return

        self._verify_key_cache = None
        self._verify_key_cache_expires_at = None
        self._resolve_verify_key_for_validation()

    def _resolve_verify_key_for_validation(self) -> str:
        if self._verify_key_provider is None:
            return self._verify_key

        now = datetime.now(timezone.utc)
        if (
            self._verify_key_cache
            and self._verify_key_cache_expires_at
            and now < self._verify_key_cache_expires_at
        ):
            return self._verify_key_cache

        try:
            refreshed = self._verify_key_provider()
        except Exception as exc:
            raise SessionValidationError("Session verify key refresh failed") from exc

        refreshed_key = str(refreshed or "").strip()
        if not refreshed_key:
            raise SessionValidationError(
                "Session verify key refresh returned an empty key"
            )

        self._verify_key_cache = refreshed_key
        self._verify_key_cache_expires_at = now + self._verify_key_cache_ttl
        return refreshed_key

    @staticmethod
    def _derive_verify_key(signing_key: str) -> str:
        """Derive public verify key from an asymmetric PEM private key."""
        try:
            private_key = serialization.load_pem_private_key(
                signing_key.encode() if isinstance(signing_key, str) else signing_key,
                password=None,
                backend=default_backend(),
            )
            public_key = private_key.public_key()
            public_pem = public_key.public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            return public_pem.decode("utf-8")
        except Exception as exc:
            raise SessionError(
                "verify_key is required for asymmetric session signing when it cannot be "
                f"derived from signing_key: {exc}"
            ) from exc

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
        parent_caveats = self._task_caveats_from_claims(parent_claims)
        if parent_caveats and not set(requested_caveats).issubset(set(parent_caveats)):
            raise SessionValidationError(
                "Task token caveats must be an attenuated subset of parent caveats"
            )

        effective_caveats = requested_caveats or parent_caveats
        issued_caveats = effective_caveats
        task_extra_claims: dict[str, Any] = {
            "task_token": True,
            "task_id": str(task_id),
            "issued_from_kind": parent_kind.value,
            "parent_session_id": str(parent_claims.get("sid") or ""),
            "can_delegate_task_tokens": False,
        }

        if self._caveat_mode == "caveat_chain":
            task_caveat_chain = self._build_caveat_chain_for_issue(effective_caveats)
            task_extra_claims["task_caveat_chain"] = task_caveat_chain
            issued_caveats = caveat_strings_from_chain(task_caveat_chain)
        task_extra_claims["task_caveats"] = issued_caveats

        issued = self.issue_session(
            subject_id=str(parent_claims.get("sub")),
            organization_id=str(parent_claims.get("org")),
            tenant_id=str(parent_claims.get("tenant")),
            session_kind=SessionKind.TASK,
            workspace_id=parent_claims.get("workspace_id"),
            directory_scope=parent_claims.get("dir_scope"),
            include_refresh=False,
            access_ttl=resolved_ttl,
            extra_claims=task_extra_claims,
        )
        self._record_audit_event(
            event_type="task_token_issued",
            principal_id=str(parent_claims.get("sub")),
            metadata={
                "task_id": str(task_id),
                "issued_session_id": issued.session_id,
                "task_caveats": issued_caveats,
                "issued_from_kind": parent_kind.value,
            },
        )
        return issued

    async def issue_handoff_token(
        self,
        *,
        source_access_token: str,
        target_subject_id: str,
        caveats: Optional[list[str]] = None,
        ttl: timedelta = timedelta(minutes=2),
    ) -> str:
        """Issue a one-time handoff token and narrow issuer scope immediately."""
        if self._denylist is None:
            raise SessionValidationError(
                "Handoff token issuance requires a deny-list backend"
            )

        source_claims = self._decode_verified(source_access_token)
        self._assert_token_type(source_claims, expected="access")
        await self._assert_not_revoked(source_claims)

        source_caveats = self._task_caveats_from_claims(source_claims)
        requested_caveats = self._normalize_caveats(caveats)
        if source_caveats and requested_caveats and not set(requested_caveats).issubset(set(source_caveats)):
            raise SessionValidationError(
                "Handoff token caveats must be an attenuated subset of source caveats"
            )
        effective_caveats = requested_caveats or source_caveats
        issued_caveats = effective_caveats

        max_ttl = timedelta(minutes=2)
        resolved_ttl = ttl if ttl <= max_ttl else max_ttl
        if resolved_ttl <= timedelta(seconds=0):
            raise SessionValidationError("Handoff token TTL must be greater than zero")

        source_token_jti = str(source_claims.get("jti") or "").strip()
        if not source_token_jti:
            raise SessionValidationError("Source access token is missing required jti claim")

        source_exp_dt = self._claim_expiry_datetime(source_claims)
        if source_exp_dt <= datetime.now(timezone.utc):
            raise SessionValidationError("Source access token has expired")

        source_remaining_caveats = [
            caveat for caveat in source_caveats if caveat not in set(effective_caveats)
        ]

        now = datetime.now(timezone.utc)
        exp = now + resolved_ttl
        handoff_jti = uuid4().hex
        handoff_extra_claims: dict[str, Any] = {
            "handoff_token": True,
            "source_subject_id": str(source_claims.get("sub")),
            "source_token_jti": source_token_jti,
            "can_delegate_task_tokens": False,
        }

        if self._caveat_mode == "caveat_chain":
            task_caveat_chain = self._build_caveat_chain_for_issue(effective_caveats)
            handoff_extra_claims["task_caveat_chain"] = task_caveat_chain
            issued_caveats = caveat_strings_from_chain(task_caveat_chain)
        handoff_extra_claims["task_caveats"] = issued_caveats

        handoff_claims = self._build_claims(
            token_type="handoff",
            token_jti=handoff_jti,
            session_id=uuid4().hex,
            subject_id=str(target_subject_id),
            organization_id=str(source_claims.get("org")),
            tenant_id=str(source_claims.get("tenant")),
            session_kind=SessionKind.TASK,
            issued_at=now,
            expires_at=exp,
            workspace_id=source_claims.get("workspace_id"),
            directory_scope=source_claims.get("dir_scope"),
            extra_claims=handoff_extra_claims,
        )
        token = jwt.encode(handoff_claims, self._signing_key, algorithm=self._algorithm)

        # Persist issuance + source scope narrowing in a single DB transaction.
        self._record_handoff_transfer(
            handoff_jti=handoff_jti,
            source_token_jti=source_token_jti,
            source_subject_id=str(source_claims.get("sub") or ""),
            target_subject_id=str(target_subject_id),
            organization_id=str(source_claims.get("org") or ""),
            tenant_id=str(source_claims.get("tenant") or ""),
            transferred_caveats=issued_caveats,
            source_remaining_caveats=source_remaining_caveats,
            issued_at=now,
        )

        # Enforce immediate source-scope loss at handoff issuance time.
        await self._denylist.add(source_token_jti, source_exp_dt)

        self._record_audit_event(
            event_type="handoff_token_issued",
            principal_id=str(source_claims.get("sub")),
            metadata={
                "target_subject_id": str(target_subject_id),
                "handoff_jti": handoff_jti,
                "source_token_jti": source_token_jti,
                "task_caveats": issued_caveats,
                "source_remaining_caveats": source_remaining_caveats,
            },
        )
        return token

    async def consume_handoff_token(self, handoff_token: str) -> IssuedSession:
        """Consume a one-time handoff token and mint a replacement task token.

        Replay prevention is enforced by deny-listing the handoff token JTI
        before returning the new task token.
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
            self._consume_handoff_transfer(handoff_jti=handoff_jti)

        if handoff_jti:
            await self._denylist.add(handoff_jti, exp_dt)

        remaining_ttl = exp_dt - datetime.now(timezone.utc)
        if remaining_ttl <= timedelta(seconds=0):
            raise SessionValidationError("Handoff token has expired")

        task_ttl = remaining_ttl if remaining_ttl <= timedelta(minutes=5) else timedelta(minutes=5)
        handoff_caveat_chain = self._verified_task_caveat_chain_from_claims(claims)
        handoff_task_caveats = (
            caveat_strings_from_chain(handoff_caveat_chain)
            if handoff_caveat_chain
            else self._normalize_caveats(claims.get("task_caveats"))
        )

        task_extra_claims: dict[str, Any] = {
            "task_token": True,
            "issued_from_kind": "handoff",
            "task_caveats": handoff_task_caveats,
            "handoff_source_subject_id": str(claims.get("source_subject_id") or ""),
            "can_delegate_task_tokens": False,
        }
        if self._caveat_mode == "caveat_chain":
            if not handoff_caveat_chain:
                handoff_caveat_chain = self._build_caveat_chain_for_issue(handoff_task_caveats)
            task_extra_claims["task_caveat_chain"] = handoff_caveat_chain

        issued = self.issue_session(
            subject_id=str(claims.get("sub")),
            organization_id=str(claims.get("org")),
            tenant_id=str(claims.get("tenant")),
            session_kind=SessionKind.TASK,
            workspace_id=claims.get("workspace_id"),
            directory_scope=claims.get("dir_scope"),
            include_refresh=False,
            access_ttl=task_ttl,
            extra_claims=task_extra_claims,
        )
        self._record_audit_event(
            event_type="handoff_token_consumed",
            principal_id=str(claims.get("sub")),
            metadata={
                "source_subject_id": str(claims.get("source_subject_id") or ""),
                "source_token_jti": source_jti,
                "consumed_handoff_jti": handoff_jti,
                "issued_session_id": issued.session_id,
                "task_caveats": handoff_task_caveats,
            },
        )
        return issued

    async def validate_task_token(
        self,
        token: str,
        *,
        required_caveats: Optional[list[str]] = None,
        required_action: Optional[str] = None,
        required_resource: Optional[str] = None,
        required_task_id: Optional[str] = None,
        current_time: Optional[datetime] = None,
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
        token_caveats = self._task_caveats_from_claims(
            claims,
            requested_action=required_action,
            requested_resource=required_resource,
            task_id=required_task_id,
            current_time=current_time,
        )
        if required and not set(required).issubset(set(token_caveats)):
            raise SessionValidationError(
                "Task token caveats do not satisfy required caveat subset"
            )

        claims["task_caveats"] = token_caveats

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
            verify_key = self._resolve_verify_key_for_validation()
            claims = jwt.decode(token, verify_key, **kwargs)
        except SessionValidationError:
            raise
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
        token_jti = str(claims.get("jti") or "").strip()

        if token_jti and self._is_token_revoked_by_handoff_store(token_jti):
            raise SessionRevokedError("Session token has been revoked")

        if self._denylist is None:
            return
        if token_jti and await self._denylist.contains(token_jti):
            raise SessionRevokedError("Session token has been revoked")

    def _is_token_revoked_by_handoff_store(self, token_jti: str) -> bool:
        token_jti = str(token_jti or "").strip()
        if not token_jti or self._db_session_manager is None:
            return False

        from caracal.db.models import SessionHandoffTransfer

        with self._db_session_manager.session_scope() as session:
            source_revoked = (
                session.query(SessionHandoffTransfer)
                .filter(SessionHandoffTransfer.source_token_jti == token_jti)
                .filter(SessionHandoffTransfer.source_token_revoked_at.isnot(None))
                .first()
            )
            if source_revoked is not None:
                return True

            consumed_handoff = (
                session.query(SessionHandoffTransfer)
                .filter(SessionHandoffTransfer.handoff_jti == token_jti)
                .filter(SessionHandoffTransfer.consumed_at.isnot(None))
                .first()
            )
            return consumed_handoff is not None

    def _record_handoff_transfer(
        self,
        *,
        handoff_jti: str,
        source_token_jti: str,
        source_subject_id: str,
        target_subject_id: str,
        organization_id: str,
        tenant_id: str,
        transferred_caveats: list[str],
        source_remaining_caveats: list[str],
        issued_at: datetime,
    ) -> None:
        if self._db_session_manager is None:
            return

        from caracal.db.models import SessionHandoffTransfer

        with self._db_session_manager.session_scope() as session:
            session.add(
                SessionHandoffTransfer(
                    handoff_jti=handoff_jti,
                    source_token_jti=source_token_jti,
                    source_subject_id=source_subject_id,
                    target_subject_id=target_subject_id,
                    organization_id=organization_id,
                    tenant_id=tenant_id,
                    transferred_caveats=transferred_caveats,
                    source_remaining_caveats=source_remaining_caveats,
                    issued_at=issued_at,
                    source_token_revoked_at=issued_at,
                )
            )
            session.flush()

    def _consume_handoff_transfer(self, *, handoff_jti: str) -> None:
        if self._db_session_manager is None:
            return

        from caracal.db.models import SessionHandoffTransfer

        with self._db_session_manager.session_scope() as session:
            transfer = (
                session.query(SessionHandoffTransfer)
                .filter(SessionHandoffTransfer.handoff_jti == handoff_jti)
                .first()
            )
            if transfer is None:
                raise SessionValidationError("Handoff token transfer record is missing")
            if transfer.consumed_at is not None:
                raise SessionRevokedError("Session token has been revoked")

            transfer.consumed_at = datetime.utcnow()
            session.flush()

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

    @staticmethod
    def _resolve_caveat_mode(mode: str) -> str:
        normalized = str(mode or "jwt").strip().lower()
        if normalized in {"jwt", "caveat_chain"}:
            return normalized
        raise SessionError("Unsupported caveat mode. Use 'jwt' or 'caveat_chain'.")

    def _build_caveat_chain_for_issue(self, caveats: list[str]) -> list[dict[str, Any]]:
        if not caveats:
            return []
        try:
            return build_caveat_chain(
                hmac_key=self._caveat_chain_hmac_key,
                parent_chain=None,
                append_caveats=self._normalize_caveats(caveats),
            )
        except CaveatChainError as exc:
            raise SessionValidationError("Task token caveat chain construction failed") from exc

    def _verified_task_caveat_chain_from_claims(self, claims: dict[str, Any]) -> list[dict[str, Any]]:
        if self._caveat_mode != "caveat_chain":
            return []

        raw_chain = claims.get("task_caveat_chain")
        if raw_chain is None:
            return []
        if not isinstance(raw_chain, list):
            raise SessionValidationError("Task token caveat chain payload is malformed")

        try:
            return verify_caveat_chain(
                hmac_key=self._caveat_chain_hmac_key,
                chain=raw_chain,
            )
        except CaveatChainError as exc:
            raise SessionValidationError(
                "Task token caveat chain integrity validation failed"
            ) from exc

    def _task_caveats_from_claims(
        self,
        claims: dict[str, Any],
        *,
        requested_action: Optional[str] = None,
        requested_resource: Optional[str] = None,
        task_id: Optional[str] = None,
        current_time: Optional[datetime] = None,
    ) -> list[str]:
        verified_chain = self._verified_task_caveat_chain_from_claims(claims)
        if verified_chain:
            if any(
                value is not None and str(value).strip()
                for value in (requested_action, requested_resource, task_id)
            ) or current_time is not None:
                try:
                    evaluate_caveat_chain(
                        verified_chain=verified_chain,
                        requested_action=requested_action,
                        requested_resource=requested_resource,
                        task_id=task_id,
                        current_time=current_time,
                    )
                except CaveatChainError as exc:
                    raise SessionValidationError(
                        "Task token caveat chain denies the requested operation"
                    ) from exc
            return caveat_strings_from_chain(verified_chain)

        return self._normalize_caveats(claims.get("task_caveats") or claims.get("caveats"))

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
