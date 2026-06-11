"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Validates the Junction Procurement provider: OAuth2 client-credentials auth, the procure-to-pay flow, tiered approval chains, cost-center budget controls, and goods receipts.
"""
from __future__ import annotations

import itertools
import os

os.environ.setdefault("PROVIDERLAB_FAST", "1")

from fastapi.testclient import TestClient

from _mock.providerlab import catalog, credentials
from _mock.providerlab.app import build_app

_caller = itertools.count(1)


def _client() -> TestClient:
    return TestClient(build_app(catalog.get("junction-procure")),
                      headers={"X-Api-Key": f"test-caller-{next(_caller)}"})


def _seed() -> dict:
    return credentials.load("junction-procure").data["seed"]


def _token(c: TestClient, scope: str = "procure.read procure.write") -> str:
    s = _seed()
    data = {"grant_type": "client_credentials", "client_id": s["clientId"],
            "client_secret": s["clientSecret"], "scope": scope}
    return c.post("/oauth/token", data=data).json()["access_token"]


def _api(c: TestClient, token: str, op: str, body: dict):
    return c.post(f"/api/{op}", json=body, headers={"Authorization": f"Bearer {token}"})


def _active_supplier(c: TestClient, token: str) -> dict:
    body = _api(c, token, "list_suppliers", {"status": "active", "pageSize": 1}).json()
    return body["data"]["items"][0]


# --------------------------------------------------------------------------- #
# OAuth2 client credentials
# --------------------------------------------------------------------------- #
def test_metadata_advertises_client_credentials():
    doc = _client().get("/.well-known/oauth-authorization-server").json()
    assert doc["grant_types_supported"] == ["client_credentials"]
    assert set(doc["scopes_supported"]) == {"procure.read", "procure.write"}
    assert "resource" not in doc


def test_invalid_client_is_rejected():
    c = _client()
    bad = c.post("/oauth/token", data={
        "grant_type": "client_credentials", "client_id": "cid_nope",
        "client_secret": "cs_nope", "scope": "procure.read"})
    assert bad.status_code == 401 and bad.json()["error"] == "invalid_client"


def test_scope_beyond_grant_is_rejected():
    c = _client()
    s = _seed()
    bad = c.post("/oauth/token", data={
        "grant_type": "client_credentials", "client_id": s["clientId"],
        "client_secret": s["clientSecret"], "scope": "procure.admin"})
    assert bad.status_code == 400 and bad.json()["error"] == "invalid_scope"


def test_read_token_cannot_write():
    c = _client()
    token = _token(c, scope="procure.read")
    denied = _api(c, token, "create_requisition",
                  {"department": "engineering", "amount": 1000, "description": "mouse"})
    assert denied.status_code == 403 and denied.json()["error"] == "insufficient_scope"


def test_missing_token_is_unauthorized():
    c = _client()
    assert c.post("/api/list_suppliers", json={}).status_code == 401


# --------------------------------------------------------------------------- #
# Supplier master and commodity catalog
# --------------------------------------------------------------------------- #
def test_supplier_listing_and_lookup():
    c = _client()
    token = _token(c, scope="procure.read")
    listed = _api(c, token, "list_suppliers", {"status": "active"}).json()["data"]
    assert listed["total"] >= 1
    supplier = listed["items"][0]
    assert supplier["status"] == "active"
    one = _api(c, token, "get_supplier", {"supplierId": supplier["supplierId"]}).json()["data"]
    assert one["supplierId"] == supplier["supplierId"]
    assert {"paymentTerms", "commodityCode", "remitToAddress"} <= set(one)
    missing = _api(c, token, "get_supplier", {"supplierId": "SUP-000000"})
    assert missing.status_code == 404 and missing.json()["error"] == "supplier_not_found"


def test_commodity_catalog_is_unspsc_shaped():
    c = _client()
    token = _token(c, scope="procure.read")
    items = _api(c, token, "list_commodities", {}).json()["data"]["items"]
    assert items and all(len(i["commodityCode"]) == 8 and i["commodityCode"].isdigit() for i in items)


# --------------------------------------------------------------------------- #
# Requisition approval matrix
# --------------------------------------------------------------------------- #
def test_sub_threshold_requisition_is_auto_approved():
    c = _client()
    token = _token(c)
    req = _api(c, token, "create_requisition",
               {"department": "engineering", "amount": 900, "description": "Keyboard"}).json()["data"]
    assert req["status"] == "approved" and req["approval"]["policyTier"] == 0
    assert req["requisitionNumber"].startswith("REQ-2026-")


def test_single_step_requisition_routes_for_approval():
    c = _client()
    token = _token(c)
    req = _api(c, token, "create_requisition",
               {"department": "engineering", "amount": 8000, "description": "Laptops"}).json()["data"]
    assert req["status"] == "pending_approval" and req["approval"]["policyTier"] == 1
    chain = _api(c, token, "get_approval_chain", {"requisitionId": req["requisitionId"]}).json()["data"]
    assert chain["chain"][0]["role"] == "Cost Center Manager"
    approved = _api(c, token, "approve_requisition", {"requisitionId": req["requisitionId"]}).json()["data"]
    assert approved["status"] == "approved"
    again = _api(c, token, "approve_requisition", {"requisitionId": req["requisitionId"]})
    assert again.status_code == 409 and again.json()["error"] == "already_approved"


def test_multi_step_chain_requires_every_signature():
    c = _client()
    token = _token(c)
    req = _api(c, token, "create_requisition",
               {"department": "it", "amount": 60000, "description": "Network refresh"}).json()["data"]
    assert req["approval"]["policyTier"] == 2
    first = _api(c, token, "approve_requisition", {"requisitionId": req["requisitionId"]}).json()["data"]
    assert first["status"] == "pending_approval"
    second = _api(c, token, "approve_requisition", {"requisitionId": req["requisitionId"]}).json()["data"]
    assert second["status"] == "approved"


def test_wrong_approver_is_rejected():
    c = _client()
    token = _token(c)
    req = _api(c, token, "create_requisition",
               {"department": "engineering", "amount": 8000, "description": "Laptops"}).json()["data"]
    denied = _api(c, token, "approve_requisition",
                  {"requisitionId": req["requisitionId"], "approverId": "EMP-9999"})
    assert denied.status_code == 403 and denied.json()["error"] == "not_authorized_approver"


def test_requisition_can_be_rejected():
    c = _client()
    token = _token(c)
    req = _api(c, token, "create_requisition",
               {"department": "marketing", "amount": 12000, "description": "Campaign"}).json()["data"]
    rejected = _api(c, token, "reject_requisition",
                    {"requisitionId": req["requisitionId"], "comment": "Deferred"}).json()["data"]
    assert rejected["status"] == "rejected"
    denied = _api(c, token, "approve_requisition", {"requisitionId": req["requisitionId"]})
    assert denied.status_code == 409 and denied.json()["error"] == "requisition_rejected"


def test_unknown_cost_center_is_not_found():
    c = _client()
    token = _token(c)
    res = _api(c, token, "create_requisition",
               {"department": "nowhere", "amount": 100, "description": "x"})
    assert res.status_code == 404 and res.json()["error"] == "cost_center_not_found"


def test_non_positive_amount_is_invalid():
    c = _client()
    token = _token(c)
    res = _api(c, token, "create_requisition",
               {"department": "engineering", "amount": 0, "description": "x"})
    assert res.status_code == 422 and res.json()["error"] == "invalid_amount"


# --------------------------------------------------------------------------- #
# Budget enforcement
# --------------------------------------------------------------------------- #
def test_hard_limit_blocks_final_approval():
    c = _client()
    token = _token(c)
    req = _api(c, token, "create_requisition",
               {"department": "legal", "amount": 50_000_000, "description": "Acquisition"}).json()["data"]
    assert req["approval"]["policyTier"] == 3
    _api(c, token, "approve_requisition", {"requisitionId": req["requisitionId"]})
    _api(c, token, "approve_requisition", {"requisitionId": req["requisitionId"]})
    final = _api(c, token, "approve_requisition", {"requisitionId": req["requisitionId"]})
    assert final.status_code == 409 and final.json()["error"] == "budget_exceeded"


def test_budget_view_exposes_commitment_accounting():
    c = _client()
    token = _token(c, scope="procure.read")
    budget = _api(c, token, "get_budget", {"department": "engineering"}).json()["data"]
    assert {"budgetAmount", "committedAmount", "spentAmount", "availableAmount",
            "consumedAmount", "softLimitAmount"} <= set(budget)
    by_code = _api(c, token, "get_budget", {"costCenter": budget["costCenter"]}).json()["data"]
    assert by_code["costCenter"] == budget["costCenter"]


# --------------------------------------------------------------------------- #
# Requisition -> purchase order -> goods receipt
# --------------------------------------------------------------------------- #
def test_full_procure_to_pay_flow_closes_and_spends_budget():
    c = _client()
    token = _token(c)
    supplier = _active_supplier(c, token)
    before = _api(c, token, "get_budget", {"department": "operations"}).json()["data"]["spentAmount"]

    req = _api(c, token, "create_requisition",
               {"department": "operations", "amount": 9000, "description": "Forklift parts"}).json()["data"]
    _api(c, token, "approve_requisition", {"requisitionId": req["requisitionId"]})

    po = _api(c, token, "create_purchase_order",
              {"requisitionId": req["requisitionId"], "supplierId": supplier["supplierId"]}).json()["data"]
    assert po["status"] == "issued" and po["poNumber"].startswith("PO-2026-")

    ack = _api(c, token, "acknowledge_order", {"poId": po["poId"]}).json()["data"]
    assert ack["status"] == "acknowledged"

    received = _api(c, token, "receive_order", {"poId": po["poId"]}).json()["data"]
    assert received["purchaseOrder"]["status"] == "received"

    closed = _api(c, token, "get_requisition", {"requisitionId": req["requisitionId"]}).json()["data"]
    assert closed["status"] == "closed"
    after = _api(c, token, "get_budget", {"department": "operations"}).json()["data"]["spentAmount"]
    assert round(after - before, 2) == req["total"]


def test_purchase_order_requires_approved_requisition():
    c = _client()
    token = _token(c)
    supplier = _active_supplier(c, token)
    req = _api(c, token, "create_requisition",
               {"department": "engineering", "amount": 8000, "description": "Laptops"}).json()["data"]
    denied = _api(c, token, "create_purchase_order",
                  {"requisitionId": req["requisitionId"], "supplierId": supplier["supplierId"]})
    assert denied.status_code == 409 and denied.json()["error"] == "requisition_not_approved"


def test_purchase_order_rejects_inactive_supplier():
    c = _client()
    token = _token(c)
    inactive = next((s for s in _api(c, token, "list_suppliers", {"pageSize": 100}).json()["data"]["items"]
                     if s["status"] != "active"), None)
    if inactive is None:
        return
    req = _api(c, token, "create_requisition",
               {"department": "facilities", "amount": 7000, "description": "HVAC"}).json()["data"]
    _api(c, token, "approve_requisition", {"requisitionId": req["requisitionId"]})
    denied = _api(c, token, "create_purchase_order",
                  {"requisitionId": req["requisitionId"], "supplierId": inactive["supplierId"]})
    assert denied.status_code == 409 and denied.json()["error"] == "supplier_inactive"


def test_partial_receipt_keeps_order_open():
    c = _client()
    token = _token(c)
    supplier = _active_supplier(c, token)
    req = _api(c, token, "create_requisition", {
        "department": "engineering", "description": "Workstations",
        "lines": [{"description": "Workstation", "quantity": 10, "unitPrice": 1500.0,
                   "commodityCode": "43211500", "glAccount": "1500"}],
    }).json()["data"]
    assert req["total"] == 15000.0
    _api(c, token, "approve_requisition", {"requisitionId": req["requisitionId"]})
    po = _api(c, token, "create_purchase_order",
              {"requisitionId": req["requisitionId"], "supplierId": supplier["supplierId"]}).json()["data"]
    partial = _api(c, token, "receive_order",
                   {"poId": po["poId"], "lines": [{"lineNumber": 1, "quantityReceived": 4}]}).json()["data"]
    assert partial["purchaseOrder"]["status"] == "partially_received"
    over = _api(c, token, "receive_order",
                {"poId": po["poId"], "lines": [{"lineNumber": 1, "quantityReceived": 999}]})
    assert over.status_code == 422 and over.json()["error"] == "invalid_quantity"


# --------------------------------------------------------------------------- #
# LynxCapital exercises the procurement surface through its agent tools
# --------------------------------------------------------------------------- #
def test_lynxcapital_procurement_tools_reach_junction(providerlab):
    from app.agents import tools as tool_fns

    suppliers = tool_fns.procurement_list_suppliers("run", "agent", "active")
    assert suppliers["provider"] == "junction-procure" and suppliers["data"]["total"] >= 1
    supplier_id = suppliers["data"]["items"][0]["supplierId"]

    req = tool_fns.create_requisition("run", "agent", "engineering", 8000.0, "Laptops")
    assert req["data"]["status"] == "pending_approval"

    chain = tool_fns.get_approval_chain("run", "agent", req["data"]["requisitionId"])
    assert chain["data"]["chain"][0]["role"] == "Cost Center Manager"

    approved = tool_fns.approve_requisition("run", "agent", req["data"]["requisitionId"])
    assert approved["data"]["status"] == "approved"

    po = tool_fns.create_purchase_order("run", "agent", req["data"]["requisitionId"], supplier_id)
    assert po["data"]["status"] == "issued"

    received = tool_fns.receive_purchase_order("run", "agent", po["data"]["poId"])
    assert received["data"]["purchaseOrder"]["status"] == "received"
