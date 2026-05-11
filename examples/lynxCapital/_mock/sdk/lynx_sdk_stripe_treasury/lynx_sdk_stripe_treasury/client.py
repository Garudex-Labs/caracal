"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

HTTP client for Stripe Treasury, modeled on the real Stripe SDK shape.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx


class StripeError(Exception):
    def __init__(self, status: int, body: dict):
        super().__init__(f"stripe error {status}: {body}")
        self.status = status
        self.body = body


@dataclass
class FinancialAccount:
    id: str
    balance_usd: float
    available_usd: float
    raw: dict


@dataclass
class OutboundPayment:
    id: str
    status: str
    amount: float
    currency: str
    raw: dict


class StripeTreasuryClient:
    def __init__(self, api_key: str, base_url: str = "http://stripe-treasury.mock",
                 timeout: float = 5.0, transport: httpx.BaseTransport | None = None):
        self._api_key = api_key
        self._http = httpx.Client(
            base_url=base_url,
            timeout=timeout,
            transport=transport,
            headers={"Authorization": f"Bearer {api_key}", "User-Agent": "lynx-sdk-stripe/0.1.0"},
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "StripeTreasuryClient":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    def _post(self, path: str, body: dict, *, idempotency_key: str | None = None,
              attempt: int = 0) -> dict:
        headers: dict[str, str] = {"X-Attempt": str(attempt)}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        r = self._http.post(path, json=body, headers=headers)
        if r.status_code >= 400:
            try:
                data = r.json()
            except Exception:
                data = {"error": r.text}
            raise StripeError(r.status_code, data)
        return r.json()

    def get_financial_account(self, account_id: str, *, attempt: int = 0) -> FinancialAccount:
        data = self._post("/v1/treasury/financial_accounts/lookup",
                          {"account_id": account_id}, attempt=attempt)
        return FinancialAccount(
            id=data.get("id", account_id),
            balance_usd=float(data.get("balance_usd", 0.0)),
            available_usd=float(data.get("available_usd", 0.0)),
            raw=data,
        )

    def create_outbound_payment(self, *, amount: float, currency: str,
                                destination: str, idempotency_key: str,
                                metadata: dict[str, Any] | None = None,
                                attempt: int = 0) -> OutboundPayment:
        body = {"amount": amount, "currency": currency, "destination": destination}
        if metadata:
            body["metadata"] = metadata
        data = self._post("/v1/treasury/outbound_payments", body,
                          idempotency_key=idempotency_key, attempt=attempt)
        return OutboundPayment(
            id=data.get("id", ""),
            status=data.get("status", "pending"),
            amount=float(data.get("amount", amount)),
            currency=data.get("currency", currency),
            raw=data,
        )
