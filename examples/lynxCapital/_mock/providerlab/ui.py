"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Server-rendered control panel for each lab provider with credentials, clients, and API client pages.
"""
from __future__ import annotations

import html
import time

from _mock.providerlab import catalog, credentials
from _mock.providerlab.providers import base

_CATEGORY_LABEL = {
    "api_key": "API key",
    "bearer_token": "Bearer token",
    "oauth2_client_credentials": "OAuth 2.0 client credentials",
    "oauth2_authorization_code": "OAuth 2.0 authorization code",
    "caracal_mandate": "Caracal mandate (partnership)",
    "none": "Internal (no upstream credential)",
    "mcp": "MCP server",
    "sdk": "Provider SDK",
}


def _esc(value) -> str:
    return html.escape(str(value))


def _ts(value) -> str:
    if not value:
        return "—"
    try:
        return time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(int(value)))
    except (ValueError, TypeError):
        return "—"


def _secret(value) -> str:
    """Render a secret masked by default, revealed on click, so shared demos
    never expose live credential material at a glance."""
    raw = str(value)
    if not raw:
        return '<code class="muted">—</code>'
    mask = raw[:4] + "…" + "•" * 6 if len(raw) > 4 else "•" * 8
    return (f'<code class="secret" data-value="{_esc(raw)}" data-mask="{_esc(mask)}" '
            f'data-shown="0" onclick="toggleSecret(this)"><span>{_esc(mask)}</span></code>')


_SECRET_FIELDS = {"apiKey", "bearerToken", "clientSecret", "accessToken", "mandate",
                  "signing_key", "refreshToken"}


def _config_rows(provider: catalog.Provider) -> list[tuple[str, str]]:
    """Real-world connection settings a caller configures to integrate, named
    with each provider's own wire vocabulary rather than any internal scheme."""
    base = f"http://localhost:{provider.port}"
    rows: list[tuple[str, str]] = [
        ("Base URL", base),
        ("Protocol", provider.protocol.upper()),
        ("Authentication", _CATEGORY_LABEL[provider.category]),
    ]
    c = provider.category
    if c in ("api_key", "sdk"):
        where = "query parameter" if provider.apikey_location == "query" else "request header"
        rows.append(("API key parameter", f"{provider.apikey_field} ({where})"))
    if c == "bearer_token" or (c == "mcp" and provider.mcp_auth == "bearer"):
        rows.append(("Token header", f"{provider.auth_header}: {provider.auth_scheme} <token>"))
    if c in ("oauth2_client_credentials", "oauth2_authorization_code"):
        rows.append(("Token endpoint", f"{base}/oauth/token"))
        rows.append(("Revocation endpoint", f"{base}/oauth/revoke"))
        rows.append(("Introspection endpoint", f"{base}/oauth/introspect"))
        rows.append(("Discovery", f"{base}/.well-known/oauth-authorization-server"))
        rows.append(("Client authentication", provider.client_auth_method))
        rows.append(("Scopes", " ".join(provider.scopes) or "—"))
    if c == "oauth2_authorization_code":
        rows.append(("Authorization endpoint", f"{base}/oauth/authorize"))
        rows.append(("PKCE", "required (S256)" if provider.use_pkce else "not required"))
        rows.append(("Refresh tokens", "issued (offline access)" if provider.offline_access else "not issued"))
    if c == "oauth2_client_credentials" and provider.audience:
        rows.append(("Resource / audience", provider.audience))
    if c == "caracal_mandate" or (c == "mcp" and provider.mcp_auth == "mandate"):
        rows.append(("Mandate header", f"{provider.auth_header}: {provider.auth_scheme} <mandate>"))
        rows.append(("Required scopes", " ".join(provider.scopes) or "—"))
        rows.append(("Delegation", "required" if provider.require_delegation else "optional"))
    if c == "mcp":
        rows.append(("MCP endpoint", f"{base}/mcp (JSON-RPC)"))
    if provider.protocol == "sse":
        rows.append(("Stream endpoint", f"{base}/stream"))
    if provider.sdk_package:
        rows.append(("SDK package", provider.sdk_package))
    rows.append(("Health check", f"{base}/healthz"))
    return rows


def layout(provider: catalog.Provider, active: str, body: str) -> str:
    nav = []
    for key, label in (("home", "Dashboard"), ("resources", "Resources"),
                       ("credentials", "Credentials"), ("clients", "Clients"),
                       ("api-clients", "API clients")):
        href = "/" if key == "home" else f"/__lab/{key}"
        cls = "active" if active == key else ""
        nav.append(f'<a class="{cls}" href="{href}">{label}</a>')
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>{_esc(provider.brand)} · provider lab</title>
<style>
  body {{ font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #0f1320; color: #e7ecf5; }}
  header {{ padding: 18px 28px; border-bottom: 1px solid #232a3d; background: #141a2b; }}
  header h1 {{ font-size: 17px; margin: 0; }}
  header .tag {{ color: #8b97b4; font-size: 12px; margin-top: 3px; }}
  .badge {{ display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 10px; background: #243049; color: #9fc0ff; margin-left: 8px; }}
  nav {{ display: flex; gap: 4px; padding: 0 22px; background: #141a2b; border-bottom: 1px solid #232a3d; }}
  nav a {{ padding: 10px 14px; color: #9aa6c2; text-decoration: none; font-size: 13px; border-bottom: 2px solid transparent; }}
  nav a.active {{ color: #fff; border-bottom-color: #5d8bff; }}
  main {{ padding: 24px 28px; max-width: 920px; }}
  h2 {{ font-size: 14px; margin: 22px 0 10px; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 14px; }}
  th, td {{ text-align: left; padding: 7px 9px; border-bottom: 1px solid #232a3d; }}
  th {{ color: #8b97b4; font-weight: 600; }}
  code {{ font-family: ui-monospace, monospace; font-size: 11px; background: #1b2236; padding: 1px 5px; border-radius: 3px; color: #cdd7ee; word-break: break-all; }}
  form.inline {{ display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0 18px; }}
  input, select {{ background: #1b2236; border: 1px solid #2c364f; color: #e7ecf5; padding: 6px 8px; border-radius: 4px; font-size: 12px; }}
  button {{ background: #2f56b5; color: #fff; border: none; padding: 6px 12px; border-radius: 4px; font-size: 12px; cursor: pointer; }}
  button.danger {{ background: #7a2b39; }}
  .muted {{ color: #8b97b4; font-size: 12px; }}
  .panel {{ background: #141a2b; border: 1px solid #232a3d; border-radius: 6px; padding: 16px; margin-bottom: 16px; }}
  .pill {{ font-size: 11px; padding: 1px 7px; border-radius: 9px; }}
  .ok {{ background: #1d3b2a; color: #7fe0a6; }}
  .gone {{ background: #3b1d22; color: #e08a98; }}
  .secret {{ cursor: pointer; user-select: none; }}
  .secret::after {{ content: " 👁"; font-size: 10px; opacity: 0.6; }}
</style></head>
<body>
<script>
function toggleSecret(el) {{
  const shown = el.dataset.shown === "1";
  el.dataset.shown = shown ? "0" : "1";
  el.firstChild.textContent = shown ? el.dataset.mask : el.dataset.value;
}}
</script>
<header>
  <h1>{_esc(provider.brand)} <span class="badge">{_esc(_CATEGORY_LABEL[provider.category])}</span></h1>
  <div class="tag">{_esc(provider.tagline)} · localhost:{provider.port}</div>
</header>
<nav>{''.join(nav)}</nav>
<main>{body}</main>
</body></html>"""


def overview(provider: catalog.Provider) -> str:
    store = credentials.load(provider.id)
    seed = store.data["seed"]
    rows = "".join(
        f"<tr><td>{_esc(k)}</td><td>{_secret(v) if k in _SECRET_FIELDS else '<code>' + _esc(v) + '</code>'}</td></tr>"
        for k, v in seed.items() if not isinstance(v, (list, dict))
    )
    ops = "".join(f"<li><code>{_esc(o)}</code></li>" for o in provider.operations)
    auth_summary = _auth_summary(provider)
    config = "".join(
        f"<tr><td>{_esc(label)}</td><td><code>{_esc(value)}</code></td></tr>"
        for label, value in _config_rows(provider)
    )
    active, revoked = _credential_counts(store)
    body = f"""
<div class="panel">
  <h2>Status</h2>
  <p><span class="pill ok">operational</span>
     <span class="muted">{active} active credential(s) · {revoked} revoked · {len(provider.resources)} resource type(s)</span></p>
</div>
<div class="panel">
  <h2>Configuration</h2>
  <table><tr><th>setting</th><th>value</th></tr>{config}</table>
  <p class="muted">{auth_summary}</p>
</div>
<div class="panel">
  <h2>Seed credential (for verification flows)</h2>
  <table><tr><th>field</th><th>value</th></tr>{rows}</table>
  <p class="muted">Seed material is persisted under <code>_store/{_esc(provider.id)}.json</code> and indexed in <code>_store/_seed_index.json</code>.</p>
</div>
<div class="panel">
  <h2>Operations</h2>
  <ul>{ops}</ul>
  <p class="muted">Domain calls are served under <code>/api/&lt;operation&gt;</code>.</p>
</div>"""
    return layout(provider, "home", body)


def _credential_counts(store) -> tuple[int, int]:
    active = revoked = 0
    for field in ("apiKeys", "bearerTokens", "clients"):
        for rec in store.data.get(field, []):
            if rec.get("revoked"):
                revoked += 1
            else:
                active += 1
    return active, revoked


def _auth_summary(provider: catalog.Provider) -> str:
    c = provider.category
    if c in ("api_key", "sdk"):
        loc = "query parameter" if provider.apikey_location == "query" else "header"
        return f"Send the API key in the <code>{_esc(provider.apikey_field)}</code> {loc}."
    if c == "bearer_token":
        return f"Send the static token as <code>{_esc(provider.auth_header)}: {_esc(provider.auth_scheme)} &lt;token&gt;</code>."
    if c == "oauth2_client_credentials":
        return (f"Exchange client credentials at <code>POST /oauth/token</code> "
                f"(grant_type=client_credentials, {_esc(provider.client_auth_method)}), then call with the access token.")
    if c == "oauth2_authorization_code":
        extra = "PKCE required. " if provider.use_pkce else ""
        extra += "Issues refresh tokens (offline access). " if provider.offline_access else ""
        return (f"{extra}Authorize at <code>GET /oauth/authorize</code>, exchange the code at "
                f"<code>POST /oauth/token</code>, then call with the access token.")
    if c == "caracal_mandate":
        d = " A delegated mandate is required." if provider.require_delegation else ""
        return (f"Present a Caracal mandate as <code>Authorization: Bearer &lt;mandate&gt;</code>. "
                f"The provider verifies it like a Caracal verifier SDK at its boundary.{d}")
    if c == "none":
        return "Internal provider. No upstream credential; access is trusted at the network boundary."
    if c == "mcp" and provider.mcp_auth == "mandate":
        return "MCP JSON-RPC at <code>POST /mcp</code>, guarded by a Caracal mandate."
    if c == "mcp":
        return "MCP JSON-RPC at <code>POST /mcp</code>, guarded by a bearer token."
    return ""


def _cred_table(title: str, headers: list[str], rows: list[str]) -> str:
    head = "".join(f"<th>{_esc(h)}</th>" for h in headers)
    body = "".join(rows) or f'<tr><td colspan="{len(headers)}" class="muted">none</td></tr>'
    return f"<h2>{_esc(title)}</h2><table><tr>{head}</tr>{body}</table>"


def _status_pill(revoked: bool) -> str:
    return '<span class="pill gone">revoked</span>' if revoked else '<span class="pill ok">active</span>'


def credentials_page(provider: catalog.Provider) -> str:
    store = credentials.load(provider.id)
    cat = provider.category
    sections: list[str] = []

    if cat in ("api_key", "sdk"):
        rows = [
            f"<tr><td><code>{_esc(r['keyId'])}</code></td><td>{_secret(r['apiKey'])}</td>"
            f"<td>{_esc(r['label'])}</td><td>{_ts(r.get('createdAt'))}</td>"
            f"<td>{_usage(r)}</td><td>{_status_pill(r['revoked'])}</td>"
            f"<td>{_action_btns('apiKey', r['keyId'], r['revoked'])}</td></tr>"
            for r in store.data["apiKeys"]
        ]
        sections.append(_cred_table(
            "API keys", ["keyId", "apiKey", "label", "created", "usage", "status", ""], rows))
        sections.append(_create_form("apiKey", "Create API key"))
        sections.append(_validate_widget("apiKey", "Test an API key"))

    if cat == "bearer_token" or (cat == "mcp" and provider.mcp_auth == "bearer"):
        rows = [
            f"<tr><td><code>{_esc(r['tokenId'])}</code></td><td>{_secret(r['accessToken'])}</td>"
            f"<td>{_esc(r['label'])}</td><td>{_ts(r.get('createdAt'))}</td>"
            f"<td>{_usage(r)}</td><td>{_status_pill(r['revoked'])}</td>"
            f"<td>{_action_btns('bearer', r['tokenId'], r['revoked'])}</td></tr>"
            for r in store.data["bearerTokens"]
        ]
        sections.append(_cred_table(
            "Bearer tokens", ["tokenId", "accessToken", "label", "created", "usage", "status", ""], rows))
        sections.append(_create_form("bearer", "Issue bearer token"))
        sections.append(_validate_widget("bearer", "Test a bearer token"))

    if cat in ("oauth2_client_credentials", "oauth2_authorization_code"):
        rows = [
            f"<tr><td><code>{_esc(r['clientId'])}</code></td><td>{_secret(r['clientSecret'])}</td>"
            f"<td>{_esc(', '.join(r['scopes']))}</td><td>{_ts(r.get('createdAt'))}</td>"
            f"<td>{_status_pill(r['revoked'])}</td></tr>"
            for r in store.data["clients"]
        ]
        sections.append(_cred_table(
            "OAuth client secrets", ["clientId", "clientSecret", "scopes", "created", "status"], rows))
        sections.append('<p class="muted">Register, rotate, and revoke clients on the '
                        '<a href="/__lab/clients">Clients</a> page.</p>')

    if cat == "caracal_mandate" or (cat == "mcp" and provider.mcp_auth == "mandate"):
        seed = store.data["seed"].get("mandate", "")
        revoked = "".join(f"<tr><td><code>{_esc(a)}</code></td></tr>" for a in store.data["revoked"]) \
            or '<tr><td class="muted">none</td></tr>'
        sections.append(f"""
<h2>Zone signing key</h2>
<table><tr><th>zone</th><th>signing key (HS256)</th></tr>
<tr><td><code>{_esc(store.data['zone'])}</code></td><td>{_secret(store.data['signing_key'])}</td></tr></table>
<h2>Seed mandate</h2>
<p>{_secret(seed)}</p>
<h2>Revoked anchors</h2>
<table><tr><th>anchor</th></tr>{revoked}</table>
<form class="inline" method="post" action="/__lab/api/revoke-anchor">
  <input name="anchor" placeholder="sid_/agent_/edge_ anchor to revoke" size="32" required>
  <button class="danger" type="submit">Revoke anchor</button>
</form>""")

    if cat == "none":
        sections.append('<div class="panel"><p class="muted">This internal provider holds no credentials. '
                        'Access is enforced at the network boundary only.</p></div>')

    sections.append(_revoked_history(store))
    return layout(provider, "credentials", "".join(sections))


def _usage(rec: dict) -> str:
    count = rec.get("useCount", 0)
    if not count:
        return '<span class="muted">unused</span>'
    return f"{count} call(s), last {_ts(rec.get('lastUsedAt'))}"


def _revoked_history(store) -> str:
    history = store.revoked_history()
    if not history:
        return ""
    rows = "".join(
        f"<tr><td>{_esc(h['kind'])}</td><td><code>{_esc(h['id'])}</code></td>"
        f"<td>{_esc(h['label'])}</td><td>{_ts(h['revokedAt'])}</td>"
        f"<td>{('<code>' + _esc(h['rotatedTo']) + '</code>') if h.get('rotatedTo') else '—'}</td></tr>"
        for h in history
    )
    return ('<h2>Revoked credential history</h2>'
            '<table><tr><th>kind</th><th>id</th><th>label</th><th>revoked</th><th>rotated to</th></tr>'
            f'{rows}</table>')


def _validate_widget(kind: str, label: str) -> str:
    return f"""
<h2>{_esc(label)}</h2>
<form class="inline" method="post" action="/__lab/api/validate"
      onsubmit="event.preventDefault();fetch(this.action,{{method:'POST',headers:{{'Content-Type':'application/x-www-form-urlencoded'}},body:new URLSearchParams(new FormData(this))}}).then(r=>r.json()).then(d=>{{this.nextElementSibling.textContent=d.valid?'valid':'invalid';this.nextElementSibling.className=d.valid?'pill ok':'pill gone';}});">
  <input type="hidden" name="kind" value="{_esc(kind)}">
  <input name="secret" placeholder="paste credential to validate" size="34" required>
  <button type="submit">Validate</button>
</form><span class="pill muted">not tested</span>"""


def resource_explorer_page(provider: catalog.Provider, state) -> str:
    """Render the provider's live domain data model: each resource table with a count and sample row."""
    from _mock.providerlab.providers import base

    with state.lock:
        if not state.seeded:
            seed = base.SEEDERS.get(provider.id)
            if seed is not None:
                seed(state)
            state.seeded = True
        tables = {name: dict(rows) for name, rows in state.tables.items()}

    panels = []
    for resource in provider.resources:
        rows = tables.get(resource, {})
        sample = next(iter(rows.values()), None)
        fields = ", ".join(f"<code>{_esc(k)}</code>" for k in sample.keys()) if isinstance(sample, dict) else "—"
        sample_json = _esc(sample) if sample is not None else "no rows yet"
        panels.append(f"""
<div class="panel">
  <h2>{_esc(resource)} <span class="badge">{len(rows)} record(s)</span></h2>
  <p class="muted">fields: {fields}</p>
  <code>{sample_json}</code>
</div>""")
    if not panels:
        panels.append('<div class="panel"><p class="muted">This provider exposes no stored resources.</p></div>')
    intro = (f'<div class="panel"><p class="muted">Live data served by {_esc(provider.brand)} on this port. '
             f'Records evolve as operations run against <code>/api/&lt;operation&gt;</code>.</p></div>')
    return layout(provider, "resources", intro + "".join(panels))


def clients_page(provider: catalog.Provider) -> str:
    store = credentials.load(provider.id)
    cat = provider.category
    if cat in ("oauth2_client_credentials", "oauth2_authorization_code"):
        rows = [
            f"<tr><td><code>{_esc(r['clientId'])}</code></td><td>{_esc(r['name'])}</td>"
            f"<td>{_secret(r['clientSecret'])}</td>"
            f"<td>{_esc(', '.join(r['redirectUris']))}</td><td>{_esc(', '.join(r['scopes']))}</td>"
            f"<td>{_status_pill(r['revoked'])}</td>"
            f"<td>{_action_btns('client', r['clientId'], r['revoked'])}</td></tr>"
            for r in store.data["clients"]
        ]
        table = _cred_table("Registered OAuth clients", ["clientId", "name", "clientSecret", "redirectUris", "scopes", "status", ""], rows)
        form = f"""
<h2>Register client</h2>
<form class="inline" method="post" action="/__lab/api/register-client">
  <input name="name" placeholder="application name" required>
  <input name="redirect_uris" placeholder="redirect URI" size="34" value="http://127.0.0.1:8000/callback">
  <input name="scopes" placeholder="scopes" value="{_esc(' '.join(provider.scopes))}" size="22">
  <button type="submit">Register</button>
</form>"""
        return layout(provider, "clients", table + form)

    body = ('<div class="panel"><p class="muted">This provider does not use OAuth application clients. '
            'Machine consumers are managed as credentials and shown on the '
            '<a href="/__lab/api-clients">API clients</a> page.</p></div>')
    return layout(provider, "clients", body)


def api_clients_page(provider: catalog.Provider, activity: list[dict]) -> str:
    rows = [
        f"<tr><td>{_esc(a['principal'])}</td><td>{_esc(a['auth'])}</td><td>{a['calls']}</td>"
        f"<td><code>{_esc(a['last_op'])}</code></td><td>{a['last_status']}</td></tr>"
        for a in activity
    ]
    table = _cred_table("Live API clients", ["principal", "auth", "calls", "last operation", "last status"], rows)
    note = ('<p class="muted">API clients are derived from authenticated calls observed on this provider port. '
            'Issue credentials on the <a href="/__lab/credentials">Credentials</a> page, then call '
            f'<code>/api/&lt;operation&gt;</code>.</p>')
    return layout(provider, "api-clients", table + note)


def _create_form(kind: str, label: str) -> str:
    return f"""
<form class="inline" method="post" action="/__lab/api/create-credential">
  <input type="hidden" name="kind" value="{_esc(kind)}">
  <input name="label" placeholder="label" required>
  <button type="submit">{_esc(label)}</button>
</form>"""


def _revoke_btn(kind: str, identifier: str, revoked: bool) -> str:
    if revoked:
        return ""
    return f"""<form method="post" action="/__lab/api/revoke" style="margin:0">
  <input type="hidden" name="kind" value="{_esc(kind)}">
  <input type="hidden" name="id" value="{_esc(identifier)}">
  <button class="danger" type="submit">Revoke</button></form>"""


def _action_btns(kind: str, identifier: str, revoked: bool) -> str:
    if revoked:
        return ""
    rotate = f"""<form method="post" action="/__lab/api/rotate" style="margin:0">
  <input type="hidden" name="kind" value="{_esc(kind)}">
  <input type="hidden" name="id" value="{_esc(identifier)}">
  <button type="submit">Rotate</button></form>"""
    return f'<div style="display:flex;gap:6px">{rotate}{_revoke_btn(kind, identifier, revoked)}</div>'
