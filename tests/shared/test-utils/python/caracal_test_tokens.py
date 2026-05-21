# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Shared JWT helpers for Python middleware tests.

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json

import jwt
from cryptography.hazmat.primitives.asymmetric import ec


def mint_es256_token(
    issuer: str = "https://sts.example.com",
    audience: str = "resource://api",
    zone_id: str | None = "zone1",
    scopes: tuple[str, ...] = ("read",),
    claims: dict[str, object] | None = None,
) -> tuple[str, dict[str, object]]:
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.now(timezone.utc)
    payload: dict[str, object] = {
        "iss": issuer,
        "aud": audience,
        "sub": "user1",
        "client_id": "app1",
        "sid": "sid1",
        "use": "resource",
        "jti": "jti1",
        "scope": " ".join(scopes),
        "iat": now,
        "exp": now + timedelta(minutes=15),
    }
    if zone_id is not None:
        payload["zone_id"] = zone_id
    if claims:
        payload.update(claims)

    token = jwt.encode(payload, key, algorithm="ES256", headers={"kid": "kid1"})
    jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(key.public_key()))
    jwk.update({"kid": "kid1", "use": "sig", "alg": "ES256"})
    return token, jwk
