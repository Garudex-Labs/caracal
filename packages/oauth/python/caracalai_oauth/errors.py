"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Typed exceptions mirroring the platform token-exchange error contract so callers branch on a stable code instead of parsing HTTP status or message text.
"""

from __future__ import annotations

import httpx


class CaracalError(Exception):
    """Base for every failure the platform reports on the token-exchange surface.
    Carries the canonical ``code`` the STS emitted, the operator-facing
    ``description`` it attached, the originating ``request_id`` for correlation,
    and the HTTP ``status`` that carried it. Callers branch on the typed subclass
    or on ``code``; the description and request id are for logs and triage, never
    for control flow."""

    code = "error"

    def __init__(
        self,
        description: str = "",
        *,
        request_id: str = "",
        http_status: int = 0,
        code: str | None = None,
    ) -> None:
        if code is not None:
            self.code = code
        self.description = description
        self.request_id = request_id
        self.http_status = http_status
        super().__init__(description or self.code)

    @property
    def is_retryable(self) -> bool:
        """Whether retrying the operation may succeed without any change on
        the caller's side: transport-level congestion and availability
        failures are retryable, policy and validation outcomes are not. A
        hint, not a guarantee - callers still own backoff and attempt
        budgets."""
        if self.code == "sts_unavailable":
            return True
        return self.http_status in (408, 425, 429) or self.http_status >= 500


class InvalidRequest(CaracalError):
    """The exchange request was malformed or missing a required parameter. Fix
    the request shape before retrying."""

    code = "invalid_request"


class AccessDenied(CaracalError):
    """The credential authenticated but policy or registration forbids the
    exchange: an unknown application, a bad client secret, or a policy that
    granted no resources. The description distinguishes the case; the remedy is
    to correct the credential or the grant, never to retry it unchanged."""

    code = "access_denied"


class InvalidToken(CaracalError):
    """The presented subject token is malformed, expired, or not trusted by this
    zone. Re-mint the upstream token before retrying."""

    code = "invalid_token"


class ZoneMismatch(CaracalError):
    """The application is registered in a different zone than the request
    targeted. Point the client at the zone the application belongs to."""

    code = "zone_invalid"


class ResourceNotFound(CaracalError):
    """The requested resource is not registered in this zone. Verify the
    resource identifier and that it is provisioned."""

    code = "resource_not_found"


class ScopeInsufficient(CaracalError):
    """The granted authority does not cover a requested scope. Request a grant
    that includes the scope before retrying."""

    code = "scope_insufficient"


class OperationNotPermitted(CaracalError):
    """The mandate does not authorize the attempted operation on the resource.
    Mint a mandate whose scope covers the operation."""

    code = "operation_not_permitted"


class DelegationRequired(CaracalError):
    """The exchange requires delegated authority.
    Supply the Session and Delegation before retrying."""

    code = "delegation_required"


class ServiceUnavailable(CaracalError):
    """The STS could not service the exchange and the condition is transient.
    Retrying after a short backoff is safe."""

    code = "sts_unavailable"


class CredentialsUnavailableError(RuntimeError):
    """The credentials resolver returned no usable credential; the client
    fails closed without contacting the platform. Raised again on every
    attempt until the resolver recovers."""

    def __init__(self) -> None:
        super().__init__(
            "Caracal credentials are unavailable: the credentials resolver "
            "returned no usable credential"
        )


class ApprovalRequired(CaracalError):
    """Raised when minting a mandate is gated on human approval. The platform has
    recorded a durable approval challenge that an authenticated approver must
    decide out-of-band before the mandate can be minted; an agent can never
    satisfy its own approval. ``binding`` proves which exact resource and scope
    set the approval covers; relay it with the approval id to the approval
    surface. Wait for a decision with ``wait_for_approval`` and retry
    ``mint_mandate`` with ``approval_id`` set: the same
    approval is returned while it is pending, and the mint succeeds
    once approved."""

    code = "interaction_required"

    def __init__(
        self,
        approval_id: str,
        expires_at: str = "",
        *,
        resource: str = "",
        state: str = "",
        tier: str = "",
        binding: str = "",
        request_id: str = "",
        http_status: int = 401,
    ) -> None:
        super().__init__(
            f"human approval required (approval {approval_id})",
            request_id=request_id,
            http_status=http_status,
        )
        self.approval_id = approval_id
        self.expires_at = expires_at
        self.resource = resource
        self.state = state
        self.tier = tier
        self.binding = binding


_CODE_MAP: dict[str, type[CaracalError]] = {
    InvalidRequest.code: InvalidRequest,
    AccessDenied.code: AccessDenied,
    InvalidToken.code: InvalidToken,
    ZoneMismatch.code: ZoneMismatch,
    ResourceNotFound.code: ResourceNotFound,
    ScopeInsufficient.code: ScopeInsufficient,
    OperationNotPermitted.code: OperationNotPermitted,
    DelegationRequired.code: DelegationRequired,
    ServiceUnavailable.code: ServiceUnavailable,
}


def raise_for_caracal_error(resp: httpx.Response) -> None:
    """Translate a non-success token-exchange response into the typed exception
    that mirrors its platform error code, preserving the description and request
    id for triage. A human-approval challenge surfaces as :class:`ApprovalRequired`
    carrying the challenge id; every other code maps to its typed subclass, and an
    unrecognized code falls back to :class:`CaracalError` retaining the raw code."""
    if resp.is_success:
        return
    try:
        body = resp.json()
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}
    code = str(body.get("error", ""))
    description = str(body.get("error_description", ""))
    request_id = str(body.get("requestId", ""))
    if code == ApprovalRequired.code and body.get("challenge_type") == "human_approval":
        raise ApprovalRequired(
            approval_id=str(body.get("challenge_id", "")),
            expires_at=str(body.get("challenge_expires_at", "")),
            state=str(body.get("state", "")),
            tier=str(body.get("tier", "")),
            binding=str(body.get("binding", "")),
            request_id=request_id,
            http_status=resp.status_code,
        )
    mapped = _CODE_MAP.get(code)
    if mapped is not None:
        raise mapped(description, request_id=request_id, http_status=resp.status_code)
    raise CaracalError(
        description,
        request_id=request_id,
        http_status=resp.status_code,
        code=code or CaracalError.code,
    )
