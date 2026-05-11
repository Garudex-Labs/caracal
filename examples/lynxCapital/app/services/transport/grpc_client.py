"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

gRPC unary and server-streaming clients with retry/breaker/auth metadata.
"""
from __future__ import annotations

import json
import os
from typing import Any, Iterator

import grpc

from app.services.resilience import RetryPolicy, breaker, with_retry


class GrpcError(RuntimeError):
    def __init__(self, code: grpc.StatusCode, details: str):
        super().__init__(f"grpc {code.name}: {details}")
        self.code = code
        self.details = details
        self.status = _STATUS_FROM_CODE.get(code, 500)
        self.retry_after_s = None


_STATUS_FROM_CODE = {
    grpc.StatusCode.UNAUTHENTICATED:    401,
    grpc.StatusCode.PERMISSION_DENIED:  403,
    grpc.StatusCode.NOT_FOUND:          404,
    grpc.StatusCode.RESOURCE_EXHAUSTED: 429,
    grpc.StatusCode.UNAVAILABLE:        503,
    grpc.StatusCode.DEADLINE_EXCEEDED:  504,
    grpc.StatusCode.INTERNAL:           500,
}
_RETRYABLE_CODES = {
    grpc.StatusCode.UNAVAILABLE,
    grpc.StatusCode.DEADLINE_EXCEEDED,
    grpc.StatusCode.RESOURCE_EXHAUSTED,
}


def _is_retryable(exc: BaseException) -> bool:
    return isinstance(exc, GrpcError) and exc.code in _RETRYABLE_CODES


class GrpcClient:
    def __init__(self, provider: str, target: str, auth_header: str, auth_env: str,
                 *, policy: RetryPolicy = RetryPolicy(), deadline_s: float = 5.0):
        self.provider = provider
        self.target = target
        self._auth_header = auth_header.lower()
        self._auth_env = auth_env
        self._channel = grpc.insecure_channel(target)
        self._policy = policy
        self._breaker = breaker(provider)
        self._deadline_s = deadline_s

    def close(self) -> None:
        self._channel.close()

    def _metadata(self) -> list[tuple[str, str]]:
        token = os.getenv(self._auth_env, "")
        return [(self._auth_header, token)] if token else []

    def unary(self, stub_factory, method_name: str, request: Any) -> Any:
        stub = stub_factory(self._channel)
        method = getattr(stub, method_name)

        def _attempt(_: int) -> Any:
            try:
                return method(request, metadata=self._metadata(), timeout=self._deadline_s)
            except grpc.RpcError as exc:
                raise GrpcError(exc.code(), exc.details() or "") from exc

        return with_retry(self.provider, _attempt,
                          policy=self._policy, is_retryable=_is_retryable,
                          breaker_obj=self._breaker)

    def server_stream(self, stub_factory, method_name: str, request: Any) -> Iterator[Any]:
        stub = stub_factory(self._channel)
        method = getattr(stub, method_name)
        try:
            for msg in method(request, metadata=self._metadata()):
                yield msg
        except grpc.RpcError as exc:
            raise GrpcError(exc.code(), exc.details() or "") from exc


def parse_json_payload(message: Any) -> dict:
    """Treasury proto wraps results in a single `json` string field."""
    return json.loads(getattr(message, "json"))
