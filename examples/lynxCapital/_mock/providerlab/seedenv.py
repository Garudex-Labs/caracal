"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Operator helper that prints shell export lines mapping each lab provider's seed credential to its LYNX_PARTNER_* variable.
"""
from __future__ import annotations

from _mock.providerlab import catalog, credentials


def _eid(provider_id: str) -> str:
    return provider_id.upper().replace("-", "_")


def lines() -> list[str]:
    out: list[str] = []
    for provider in catalog.CATALOG:
        seed = credentials.load(provider.id).data["seed"]
        eid = _eid(provider.id)
        out.append(f"export LYNX_PARTNER_{eid}_URL=http://127.0.0.1:{provider.port}")
        if catalog.apikey_auth(provider):
            out.append(f"export LYNX_PARTNER_{eid}_API_KEY={seed['apiKey']}")
        elif catalog.bearer_auth(provider) or (provider.category == "mcp" and provider.mcp_auth == "bearer"):
            out.append(f"export LYNX_PARTNER_{eid}_TOKEN={seed['bearerToken']}")
        elif provider.category in ("oauth2_client_credentials", "oauth2_authorization_code"):
            out.append(f"export LYNX_PARTNER_{eid}_CLIENT_ID={seed['clientId']}")
            out.append(f"export LYNX_PARTNER_{eid}_CLIENT_SECRET={seed['clientSecret']}")
        elif provider.category == "caracal_mandate" or (provider.category == "mcp" and provider.mcp_auth == "mandate"):
            out.append(f"export LYNX_PARTNER_{eid}_MANDATE={seed['mandate']}")
    return out


def main() -> None:
    print("\n".join(lines()))


if __name__ == "__main__":
    main()
