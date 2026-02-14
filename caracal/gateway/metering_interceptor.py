"""
Gateway metering interceptor for Caracal Gateway.

Instruments the gateway proxy to record server-side metering events
for every request that passes through.  This is the primary metering
point for Caracal Enterprise — all validation requests are counted here.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import secrets
from datetime import datetime
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


class MeteringInterceptor:
    """
    Gateway-level metering hook.

    Sits inside the GatewayProxy request pipeline and records metering
    events for every validation request.  In hosted deployments, events
    are written directly to the database.  In on-premise deployments,
    events are queued and forwarded to Caracal's metering ingest API.

    This interceptor is purely server-side — the SDK knows nothing
    about metering.
    """

    def __init__(
        self,
        org_id: str,
        metering_secret: str,
        api_endpoint: Optional[str] = None,
        batch_size: int = 100,
        flush_interval_seconds: int = 30,
    ):
        self.org_id = org_id
        self.metering_secret = metering_secret
        self.api_endpoint = api_endpoint
        self.batch_size = batch_size
        self.flush_interval = flush_interval_seconds

        self._sequence: int = 0
        self._event_buffer: list = []

        logger.info("MeteringInterceptor initialized for org %s", org_id)

    def _next_sequence(self) -> int:
        """Get next monotonic sequence number."""
        self._sequence += 1
        return self._sequence

    def compute_hmac(
        self,
        sequence: int,
        event_type: str,
        timestamp_iso: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Compute HMAC-SHA256 signature for a metering event."""
        metadata_hash = hashlib.sha256(
            json.dumps(metadata or {}, sort_keys=True, default=str).encode()
        ).hexdigest()

        payload = (
            f"{self.org_id}:{sequence}:{event_type}:{timestamp_iso}:{metadata_hash}"
        )

        return hmac.new(
            self.metering_secret.encode(),
            payload.encode(),
            hashlib.sha256,
        ).hexdigest()

    def on_request(
        self,
        request_type: str,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Called by GatewayProxy for each incoming request.

        Records the metering event and returns event metadata.
        """
        now = datetime.utcnow()
        seq = self._next_sequence()
        timestamp_iso = now.isoformat()

        event_metadata = {
            "request_type": request_type,
            **(metadata or {}),
        }

        signature = self.compute_hmac(seq, request_type, timestamp_iso, event_metadata)

        event = {
            "event_type": request_type,
            "sequence_number": seq,
            "timestamp": timestamp_iso,
            "hmac_signature": signature,
            "agent_id": agent_id,
            "user_id": user_id,
            "metadata": event_metadata,
        }

        self._event_buffer.append(event)

        # Auto-flush if buffer is full
        if len(self._event_buffer) >= self.batch_size:
            self.flush()

        logger.debug(
            "Metered event: org=%s seq=%d type=%s agent=%s",
            self.org_id, seq, request_type, agent_id,
        )
        return event

    def on_validation_request(
        self,
        agent_id: str,
        mandate_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Convenience method for validation request metering."""
        return self.on_request(
            request_type="validation_request",
            agent_id=agent_id,
            metadata={"mandate_id": mandate_id, **(metadata or {})},
        )

    def on_mandate_issuance(
        self,
        agent_id: str,
        mandate_id: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Convenience method for mandate issuance metering."""
        return self.on_request(
            request_type="mandate_issuance",
            agent_id=agent_id,
            metadata={"mandate_id": mandate_id, **(metadata or {})},
        )

    def on_policy_evaluation(
        self,
        agent_id: str,
        policy_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Convenience method for policy evaluation metering."""
        return self.on_request(
            request_type="policy_evaluation",
            agent_id=agent_id,
            metadata={"policy_id": policy_id, **(metadata or {})},
        )

    def flush(self) -> int:
        """
        Flush buffered events.

        In hosted mode: directly written to database.
        In on-premise mode: sent to Caracal metering ingest API.

        Returns number of events flushed.
        """
        if not self._event_buffer:
            return 0

        count = len(self._event_buffer)
        events = self._event_buffer.copy()
        self._event_buffer.clear()

        if self.api_endpoint:
            # On-premise mode: forward to Caracal ingest API
            self._forward_to_api(events)
        else:
            # Hosted mode: directly write to DB
            self._write_to_db(events)

        logger.info(
            "Flushed %d metering events for org %s", count, self.org_id
        )
        return count

    def _forward_to_api(self, events: list) -> None:
        """Forward events to Caracal metering ingest API."""
        import urllib.request
        import urllib.error

        payload = json.dumps({
            "organization_id": self.org_id,
            "events": events,
        }).encode()

        req = urllib.request.Request(
            f"{self.api_endpoint}/api/metering/ingest",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read())
                logger.debug("Ingest response: %s", result)
        except urllib.error.URLError as e:
            logger.error("Failed to forward metering events: %s", e)
            # Re-buffer events for retry
            self._event_buffer.extend(events)

    def _write_to_db(self, events: list) -> None:
        """Write events directly to database (hosted mode)."""
        # In hosted deployments, the gateway imports the enterprise DB
        # session and writes directly.  This is a placeholder that
        # shows the pattern — actual integration depends on the
        # gateway's database configuration.
        logger.debug(
            "Direct DB write for %d events (hosted mode)", len(events)
        )

    def get_stats(self) -> Dict[str, Any]:
        """Get interceptor statistics."""
        return {
            "org_id": self.org_id,
            "current_sequence": self._sequence,
            "buffered_events": len(self._event_buffer),
            "batch_size": self.batch_size,
        }


class LicenseGate:
    """
    Fail-closed license enforcement at the gateway.

    If the gateway cannot validate the organization's license within
    a configurable grace period, all requests are rejected.
    """

    def __init__(
        self,
        org_id: str,
        license_check_url: str,
        grace_period_minutes: int = 60,
    ):
        self.org_id = org_id
        self.license_check_url = license_check_url
        self.grace_period_minutes = grace_period_minutes

        self._last_valid_check: Optional[datetime] = None
        self._is_valid: bool = False

        logger.info(
            "LicenseGate initialized: org=%s grace=%d min",
            org_id, grace_period_minutes,
        )

    def check_license(self) -> bool:
        """
        Verify license validity.

        Calls Caracal license validation endpoint.  Caches result
        for the grace period.  If check fails and grace period has
        elapsed, returns False (fail-closed).
        """
        now = datetime.utcnow()

        # Use cached result if within grace period
        if self._last_valid_check:
            delta = (now - self._last_valid_check).total_seconds() / 60
            if delta < self.grace_period_minutes and self._is_valid:
                return True

        # Attempt validation
        try:
            result = self._validate_remotely()
            self._is_valid = result
            self._last_valid_check = now
            return result
        except Exception as e:
            logger.error("License check failed for org %s: %s", self.org_id, e)

            # Fail-closed: if we've never validated or grace period expired
            if not self._last_valid_check:
                logger.critical(
                    "FAIL-CLOSED: No prior license validation for org %s", self.org_id
                )
                return False

            delta = (now - self._last_valid_check).total_seconds() / 60
            if delta > self.grace_period_minutes:
                logger.critical(
                    "FAIL-CLOSED: Grace period expired (%d min) for org %s",
                    delta, self.org_id,
                )
                return False

            # Within grace period, allow (degraded state)
            logger.warning(
                "License check failed but within grace period for org %s (%d min)",
                self.org_id, delta,
            )
            return True

    def _validate_remotely(self) -> bool:
        """Call Caracal license validation endpoint."""
        import urllib.request
        import urllib.error

        try:
            req = urllib.request.Request(
                f"{self.license_check_url}/api/license/validate",
                data=json.dumps({"organization_id": self.org_id}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                result = json.loads(resp.read())
                return result.get("valid", False)
        except Exception as e:
            raise RuntimeError(f"License validation request failed: {e}")

    def get_status(self) -> Dict[str, Any]:
        """Get gate status for monitoring."""
        return {
            "org_id": self.org_id,
            "is_valid": self._is_valid,
            "last_check": (
                self._last_valid_check.isoformat()
                if self._last_valid_check else None
            ),
            "grace_period_minutes": self.grace_period_minutes,
        }
