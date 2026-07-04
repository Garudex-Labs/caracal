"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Error type raised for non-2xx admin API responses.
"""

from __future__ import annotations

from typing import Any

from caracalai_core.errors import CaracalError
from caracalai_core.logging import redact


class AdminApiError(CaracalError):
    """A non-2xx admin API response, carrying the HTTP status, the stable wire
    code, and the redacted response body."""

    def __init__(
        self,
        status: int,
        code: str,
        body: Any,
        message: str | None = None,
        target: str = "api",
    ) -> None:
        safe_body = redact(body)
        super().__init__(
            code,
            message or f"{code} (HTTP {status})",
            details={"status": status, "body": safe_body, "target": target},
        )
        self.status = status
        self.body = safe_body
        self.target = target
