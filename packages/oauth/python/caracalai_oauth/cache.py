"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Bounded in-memory token cache keyed by hashed subject and resource.
"""

from __future__ import annotations

from collections import OrderedDict
from hashlib import sha256
from time import time
from typing import Protocol

from .types import TokenExchangeResponse


class TokenCache(Protocol):
    def get(self, subject_token: str, resource: str) -> TokenExchangeResponse | None:
        pass

    def set(self, subject_token: str, resource: str, token: TokenExchangeResponse) -> None:
        pass


class InMemoryTokenCache:
    def __init__(self, max_entries: int = 10_000) -> None:
        if max_entries <= 0:
            raise ValueError("InMemoryTokenCache.max_entries must be a positive integer")
        self._max_entries = max_entries
        self._entries: OrderedDict[str, tuple[TokenExchangeResponse, int]] = OrderedDict()

    def get(self, subject_token: str, resource: str) -> TokenExchangeResponse | None:
        key = _cache_key(subject_token, resource)
        entry = self._entries.get(key)
        if entry is None:
            return None
        token, expires_at = entry
        if time() >= expires_at:
            del self._entries[key]
            return None
        self._entries.move_to_end(key)
        return token

    def set(self, subject_token: str, resource: str, token: TokenExchangeResponse) -> None:
        key = _cache_key(subject_token, resource)
        self._entries[key] = (token, token.issued_at + token.expires_in)
        self._entries.move_to_end(key)
        while len(self._entries) > self._max_entries:
            self._entries.popitem(last=False)


def _cache_key(subject_token: str, resource: str) -> str:
    return sha256(f"{subject_token}\0{resource}".encode()).hexdigest()
