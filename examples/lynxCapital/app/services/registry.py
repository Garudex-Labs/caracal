"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Service registry: declarative provider table that dispatches each
(service_id, action, payload) tuple to its real protocol-specific client.
"""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from typing import Any, Callable

import httpx

from app.services.resilience import RetryPolicy, idempotency_key
from app.services.transport.rest import AuthSpec, RestClient, RestEndpoint


_REST_PROVIDERS: dict[str, dict] = {
    "mercury-bank": {
        "base_url_env": "LYNX_MERCURY_URL",
        "base_url_default": "http://mercury-bank.mock",
        "auth": AuthSpec("Authorization", "Bearer ", "LYNX_MERCURY_KEY"),
        "timeout_s": 4.0,
        "actions": {
            "get_account_balance": RestEndpoint("POST", "/v1/accounts/balance"),
            "submit_payment":      RestEndpoint("POST", "/v1/payments", idempotent_write=True),
        },
    },
    "wise-payouts": {
        "base_url_env": "LYNX_WISE_URL",
        "base_url_default": "http://wise-payouts.mock",
        "auth": AuthSpec("Authorization", "Bearer ", "LYNX_WISE_KEY"),
        "timeout_s": 4.0,
        "actions": {
            "get_quote":     RestEndpoint("POST", "/v1/quotes"),
            "submit_payout": RestEndpoint("POST", "/v1/transfers", idempotent_write=True),
        },
    },
    "quickbooks": {
        "base_url_env": "LYNX_QB_URL",
        "base_url_default": "http://quickbooks.mock",
        "auth": AuthSpec("Authorization", "Bearer ", "LYNX_QB_KEY"),
        "timeout_s": 4.0,
        "actions": {
            "get_vendor":             RestEndpoint("POST", "/v3/vendor"),
            "match_bill":             RestEndpoint("POST", "/v3/bill", idempotent_write=True),
            "create_vendor_payment":  RestEndpoint("POST", "/v3/billpayment", idempotent_write=True),
        },
    },
    "customer-billing": {
        "base_url_env": "LYNX_BILLING_URL",
        "base_url_default": "http://customer-billing.mock",
        "auth": AuthSpec("Authorization", "Bearer ", "LYNX_BILLING_KEY"),
        "timeout_s": 4.0,
        "actions": {
            "issue_customer_invoice":   RestEndpoint("POST", "/v1/invoices", idempotent_write=True),
            "send_dunning_notice":      RestEndpoint("POST", "/v1/dunning", idempotent_write=True),
            "apply_customer_payment":   RestEndpoint("POST", "/v1/payments/apply", idempotent_write=True),
            "get_ar_aging":             RestEndpoint("POST", "/v1/ar_aging"),
        },
    },
    "fx-rates": {
        "base_url_env": "LYNX_FX_URL",
        "base_url_default": "http://fx-rates.mock",
        "auth": AuthSpec("X-API-Key", "", "LYNX_FX_KEY"),
        "timeout_s": 3.0,
        "actions": {
            "get_rate":        RestEndpoint("POST", "/v1/rate"),
            "get_rates_batch": RestEndpoint("POST", "/v1/rates/batch"),
        },
    },
    "compliance-nexus": {
        "base_url_env": "LYNX_COMPLIANCE_URL",
        "base_url_default": "http://compliance-nexus.mock",
        "auth": AuthSpec("Authorization", "Bearer ", "LYNX_COMPLIANCE_KEY"),
        "timeout_s": 4.0,
        "actions": {
            "check_vendor":               RestEndpoint("POST", "/v1/vendor/check"),
            "check_transaction":          RestEndpoint("POST", "/v1/transaction/check"),
            "kyb_screen_vendor":          RestEndpoint("POST", "/v1/vendor/kyb", idempotent_write=True),
            "refresh_vendor_compliance":  RestEndpoint("POST", "/v1/vendor/refresh", idempotent_write=True),
        },
    },
}


_REST_JOB_PROVIDERS: dict[str, dict] = {
    "netsuite": {
        "base_url_env": "LYNX_NETSUITE_URL",
        "base_url_default": "http://netsuite.mock",
        "auth": AuthSpec("Authorization", "Bearer ", "LYNX_NETSUITE_KEY"),
        "timeout_s": 6.0,
        "poll_path": "/services/rest/v1/jobs",
        "sync_actions": {
            "get_vendor_record":  RestEndpoint("POST", "/services/rest/v1/get_vendor_record"),
            "get_payment_status": RestEndpoint("POST", "/services/rest/v1/get_payment_status"),
        },
        "job_actions": {
            "match_invoice": RestEndpoint("POST", "/services/rest/v1/match_invoice", idempotent_write=True),
        },
    },
    "sap-erp": {
        "base_url_env": "LYNX_SAP_URL",
        "base_url_default": "http://sap-erp.mock",
        "auth": AuthSpec("X-SAP-Token", "", "LYNX_SAP_KEY"),
        "timeout_s": 6.0,
        "poll_path": "/sap/opu/odata/sap/jobs",
        "sync_actions": {
            "get_vendor_record": RestEndpoint("POST", "/sap/opu/odata/sap/get_vendor_record"),
        },
        "job_actions": {
            "match_invoice":             RestEndpoint("POST", "/sap/opu/odata/sap/match_invoice", idempotent_write=True),
            "post_payment_confirmation": RestEndpoint("POST", "/sap/opu/odata/sap/post_payment_confirmation", idempotent_write=True),
        },
    },
    "ocr-vision": {
        "base_url_env": "LYNX_OCR_URL",
        "base_url_default": "http://ocr-vision.mock",
        "auth": AuthSpec("X-API-Key", "", "LYNX_OCR_KEY"),
        "timeout_s": 8.0,
        "poll_path": "/v1/documents/jobs",
        "sync_actions": {},
        "job_actions": {
            "extract_invoice": RestEndpoint("POST", "/v1/documents/extract_invoice", idempotent_write=True),
        },
    },
    "close-engine": {
        "base_url_env": "LYNX_CLOSE_URL",
        "base_url_default": "http://close-engine.mock",
        "auth": AuthSpec("Authorization", "Bearer ", "LYNX_CLOSE_KEY"),
        "timeout_s": 8.0,
        "poll_path": "/v1/close/jobs",
        "sync_actions": {},
        "job_actions": {
            "post_journal_entry": RestEndpoint("POST", "/v1/close/post_journal_entry", idempotent_write=True),
            "reconcile_account":  RestEndpoint("POST", "/v1/close/reconcile_account", idempotent_write=True),
            "compute_accrual":    RestEndpoint("POST", "/v1/close/compute_accrual", idempotent_write=True),
            "close_period":       RestEndpoint("POST", "/v1/close/close_period", idempotent_write=True),
        },
    },
    "regulatory-filings": {
        "base_url_env": "LYNX_REGULATORY_URL",
        "base_url_default": "http://regulatory-filings.mock",
        "auth": AuthSpec("Authorization", "Bearer ", "LYNX_REGULATORY_KEY"),
        "timeout_s": 8.0,
        "poll_path": "/v1/regulatory/jobs",
        "sync_actions": {},
        "job_actions": {
            "aml_monitor_transaction":   RestEndpoint("POST", "/v1/regulatory/aml_monitor_transaction"),
            "sanctions_screen_batch":    RestEndpoint("POST", "/v1/regulatory/sanctions_screen_batch", idempotent_write=True),
            "prepare_regulatory_filing": RestEndpoint("POST", "/v1/regulatory/prepare_regulatory_filing", idempotent_write=True),
            "attest_control":            RestEndpoint("POST", "/v1/regulatory/attest_control", idempotent_write=True),
        },
    },
}


_HTTP_TRANSPORT: httpx.BaseTransport | None = None
_TRANSPORT_LOCK = threading.Lock()


def set_http_transport(transport: httpx.BaseTransport | None) -> None:
    """Override the httpx transport (used by tests with ASGITransport)."""
    global _HTTP_TRANSPORT
    with _TRANSPORT_LOCK:
        _HTTP_TRANSPORT = transport
    reset()


@dataclass
class _RestEntry:
    client: RestClient
    actions: dict[str, RestEndpoint]
    job_actions: dict[str, RestEndpoint]
    poll_path: str | None


_CLIENT_CACHE: dict[str, Any] = {}
_CACHE_LOCK = threading.Lock()


def _build_rest(provider: str) -> _RestEntry:
    cfg = _REST_PROVIDERS.get(provider) or _REST_JOB_PROVIDERS.get(provider)
    if cfg is None:
        raise KeyError(f"REST provider not configured: {provider}")
    base_url = os.getenv(cfg["base_url_env"], cfg["base_url_default"])
    client = RestClient(
        provider, base_url, cfg["auth"],
        timeout_s=cfg.get("timeout_s", 5.0),
        policy=cfg.get("policy", RetryPolicy()),
        transport=_HTTP_TRANSPORT,
    )
    if provider in _REST_JOB_PROVIDERS:
        return _RestEntry(client, cfg.get("sync_actions", {}), cfg.get("job_actions", {}),
                          cfg.get("poll_path"))
    return _RestEntry(client, cfg["actions"], {}, None)


def _entry(provider: str) -> _RestEntry:
    with _CACHE_LOCK:
        e = _CLIENT_CACHE.get(provider)
        if not isinstance(e, _RestEntry):
            e = _CLIENT_CACHE[provider] = _build_rest(provider)
        return e


def _rest_call(provider: str, action: str, payload: dict) -> dict:
    e = _entry(provider)
    if action in e.actions:
        return e.client.call(e.actions[action], payload)
    if action in e.job_actions and e.poll_path:
        return e.client.submit_and_wait(e.job_actions[action], payload, poll_path=e.poll_path)
    raise KeyError(f"unknown action {action!r} for provider {provider!r}")


def _stripe_client():
    c = _CLIENT_CACHE.get("stripe-treasury")
    if c is not None:
        return c
    from lynx_sdk_stripe_treasury import StripeTreasuryClient
    base = os.getenv("LYNX_STRIPE_URL", "http://stripe-treasury.mock")
    c = StripeTreasuryClient(api_key=os.getenv("LYNX_STRIPE_KEY", ""),
                             base_url=base, transport=_HTTP_TRANSPORT)
    _CLIENT_CACHE["stripe-treasury"] = c
    return c


def _tax_client():
    c = _CLIENT_CACHE.get("tax-rules")
    if c is not None:
        return c
    from lynx_sdk_tax import TaxClient
    base = os.getenv("LYNX_TAX_URL", "http://tax-rules.mock")
    c = TaxClient(api_key=os.getenv("LYNX_TAX_KEY", ""),
                  base_url=base, transport=_HTTP_TRANSPORT)
    _CLIENT_CACHE["tax-rules"] = c
    return c


def _treasury_client():
    c = _CLIENT_CACHE.get("treasury-ops")
    if c is not None:
        return c
    from app.services.transport.grpc_client import GrpcClient
    target = os.getenv("LYNX_TREASURY_GRPC", "treasury-ops.mock:50051")
    c = GrpcClient("treasury-ops", target,
                   auth_header="metadata-token", auth_env="LYNX_TREASURY_KEY")
    _CLIENT_CACHE["treasury-ops"] = c
    return c


def _vendor_portal_client():
    c = _CLIENT_CACHE.get("vendor-portal")
    if c is not None:
        return c
    from app.services.transport.mcp import McpClient
    host = os.getenv("LYNX_MCP_HOST", "vendor-portal.mock")
    port = int(os.getenv("LYNX_MCP_PORT", "7800"))
    c = McpClient("vendor-portal", host, port, auth_env="LYNX_VENDOR_PORTAL_KEY")
    _CLIENT_CACHE["vendor-portal"] = c
    return c


def _stripe_call(action: str, payload: dict) -> dict:
    c = _stripe_client()
    if action == "get_financial_account":
        return c.get_financial_account(payload.get("vendor_id", "")).raw
    if action == "create_outbound_payment":
        return c.create_outbound_payment(
            amount=float(payload.get("amount", 0.0)),
            currency=str(payload.get("currency", "USD")),
            destination=str(payload.get("vendor_id", "")),
            idempotency_key=idempotency_key("stripe"),
            metadata={"reference": payload.get("reference", ""), "rail": payload.get("rail", "")},
        ).raw
    raise KeyError(f"unknown stripe action: {action}")


def _tax_call(action: str, payload: dict) -> dict:
    c = _tax_client()
    if action == "get_withholding_rate":
        return c.withholding(country=str(payload.get("region", "")),
                             vendor_type=str(payload.get("vendor_type", "service")),
                             amount=float(payload.get("amount", 0.0))).raw
    if action == "validate_tax_id":
        return c.validate_tax_id(tax_id=str(payload.get("vendor_id", "")),
                                 country=str(payload.get("country", "US"))).raw
    raise KeyError(f"unknown tax action: {action}")


def _treasury_call(action: str, payload: dict) -> dict:
    from app.services.transport.grpc_client import parse_json_payload
    from _mock.grpc.treasury_ops import treasury_pb2 as pb2
    from _mock.grpc.treasury_ops import treasury_pb2_grpc as pb2_grpc
    c = _treasury_client()
    if action == "get_cash_position":
        req = pb2.CashPositionRequest(entity_id=str(payload.get("region", "")))
        return parse_json_payload(c.unary(pb2_grpc.TreasuryOpsStub, "GetCashPosition", req))
    if action == "forecast_liquidity":
        req = pb2.ForecastRequest(entity_id=str(payload.get("region", "")),
                                  horizon_days=int(payload.get("horizon_days", 0)))
        return parse_json_payload(c.unary(pb2_grpc.TreasuryOpsStub, "ForecastLiquidity", req))
    if action == "place_fx_hedge":
        pair = f"{payload.get('from_currency','USD')}{payload.get('to_currency','USD')}"
        req = pb2.FxHedgeRequest(pair=pair,
                                 notional=float(payload.get("notional", 0.0)),
                                 tenor=str(payload.get("tenor_days", "30")))
        return parse_json_payload(c.unary(pb2_grpc.TreasuryOpsStub, "PlaceFxHedge", req))
    if action == "transfer_funds":
        req = pb2.TransferRequest(
            from_account=str(payload.get("from_region", "")),
            to_account=str(payload.get("to_region", "")),
            amount=float(payload.get("amount_usd", 0.0)),
            currency="USD",
            idempotency_key=idempotency_key("treasury"),
        )
        return parse_json_payload(c.unary(pb2_grpc.TreasuryOpsStub, "TransferFunds", req))
    raise KeyError(f"unknown treasury action: {action}")


def _vendor_portal_call(action: str, payload: dict) -> dict:
    c = _vendor_portal_client()
    name_map = {
        "get_vendor_profile":  "vendor.get_profile",
        "get_contract_terms":  "vendor.get_contract_terms",
        "register_vendor":     "vendor.register",
    }
    name = name_map.get(action)
    if name is None:
        raise KeyError(f"unknown vendor-portal action: {action}")
    return c.call_tool(name, payload)


_DISPATCH: dict[str, Callable[[str, dict], dict]] = {
    "stripe-treasury":  _stripe_call,
    "tax-rules":        _tax_call,
    "treasury-ops":     _treasury_call,
    "vendor-portal":    _vendor_portal_call,
}


def call(service_id: str, action: str, payload: dict) -> dict:
    """Dispatch a single (service, action, payload) to its real protocol client."""
    handler = _DISPATCH.get(service_id)
    if handler is not None:
        return handler(action, payload)
    if service_id in _REST_PROVIDERS or service_id in _REST_JOB_PROVIDERS:
        return _rest_call(service_id, action, payload)
    raise KeyError(f"Unknown service: {service_id!r}")


def reset() -> None:
    """Drop cached clients and circuit-breaker state (used by tests)."""
    from app.services.resilience import reset_breakers

    with _CACHE_LOCK:
        for c in list(_CLIENT_CACHE.values()):
            inner = getattr(c, "client", None)
            close = getattr(inner, "close", None) or getattr(c, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
        _CLIENT_CACHE.clear()
    reset_breakers()
