"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Catalog of the twenty external providers LynxCapital integrates with, each a realistic third-party service on its own localhost port.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Category = Literal[
    "api_key",
    "bearer_token",
    "oauth2_client_credentials",
    "oauth2_authorization_code",
    "caracal_mandate",
    "none",
    "mcp",
    "sdk",
]

Protocol = Literal["rest", "grpc", "mcp", "sse", "sdk"]

CATEGORIES: tuple[Category, ...] = (
    "api_key",
    "bearer_token",
    "oauth2_client_credentials",
    "oauth2_authorization_code",
    "caracal_mandate",
    "none",
    "mcp",
    "sdk",
)


@dataclass(frozen=True)
class Provider:
    """One external provider LynxCapital integrates with.

    Wire field names intentionally use third-party industry shapes
    (clientId, apiKey, accessToken) and never Caracal-internal naming.
    """

    id: str
    brand: str
    category: Category
    protocol: Protocol
    port: int
    industry: str
    tagline: str
    resources: tuple[str, ...]
    operations: tuple[str, ...]
    failure_profile: str = "standard"        # standard | flaky | strict | quiet
    llm_capable: bool = False
    apikey_location: str = "header"          # header | query
    apikey_field: str = "X-Api-Key"
    auth_header: str = "Authorization"
    auth_scheme: str = "Bearer"
    client_auth_method: str = "client_secret_basic"
    scopes: tuple[str, ...] = ()
    audience: str | None = None
    use_pkce: bool = False
    offline_access: bool = False
    require_delegation: bool = False
    mcp_auth: str = "bearer"                 # mcp: bearer | mandate
    sdk_package: str | None = None


CATALOG: tuple[Provider, ...] = (
    Provider(
        id="halcyon-bank", brand="Halcyon Bank", category="oauth2_authorization_code",
        protocol="rest", port=9400, industry="Banking",
        tagline="Open banking accounts, payments, and statements",
        resources=("accounts", "transactions", "payments", "statements"),
        operations=("list_accounts", "get_account", "list_transactions",
                    "initiate_payment", "get_payment", "get_statement"),
        failure_profile="flaky", scopes=("accounts.read", "payments.write"), use_pkce=True,
    ),
    Provider(
        id="meridian-pay", brand="Meridian Pay", category="api_key",
        protocol="rest", port=9401, industry="Payments",
        tagline="Card and wallet acceptance with refunds, disputes, settlements, and payouts",
        resources=("charges", "refunds", "disputes", "settlements", "payouts", "balances", "events"),
        operations=("create_charge", "get_charge", "capture_charge", "list_charges",
                    "refund_charge", "create_payout", "get_payout", "get_balance",
                    "list_disputes", "get_dispute", "submit_dispute_evidence",
                    "list_settlements", "get_settlement", "list_events"),
        failure_profile="standard", apikey_location="header", apikey_field="X-Api-Key",
    ),
    Provider(
        id="cordoba-fx", brand="Cordoba FX", category="oauth2_client_credentials",
        protocol="rest", port=9402, industry="Foreign exchange",
        tagline="Cross-border FX quotes, rate-locked conversions, beneficiaries, and settlement payments",
        resources=("quotes", "conversions", "beneficiaries", "payments", "balances"),
        operations=("get_quote", "create_conversion", "get_conversion",
                    "create_beneficiary", "get_beneficiary", "list_beneficiaries",
                    "create_payment", "get_payment", "list_balances"),
        client_auth_method="client_secret_basic", scopes=("fx.read", "fx.convert", "fx.transfer"),
    ),
    Provider(
        id="ironbark-erp", brand="Ironbark ERP", category="oauth2_client_credentials",
        protocol="rest", port=9403, industry="Enterprise ERP",
        tagline="Enterprise vendors, purchase orders, bills, three-way match, and ledger",
        resources=("vendors", "purchase_orders", "bills", "journal_entries", "accounts"),
        operations=("list_vendors", "get_vendor",
                    "list_purchase_orders", "get_purchase_order", "create_purchase_order",
                    "list_bills", "get_bill", "create_bill", "approve_bill",
                    "match_invoice",
                    "post_journal_entry", "get_journal_entry", "list_journal_entries",
                    "list_accounts", "get_account"),
        failure_profile="strict", client_auth_method="client_secret_post",
        scopes=("erp.read", "erp.write"), audience="https://api.ironbark-erp.test",
    ),
    Provider(
        id="tallyhall-books", brand="Tallyhall Books", category="oauth2_authorization_code",
        protocol="rest", port=9404, industry="SMB accounting",
        tagline="Small-business accounting for regional entities",
        resources=("vendors", "bills", "invoices", "payments", "accounts"),
        operations=("list_vendors", "get_vendor", "create_bill", "match_bill",
                    "create_invoice", "record_payment", "get_account"),
        scopes=("accounting.read", "accounting.write"), offline_access=True,
    ),
    Provider(
        id="slate-ledger", brand="Slate Ledger", category="bearer_token",
        protocol="rest", port=9405, industry="General ledger",
        tagline="Double-entry general ledger and financial close",
        resources=("journals", "entries", "accounts", "periods", "reconciliations"),
        operations=("post_entry", "get_entry", "get_account", "reconcile_account",
                    "compute_accrual", "close_period", "get_period"),
        failure_profile="strict", auth_header="Authorization", auth_scheme="Bearer",
    ),
    Provider(
        id="inkwell-ocr", brand="Inkwell OCR", category="api_key",
        protocol="rest", port=9406, industry="Document AI",
        tagline="Invoice capture and field extraction",
        resources=("documents", "extractions"),
        operations=("submit_document", "get_extraction", "list_documents"),
        llm_capable=True, apikey_location="query", apikey_field="api_key",
    ),
    Provider(
        id="aegis-screening", brand="Aegis Screening", category="caracal_mandate",
        protocol="rest", port=9407, industry="Compliance / AML",
        tagline="Sanctions, AML, and KYB screening",
        resources=("screenings", "cases", "watchlist_hits"),
        operations=("screen_party", "get_screening", "get_case", "resolve_case"),
        llm_capable=True, scopes=("screening.run", "cases.read"),
    ),
    Provider(
        id="verafin-monitor", brand="Verafin Monitor", category="caracal_mandate",
        protocol="rest", port=9408, industry="Regulatory / RegTech",
        tagline="Transaction monitoring and regulatory filing",
        resources=("monitors", "alerts", "filings", "attestations"),
        operations=("monitor_transaction", "get_alert", "prepare_filing",
                    "get_filing", "attest_control"),
        llm_capable=True, scopes=("monitoring.run", "filings.write"), require_delegation=True,
    ),
    Provider(
        id="lumen-identity", brand="Lumen Identity", category="none",
        protocol="rest", port=9409, industry="Identity / directory",
        tagline="Internal directory of users, roles, and service accounts",
        resources=("users", "groups", "roles", "service_accounts"),
        operations=("get_user", "list_users", "list_groups", "get_service_account"),
    ),
    Provider(
        id="beacon-crm", brand="Beacon CRM", category="oauth2_authorization_code",
        protocol="rest", port=9410, industry="CRM",
        tagline="Vendor and customer relationship management",
        resources=("contacts", "accounts", "deals", "activities"),
        operations=("get_contact", "list_contacts", "update_deal",
                    "log_activity", "get_account"),
        llm_capable=True, scopes=("contacts.read", "deals.write"), offline_access=True,
    ),
    Provider(
        id="atlas-vendor", brand="Atlas Vendor Network", category="mcp",
        protocol="mcp", port=9411, industry="Vendor master data",
        tagline="Vendor onboarding and master-data tool server",
        resources=("vendors", "contracts"),
        operations=("get_vendor_profile", "register_vendor",
                    "get_contract_terms", "search_vendors"),
        mcp_auth="bearer", auth_header="Authorization", auth_scheme="Bearer",
    ),
    Provider(
        id="keystone-treasury", brand="Keystone Treasury", category="api_key",
        protocol="grpc", port=9412, industry="Corporate treasury",
        tagline="Cash positioning, forecasting, and hedging",
        resources=("positions", "forecasts", "hedges", "transfers"),
        operations=("get_position", "forecast_liquidity", "place_hedge", "transfer_funds"),
        apikey_location="header", apikey_field="X-Api-Key",
    ),
    Provider(
        id="sabre-tax", brand="Sabre Tax", category="sdk",
        protocol="sdk", port=9413, industry="Tax",
        tagline="Tax determination and tax-ID validation",
        resources=("calculations", "jurisdictions", "tax_ids"),
        operations=("calculate", "get_jurisdiction", "validate_id"),
        apikey_location="header", apikey_field="X-Api-Key", sdk_package="sabre_tax",
    ),
    Provider(
        id="quetzal-payouts", brand="Quetzal Payouts", category="sdk",
        protocol="sdk", port=9414, industry="Mass payouts",
        tagline="Global recipient disbursement and batches",
        resources=("recipients", "payouts", "batches", "quotes"),
        operations=("create_recipient", "get_quote", "create_payout",
                    "create_batch", "get_batch"),
        failure_profile="flaky", auth_header="Authorization", auth_scheme="Bearer",
        sdk_package="quetzal_payouts",
    ),
    Provider(
        id="vela-notify", brand="Vela Notify", category="bearer_token",
        protocol="rest", port=9415, industry="Messaging",
        tagline="Transactional email and SMS for remittance and dunning",
        resources=("messages", "templates"),
        operations=("send_message", "get_message", "list_templates"),
        auth_header="X-Vela-Token", auth_scheme="Token",
    ),
    Provider(
        id="core-billing", brand="Core Billing", category="none",
        protocol="rest", port=9416, industry="Internal billing",
        tagline="Internal accounts-receivable and billing service",
        resources=("invoices", "customers", "dunning", "payments"),
        operations=("create_invoice", "get_invoice", "issue_dunning",
                    "apply_payment", "get_ar_aging"),
    ),
    Provider(
        id="relay-automation", brand="Relay Automation", category="mcp",
        protocol="mcp", port=9417, industry="Workflow automation",
        tagline="Caracal-mandate-guarded workflow and job automation",
        resources=("workflows", "jobs"),
        operations=("list_workflows", "dispatch_job", "get_job", "cancel_job"),
        mcp_auth="mandate", scopes=("relay.invoke",), require_delegation=True,
    ),
    Provider(
        id="pulse-market", brand="Pulse Market Data", category="api_key",
        protocol="sse", port=9418, industry="Market data",
        tagline="Real-time FX and reference market data",
        resources=("instruments", "rates", "snapshots"),
        operations=("list_instruments", "get_snapshot", "stream_rates"),
        apikey_location="header", apikey_field="X-Api-Key",
    ),
    Provider(
        id="junction-procure", brand="Junction Procurement", category="oauth2_client_credentials",
        protocol="rest", port=9419, industry="Procurement",
        tagline="Procure-to-pay requisitions, POs, and approvals",
        resources=("requisitions", "purchase_orders", "approvals", "budgets"),
        operations=("create_requisition", "approve_requisition", "create_purchase_order",
                    "get_purchase_order", "get_budget"),
        client_auth_method="client_secret_basic", scopes=("procure.read", "procure.write"),
    ),
)

BY_ID: dict[str, Provider] = {p.id: p for p in CATALOG}
BY_CATEGORY: dict[str, list[Provider]] = {
    c: [p for p in CATALOG if p.category == c] for c in CATEGORIES
}
BY_PROTOCOL: dict[str, list[Provider]] = {
    proto: [p for p in CATALOG if p.protocol == proto]
    for proto in ("rest", "grpc", "mcp", "sse", "sdk")
}


def get(provider_id: str) -> Provider:
    if provider_id not in BY_ID:
        raise KeyError(f"unknown provider: {provider_id!r}")
    return BY_ID[provider_id]


def taxonomy_complete() -> bool:
    """Every Caracal auth category and every protocol is represented within 20 providers."""
    cats = all(len(BY_CATEGORY[c]) >= 1 for c in CATEGORIES)
    protos = all(len(BY_PROTOCOL[p]) >= 1 for p in ("rest", "grpc", "mcp", "sse", "sdk"))
    return cats and protos and len(CATALOG) <= 20
