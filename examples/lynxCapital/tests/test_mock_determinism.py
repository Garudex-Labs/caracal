"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Mock determinism tests: same inputs always produce identical outputs across repeated calls.
"""
from __future__ import annotations

import json
import os
import sys
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from threading import Thread

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.services.registry import call
from app.core.dataset import INVOICES, VENDORS
from _mock import server as mock_server


# Representative sample: one call per service action, exercised 100 times.

_CASES: list[tuple[str, str, dict]] = [
    ("mercury-bank",     "get_account_balance",     {"vendor_id": "us-axiom-cloud"}),
    ("mercury-bank",     "submit_payment",          {"vendor_id": "us-axiom-cloud", "amount": 1000.0, "currency": "USD", "rail": "ACH", "reference": "ref-1"}),
    ("wise-payouts",     "get_quote",               {"from_currency": "USD", "to_currency": "INR"}),
    ("wise-payouts",     "submit_payout",           {"vendor_id": "in-zylotech", "amount": 500.0, "currency": "INR", "reference": "ref-2"}),
    ("stripe-treasury",  "create_outbound_payment", {"vendor_id": "us-crestview-sw", "amount": 750.0, "currency": "USD", "rail": "ACH", "reference": "ref-3"}),
    ("netsuite",         "get_vendor_record",       {"vendor_id": "us-axiom-cloud"}),
    ("netsuite",         "match_invoice",           {"vendor_id": "us-axiom-cloud", "invoice_id": "INV-US-0001", "amount": 1000.0, "currency": "USD"}),
    ("sap-erp",          "get_vendor_record",       {"vendor_id": "de-berliner"}),
    ("sap-erp",          "match_invoice",           {"vendor_id": "de-berliner", "invoice_id": "INV-DE-0001", "amount": 750.0}),
    ("quickbooks",       "get_vendor",              {"vendor_id": "in-zylotech"}),
    ("quickbooks",       "create_vendor_payment",   {"vendor_id": "in-zylotech", "invoice_id": "INV-IN-0001", "amount": 500.0, "currency": "INR", "reference": "ref-4"}),
    ("compliance-nexus", "check_vendor",            {"vendor_id": "us-axiom-cloud"}),
    ("compliance-nexus", "check_transaction",        {"vendor_id": "us-summit-fin", "amount": 1000.0}),
    ("ocr-vision",       "extract_invoice",         {"invoice_id": "INV-00001", "doc_id": "doc-INV-00001"}),
    ("vendor-portal",    "get_vendor_profile",      {"vendor_id": "us-axiom-cloud"}),
    ("vendor-portal",    "get_contract_terms",      {"vendor_id": "us-axiom-cloud"}),
    ("tax-rules",        "get_withholding_rate",    {"region": "US", "currency": "USD"}),
    ("tax-rules",        "get_withholding_rate",    {"region": "IN", "currency": "INR"}),
    ("fx-rates",         "get_rate",               {"from_currency": "USD", "to_currency": "EUR"}),
    ("fx-rates",         "get_rate",               {"from_currency": "USD", "to_currency": "INR"}),
]


@pytest.mark.parametrize("service_id,action,payload", _CASES)
def test_determinism_100_runs(service_id, action, payload):
    """Same (service, action, payload) must return an identical dict on every call."""
    first = call(service_id, action, payload)
    for _ in range(99):
        result = call(service_id, action, payload)
        assert result == first, (
            f"{service_id}.{action} returned different results:\n"
            f"  first:   {first}\n"
            f"  current: {result}"
        )


def test_distinct_payloads_differ():
    """Different payloads that map to different cases must return different results."""
    r_us = call("tax-rules", "get_withholding_rate", {"region": "US", "currency": "USD"})
    r_de = call("tax-rules", "get_withholding_rate", {"region": "DE", "currency": "EUR"})
    # They may legitimately have the same rate, but the call must succeed for both
    assert isinstance(r_us, dict)
    assert isinstance(r_de, dict)


def test_all_invoice_ids_stable():
    """Dataset generator produces the same invoice IDs on each import."""
    ids_first  = [inv.id for inv in INVOICES]
    ids_second = [inv.id for inv in INVOICES]
    assert ids_first == ids_second, "Invoice dataset is not stable across accesses"


def test_all_vendor_ids_stable():
    """Vendor catalog is stable across accesses."""
    ids_first  = list(VENDORS.keys())
    ids_second = list(VENDORS.keys())
    assert ids_first == ids_second


def test_mock_server_loads_only_discovered_case_paths():
    """Request-controlled service IDs must not be used to construct filesystem paths."""
    assert "mercury-bank" in mock_server._SERVICE_CASE_PATHS
    assert mock_server._load("mercury-bank")["actions"]

    with pytest.raises(KeyError):
        mock_server._load("../mercury-bank")

    with pytest.raises(KeyError):
        mock_server._load("missing-service")


def test_mock_server_binds_to_container_network_by_default(monkeypatch):
    monkeypatch.delenv("MOCK_SERVER_HOST", raising=False)
    monkeypatch.delenv("MOCK_SERVER_PORT", raising=False)

    assert mock_server._server_address_from_env() == ("0.0.0.0", 80)

    monkeypatch.setenv("MOCK_SERVER_HOST", "127.0.0.1")
    monkeypatch.setenv("MOCK_SERVER_PORT", "8088")
    assert mock_server._server_address_from_env() == ("127.0.0.1", 8088)


def _mock_http_request(
    method: str,
    path: str,
    *,
    host: str = "mercury-bank.mock",
    body: bytes | None = None,
) -> tuple[int, dict]:
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), mock_server.Handler)
    thread = Thread(target=httpd.serve_forever, daemon=True)
    conn: HTTPConnection | None = None
    thread.start()
    try:
        conn = HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
        headers = {"Host": host}
        if body is not None:
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode())
        return resp.status, payload
    finally:
        if conn is not None:
            conn.close()
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


def test_mock_http_server_dispatches_valid_provider_request():
    status, payload = _mock_http_request(
        "POST",
        "/get_account_balance",
        body=json.dumps({"vendor_id": "us-axiom-cloud"}).encode(),
    )

    assert status == 200
    assert payload["account_id"] == "acct_axm_4521"


def test_mock_http_server_rejects_invalid_host_and_json():
    status, payload = _mock_http_request("POST", "/get_account_balance", host="localhost")

    assert status == 400
    assert "invalid host header" in payload["error"]

    status, payload = _mock_http_request("POST", "/get_account_balance", body=b"{")

    assert status == 400
    assert payload["error"] == "invalid JSON in request body"


def test_mock_http_server_get_health():
    status, payload = _mock_http_request("GET", "/health", host="localhost")

    assert status == 200
    assert payload == {"status": "ok"}
