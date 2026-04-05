"""Concrete revocation event publishers for runtime deployment targets."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Callable, Optional
from urllib import error as urllib_error
from urllib import request as urllib_request

from caracal.redis.client import RedisClient


def _build_revocation_event_payload(
    *,
    event_type: str,
    principal_id: str,
    reason: str,
    actor_principal_id: Optional[str],
    root_principal_id: Optional[str],
    revoked_mandate_ids: Optional[list[str]],
    metadata: Optional[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "event_type": event_type,
        "principal_id": principal_id,
        "reason": reason,
        "actor_principal_id": actor_principal_id,
        "root_principal_id": root_principal_id,
        "revoked_mandate_ids": list(revoked_mandate_ids or []),
        "metadata": dict(metadata or {}),
        "published_at": datetime.now(timezone.utc).isoformat(),
    }


class RedisPubSubRevocationEventPublisher:
    """Publish principal revocation events to an OSS Redis pub/sub channel."""

    DEFAULT_CHANNEL = "caracal:identity:revocation_events"

    def __init__(self, redis_client: RedisClient, *, channel: str = DEFAULT_CHANNEL) -> None:
        self._redis_client = redis_client
        self._channel = str(channel or "").strip()
        if not self._channel:
            raise ValueError("channel cannot be empty")

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
        payload = _build_revocation_event_payload(
            event_type=event_type,
            principal_id=principal_id,
            reason=reason,
            actor_principal_id=actor_principal_id,
            root_principal_id=root_principal_id,
            revoked_mandate_ids=revoked_mandate_ids,
            metadata=metadata,
        )
        self._redis_client.publish(self._channel, json.dumps(payload, sort_keys=True))


def _post_webhook_json(
    *,
    webhook_url: str,
    payload: dict[str, Any],
    headers: dict[str, str],
    timeout_seconds: float,
) -> None:
    request_payload = json.dumps(payload, sort_keys=True).encode("utf-8")
    request = urllib_request.Request(
        webhook_url,
        data=request_payload,
        headers=headers,
        method="POST",
    )

    try:
        with urllib_request.urlopen(request, timeout=timeout_seconds) as response:
            response.read()
    except urllib_error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        raise ConnectionError(f"Webhook POST failed with HTTP {exc.code}: {body[:500]}") from exc
    except urllib_error.URLError as exc:
        raise ConnectionError(f"Webhook POST failed: {exc.reason}") from exc


class EnterpriseWebhookRevocationEventPublisher:
    """Publish principal revocation events to an enterprise webhook endpoint."""

    def __init__(
        self,
        webhook_url: str,
        *,
        sync_api_key: Optional[str] = None,
        bearer_token: Optional[str] = None,
        timeout_seconds: float = 5.0,
        post_json_fn: Callable[..., None] = _post_webhook_json,
    ) -> None:
        normalized_url = str(webhook_url or "").strip()
        if not normalized_url:
            raise ValueError("webhook_url cannot be empty")
        if not normalized_url.startswith(("http://", "https://")):
            raise ValueError("webhook_url must start with http:// or https://")

        self._webhook_url = normalized_url
        self._sync_api_key = str(sync_api_key or "").strip() or None
        self._bearer_token = str(bearer_token or "").strip() or None
        self._timeout_seconds = float(timeout_seconds)
        self._post_json_fn = post_json_fn

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
        payload = _build_revocation_event_payload(
            event_type=event_type,
            principal_id=principal_id,
            reason=reason,
            actor_principal_id=actor_principal_id,
            root_principal_id=root_principal_id,
            revoked_mandate_ids=revoked_mandate_ids,
            metadata=metadata,
        )

        headers = {
            "Content-Type": "application/json",
            "User-Agent": "caracal-revocation-publisher/1.0",
        }
        if self._sync_api_key:
            headers["X-Sync-Api-Key"] = self._sync_api_key
        if self._bearer_token:
            headers["Authorization"] = f"Bearer {self._bearer_token}"

        self._post_json_fn(
            webhook_url=self._webhook_url,
            payload=payload,
            headers=headers,
            timeout_seconds=self._timeout_seconds,
        )
