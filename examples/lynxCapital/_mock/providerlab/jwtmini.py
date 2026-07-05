"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Dependency-free HS256 JWT encode and decode used by the mandate mocks.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    pad = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + pad)


class JwtError(ValueError):
    pass


def encode(claims: dict, key: str, *, kid: str | None = None) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    if kid:
        header["kid"] = kid
    segments = [
        _b64url(json.dumps(header, separators=(",", ":")).encode()),
        _b64url(json.dumps(claims, separators=(",", ":")).encode()),
    ]
    signing_input = ".".join(segments).encode("ascii")
    signature = hmac.new(key.encode(), signing_input, hashlib.sha256).digest()
    segments.append(_b64url(signature))
    return ".".join(segments)


def peek(token: str) -> tuple[dict, dict]:
    """The decoded header and payload without signature verification."""
    try:
        header_b64, payload_b64, _ = token.split(".")
        header = json.loads(_b64url_decode(header_b64))
        payload = json.loads(_b64url_decode(payload_b64))
    except (ValueError, UnicodeDecodeError) as exc:
        raise JwtError("malformed token") from exc
    if not isinstance(header, dict) or not isinstance(payload, dict):
        raise JwtError("malformed token")
    return header, payload


def decode(token: str, key: str, *, verify_exp: bool = True) -> dict:
    try:
        header_b64, payload_b64, signature_b64 = token.split(".")
    except ValueError as exc:
        raise JwtError("malformed token") from exc
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    expected = hmac.new(key.encode(), signing_input, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, _b64url_decode(signature_b64)):
        raise JwtError("bad signature")
    claims = json.loads(_b64url_decode(payload_b64))
    if verify_exp and "exp" in claims and int(claims["exp"]) < int(time.time()):
        raise JwtError("token expired")
    return claims
