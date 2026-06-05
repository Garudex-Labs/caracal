"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Catalog of mock external providers, two per Caracal provider auth category, each on its own localhost port.
"""
from __future__ import annotations

from dataclasses import dataclass, field
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

# The eight Caracal provider auth categories the lab must cover end to end.
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
    """One mock external provider.

    Wire field names intentionally use third-party industry shapes
    (clientId, apiKey, accessToken) and never Caracal-internal naming.
    """

    id: str
    brand: str
    category: Category
    port: int
    tagline: str
    # Auth shaping. Only the fields relevant to the category are read.
    apikey_location: str = "header"          # header | query
    apikey_field: str = "X-Api-Key"          # header name or query param
    auth_header: str = "Authorization"       # bearer/oauth/mandate header
    auth_scheme: str = "Bearer"              # bearer/oauth/mandate scheme
    client_auth_method: str = "client_secret_basic"  # oauth client cred/auth code
    scopes: tuple[str, ...] = ()
    audience: str | None = None              # oauth client credentials
    use_pkce: bool = False                   # oauth authorization code
    offline_access: bool = False             # oauth authorization code refresh tokens
    require_delegation: bool = False         # caracal_mandate
    mcp_auth: str = "bearer"                 # mcp: bearer | mandate
    sdk_package: str | None = None           # sdk category pip package name
    resource_kind: str = "generic"           # flavor for domain endpoints
    operations: tuple[str, ...] = ()         # domain operations exposed


CATALOG: tuple[Provider, ...] = (
    # ---- api_key (header vs query) ----
    Provider(
        id="aurum-pay", brand="Aurum Pay", category="api_key", port=9400,
        tagline="Card and wallet payment acceptance",
        apikey_location="header", apikey_field="X-Api-Key",
        resource_kind="payments", operations=("create_charge", "get_balance"),
    ),
    Provider(
        id="quill-ocr", brand="Quill OCR", category="api_key", port=9401,
        tagline="Document capture and extraction",
        apikey_location="query", apikey_field="api_key",
        resource_kind="ocr", operations=("extract_document", "get_job"),
    ),
    # ---- bearer_token (standard vs custom header/scheme) ----
    Provider(
        id="nimbus-ledger", brand="Nimbus Ledger", category="bearer_token", port=9402,
        tagline="General ledger and journals",
        auth_header="Authorization", auth_scheme="Bearer",
        resource_kind="ledger", operations=("post_entry", "get_account"),
    ),
    Provider(
        id="vela-mail", brand="Vela Mail", category="bearer_token", port=9403,
        tagline="Transactional email delivery",
        auth_header="X-Vela-Token", auth_scheme="Token",
        resource_kind="mail", operations=("send_message", "get_message"),
    ),
    # ---- oauth2_client_credentials (basic vs post + audience) ----
    Provider(
        id="helios-fx", brand="Helios FX", category="oauth2_client_credentials", port=9404,
        tagline="Foreign exchange quotes and conversions",
        client_auth_method="client_secret_basic",
        scopes=("fx.read", "fx.convert"),
        resource_kind="fx", operations=("get_quote", "convert"),
    ),
    Provider(
        id="orbit-erp", brand="Orbit ERP", category="oauth2_client_credentials", port=9405,
        tagline="Enterprise resource planning",
        client_auth_method="client_secret_post",
        scopes=("erp.read", "erp.write"), audience="https://api.orbit-erp.test",
        resource_kind="erp", operations=("get_vendor", "create_bill"),
    ),
    # ---- oauth2_authorization_code (PKCE vs offline refresh) ----
    Provider(
        id="corvus-bank", brand="Corvus Bank", category="oauth2_authorization_code", port=9406,
        tagline="Open banking account access",
        scopes=("accounts.read", "payments.write"), use_pkce=True,
        resource_kind="bank", operations=("list_accounts", "initiate_payment"),
    ),
    Provider(
        id="lumen-crm", brand="Lumen CRM", category="oauth2_authorization_code", port=9407,
        tagline="Customer relationship management",
        scopes=("contacts.read", "deals.write"), offline_access=True,
        resource_kind="crm", operations=("get_contact", "update_deal"),
    ),
    # ---- caracal_mandate (partnership provider, verifier SDK semantics) ----
    Provider(
        id="atlas-treasury", brand="Atlas Treasury", category="caracal_mandate", port=9408,
        tagline="Caracal-aware treasury rails",
        scopes=("treasury.read", "treasury.write"),
        resource_kind="treasury", operations=("get_position", "move_funds"),
    ),
    Provider(
        id="sentinel-compliance", brand="Sentinel Compliance", category="caracal_mandate", port=9409,
        tagline="Caracal-aware compliance screening",
        scopes=("screening.run",), require_delegation=True,
        resource_kind="compliance", operations=("screen_party", "get_case"),
    ),
    # ---- none (internal provider, no upstream credential) ----
    Provider(
        id="core-billing", brand="Core Billing", category="none", port=9410,
        tagline="Internal billing service behind the boundary",
        resource_kind="billing", operations=("create_invoice", "get_invoice"),
    ),
    Provider(
        id="core-identity", brand="Core Identity", category="none", port=9411,
        tagline="Internal identity directory behind the boundary",
        resource_kind="identity", operations=("get_user", "list_groups"),
    ),
    # ---- mcp (bearer-guarded vs mandate-guarded) ----
    Provider(
        id="forge-mcp", brand="Forge Tools", category="mcp", port=9412,
        tagline="MCP tool server, bearer guarded",
        mcp_auth="bearer", auth_header="Authorization", auth_scheme="Bearer",
        resource_kind="mcp", operations=("search_catalog", "create_ticket"),
    ),
    Provider(
        id="relay-mcp", brand="Relay", category="mcp", port=9413,
        tagline="MCP tool server, Caracal mandate guarded",
        mcp_auth="mandate", scopes=("relay.invoke",), require_delegation=True,
        resource_kind="mcp", operations=("dispatch_job", "get_job"),
    ),
    # ---- sdk (shipped pip SDK shim over an HTTP provider) ----
    Provider(
        id="zephyr-pay", brand="Zephyr Pay", category="sdk", port=9414,
        tagline="Payouts provider with a first-party SDK",
        apikey_location="header", apikey_field="X-Api-Key",
        sdk_package="zephyr_pay",
        resource_kind="payouts", operations=("create_payout", "get_payout"),
    ),
    Provider(
        id="terra-tax", brand="Terra Tax", category="sdk", port=9415,
        tagline="Tax determination with a first-party SDK",
        apikey_location="header", apikey_field="X-Api-Key",
        sdk_package="terra_tax",
        resource_kind="tax", operations=("calculate", "validate_id"),
    ),
)

BY_ID: dict[str, Provider] = {p.id: p for p in CATALOG}
BY_CATEGORY: dict[str, list[Provider]] = {
    c: [p for p in CATALOG if p.category == c] for c in CATEGORIES
}


def get(provider_id: str) -> Provider:
    if provider_id not in BY_ID:
        raise KeyError(f"unknown provider: {provider_id!r}")
    return BY_ID[provider_id]


def taxonomy_complete() -> bool:
    """Every category is represented by exactly two providers."""
    return all(len(BY_CATEGORY[c]) == 2 for c in CATEGORIES)
