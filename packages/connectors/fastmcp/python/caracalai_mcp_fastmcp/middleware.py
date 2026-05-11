# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# FastMCP auth middleware that delegates to caracalai_transport_mcp.

from __future__ import annotations

from caracalai_identity import Claims
from caracalai_revocation import RevocationStore
from caracalai_transport_mcp import authenticate


class CaracalAuthError(Exception):
    def __init__(self, code: str, description: str) -> None:
        super().__init__(description)
        self.code = code
        self.description = description


class CaracalAuth:
    def __init__(
        self,
        issuer: str,
        audience: str,
        revocations: RevocationStore,
        required_scopes: list[str] | None = None,
        expected_zone_id: str | None = None,
        require_agent: bool = False,
        require_delegation: bool = False,
        require_chain_contains: list[str] | None = None,
    ) -> None:
        self.issuer = issuer
        self.audience = audience
        self.expected_zone_id = expected_zone_id
        self.required_scopes = required_scopes or []
        self.revocations = revocations
        self.require_agent = require_agent
        self.require_delegation = require_delegation
        self.require_chain_contains = require_chain_contains or []

    async def __call__(self, token: str) -> Claims:
        result = await authenticate(
            token,
            self.issuer,
            self.audience,
            self.required_scopes,
            self.expected_zone_id,
            self.revocations,
            require_agent=self.require_agent,
            require_delegation=self.require_delegation,
            require_chain_contains=self.require_chain_contains,
        )
        if result.error is not None:
            raise CaracalAuthError(result.error.code, result.error.description)
        assert result.principal is not None
        return result.principal
