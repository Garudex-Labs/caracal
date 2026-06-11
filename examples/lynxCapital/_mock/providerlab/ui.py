"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Server-rendered control panel for each lab provider with credentials, clients, and API client pages.
"""
from __future__ import annotations

import html
import json
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
    """Render a secret masked by default with reveal and copy controls, so shared
    demos never expose live credential material at a glance."""
    raw = str(value)
    if not raw:
        return '<code class="muted">—</code>'
    mask = raw[:4] + "…" + "•" * 6 if len(raw) > 4 else "•" * 8
    return (
        '<span class="secret-wrap">'
        f'<code class="secret" data-value="{_esc(raw)}" data-mask="{_esc(mask)}" '
        f'data-shown="0" onclick="toggleSecret(this)" title="Click to reveal"><span>{_esc(mask)}</span></code>'
        f'<button type="button" class="icon-btn" onclick="copySecret(this)" data-value="{_esc(raw)}" '
        'title="Copy to clipboard">copy</button></span>'
    )


_SECRET_FIELDS = {"apiKey", "bearerToken", "clientSecret", "accessToken", "mandate",
                  "signing_key", "refreshToken"}


def _config_rows(provider: catalog.Provider) -> list[tuple[str, str]]:
    """Real-world connection settings a caller configures to integrate, named
    with each provider's own wire vocabulary rather than any internal scheme."""
    base_url = f"http://localhost:{provider.port}"
    rows: list[tuple[str, str]] = [
        ("Base URL", base_url),
        ("Protocol", provider.protocol.upper()),
        ("Authentication", _CATEGORY_LABEL[provider.category]),
    ]
    if provider.protocol == "grpc":
        descriptor = base.GRPC_SERVICES.get(provider.id)
        if descriptor:
            rows.append(("gRPC target", f"localhost:{provider.port}"))
            rows.append(("Proto package", descriptor["package"]))
            rows.append(("Server reflection", "enabled"))
    c = provider.category
    if catalog.apikey_auth(provider):
        if provider.protocol == "grpc":
            where = "call metadata"
        else:
            where = "query parameter" if provider.apikey_location == "query" else "request header"
        rows.append(("API key parameter", f"{provider.apikey_field} ({where})"))
    if catalog.bearer_auth(provider) or (c == "mcp" and provider.mcp_auth == "bearer"):
        rows.append(("Token header", f"{provider.auth_header}: {provider.auth_scheme} <token>"))
    if c in ("oauth2_client_credentials", "oauth2_authorization_code"):
        rows.append(("Token endpoint", f"{base_url}/oauth/token"))
        rows.append(("Revocation endpoint", f"{base_url}/oauth/revoke"))
        rows.append(("Introspection endpoint", f"{base_url}/oauth/introspect"))
        rows.append(("Discovery", f"{base_url}/.well-known/oauth-authorization-server"))
        rows.append(("Client authentication", provider.client_auth_method))
        rows.append(("Scopes", " ".join(provider.scopes) or "—"))
    if c == "oauth2_authorization_code":
        rows.append(("Authorization endpoint", f"{base_url}/oauth/authorize"))
        rows.append(("PKCE", "required (S256)" if provider.use_pkce else "not required"))
        rows.append(("Refresh tokens", "issued (offline access)" if provider.offline_access else "not issued"))
    if c == "oauth2_client_credentials" and provider.audience:
        rows.append(("Resource / audience", provider.audience))
    if c == "caracal_mandate" or (c == "mcp" and provider.mcp_auth == "mandate"):
        rows.append(("Mandate header", f"{provider.auth_header}: {provider.auth_scheme} <mandate>"))
        rows.append(("Required scopes", " ".join(provider.scopes) or "—"))
        rows.append(("Delegation", "required" if provider.require_delegation else "optional"))
    if c == "mcp":
        rows.append(("MCP endpoint", f"{base_url}/mcp (JSON-RPC)"))
    if provider.protocol == "sse":
        rows.append(("Stream endpoint", f"{base_url}/stream"))
    if provider.sdk_package:
        rows.append(("SDK package", provider.sdk_package))
    rows.append(("Health check", f"{base_url}/healthz"))
    return rows


_STYLE = """
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", system-ui, sans-serif; margin: 0;
         background: #0a0a0a; color: #ededed; font-size: 13px; line-height: 1.5;
         -webkit-font-smoothing: antialiased; }
  header { display: flex; align-items: baseline; gap: 10px; padding: 14px 24px 0; }
  header h1 { font-size: 15px; font-weight: 600; margin: 0; white-space: nowrap; }
  header .tag { color: #8f8f8f; font-size: 12px; overflow: hidden;
                text-overflow: ellipsis; white-space: nowrap; }
  header .host { margin-left: auto; font-family: ui-monospace, monospace; font-size: 11px;
                 color: #8f8f8f; white-space: nowrap; }
  .badge { display: inline-flex; font-size: 11px; padding: 0 7px; line-height: 18px;
           border-radius: 4px; background: #1f1f1f; color: #a1a1a1; white-space: nowrap; }
  nav { display: flex; gap: 4px; padding: 6px 16px 0; border-bottom: 1px solid #1f1f1f; }
  nav a { padding: 7px 10px 9px; color: #8f8f8f; text-decoration: none; font-size: 13px;
          border-bottom: 2px solid transparent; margin-bottom: -1px; }
  nav a:hover { color: #ededed; }
  nav a.active { color: #ededed; border-bottom-color: #ededed; }
  main { padding: 24px 24px 48px; max-width: 960px; margin: 0 auto; }
  section { margin-bottom: 28px; }
  h2 { font-size: 13px; font-weight: 500; margin: 0 0 8px; color: #ededed;
       display: flex; align-items: center; gap: 8px; }
  h2 .count { color: #8f8f8f; font-weight: 400; }
  .statbar { display: flex; gap: 36px; margin-bottom: 28px; overflow-x: auto;
             padding-bottom: 2px; }
  .stat { display: flex; flex-direction: column; flex-shrink: 0; }
  .stat .k { font-size: 11px; color: #8f8f8f; white-space: nowrap; }
  .stat .v { font-size: 15px; font-weight: 600; white-space: nowrap; }
  .statusdot { display: inline-block; width: 7px; height: 7px; border-radius: 50%;
               background: #3fb950; margin: 0 6px 1px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #1a1a1a;
           vertical-align: top; }
  th { color: #8f8f8f; font-weight: 500; font-size: 12px; white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  code { font-family: ui-monospace, "SF Mono", monospace; font-size: 12px;
         color: #ededed; word-break: break-all; }
  .panel { border: 1px solid #1f1f1f; border-radius: 6px; overflow-x: auto; }
  .panel-body { padding: 12px; }
  .panel-foot { padding: 9px 12px; border-top: 1px solid #1a1a1a; color: #8f8f8f;
                font-size: 12px; }
  .hint { color: #8f8f8f; font-size: 12px; margin: 8px 2px 0; }
  form.inline { display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
                padding: 10px 12px; border-top: 1px solid #1a1a1a; }
  input, select { background: transparent; border: 1px solid #2e2e2e; color: #ededed;
                  padding: 5px 9px; border-radius: 5px; font-size: 12.5px; }
  input::placeholder { color: #707070; }
  input:focus { outline: none; border-color: #707070; }
  button { background: transparent; color: #ededed; border: 1px solid #2e2e2e;
           padding: 5px 12px; border-radius: 5px; font-size: 12.5px;
           cursor: pointer; white-space: nowrap; }
  button:hover { border-color: #707070; }
  button.primary { background: #ededed; color: #0a0a0a; border-color: #ededed;
                   font-weight: 500; }
  button.primary:hover { background: #cfcfcf; border-color: #cfcfcf; }
  button.danger { color: #f85149; }
  button.danger:hover { border-color: #f85149; }
  .icon-btn { padding: 0 6px; font-size: 11px; line-height: 18px; color: #8f8f8f;
              border: none; }
  .icon-btn:hover { color: #ededed; }
  .muted { color: #8f8f8f; font-size: 12px; }
  .pill { font-size: 12px; white-space: nowrap; }
  .pill::before { content: "\\25CF\\00A0"; font-size: 9px; vertical-align: 1px; }
  .ok { color: #3fb950; }
  .gone { color: #f85149; }
  .neutral { color: #8f8f8f; }
  .secret-wrap { display: inline-flex; align-items: center; gap: 4px; }
  .secret { cursor: pointer; user-select: none; color: #a1a1a1; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px 18px; }
  .chips code { color: #c0c0c0; }
  .row-actions { display: flex; gap: 4px; justify-content: flex-end; }
  .row-actions form { margin: 0; }
  .row-actions button { padding: 2px 9px; font-size: 12px; color: #a1a1a1; }
  .row-actions button:hover { color: #ededed; }
  .row-actions button.danger:hover { color: #f85149; }
  .empty { padding: 20px 12px; color: #8f8f8f; font-size: 12.5px; text-align: center; }
  .kv-grid { display: grid; grid-template-columns: max-content 1fr; gap: 6px 20px;
             padding: 12px; font-size: 12.5px; }
  .kv-grid .k { color: #8f8f8f; white-space: nowrap; }
  details.sample summary { cursor: pointer; color: #8f8f8f; font-size: 12px;
                           padding: 8px 12px; border-top: 1px solid #1a1a1a;
                           user-select: none; }
  details.sample summary:hover { color: #ededed; }
  pre.sample { margin: 0; padding: 10px 12px; font-family: ui-monospace, monospace;
               font-size: 11.5px; line-height: 1.55; color: #c0c0c0;
               border-top: 1px solid #1a1a1a; overflow-x: auto; white-space: pre;
               max-height: 280px; overflow-y: auto; }
  a { color: #52a8ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  @media (max-width: 760px) {
    main { padding: 16px 12px 40px; }
    header { padding: 14px 12px 0; flex-wrap: wrap; }
    header .tag { display: none; }
    nav { padding: 6px 4px 0; overflow-x: auto; }
    .statbar { gap: 24px; }
    .kv-grid { grid-template-columns: 1fr; gap: 0; }
    .kv-grid .k { margin-top: 8px; }
  }
"""

_SCRIPT = """
function toggleSecret(el) {
  const shown = el.dataset.shown === "1";
  el.dataset.shown = shown ? "0" : "1";
  el.firstChild.textContent = shown ? el.dataset.mask : el.dataset.value;
}
function copySecret(btn) {
  navigator.clipboard.writeText(btn.dataset.value).then(() => {
    const old = btn.textContent;
    btn.textContent = "copied";
    setTimeout(() => { btn.textContent = old; }, 1200);
  });
}
function validateCred(form) {
  const out = form.querySelector(".validate-result");
  fetch(form.action, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(new FormData(form)),
  }).then(r => r.json()).then(d => {
    out.textContent = d.valid ? "valid" : "invalid";
    out.className = "validate-result pill " + (d.valid ? "ok" : "gone");
  }).catch(() => {
    out.textContent = "error";
    out.className = "validate-result pill gone";
  });
  return false;
}
"""


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
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>{_STYLE}</style></head>
<body>
<script>{_SCRIPT}</script>
<header>
  <h1>{_esc(provider.brand)}</h1>
  <span class="badge">{_esc(_CATEGORY_LABEL[provider.category])}</span>
  <span class="tag">{_esc(provider.tagline)}</span>
  <span class="host">localhost:{provider.port}</span>
</header>
<nav>{''.join(nav)}</nav>
<main>{body}</main>
</body></html>"""


def overview(provider: catalog.Provider) -> str:
    store = credentials.load(provider.id)
    seed = store.data["seed"]
    seed_rows = "".join(
        f"<tr><td class=\"muted\">{_esc(k)}</td>"
        f"<td>{_secret(v) if k in _SECRET_FIELDS else '<code>' + _esc(v) + '</code>'}</td></tr>"
        for k, v in seed.items() if not isinstance(v, (list, dict))
    )
    ops = "".join(f"<code>{_esc(o)}</code>" for o in provider.operations)
    if provider.category == "mcp":
        ops_hint = "Tools are invoked over JSON-RPC at <code>POST /mcp</code>."
    elif provider.protocol == "grpc":
        ops_hint = ("Each operation maps to a unary or server-streaming gRPC method; "
                    "the lab serves them over the shared HTTP transport.")
    else:
        ops_hint = "Domain calls are served under <code>/api/&lt;operation&gt;</code>."
    config = "".join(
        f"<tr><td class=\"muted\">{_esc(label)}</td><td><code>{_esc(value)}</code></td></tr>"
        for label, value in _config_rows(provider)
    )
    active, revoked = _credential_counts(store)
    body = f"""
<div class="statbar" aria-label="Status">
  <div class="stat"><span class="k">Status</span>
    <span class="v"><span class="statusdot"></span>operational</span></div>
  <div class="stat"><span class="k">Active credentials</span><span class="v">{active}</span></div>
  <div class="stat"><span class="k">Revoked</span><span class="v">{revoked}</span></div>
  <div class="stat"><span class="k">Resource types</span><span class="v">{len(provider.resources)}</span></div>
  <div class="stat"><span class="k">Operations</span><span class="v">{len(provider.operations)}</span></div>
  <div class="stat"><span class="k">Industry</span><span class="v">{_esc(provider.industry)}</span></div>
</div>
<section>
  <h2>Configuration</h2>
  <div class="panel"><table>{config}</table></div>
  <p class="hint">{_auth_summary(provider)}</p>
</section>
<section>
  <h2>Seed credential</h2>
  <div class="panel"><table>{seed_rows}</table></div>
  <p class="hint">Used by verification flows. Persisted under <code>_store/{_esc(provider.id)}.json</code>.</p>
</section>
<section>
  <h2>Operations <span class="count">{len(provider.operations)}</span></h2>
  <div class="panel"><div class="panel-body chips">{ops}</div></div>
  <p class="hint">{ops_hint}</p>
</section>{_grpc_panel(provider)}{_mcp_panel(provider)}"""
    return layout(provider, "home", body)


def _grpc_panel(provider: catalog.Provider) -> str:
    """Render the gRPC service/method surface for a grpc provider."""
    descriptor = base.GRPC_SERVICES.get(provider.id)
    if provider.protocol != "grpc" or not descriptor:
        return ""
    blocks = []
    for service in descriptor["services"]:
        rpc_rows = []
        for rpc in service["rpcs"]:
            response = rpc["response"]
            if rpc.get("server_streaming"):
                response = f"stream {response}"
            badge = ' <span class="badge">server streaming</span>' if rpc.get("server_streaming") else ""
            rpc_rows.append(
                f"<tr><td><code>{_esc(rpc['name'])}</code>{badge}</td>"
                f"<td><code>({_esc(rpc['request'])}) returns ({_esc(response)})</code></td></tr>")
        blocks.append(
            f'<section><h2>{_esc(descriptor["package"])}.{_esc(service["name"])}</h2>'
            f'<div class="panel"><table><tr><th>rpc</th><th>signature</th></tr>{"".join(rpc_rows)}</table></div></section>')
    return ("".join(blocks) +
            '<p class="hint">Methods are discoverable through server reflection and '
            'authenticated with the <code>x-api-key</code> call metadata.</p>')


def _mcp_panel(provider: catalog.Provider) -> str:
    """Render the MCP tool catalog and resource list for an MCP provider."""
    if provider.category != "mcp":
        return ""
    specs = base.TOOLSPECS.get(provider.id, {})
    rows = []
    for op in provider.operations:
        spec = specs.get(op, {})
        title = spec.get("title", op)
        desc = spec.get("description", "")
        ann = spec.get("annotations", {})
        flags = []
        if ann.get("readOnlyHint"):
            flags.append("read-only")
        if ann.get("destructiveHint"):
            flags.append("destructive")
        if ann.get("idempotentHint"):
            flags.append("idempotent")
        badge = f' <span class="badge">{" · ".join(flags)}</span>' if flags else ""
        rows.append(f"<tr><td><code>{_esc(op)}</code></td><td>{_esc(title)}{badge}<br>"
                    f'<span class="muted">{_esc(desc)}</span></td></tr>')
    tools = (f'<section><h2>MCP tools <span class="count">{len(rows)}</span></h2>'
             f'<div class="panel"><table><tr><th>tool</th><th>description</th></tr>{"".join(rows)}</table></div>'
             '<p class="hint">Discoverable via JSON-RPC <code>tools/list</code>; '
             'invoked with <code>tools/call</code>.</p></section>')
    resources = base.RESOURCES.get(provider.id, [])
    if not resources:
        return tools
    res_rows = "".join(
        f"<tr><td><code>{_esc(r['uri'])}</code></td><td>{_esc(r['name'])}<br>"
        f'<span class="muted">{_esc(r["description"])}</span></td></tr>'
        for r in resources)
    res = (f'<section><h2>MCP resources <span class="count">{len(resources)}</span></h2>'
           f'<div class="panel"><table><tr><th>uri</th><th>resource</th></tr>{res_rows}</table></div>'
           '<p class="hint">Discoverable via <code>resources/list</code>; '
           'fetched with <code>resources/read</code>.</p></section>')
    return tools + res


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
    if c == "sdk" and catalog.bearer_auth(provider):
        return (f"Initialize the {_esc(provider.sdk_package)} SDK with your secret key; "
                f"the SDK sends it as <code>{_esc(provider.auth_header)}: {_esc(provider.auth_scheme)} &lt;secret&gt;</code>.")
    if catalog.apikey_auth(provider):
        if provider.protocol == "grpc":
            return (f"Attach the API key as the <code>{_esc(provider.apikey_field)}</code> "
                    "gRPC call metadata on every RPC.")
        loc = "query parameter" if provider.apikey_location == "query" else "header"
        return f"Send the API key in the <code>{_esc(provider.apikey_field)}</code> {loc}."
    if catalog.bearer_auth(provider):
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


def _cred_panel(title: str, headers: list[str], rows: list[str],
                forms: str = "", empty: str = "none issued yet") -> str:
    head = "".join(f"<th>{_esc(h)}</th>" for h in headers)
    body = "".join(rows) or f'<tr><td colspan="{len(headers)}" class="empty">{_esc(empty)}</td></tr>'
    count = f' <span class="count">{len(rows)}</span>' if rows else ""
    return (f"<section><h2>{_esc(title)}{count}</h2>"
            f'<div class="panel"><table><tr>{head}</tr>{body}</table>{forms}</div></section>')


def _status_pill(revoked: bool) -> str:
    return '<span class="pill gone">revoked</span>' if revoked else '<span class="pill ok">active</span>'


def credentials_page(provider: catalog.Provider) -> str:
    store = credentials.load(provider.id)
    cat = provider.category
    sections: list[str] = []

    if catalog.apikey_auth(provider):
        rows = [
            f"<tr><td><code>{_esc(r['keyId'])}</code></td><td>{_secret(r['apiKey'])}</td>"
            f"<td>{_esc(r['label'])}</td><td>{_ts(r.get('createdAt'))}</td>"
            f"<td>{_usage(r)}</td><td>{_status_pill(r['revoked'])}</td>"
            f"<td>{_action_btns('apiKey', r['keyId'], r['revoked'])}</td></tr>"
            for r in store.data["apiKeys"]
        ]
        forms = _create_form("apiKey", "Create API key") + _validate_widget("apiKey", "Test an API key")
        sections.append(_cred_panel(
            "API keys", ["keyId", "apiKey", "label", "created", "usage", "status", ""], rows, forms))

    if catalog.bearer_auth(provider) or (cat == "mcp" and provider.mcp_auth == "bearer"):
        label_noun = "Secret keys" if cat == "sdk" else "Bearer tokens"
        rows = [
            f"<tr><td><code>{_esc(r['tokenId'])}</code></td><td>{_secret(r['accessToken'])}</td>"
            f"<td>{_esc(r['label'])}</td><td>{_ts(r.get('createdAt'))}</td>"
            f"<td>{_usage(r)}</td><td>{_status_pill(r['revoked'])}</td>"
            f"<td>{_action_btns('bearer', r['tokenId'], r['revoked'])}</td></tr>"
            for r in store.data["bearerTokens"]
        ]
        forms = (_create_form("bearer", "Issue secret key" if cat == "sdk" else "Issue bearer token")
                 + _validate_widget("bearer", "Test a secret key" if cat == "sdk" else "Test a bearer token"))
        sections.append(_cred_panel(
            label_noun, ["tokenId", "accessToken", "label", "created", "usage", "status", ""], rows, forms))

    if cat in ("oauth2_client_credentials", "oauth2_authorization_code"):
        rows = [
            f"<tr><td><code>{_esc(r['clientId'])}</code></td><td>{_secret(r['clientSecret'])}</td>"
            f"<td>{_esc(', '.join(r['scopes']))}</td><td>{_ts(r.get('createdAt'))}</td>"
            f"<td>{_usage(r)}</td><td>{_status_pill(r['revoked'])}</td></tr>"
            for r in store.data["clients"]
        ]
        forms = _validate_widget("access_token", "Test an access token",
                                 placeholder="paste access token from /oauth/token")
        sections.append(_cred_panel(
            "OAuth client secrets",
            ["clientId", "clientSecret", "scopes", "created", "usage", "status"], rows, forms))
        sections.append('<p class="hint">Register, rotate, and revoke clients on the '
                        '<a href="/__lab/clients">Clients</a> page.</p>')

    if cat == "caracal_mandate" or (cat == "mcp" and provider.mcp_auth == "mandate"):
        seed = store.data["seed"].get("mandate", "")
        revoked_rows = ["<tr><td><code>" + _esc(a) + "</code></td></tr>" for a in store.data["revoked"]]
        revoke_form = """
<form class="inline" method="post" action="/__lab/api/revoke-anchor">
  <input name="anchor" placeholder="sid_/agent_/edge_ anchor to revoke" size="32" required>
  <button class="danger" type="submit">Revoke anchor</button>
</form>"""
        sections.append(f"""
<section>
  <h2>Zone signing key</h2>
  <div class="panel"><table><tr><th>zone</th><th>signing key (HS256)</th></tr>
  <tr><td><code>{_esc(store.data['zone'])}</code></td><td>{_secret(store.data['signing_key'])}</td></tr></table></div>
</section>
<section>
  <h2>Seed mandate</h2>
  <div class="panel"><div class="panel-body">{_secret(seed)}</div></div>
</section>""")
        sections.append(_cred_panel("Revoked anchors", ["anchor"], revoked_rows,
                                    revoke_form, empty="no anchors revoked"))

    if cat == "none":
        sections.append('<div class="panel"><div class="empty">This internal provider holds no '
                        'credentials. Access is enforced at the network boundary only.</div></div>')

    sections.append(_revoked_history(store))
    return layout(provider, "credentials", "".join(sections))


def _usage(rec: dict) -> str:
    count = rec.get("useCount", 0)
    if not count:
        return '<span class="muted">unused</span>'
    return f"{count} calls<br><span class=\"muted\">{_ts(rec.get('lastUsedAt'))}</span>"


def _revoked_history(store) -> str:
    history = store.revoked_history()
    if not history:
        return ""
    rows = [
        f"<tr><td>{_esc(h['kind'])}</td><td><code>{_esc(h['id'])}</code></td>"
        f"<td>{_esc(h['label'])}</td><td>{_ts(h['revokedAt'])}</td>"
        f"<td>{('<code>' + _esc(h['rotatedTo']) + '</code>') if h.get('rotatedTo') else '—'}</td></tr>"
        for h in history
    ]
    return _cred_panel("Revoked credential history",
                       ["kind", "id", "label", "revoked", "rotated to"], rows)


def _validate_widget(kind: str, label: str, placeholder: str = "paste credential to validate") -> str:
    return f"""
<form class="inline" method="post" action="/__lab/api/validate" onsubmit="return validateCred(this)">
  <input type="hidden" name="kind" value="{_esc(kind)}">
  <input name="secret" placeholder="{_esc(placeholder)}" size="34" required>
  <button type="submit">{_esc(label)}</button>
  <span class="validate-result pill neutral">not tested</span>
</form>"""


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
        fields = "".join(f"<code>{_esc(k)}</code>" for k in sample.keys()) if isinstance(sample, dict) else ""
        if sample is not None:
            try:
                pretty = json.dumps(sample, indent=2, default=str)
            except (TypeError, ValueError):
                pretty = str(sample)
            sample_block = (f'<details class="sample"><summary>Sample record</summary>'
                            f'<pre class="sample">{_esc(pretty)}</pre></details>')
        else:
            sample_block = '<div class="empty">no rows yet</div>'
        field_row = f'<div class="panel-body chips">{fields}</div>' if fields else ""
        panels.append(f"""
<section>
  <h2>{_esc(resource)} <span class="count">{len(rows)}</span></h2>
  <div class="panel">{field_row}{sample_block}</div>
</section>""")
    if not panels:
        panels.append('<div class="panel"><div class="empty">This provider exposes no stored resources.</div></div>')
    intro = (f'<p class="hint" style="margin:0 0 20px">Live data served by {_esc(provider.brand)} on this port. '
             f'Records evolve as operations run against <code>/api/&lt;operation&gt;</code>.</p>')
    return layout(provider, "resources", intro + "".join(panels))


def clients_page(provider: catalog.Provider) -> str:
    store = credentials.load(provider.id)
    cat = provider.category
    if cat in ("oauth2_client_credentials", "oauth2_authorization_code"):
        rows = [
            f"<tr><td><code>{_esc(r['clientId'])}</code></td><td>{_esc(r['name'])}</td>"
            f"<td>{_secret(r['clientSecret'])}</td>"
            f"<td>{_esc(', '.join(r['redirectUris']))}</td><td>{_esc(', '.join(r['scopes']))}</td>"
            f"<td>{_usage(r)}</td><td>{_status_pill(r['revoked'])}</td>"
            f"<td>{_action_btns('client', r['clientId'], r['revoked'])}</td></tr>"
            for r in store.data["clients"]
        ]
        form = f"""
<form class="inline" method="post" action="/__lab/api/register-client">
  <input name="name" placeholder="application name" required>
  <input name="redirect_uris" placeholder="redirect URI" size="34" value="http://127.0.0.1:8000/callback">
  <input name="scopes" placeholder="scopes" value="{_esc(' '.join(provider.scopes))}" size="22">
  <button class="primary" type="submit">Register client</button>
</form>"""
        return layout(provider, "clients", _cred_panel(
            "Registered OAuth clients",
            ["clientId", "name", "clientSecret", "redirectUris", "scopes", "usage", "status", ""],
            rows, form, empty="no clients registered"))

    body = ('<div class="panel"><div class="empty">This provider does not use OAuth application clients. '
            'Machine consumers are managed as credentials and shown on the '
            '<a href="/__lab/api-clients">API clients</a> page.</div></div>')
    return layout(provider, "clients", body)


def api_clients_page(provider: catalog.Provider, activity: list[dict]) -> str:
    rows = [
        f"<tr><td><code>{_esc(a['principal'])}</code></td><td>{_esc(a['auth'])}</td>"
        f"<td>{a['calls']}</td><td><code>{_esc(a['last_op'])}</code></td>"
        f"<td>{_call_status(a['last_status'])}</td></tr>"
        for a in activity
    ]
    panel = _cred_panel(
        "Live API clients", ["principal", "auth", "calls", "last operation", "last status"],
        rows, empty="no authenticated calls observed yet")
    note = ('<p class="hint">API clients are derived from authenticated calls observed on this provider port. '
            'Issue credentials on the <a href="/__lab/credentials">Credentials</a> page, then call '
            '<code>/api/&lt;operation&gt;</code>.</p>')
    return layout(provider, "api-clients", panel + note)


def _call_status(status: int) -> str:
    cls = "ok" if 200 <= status < 400 else "gone"
    return f'<span class="pill {cls}">{status}</span>'


def _create_form(kind: str, label: str) -> str:
    return f"""
<form class="inline" method="post" action="/__lab/api/create-credential">
  <input type="hidden" name="kind" value="{_esc(kind)}">
  <input name="label" placeholder="label" required>
  <button class="primary" type="submit">{_esc(label)}</button>
</form>"""


def _action_btns(kind: str, identifier: str, revoked: bool) -> str:
    if revoked:
        return ""
    return f"""<div class="row-actions">
<form method="post" action="/__lab/api/rotate">
  <input type="hidden" name="kind" value="{_esc(kind)}">
  <input type="hidden" name="id" value="{_esc(identifier)}">
  <button type="submit">Rotate</button></form>
<form method="post" action="/__lab/api/revoke">
  <input type="hidden" name="kind" value="{_esc(kind)}">
  <input type="hidden" name="id" value="{_esc(identifier)}">
  <button class="danger" type="submit">Revoke</button></form>
</div>"""


def consent_page(provider: catalog.Provider, params: dict) -> str:
    """OAuth authorization consent prompt shown to the resource owner."""
    scopes = "".join(f"<code>{_esc(s)}</code>" for s in params.get("scope", "").split() if s) or \
        '<span class="muted">no scopes requested</span>'
    hidden = "".join(
        f'<input type="hidden" name="{_esc(k)}" value="{_esc(params.get(k, ""))}">'
        for k in ("client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method")
    )
    body = f"""
<section style="max-width:440px;margin:48px auto 0">
  <h2>Authorize application</h2>
  <div class="panel">
    <div class="kv-grid">
      <span class="k">Application</span><span><code>{_esc(params.get('client_id', ''))}</code></span>
      <span class="k">Scopes</span><span class="chips">{scopes}</span>
      <span class="k">Redirects to</span><span><code>{_esc(params.get('redirect_uri', ''))}</code></span>
    </div>
    <form class="inline" method="post" action="/oauth/authorize">
      {hidden}
      <button class="primary" type="submit">Approve</button>
    </form>
  </div>
</section>"""
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>{_esc(provider.brand)} · authorize</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>{_STYLE}</style></head>
<body>
<header><h1>{_esc(provider.brand)}</h1><span class="badge">OAuth 2.0</span>
<span class="host">localhost:{provider.port}</span></header>
<main>{body}</main>
</body></html>"""
