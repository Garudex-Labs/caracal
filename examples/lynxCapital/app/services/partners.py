"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Partner integration layer that authenticates to external third-party providers per auth category and dispatches business operations.
"""
from __future__ import annotations

import base64
import hashlib
import os
import secrets
import threading
import time
from dataclasses import dataclass, field
from urllib.parse import parse_qs, urlsplit

import httpx


class PartnerError(Exception):
    """Raised when a partner call cannot be completed at the transport or auth layer."""

    def __init__(self, provider_id: str, message: str):
        super().__init__(f"{provider_id}: {message}")
        self.provider_id = provider_id
        self.message = message


class PartnerPendingCaracal(Exception):
    """Raised when a provider requires a Caracal-issued mandate that is wired in the Phase-2 integration."""

    def __init__(self, provider_id: str):
        super().__init__(
            f"{provider_id} requires a Caracal mandate; this provider activates in the Caracal SDK integration phase"
        )
        self.provider_id = provider_id


@dataclass(frozen=True)
class PartnerSpec:
    """Integration contract for one external provider, mirroring its real auth and routing surface."""

    id: str
    auth: str                                  # api_key | bearer | oauth_cc | oauth_ac | none | mcp_bearer | mandate
    port: int
    operations: tuple[str, ...]
    apikey_location: str = "header"            # header | query
    apikey_field: str = "X-Api-Key"
    auth_header: str = "Authorization"
    auth_scheme: str = "Bearer"
    client_auth_method: str = "client_secret_basic"
    scopes: tuple[str, ...] = ()
    audience: str = ""
    use_pkce: bool = False
    offline_access: bool = False
    redirect_uri: str = "http://127.0.0.1:8000/callback"
    timeout_s: float = 6.0


_SPECS: dict[str, PartnerSpec] = {
    "halcyon-bank": PartnerSpec(
        "halcyon-bank", "oauth_ac", 9400,
        ("list_accounts", "get_account", "list_transactions",
         "initiate_payment", "get_payment", "get_statement"),
        scopes=("accounts.read", "payments.write"), use_pkce=True),
    "meridian-pay": PartnerSpec(
        "meridian-pay", "api_key", 9401,
        ("create_charge", "get_charge", "capture_charge", "list_charges",
         "refund_charge", "create_payout", "get_payout", "get_balance",
         "list_disputes", "get_dispute", "submit_dispute_evidence",
         "list_settlements", "get_settlement", "list_events"),
        apikey_location="header", apikey_field="X-Api-Key"),
    "cordoba-fx": PartnerSpec(
        "cordoba-fx", "oauth_cc", 9402,
        ("get_quote", "create_conversion", "get_conversion",
         "create_beneficiary", "get_beneficiary", "list_beneficiaries",
         "create_payment", "get_payment", "list_balances"),
        client_auth_method="client_secret_basic",
        scopes=("fx.read", "fx.convert", "fx.transfer")),
    "ironbark-erp": PartnerSpec(
        "ironbark-erp", "oauth_cc", 9403,
        ("list_vendors", "get_vendor",
         "list_purchase_orders", "get_purchase_order", "create_purchase_order",
         "list_bills", "get_bill", "create_bill", "approve_bill",
         "match_invoice",
         "post_journal_entry", "get_journal_entry", "list_journal_entries",
         "list_accounts", "get_account"),
        client_auth_method="client_secret_post", scopes=("erp.read", "erp.write"),
        audience="https://api.ironbark-erp.test"),
    "tallyhall-books": PartnerSpec(
        "tallyhall-books", "oauth_ac", 9404,
        ("get_company_info",
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
        offline_access=True),
    "slate-ledger": PartnerSpec(
        "slate-ledger", "bearer", 9405,
        ("list_accounts", "get_account",
         "post_entry", "get_entry", "list_entries", "reverse_entry",
         "reconcile_account", "get_reconciliation", "create_accrual",
         "trial_balance", "close_period", "get_period", "list_periods"),
        auth_header="Authorization", auth_scheme="Bearer"),
    "inkwell-ocr": PartnerSpec(
        "inkwell-ocr", "api_key", 9406,
        ("submit_document", "get_document", "get_extraction",
         "list_documents", "list_models", "delete_document"),
        apikey_location="query", apikey_field="api_key"),
    "aegis-screening": PartnerSpec(
        "aegis-screening", "mandate", 9407,
        ("screen_party", "verify_business", "screen_batch", "rescreen_entity",
         "get_screening", "list_screenings", "get_entity", "get_watchlist_hit",
         "list_watchlists", "get_case", "list_cases", "get_audit_trail",
         "assign_case", "add_case_note", "escalate_case", "resolve_case",
         "create_monitor", "get_monitor", "list_monitors"),
        scopes=("screening.run", "screening.read", "cases.read", "cases.write", "monitoring.write")),
    "verafin-monitor": PartnerSpec(
        "verafin-monitor", "mandate", 9408,
        ("monitor_transaction", "get_alert", "list_alerts", "assign_alert",
         "resolve_alert", "open_case", "get_case", "list_cases",
         "add_case_note", "escalate_case", "resolve_case",
         "prepare_filing", "get_filing", "list_filings", "submit_filing",
         "list_controls", "attest_control", "get_attestation",
         "list_attestations", "get_audit_trail"),
        scopes=("monitoring.run", "monitoring.read", "alerts.read", "cases.read",
                "cases.write", "filings.read", "filings.write", "filings.submit",
                "attestations.write")),
    "lumen-identity": PartnerSpec(
        "lumen-identity", "none", 9409,
        ("get_user", "lookup_user", "list_users", "get_user_access",
         "list_direct_reports", "get_manager_chain",
         "list_roles", "get_role", "list_groups", "get_group",
         "list_teams", "get_team", "list_departments", "get_department",
         "list_service_accounts", "get_service_account")),
    "beacon-crm": PartnerSpec(
        "beacon-crm", "oauth_ac", 9410,
        ("list_contacts", "get_contact", "create_contact", "update_contact",
         "list_accounts", "get_account",
         "list_deals", "get_deal", "update_deal",
         "list_activities", "log_activity",
         "add_note", "list_notes", "list_relationships"),
        scopes=("contacts.read", "accounts.read", "deals.read", "deals.write",
                "activities.read", "activities.write"),
        offline_access=True),
    "atlas-vendor": PartnerSpec(
        "atlas-vendor", "mcp_bearer", 9411,
        ("search_vendors", "list_vendors", "get_vendor_profile",
         "list_vendor_contacts", "register_vendor", "get_onboarding_status",
         "advance_onboarding", "verify_vendor_banking", "get_compliance_status",
         "list_vendor_documents", "submit_vendor_document", "set_vendor_status",
         "list_contracts", "get_contract_terms"),
        auth_header="Authorization", auth_scheme="Bearer"),
    "keystone-treasury": PartnerSpec(
        "keystone-treasury", "api_key", 9412,
        ("list_positions", "get_position", "get_account", "get_position_summary",
         "watch_positions", "forecast_liquidity",
         "list_hedges", "place_hedge", "get_hedge", "cancel_hedge",
         "transfer_funds", "get_transfer", "list_transfers",
         "get_exposure", "list_exposures",
         "list_operations", "get_operation"),
        apikey_location="header", apikey_field="x-api-key"),
    "sabre-tax": PartnerSpec(
        "sabre-tax", "api_key", 9413,
        ("calculate_tax", "get_transaction", "commit_transaction",
         "void_transaction", "resolve_jurisdiction", "validate_tax_id",
         "determine_withholding", "get_exemption_certificate", "list_tax_codes"),
        apikey_location="header", apikey_field="X-Api-Key"),
    "quetzal-payouts": PartnerSpec(
        "quetzal-payouts", "bearer", 9414,
        ("create_recipient", "get_recipient", "list_recipients", "verify_recipient",
         "get_quote", "create_payout", "get_payout", "list_payouts", "cancel_payout",
         "create_batch", "get_batch", "list_batches",
         "list_settlements", "get_balance"),
        auth_header="Authorization", auth_scheme="Bearer"),
    "vela-notify": PartnerSpec(
        "vela-notify", "bearer", 9415,
        ("send_message", "send_batch", "get_message", "list_messages",
         "get_message_events",
         "list_templates", "get_template", "create_template", "render_template",
         "list_suppressions", "create_suppression", "delete_suppression",
         "list_webhooks", "get_webhook", "create_webhook",
         "get_delivery_stats"),
        auth_header="X-Vela-Token", auth_scheme="Token"),
    "core-billing": PartnerSpec(
        "core-billing", "none", 9416,
        ("list_customers", "get_customer",
         "create_invoice", "get_invoice", "list_invoices",
         "void_invoice", "write_off_invoice", "dispute_invoice",
         "apply_payment", "record_payment", "get_payment", "list_payments",
         "issue_credit_memo", "apply_credit_memo",
         "issue_dunning", "run_dunning_cycle", "list_dunning",
         "open_collection_case", "list_collections",
         "get_ar_aging", "get_ar_summary", "get_audit_trail")),
    "relay-automation": PartnerSpec(
        "relay-automation", "mandate", 9417,
        ("list_workflows", "get_workflow",
         "start_execution", "get_execution", "list_executions",
         "get_execution_logs", "get_execution_result",
         "signal_execution", "retry_execution", "cancel_execution",
         "list_queues", "get_queue", "get_execution_audit"),
        scopes=("relay.workflows.read", "relay.executions.read", "relay.executions.write")),
    "pulse-market": PartnerSpec(
        "pulse-market", "api_key", 9418,
        ("list_instruments", "get_instrument", "get_snapshot", "get_quotes",
         "get_bars", "get_market_status", "list_reference_rates", "get_reference_rate",
         "create_subscription", "list_subscriptions", "get_subscription",
         "cancel_subscription", "stream_rates"),
        apikey_location="header", apikey_field="X-Api-Key"),
    "junction-procure": PartnerSpec(
        "junction-procure", "oauth_cc", 9419,
        ("list_suppliers", "get_supplier", "list_commodities",
         "create_requisition", "submit_requisition", "approve_requisition",
         "reject_requisition", "list_requisitions", "get_requisition",
         "get_approval_chain",
         "create_purchase_order", "acknowledge_order", "receive_order",
         "list_purchase_orders", "get_purchase_order",
         "list_budgets", "get_budget"),
        client_auth_method="client_secret_basic", scopes=("procure.read", "procure.write")),
}


def _env_id(provider_id: str) -> str:
    return provider_id.upper().replace("-", "_")


def _base_url(spec: PartnerSpec) -> str:
    return os.environ.get(f"LYNX_PARTNER_{_env_id(spec.id)}_URL", f"http://127.0.0.1:{spec.port}")


def _required(provider_id: str, name: str) -> str:
    val = os.environ.get(name)
    if not val:
        raise PartnerError(provider_id, f"credential env not set: {name}")
    return val


@dataclass
class _OAuthToken:
    access_token: str
    expires_at: float
    refresh_token: str | None = None


@dataclass
class _Session:
    client: httpx.Client
    token: _OAuthToken | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)


_SESSIONS: dict[str, _Session] = {}
_REGISTRY_LOCK = threading.Lock()


def _session(spec: PartnerSpec) -> _Session:
    with _REGISTRY_LOCK:
        sess = _SESSIONS.get(spec.id)
        if sess is None:
            sess = _SESSIONS[spec.id] = _Session(
                client=httpx.Client(base_url=_base_url(spec), timeout=spec.timeout_s)
            )
        return sess


def _result(provider_id: str, operation: str, response: httpx.Response) -> dict:
    try:
        body = response.json()
    except ValueError:
        raise PartnerError(provider_id, f"non-JSON response ({response.status_code})")
    if response.is_success and isinstance(body, dict) and "data" in body:
        return {"provider": provider_id, "operation": operation, "status": response.status_code,
                "data": body["data"]}
    return {"provider": provider_id, "operation": operation, "status": response.status_code,
            "error": body.get("error") if isinstance(body, dict) else None,
            "data": body if response.is_success else None,
            "message": body.get("message") if isinstance(body, dict) else None}


# --------------------------------------------------------------------------- #
# api key + bearer
# --------------------------------------------------------------------------- #
def _call_api_key(spec: PartnerSpec, operation: str, payload: dict) -> dict:
    key = _required(spec.id, f"LYNX_PARTNER_{_env_id(spec.id)}_API_KEY")
    sess = _session(spec)
    headers, params = {}, {}
    if spec.apikey_location == "query":
        params[spec.apikey_field] = key
    else:
        headers[spec.apikey_field] = key
    resp = sess.client.post(f"/api/{operation}", json=payload, headers=headers, params=params)
    return _result(spec.id, operation, resp)


def _call_bearer(spec: PartnerSpec, operation: str, payload: dict) -> dict:
    token = _required(spec.id, f"LYNX_PARTNER_{_env_id(spec.id)}_TOKEN")
    sess = _session(spec)
    headers = {spec.auth_header: f"{spec.auth_scheme} {token}".strip()}
    resp = sess.client.post(f"/api/{operation}", json=payload, headers=headers)
    return _result(spec.id, operation, resp)


def _call_none(spec: PartnerSpec, operation: str, payload: dict) -> dict:
    sess = _session(spec)
    resp = sess.client.post(f"/api/{operation}", json=payload)
    return _result(spec.id, operation, resp)


# --------------------------------------------------------------------------- #
# oauth2 client credentials
# --------------------------------------------------------------------------- #
def _fetch_client_credentials_token(spec: PartnerSpec, sess: _Session) -> _OAuthToken:
    eid = _env_id(spec.id)
    client_id = _required(spec.id, f"LYNX_PARTNER_{eid}_CLIENT_ID")
    client_secret = _required(spec.id, f"LYNX_PARTNER_{eid}_CLIENT_SECRET")
    data = {"grant_type": "client_credentials", "scope": " ".join(spec.scopes)}
    if spec.audience:
        data["resource"] = spec.audience
    headers = {}
    if spec.client_auth_method == "client_secret_basic":
        creds = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        headers["Authorization"] = f"Basic {creds}"
    else:
        data["client_id"] = client_id
        data["client_secret"] = client_secret
    resp = sess.client.post("/oauth/token", data=data, headers=headers)
    if resp.status_code != 200:
        raise PartnerError(spec.id, f"token request failed ({resp.status_code})")
    body = resp.json()
    return _OAuthToken(body["access_token"], time.time() + int(body.get("expires_in", 3600)) - 30)


# --------------------------------------------------------------------------- #
# oauth2 authorization code (consent auto-approved by the provider lab)
# --------------------------------------------------------------------------- #
def _pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return verifier, challenge


def _fetch_authorization_code_token(spec: PartnerSpec, sess: _Session) -> _OAuthToken:
    eid = _env_id(spec.id)
    client_id = _required(spec.id, f"LYNX_PARTNER_{eid}_CLIENT_ID")
    client_secret = _required(spec.id, f"LYNX_PARTNER_{eid}_CLIENT_SECRET")
    scope = " ".join(spec.scopes)
    verifier = challenge = ""
    if spec.use_pkce:
        verifier, challenge = _pkce_pair()
    decision = sess.client.post("/oauth/authorize", data={
        "client_id": client_id, "redirect_uri": spec.redirect_uri,
        "scope": scope, "state": secrets.token_urlsafe(8), "code_challenge": challenge,
    })
    if decision.status_code not in (302, 303):
        raise PartnerError(spec.id, f"authorization failed ({decision.status_code})")
    location = decision.headers.get("location", "")
    code = parse_qs(urlsplit(location).query).get("code", [""])[0]
    if not code:
        raise PartnerError(spec.id, "authorization returned no code")
    data = {"grant_type": "authorization_code", "code": code,
            "redirect_uri": spec.redirect_uri, "client_id": client_id,
            "client_secret": client_secret}
    if spec.use_pkce:
        data["code_verifier"] = verifier
    resp = sess.client.post("/oauth/token", data=data)
    if resp.status_code != 200:
        raise PartnerError(spec.id, f"token exchange failed ({resp.status_code})")
    body = resp.json()
    return _OAuthToken(body["access_token"],
                       time.time() + int(body.get("expires_in", 3600)) - 30,
                       body.get("refresh_token"))


def _refresh_authorization_code_token(spec: PartnerSpec, sess: _Session,
                                      refresh_token: str) -> _OAuthToken | None:
    """Exchange a stored refresh token for a fresh access token the way a real
    offline integration does, rather than re-running interactive consent. The
    provider rotates the refresh token on each use, so the new one is carried
    forward; a rejected refresh token returns None to trigger re-authorization."""
    eid = _env_id(spec.id)
    client_id = _required(spec.id, f"LYNX_PARTNER_{eid}_CLIENT_ID")
    client_secret = _required(spec.id, f"LYNX_PARTNER_{eid}_CLIENT_SECRET")
    resp = sess.client.post("/oauth/token", data={
        "grant_type": "refresh_token", "refresh_token": refresh_token,
        "client_id": client_id, "client_secret": client_secret,
    })
    if resp.status_code != 200:
        return None
    body = resp.json()
    return _OAuthToken(body["access_token"],
                       time.time() + int(body.get("expires_in", 3600)) - 30,
                       body.get("refresh_token", refresh_token))


def _oauth_token(spec: PartnerSpec, sess: _Session) -> str:
    with sess.lock:
        token = sess.token
        if token is not None and token.expires_at > time.time():
            return token.access_token
        if spec.auth == "oauth_cc":
            sess.token = _fetch_client_credentials_token(spec, sess)
            return sess.token.access_token
        if spec.offline_access and token is not None and token.refresh_token:
            refreshed = _refresh_authorization_code_token(spec, sess, token.refresh_token)
            if refreshed is not None:
                sess.token = refreshed
                return refreshed.access_token
        sess.token = _fetch_authorization_code_token(spec, sess)
        return sess.token.access_token


def _call_oauth(spec: PartnerSpec, operation: str, payload: dict) -> dict:
    sess = _session(spec)
    access_token = _oauth_token(spec, sess)
    headers = {spec.auth_header: f"{spec.auth_scheme} {access_token}".strip()}
    resp = sess.client.post(f"/api/{operation}", json=payload, headers=headers)
    return _result(spec.id, operation, resp)


# --------------------------------------------------------------------------- #
# MCP (JSON-RPC tools/call over a bearer-guarded endpoint)
# --------------------------------------------------------------------------- #
def _call_mcp(spec: PartnerSpec, operation: str, payload: dict) -> dict:
    token = _required(spec.id, f"LYNX_PARTNER_{_env_id(spec.id)}_TOKEN")
    sess = _session(spec)
    headers = {spec.auth_header: f"{spec.auth_scheme} {token}".strip()}
    message = {"jsonrpc": "2.0", "id": secrets.token_hex(6),
               "method": "tools/call", "params": {"name": operation, "arguments": payload}}
    resp = sess.client.post("/mcp", json=message, headers=headers)
    if resp.status_code != 200:
        raise PartnerError(spec.id, f"mcp transport error ({resp.status_code})")
    body = resp.json()
    if "error" in body:
        return {"provider": spec.id, "operation": operation, "status": body["error"].get("code"),
                "error": body["error"].get("message"), "data": None}
    result = body.get("result") or {}
    if result.get("isError"):
        content = result.get("content") or []
        text = content[0].get("text") if content else "tool execution error"
        return {"provider": spec.id, "operation": operation, "status": 422,
                "error": text, "data": None}
    if "structuredContent" in result:
        data = result["structuredContent"]
    else:
        content = result.get("content") or []
        data = content[0].get("data") if content else result
    return {"provider": spec.id, "operation": operation, "status": 200, "data": data}


_DISPATCH = {
    "api_key": _call_api_key,
    "bearer": _call_bearer,
    "none": _call_none,
    "oauth_cc": _call_oauth,
    "oauth_ac": _call_oauth,
    "mcp_bearer": _call_mcp,
}


def spec(provider_id: str) -> PartnerSpec:
    if provider_id not in _SPECS:
        raise KeyError(f"unknown partner provider: {provider_id!r}")
    return _SPECS[provider_id]


def catalog() -> dict[str, PartnerSpec]:
    return dict(_SPECS)


def _caracal_external(s: PartnerSpec, operation: str, payload: dict) -> dict:
    """Route an external provider through the Caracal upstream gateway. The gateway
    holds the provider credential and injects it; the app sends only its envelope."""
    from app import caracal

    resp = caracal.gateway_call(s.id, operation, payload, timeout_s=s.timeout_s)
    return _result(s.id, operation, resp)


def _caracal_internal(s: PartnerSpec, operation: str, payload: dict) -> dict:
    """Serve an internal provider after verifying the caller's delegated authority
    with the Caracal verifier. Internal providers are never network-exposed, so the
    trust boundary is enforced in-process here rather than at the gateway."""
    from app import caracal

    zone_id = os.environ.get("CARACAL_ZONE_ID", "")
    try:
        caracal.verify_internal(zone_id=zone_id, audience=s.id, required_scopes=list(s.scopes))
    except caracal.VerifyErrors as exc:
        raise PartnerError(s.id, f"internal authority rejected: {exc.__class__.__name__}") from exc
    return _call_none(s, operation, payload)


def call(provider_id: str, operation: str, payload: dict) -> dict:
    """Authenticate to one external partner and run a single business operation.

    When Caracal is configured, external and mandate providers route through the
    upstream gateway and internal providers are guarded by the verifier; otherwise
    the call falls back to the direct local provider surface."""
    s = spec(provider_id)
    if operation not in s.operations:
        raise KeyError(f"unknown operation {operation!r} for partner {provider_id!r}")

    from app import caracal

    if caracal.enabled():
        if s.auth == "none":
            return _caracal_internal(s, operation, payload or {})
        return _caracal_external(s, operation, payload or {})

    if s.auth == "mandate":
        raise PartnerPendingCaracal(provider_id)
    return _DISPATCH[s.auth](s, operation, payload or {})


def reset() -> None:
    """Close pooled partner clients and drop cached tokens (used by tests)."""
    with _REGISTRY_LOCK:
        for sess in _SESSIONS.values():
            sess.client.close()
        _SESSIONS.clear()
