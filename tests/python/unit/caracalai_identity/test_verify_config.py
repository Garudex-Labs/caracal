# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Unit tests for verify_config and verify_chain_contains covering all constraint paths.

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest

import jwt as pyjwt
from cryptography.hazmat.primitives.asymmetric import ec

sys.path.append(str(Path(__file__).parents[3] / "shared" / "test-utils" / "python"))

from caracal_test_tokens import mint_es256_token
from caracalai_identity import verify
from caracalai_identity.types import Claims, ChainHop, JwtConfig
from caracalai_identity.verify import (
    AgentIdentityRequiredError,
    ChainMismatchError,
    DelegationRequiredError,
    HopCountExceededError,
    TokenInvalidError,
    verify_chain_contains,
    verify_config,
)


def _mint_no_kid_token() -> tuple[str, dict]:
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.now(timezone.utc)
    payload = {
        "iss": "https://sts.example.com",
        "aud": "resource://api",
        "sub": "user1",
        "client_id": "app1",
        "sid": "sid1",
        "use": "resource",
        "jti": "jti1",
        "zone_id": "zone1",
        "scope": "read",
        "iat": now,
        "exp": now + timedelta(minutes=15),
    }
    token = pyjwt.encode(payload, key, algorithm="ES256")
    jwk = json.loads(pyjwt.algorithms.ECAlgorithm.to_jwk(key.public_key()))
    jwk.update({"use": "sig", "alg": "ES256"})
    return token, jwk


class StubCache:
    def __init__(self, keys: list[dict] | None = None) -> None:
        self.keys = keys or []

    async def get_keys(self, issuer: str) -> list[dict]:
        return self.keys



class VerifyConfigTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.original_cache = verify._cache

    async def asyncTearDown(self) -> None:
        verify._cache = self.original_cache

    async def _verify(self, extra_claims: dict, **config_kwargs) -> Claims:
        token, jwk = mint_es256_token(claims=extra_claims)
        verify._cache = StubCache([jwk])
        cfg = JwtConfig(
            issuer="https://sts.example.com",
            audience="resource://api",
            **config_kwargs,
        )
        return await verify_config(token, cfg)

    async def test_returns_claims_for_valid_token(self) -> None:
        claims = await self._verify(
            {"sid": "sid-1", "client_id": "app-1", "target": ["resource://api"]},
            expected_zone_id="zone1",
        )
        self.assertEqual(claims.sub, "user1")
        self.assertEqual(claims.zone_id, "zone1")
        self.assertEqual(claims.client_id, "app-1")
        self.assertEqual(claims.sid, "sid-1")
        self.assertGreater(claims.expires_at, claims.issued_at)
        self.assertEqual(claims.target_resources, ["resource://api"])

    async def test_raises_agent_required_when_absent(self) -> None:
        with self.assertRaises(AgentIdentityRequiredError):
            await self._verify({}, require_agent=True)

    async def test_accepts_when_agent_session_id_present(self) -> None:
        claims = await self._verify({"agent_session_id": "agent-1"}, require_agent=True)
        self.assertEqual(claims.agent_session_id, "agent-1")

    async def test_raises_delegation_required_when_absent(self) -> None:
        with self.assertRaises(DelegationRequiredError):
            await self._verify({}, require_delegation=True)

    async def test_accepts_when_delegation_edge_id_present(self) -> None:
        claims = await self._verify({"delegation_edge_id": "edge-1"}, require_delegation=True)
        self.assertEqual(claims.delegation_edge_id, "edge-1")

    async def test_raises_chain_mismatch_when_app_absent(self) -> None:
        chain = [{"application_id": "app-child"}]
        with self.assertRaises(ChainMismatchError) as cm:
            await self._verify(
                {"delegation_chain": chain},
                require_chain_contains=["app-parent"],
            )
        self.assertEqual(cm.exception.missing_application_id, "app-parent")

    async def test_accepts_chain_when_app_present(self) -> None:
        chain = [{"application_id": "app-parent", "agent_session_id": "s1", "delegation_edge_id": "e1"}]
        claims = await self._verify(
            {"delegation_chain": chain},
            require_chain_contains=["app-parent"],
        )
        self.assertEqual(claims.delegation_chain[0].application_id, "app-parent")
        self.assertEqual(claims.delegation_chain[0].agent_session_id, "s1")
        self.assertEqual(claims.delegation_chain[0].delegation_edge_id, "e1")

    async def test_rejects_compact_chain_keys(self) -> None:
        chain = [{"app": "app-child", "session": "s2", "edge": "e2"}]
        with self.assertRaises(TokenInvalidError):
            await self._verify(
                {"delegation_chain": chain},
                require_chain_contains=["app-child"],
            )

    async def test_extracts_delegation_path(self) -> None:
        claims = await self._verify({"delegation_path": ["edge-0", "edge-1"]})
        self.assertEqual(claims.delegation_path, ["edge-0", "edge-1"])

    async def test_raises_for_invalid_token_string(self) -> None:
        verify._cache = StubCache([])
        cfg = JwtConfig(issuer="https://sts.example.com", audience="resource://api")
        with self.assertRaises(TokenInvalidError):
            await verify_config("not.a.jwt", cfg)

    async def test_raises_for_missing_expiration(self) -> None:
        with self.assertRaises(TokenInvalidError):
            await self._verify({"exp": None})

    async def test_raises_for_missing_session_id(self) -> None:
        with self.assertRaises(TokenInvalidError):
            await self._verify({"sid": ""})

    async def test_raises_for_wrong_token_use(self) -> None:
        with self.assertRaises(TokenInvalidError):
            await self._verify({"use": "session"}, required_use="resource")

    async def test_raises_for_malformed_agent_claim(self) -> None:
        with self.assertRaises(TokenInvalidError):
            await self._verify({"agent_session_id": ["agent-1"]}, require_agent=True)

    async def test_raises_hop_count_exceeded(self) -> None:
        with self.assertRaises(HopCountExceededError):
            await self._verify({"hop_count": 5}, max_hop_count=1)

    async def test_raises_for_missing_target_resource(self) -> None:
        with self.assertRaises(TokenInvalidError):
            await self._verify(
                {"target": ["resource://tools/files"]},
                required_targets=["resource://tools/calendar"],
            )

    async def test_ignores_legacy_graph_epoch(self) -> None:
        claims = await self._verify({"graph_epoch": 99})
        self.assertIsNone(claims.graph_epoch)

    async def test_raises_for_unknown_kid(self) -> None:
        token, _ = mint_es256_token()
        _, wrong_jwk = mint_es256_token()
        wrong_jwk["kid"] = "other-kid"
        verify._cache = StubCache([wrong_jwk])
        cfg = JwtConfig(issuer="https://sts.example.com", audience="resource://api")
        with self.assertRaises(TokenInvalidError):
            await verify_config(token, cfg)

    async def test_raises_when_all_key_candidates_fail(self) -> None:
        token, _ = mint_es256_token()
        _, wrong_jwk = mint_es256_token()
        verify._cache = StubCache([wrong_jwk])
        cfg = JwtConfig(issuer="https://sts.example.com", audience="resource://api")
        with self.assertRaises(TokenInvalidError):
            await verify_config(token, cfg)

    async def test_resolves_no_kid_token_using_all_keys(self) -> None:
        token, jwk = _mint_no_kid_token()
        verify._cache = StubCache([jwk])
        cfg = JwtConfig(issuer="https://sts.example.com", audience="resource://api")
        claims = await verify_config(token, cfg)
        self.assertEqual(claims.sub, "user1")


class VerifyChainContainsTests(unittest.TestCase):
    def _claims(self, client_id: str = "app-1", chain: list[ChainHop] | None = None) -> Claims:
        return Claims(
            sub="u",
            zone_id="z",
            client_id=client_id,
            sid="s",
            use="resource",
            jti="j",
            scope="read",
            issued_at=1,
            expires_at=2,
            delegation_chain=chain or [],
        )

    def test_matches_by_client_id(self) -> None:
        self.assertTrue(verify_chain_contains(self._claims("app-1"), "app-1"))

    def test_matches_by_delegation_chain_hop(self) -> None:
        chain = [ChainHop(application_id="app-parent")]
        self.assertTrue(verify_chain_contains(self._claims(chain=chain), "app-parent"))

    def test_returns_false_when_application_is_absent(self) -> None:
        chain = [ChainHop(application_id="app-other")]
        self.assertFalse(verify_chain_contains(self._claims(chain=chain), "app-unknown"))


if __name__ == "__main__":
    unittest.main()
