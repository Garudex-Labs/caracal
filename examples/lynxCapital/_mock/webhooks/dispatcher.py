"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

HMAC-signed webhook delivery from mock providers to the app callback URL.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import threading
import time
from uuid import uuid4

import httpx


def _callback_url(provider: str) -> str | None:
    base = os.getenv("LYNX_HOOK_BASE")
    if not base:
        return None
    return f"{base.rstrip('/')}/hooks/{provider}"


def _secret(provider: str) -> str:
    from _mock.faults.engine import profile_for
    env = profile_for(provider).get("webhook_secret_env")
    if not env:
        return ""
    return os.getenv(env, f"dev-{provider}-secret")


def sign(provider: str, body: bytes, ts: str) -> str:
    secret = _secret(provider).encode()
    mac = hmac.new(secret, ts.encode() + b"." + body, hashlib.sha256).hexdigest()
    return f"t={ts},v1={mac}"


def deliver(provider: str, event_type: str, data: dict, *, delay_s: float = 0.0) -> None:
    url = _callback_url(provider)
    if not url:
        return

    def _send() -> None:
        if delay_s > 0:
            time.sleep(delay_s)
        envelope = {
            "id": f"evt_{uuid4().hex[:16]}",
            "type": event_type,
            "provider": provider,
            "created": int(time.time()),
            "data": data,
        }
        body = json.dumps(envelope, separators=(",", ":"), sort_keys=True).encode()
        ts = str(envelope["created"])
        headers = {
            "Content-Type": "application/json",
            "X-Lynx-Signature": sign(provider, body, ts),
            "X-Lynx-Event-Id": envelope["id"],
        }
        try:
            with httpx.Client(timeout=5.0) as c:
                c.post(url, content=body, headers=headers)
        except Exception:
            pass

    threading.Thread(target=_send, daemon=True).start()
