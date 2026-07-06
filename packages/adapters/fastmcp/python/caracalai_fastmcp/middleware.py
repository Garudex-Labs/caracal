# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# FastMCP auth middleware that delegates to caracalai_verify.

from __future__ import annotations

from caracalai_identity import Claims
from caracalai_revocation import RevocationStore
from caracalai_verify import AuthOptions, MandateVerifier, create_mandate_verifier


class CaracalAuthError(Exception):
    def __init__(self, code: str, description: str, hint: str | None = None) -> None:
        super().__init__(description)
        self.code = code
        self.description = description
        self.hint = hint


class CaracalAuth:
    def __init__(
        self,
        issuer: str,
        audience: str,
        revocations: RevocationStore,
        required_scopes: list[str] | None = None,
        required_targets: list[str] | None = None,
        required_use: str | None = "resource",
        expected_zone_id: str | None = None,
        require_agent: bool = False,
        require_delegation: bool = False,
        require_chain_contains: list[str] | None = None,
        max_hop_count: int | None = None,
    ) -> None:
        if not expected_zone_id:
            raise ValueError("CaracalAuth requires a zone: pass expected_zone_id=")
        self.verifier: MandateVerifier = create_mandate_verifier(
            AuthOptions(
                issuer=issuer,
                audience=audience,
                expected_zone_id=expected_zone_id,
                required_scopes=required_scopes or [],
                required_targets=required_targets or [],
                required_use=required_use,
                revocations=revocations,
                require_agent=require_agent,
                require_delegation=require_delegation,
                require_chain_contains=require_chain_contains or [],
                max_hop_count=max_hop_count,
            )
        )

    async def __call__(self, token: str) -> Claims:
        result = await self.verifier.authenticate(token)
        if result.error is not None:
            raise CaracalAuthError(
                result.error.code, result.error.description, result.error.hint
            )
        assert result.principal is not None
        return result.principal

    async def warmup(self) -> None:
        await self.verifier.warmup()
