"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Validates that agent tool wrappers reach their intended providers, including rail-based payment routing and multi-ERP selection.
"""
from __future__ import annotations

import pytest

from app.agents import tools as tool_fns
from app.services import partners


@pytest.fixture(autouse=True)
def _reset_partners():
    partners.reset()
    yield
    partners.reset()


def _provider_of(result: dict) -> str:
    return result.get("provider", "")


# --------------------------------------------------------------------------- #
# Rail-based payment routing reaches three distinct providers
# --------------------------------------------------------------------------- #
def test_rail_routes_card_to_meridian(providerlab):
    res = tool_fns.submit_payment("r", "a", "us-axiom-cloud", 100.0, "USD", "CARD", "ref-1")
    assert _provider_of(res) == "meridian-pay"


def test_rail_routes_ach_to_halcyon(providerlab):
    res = tool_fns.submit_payment("r", "a", "us-axiom-cloud", 100.0, "USD", "ACH", "ref-2")
    assert _provider_of(res) == "halcyon-bank"
    assert res["operation"] == "initiate_payment"


def test_rail_routes_wire_to_quetzal(providerlab):
    res = tool_fns.submit_payment("r", "a", "us-axiom-cloud", 100.0, "USD", "WIRE", "ref-3")
    assert _provider_of(res) == "quetzal-payouts"


# --------------------------------------------------------------------------- #
# ERP selection reaches both accounting back ends
# --------------------------------------------------------------------------- #
def test_erp_selector_routes_to_both(providerlab):
    ironbark = tool_fns.match_invoice("r", "a", "v1", "INV-1", 100.0, "USD", erp="ironbark")
    assert _provider_of(ironbark) == "ironbark-erp"
    tallyhall = tool_fns.match_invoice("r", "a", "v1", "INV-1", 100.0, "USD", erp="tallyhall")
    assert _provider_of(tallyhall) == "tallyhall-books"


def test_erp_auto_is_deterministic(providerlab):
    a = tool_fns.match_invoice("r", "a", "us-axiom-cloud", "INV-9", 100.0, "USD")
    b = tool_fns.match_invoice("r", "a", "us-axiom-cloud", "INV-9", 100.0, "USD")
    assert _provider_of(a) == _provider_of(b)
    assert _provider_of(a) in ("ironbark-erp", "tallyhall-books")


# --------------------------------------------------------------------------- #
# Previously-orphaned providers are now reachable through dedicated tools
# --------------------------------------------------------------------------- #
def test_procurement_requisition_flow(providerlab):
    res = tool_fns.create_requisition("r", "a", "engineering", 5000, "laptops")
    assert _provider_of(res) == "junction-procure"
    assert res["data"]["status"] in ("approved", "pending_approval")


def test_identity_directory_reachable(providerlab):
    res = tool_fns.list_approver_groups("r", "a")
    assert _provider_of(res) == "lumen-identity"
    assert "items" in res["data"]


def test_identity_org_and_access_tools_reachable(providerlab):
    chain = tool_fns.resolve_approver_chain("r", "a", "EMP-1002")
    assert _provider_of(chain) == "lumen-identity"
    assert chain["data"]["chain"][-1]["id"] == "EMP-1001"

    access = tool_fns.check_user_access("r", "a", "EMP-1001")
    assert _provider_of(access) == "lumen-identity"
    assert "directory:read" in access["data"]["permissions"]

    members = tool_fns.list_team_members("r", "a", "TEAM-ap")
    assert _provider_of(members) == "lumen-identity"
    assert all(u["teamId"] == "TEAM-ap" for u in members["data"]["items"])

    svc = tool_fns.get_service_identity("r", "a", "SVC-ap-bot")
    assert _provider_of(svc) == "lumen-identity"
    assert svc["data"]["ownerTeamId"] == "TEAM-ap"


def test_market_snapshot_reachable(providerlab):
    res = tool_fns.get_market_snapshot("r", "a", "USD/EUR")
    assert _provider_of(res) == "pulse-market"
    assert "mid" in res["data"]


def test_crm_activity_reachable(providerlab):
    res = tool_fns.log_supplier_activity("r", "a", "CONT-00001", "call")
    assert _provider_of(res) == "beacon-crm"


def test_crm_account_and_pipeline_reachable(providerlab):
    contact = tool_fns.get_supplier_contact("r", "a", "CONT-00001")["data"]
    account_id = contact["accountId"]

    account = tool_fns.get_supplier_account("r", "a", account_id)
    assert _provider_of(account) == "beacon-crm"
    assert account["data"]["id"] == account_id

    contacts = tool_fns.list_supplier_contacts("r", "a", account_id)
    assert all(ct["accountId"] == account_id for ct in contacts["data"]["items"])

    deals = tool_fns.list_supplier_deals("r", "a", account_id)
    assert _provider_of(deals) == "beacon-crm"
    assert all(d["status"] == "open" for d in deals["data"]["items"])

    note = tool_fns.add_supplier_note("r", "a", "CONT-00001", "Reviewed payment terms.")
    assert note["data"]["body"] == "Reviewed payment terms."


# --------------------------------------------------------------------------- #
# Tool-payload correctness fixes
# --------------------------------------------------------------------------- #
def test_quickbooks_match_creates_then_matches(providerlab):
    res = tool_fns.quickbooks_match_bill("r", "a", "QBV-001", "INV-7", 250.0, "USD")
    # Either the bill matched, or the vendor is unknown to QuickBooks (realistic 404).
    assert _provider_of(res) == "tallyhall-books"
    assert res["operation"] in ("create_bill", "match_bill")


def test_payment_status_reads_charge(providerlab):
    created = partners.call("meridian-pay", "create_charge",
                            {"amount": 500, "currency": "USD", "source": "tok_visa"})
    charge_id = created["data"]["chargeId"]
    res = tool_fns.get_payment_status("r", "a", charge_id)
    assert res["operation"] == "get_charge"
    assert res["data"]["chargeId"] == charge_id


def test_receivables_capture_and_refund_reach_meridian(providerlab):
    captured = tool_fns.capture_receivable("r", "a", "cus_1", 320.0, "USD", "tok_visa")
    assert _provider_of(captured) == "meridian-pay"
    assert captured["operation"] == "create_charge"
    charge_id = captured["data"]["chargeId"]
    refunded = tool_fns.refund_receivable("r", "a", charge_id, 120.0)
    assert _provider_of(refunded) == "meridian-pay"
    assert refunded["data"]["status"] == "succeeded"
    assert refunded["data"]["amount"] == 120.0


def test_payment_dispute_listing_reaches_meridian(providerlab):
    res = tool_fns.list_payment_disputes("r", "a")
    assert _provider_of(res) == "meridian-pay"
    assert "items" in res["data"]


# --------------------------------------------------------------------------- #
# FX conversion and end-to-end settlement reach Cordoba FX
# --------------------------------------------------------------------------- #
def test_fx_rate_and_convert_reach_cordoba(providerlab):
    rate = tool_fns.get_fx_rate("r", "a", "USD", "EUR")
    assert _provider_of(rate) == "cordoba-fx" and rate["operation"] == "get_quote"
    assert rate["data"]["currency_pair"] == "EURUSD"
    conv = tool_fns.convert_currency("r", "a", "USD", "EUR", 10000.0)
    assert _provider_of(conv) == "cordoba-fx" and conv["operation"] == "create_conversion"
    assert conv["data"]["status"] == "awaiting_funds"


def test_settle_vendor_fx_payment_chains_conversion_beneficiary_payment(providerlab):
    res = tool_fns.settle_vendor_fx_payment(
        "r", "a", "Granite Industries", 7500.0, "EUR", sell_currency="USD",
        bank_country="DE", iban="DE89370400440532013000", reference="INV-7500")
    assert _provider_of(res) == "cordoba-fx" and res["operation"] == "create_payment"
    payment = res["data"]
    assert payment["status"] == "ready_to_send"
    assert payment["conversion_id"] and payment["currency"] == "EUR"
    settled = tool_fns.get_fx_settlement_status("r", "a", payment["id"])
    assert settled["data"]["status"] in ("submitted", "completed")



# --------------------------------------------------------------------------- #
# Treasury tools reach Keystone over its gRPC-style surface
# --------------------------------------------------------------------------- #
def test_cash_position_and_summary_reach_keystone(providerlab):
    pos = tool_fns.get_cash_position("r", "a", "US")
    assert _provider_of(pos) == "keystone-treasury" and pos["operation"] == "get_position"
    assert pos["data"]["currency"] == "USD" and pos["data"]["accountCount"] >= 1

    summary = tool_fns.get_treasury_summary("r", "a")
    assert _provider_of(summary) == "keystone-treasury"
    assert summary["data"]["reportingCurrency"] == "USD"
    assert summary["data"]["byCurrency"]


def test_forecast_and_exposure_reach_keystone(providerlab):
    fc = tool_fns.forecast_liquidity("r", "a", 30, "stress")
    assert _provider_of(fc) == "keystone-treasury" and fc["data"]["scenario"] == "stress"
    assert fc["data"]["points"]

    exp = tool_fns.get_fx_exposure("r", "a", "EUR")
    assert _provider_of(exp) == "keystone-treasury" and exp["operation"] == "get_exposure"
    assert "unhedgedAmount" in exp["data"]


def test_hedge_and_transfer_reach_keystone(providerlab):
    hedge = tool_fns.place_fx_hedge("r", "a", "EUR", "USD", 1_000_000.0, 90)
    assert _provider_of(hedge) == "keystone-treasury" and hedge["operation"] == "place_hedge"
    assert hedge["data"]["status"] == "booked" and hedge["data"]["instrument"] == "forward"

    transfer = tool_fns.transfer_funds("r", "a", "US", "DE", 25_000.0)
    assert _provider_of(transfer) == "keystone-treasury"
    assert transfer["data"]["type"] == "intercompany"
