"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tax-rules HTTP client with on-demand snapshot caching.
"""
from __future__ import annotations

import time
from dataclasses import dataclass

import httpx


class TaxError(Exception):
    def __init__(self, status: int, body: dict):
        super().__init__(f"tax error {status}: {body}")
        self.status = status
        self.body = body


@dataclass
class WithholdingResult:
    rate: float
    jurisdiction: str
    raw: dict


@dataclass
class TaxIdValidation:
    valid: bool
    country: str
    raw: dict


class TaxClient:
    def __init__(self, api_key: str, base_url: str = "http://tax-rules.mock",
                 timeout: float = 4.0, snapshot_ttl_s: float = 300.0,
                 transport: httpx.BaseTransport | None = None):
        self._api_key = api_key
        self._http = httpx.Client(
            base_url=base_url,
            timeout=timeout,
            transport=transport,
            headers={"X-API-Key": api_key, "User-Agent": "lynx-sdk-tax/0.1.0"},
        )
        self._snapshot: dict | None = None
        self._snapshot_at: float = 0.0
        self._ttl = snapshot_ttl_s

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "TaxClient":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    def _post(self, path: str, body: dict, attempt: int = 0) -> dict:
        r = self._http.post(path, json=body, headers={"X-Attempt": str(attempt)})
        if r.status_code >= 400:
            try:
                data = r.json()
            except Exception:
                data = {"error": r.text}
            raise TaxError(r.status_code, data)
        return r.json()

    def snapshot(self, *, force: bool = False) -> dict:
        now = time.time()
        if not force and self._snapshot is not None and now - self._snapshot_at < self._ttl:
            return self._snapshot
        r = self._http.get("/v1/rules/snapshot", headers={"X-Attempt": "0"})
        if r.status_code >= 400:
            raise TaxError(r.status_code, r.json() if r.content else {})
        self._snapshot = r.json()
        self._snapshot_at = now
        return self._snapshot

    def withholding(self, *, country: str, vendor_type: str, amount: float,
                    attempt: int = 0) -> WithholdingResult:
        data = self._post("/v1/withholding",
                          {"country": country, "vendor_type": vendor_type, "amount": amount},
                          attempt=attempt)
        return WithholdingResult(
            rate=float(data.get("rate", 0.0)),
            jurisdiction=data.get("jurisdiction", country),
            raw=data,
        )

    def validate_tax_id(self, *, tax_id: str, country: str,
                        attempt: int = 0) -> TaxIdValidation:
        data = self._post("/v1/tax_id/validate",
                          {"tax_id": tax_id, "country": country},
                          attempt=attempt)
        return TaxIdValidation(
            valid=bool(data.get("valid", False)),
            country=data.get("country", country),
            raw=data,
        )
