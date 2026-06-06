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
    sdk_auth: str = "api_key"                # sdk: api_key | bearer


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
        tagline="Small-business cloud accounting: bookkeeping, A/P, A/R, and financial reports",
        resources=("company", "accounts", "vendors", "customers", "items", "bills",
                   "invoices", "expenses", "payments", "bill_payments", "journal_entries"),
        operations=("get_company_info",
                    "list_accounts", "get_account",
                    "list_vendors", "get_vendor", "create_vendor",
                    "list_customers", "get_customer", "create_customer",
                    "list_items",
                    "list_bills", "get_bill", "create_bill", "match_bill", "pay_bill",
                    "list_invoices", "get_invoice", "create_invoice",
                    "send_invoice", "void_invoice", "record_payment",
                    "list_expenses", "get_expense", "create_expense",
                    "list_journal_entries", "get_journal_entry", "post_journal_entry",
                    "get_report"),
        scopes=("com.intuit.quickbooks.accounting", "com.intuit.quickbooks.payment"),
        offline_access=True,
    ),
    Provider(
        id="slate-ledger", brand="Slate Ledger", category="bearer_token",
        protocol="rest", port=9405, industry="General ledger",
        tagline="Double-entry general ledger, reconciliation, and financial close",
        resources=("accounts", "entries", "reconciliations", "accruals", "periods"),
        operations=("list_accounts", "get_account",
                    "post_entry", "get_entry", "list_entries", "reverse_entry",
                    "reconcile_account", "get_reconciliation", "create_accrual",
                    "trial_balance", "close_period", "get_period", "list_periods"),
        failure_profile="strict", auth_header="Authorization", auth_scheme="Bearer",
    ),
    Provider(
        id="inkwell-ocr", brand="Inkwell OCR", category="api_key",
        protocol="rest", port=9406, industry="Document AI / OCR",
        tagline="Intelligent document capture: classification, field extraction, line items, and confidence scoring",
        resources=("documents", "extractions", "models"),
        operations=("submit_document", "get_document", "get_extraction",
                    "list_documents", "list_models", "delete_document"),
        llm_capable=True, apikey_location="query", apikey_field="api_key",
    ),
    Provider(
        id="aegis-screening", brand="Aegis Screening", category="caracal_mandate",
        protocol="rest", port=9407, industry="Compliance / AML",
        tagline="Sanctions, PEP, adverse-media, and KYB screening with case management",
        resources=("entities", "screenings", "watchlist_hits", "cases",
                   "audit_events", "monitors", "watchlists"),
        operations=("screen_party", "verify_business", "screen_batch", "rescreen_entity",
                    "get_screening", "list_screenings", "get_entity", "get_watchlist_hit",
                    "list_watchlists", "get_case", "list_cases", "get_audit_trail",
                    "assign_case", "add_case_note", "escalate_case", "resolve_case",
                    "create_monitor", "get_monitor", "list_monitors"),
        llm_capable=True,
        scopes=("screening.run", "screening.read", "cases.read", "cases.write", "monitoring.write"),
    ),
    Provider(
        id="verafin-monitor", brand="Verafin Monitor", category="caracal_mandate",
        protocol="rest", port=9408, industry="Regulatory / RegTech",
        tagline="Transaction monitoring, alert investigation, and BSA/AML regulatory filing",
        resources=("customers", "accounts", "alerts", "cases", "filings",
                   "attestations", "controls", "audit_events"),
        operations=("monitor_transaction", "get_alert", "list_alerts", "assign_alert",
                    "resolve_alert", "open_case", "get_case", "list_cases",
                    "add_case_note", "escalate_case", "resolve_case",
                    "prepare_filing", "get_filing", "list_filings", "submit_filing",
                    "list_controls", "attest_control", "get_attestation",
                    "list_attestations", "get_audit_trail"),
        llm_capable=True,
        scopes=("monitoring.run", "monitoring.read", "alerts.read", "cases.read",
                "cases.write", "filings.read", "filings.write", "filings.submit",
                "attestations.write"),
        require_delegation=True,
    ),
    Provider(
        id="lumen-identity", brand="Lumen Identity", category="none",
        protocol="rest", port=9409, industry="Identity / directory",
        tagline="Internal directory and IAM: employees, org chart, RBAC roles, groups, and service accounts",
        resources=("users", "roles", "groups", "teams", "departments", "service_accounts"),
        operations=("get_user", "lookup_user", "list_users", "get_user_access",
                    "list_direct_reports", "get_manager_chain",
                    "list_roles", "get_role", "list_groups", "get_group",
                    "list_teams", "get_team", "list_departments", "get_department",
                    "list_service_accounts", "get_service_account"),
    ),
    Provider(
        id="beacon-crm", brand="Beacon CRM", category="oauth2_authorization_code",
        protocol="rest", port=9410, industry="CRM",
        tagline="Customer and vendor relationship management: accounts, contacts, deal pipeline, and activities",
        resources=("contacts", "accounts", "deals", "activities", "notes", "relationships"),
        operations=("list_contacts", "get_contact", "create_contact", "update_contact",
                    "list_accounts", "get_account",
                    "list_deals", "get_deal", "update_deal",
                    "list_activities", "log_activity",
                    "add_note", "list_notes", "list_relationships"),
        llm_capable=True,
        scopes=("contacts.read", "contacts.write", "accounts.read",
                "deals.read", "deals.write", "activities.read", "activities.write"),
        offline_access=True,
    ),
    Provider(
        id="atlas-vendor", brand="Atlas Vendor Network", category="mcp",
        protocol="mcp", port=9411, industry="Vendor master data",
        tagline="Vendor onboarding, verification, and master-data tool server",
        resources=("vendors", "contracts"),
        operations=("search_vendors", "list_vendors", "get_vendor_profile",
                    "list_vendor_contacts", "register_vendor", "get_onboarding_status",
                    "advance_onboarding", "verify_vendor_banking", "get_compliance_status",
                    "list_vendor_documents", "submit_vendor_document", "set_vendor_status",
                    "list_contracts", "get_contract_terms"),
        mcp_auth="bearer", auth_header="Authorization", auth_scheme="Bearer",
    ),
    Provider(
        id="keystone-treasury", brand="Keystone Treasury", category="api_key",
        protocol="grpc", port=9412, industry="Corporate treasury",
        tagline="Multi-entity cash positioning, liquidity forecasting, FX hedging, intercompany transfers, and exposure management",
        resources=("positions", "forecasts", "hedges", "transfers", "exposures", "operations"),
        operations=("list_positions", "get_position", "get_account", "get_position_summary",
                    "watch_positions", "forecast_liquidity",
                    "list_hedges", "place_hedge", "get_hedge", "cancel_hedge",
                    "transfer_funds", "get_transfer", "list_transfers",
                    "get_exposure", "list_exposures",
                    "list_operations", "get_operation"),
        apikey_location="header", apikey_field="x-api-key",
    ),
    Provider(
        id="sabre-tax", brand="Sabre Tax", category="sdk",
        protocol="sdk", port=9413, industry="Tax",
        tagline="Transaction tax determination, jurisdiction resolution, tax-ID validation, exemptions, and cross-border withholding",
        resources=("transactions", "jurisdictions", "tax_codes", "exemption_certificates"),
        operations=("calculate_tax", "get_transaction", "commit_transaction",
                    "void_transaction", "resolve_jurisdiction", "validate_tax_id",
                    "determine_withholding", "get_exemption_certificate", "list_tax_codes"),
        apikey_location="header", apikey_field="X-Api-Key", sdk_package="sabre_tax",
    ),
    Provider(
        id="quetzal-payouts", brand="Quetzal Payouts", category="sdk",
        protocol="sdk", port=9414, industry="Mass payouts",
        tagline="Global recipient onboarding, FX-aware payout quotes, mass disbursement batches, and settlement funding",
        resources=("recipients", "payouts", "batches", "quotes", "settlements", "balances"),
        operations=("create_recipient", "get_recipient", "list_recipients", "verify_recipient",
                    "get_quote", "create_payout", "get_payout", "list_payouts", "cancel_payout",
                    "create_batch", "get_batch", "list_batches",
                    "list_settlements", "get_balance"),
        failure_profile="flaky", auth_header="Authorization", auth_scheme="Bearer",
        sdk_package="quetzal_payouts", sdk_auth="bearer",
    ),
    Provider(
        id="vela-notify", brand="Vela Notify", category="bearer_token",
        protocol="rest", port=9415, industry="Messaging",
        tagline="Transactional email and SMS with templates, delivery tracking, suppressions, and webhooks",
        resources=("messages", "templates", "events", "suppressions", "webhooks"),
        operations=("send_message", "send_batch", "get_message", "list_messages",
                    "get_message_events",
                    "list_templates", "get_template", "create_template", "render_template",
                    "list_suppressions", "create_suppression", "delete_suppression",
                    "list_webhooks", "get_webhook", "create_webhook",
                    "get_delivery_stats"),
        auth_header="X-Vela-Token", auth_scheme="Token",
    ),
    Provider(
        id="core-billing", brand="Core Billing", category="none",
        protocol="rest", port=9416, industry="Internal billing",
        tagline="Internal accounts-receivable platform: customer billing, cash application, AR aging, dunning, and collections",
        resources=("customers", "invoices", "payments", "credit_memos",
                   "dunning", "collections", "audit_events"),
        operations=("list_customers", "get_customer",
                    "create_invoice", "get_invoice", "list_invoices",
                    "void_invoice", "write_off_invoice", "dispute_invoice",
                    "apply_payment", "record_payment", "get_payment", "list_payments",
                    "issue_credit_memo", "apply_credit_memo",
                    "issue_dunning", "run_dunning_cycle", "list_dunning",
                    "open_collection_case", "list_collections",
                    "get_ar_aging", "get_ar_summary", "get_audit_trail"),
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


def apikey_auth(provider: Provider) -> bool:
    """Wire auth resolves to an API key: api_key providers and SDK providers whose
    shim authenticates with an API key under the hood."""
    return provider.category == "api_key" or (
        provider.category == "sdk" and provider.sdk_auth == "api_key")


def bearer_auth(provider: Provider) -> bool:
    """Wire auth resolves to a static bearer token: bearer_token providers and SDK
    providers whose shim presents a secret key as a bearer token."""
    return provider.category == "bearer_token" or (
        provider.category == "sdk" and provider.sdk_auth == "bearer")


def taxonomy_complete() -> bool:
    """Every Caracal auth category and every protocol is represented within 20 providers."""
    cats = all(len(BY_CATEGORY[c]) >= 1 for c in CATEGORIES)
    protos = all(len(BY_PROTOCOL[p]) >= 1 for p in ("rest", "grpc", "mcp", "sse", "sdk"))
    return cats and protos and len(CATALOG) <= 20
