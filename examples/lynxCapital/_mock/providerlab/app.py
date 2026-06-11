"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

FastAPI application factory that builds one external-style provider, its OAuth and MCP surfaces, and its control UI.
"""
from __future__ import annotations

import base64
import hashlib
import threading
from json import dumps as json_dumps
from urllib.parse import parse_qsl

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

from _mock.providerlab import auth, catalog, credentials, domain, mcp, netsim, ui


async def _form(request: Request) -> dict[str, str]:
    """Parse an application/x-www-form-urlencoded body without a multipart dependency."""
    raw = await request.body()
    return dict(parse_qsl(raw.decode("utf-8"))) if raw else {}


class _Activity:
    """Tracks authenticated callers seen on this provider port for the API clients page."""

    def __init__(self):
        self._lock = threading.Lock()
        self._seen: dict[str, dict] = {}

    def record(self, principal: str, auth_type: str, operation: str, status: int) -> None:
        key = f"{principal}:{auth_type}"
        with self._lock:
            entry = self._seen.setdefault(
                key, {"principal": principal, "auth": auth_type, "calls": 0, "last_op": "", "last_status": 0}
            )
            entry["calls"] += 1
            entry["last_op"] = operation
            entry["last_status"] = status

    def list(self) -> list[dict]:
        with self._lock:
            return list(self._seen.values())


def _auth_error_response(exc: auth.AuthError, provider: catalog.Provider) -> JSONResponse:
    headers = {}
    if provider.category in ("bearer_token", "oauth2_client_credentials",
                             "oauth2_authorization_code", "caracal_mandate"):
        headers["WWW-Authenticate"] = f'{provider.auth_scheme} error="{exc.code}"'
    return JSONResponse(status_code=exc.status, content={"error": exc.code, "message": exc.message}, headers=headers)


def build_app(provider: catalog.Provider) -> FastAPI:
    app = FastAPI(title=f"providerlab-{provider.id}")
    activity = _Activity()
    state = domain.State(provider.id)
    netsim.install(app, provider)

    # ---------- health ----------
    @app.get("/healthz")
    async def healthz():
        return {"status": "ok", "provider": provider.id, "category": provider.category}

    # ---------- control UI ----------
    @app.get("/", response_class=HTMLResponse)
    async def home():
        return HTMLResponse(ui.overview(provider))

    @app.get("/__lab/credentials", response_class=HTMLResponse)
    async def page_credentials():
        return HTMLResponse(ui.credentials_page(provider))

    @app.get("/__lab/clients", response_class=HTMLResponse)
    async def page_clients():
        return HTMLResponse(ui.clients_page(provider))

    @app.get("/__lab/resources", response_class=HTMLResponse)
    async def page_resources():
        return HTMLResponse(ui.resource_explorer_page(provider, state))

    @app.get("/__lab/api-clients", response_class=HTMLResponse)
    async def page_api_clients():
        return HTMLResponse(ui.api_clients_page(provider, activity.list()))

    @app.post("/__lab/api/create-credential")
    async def create_credential(request: Request):
        form = await _form(request)
        store = credentials.load(provider.id)
        kind, label = form.get("kind"), form.get("label", "unnamed")
        if kind == "apiKey":
            store.create_api_key(label)
        elif kind == "bearer":
            store.create_bearer(label)
        return RedirectResponse("/__lab/credentials", status_code=303)

    @app.post("/__lab/api/revoke")
    async def revoke_credential(request: Request):
        form = await _form(request)
        credentials.load(provider.id).revoke(form.get("kind"), form.get("id"))
        back = "/__lab/clients" if form.get("kind") == "client" else "/__lab/credentials"
        return RedirectResponse(back, status_code=303)

    @app.post("/__lab/api/rotate")
    async def rotate_credential(request: Request):
        form = await _form(request)
        credentials.load(provider.id).rotate(form.get("kind"), form.get("id"))
        back = "/__lab/clients" if form.get("kind") == "client" else "/__lab/credentials"
        return RedirectResponse(back, status_code=303)

    @app.post("/__lab/api/validate")
    async def validate_credential(request: Request):
        form = await _form(request)
        store = credentials.load(provider.id)
        kind, secret = form.get("kind", ""), form.get("secret", "").strip()
        valid = False
        if kind == "apiKey":
            valid = store.valid_api_key(secret)
        elif kind == "bearer":
            valid = store.valid_bearer(secret)
        elif kind == "access_token":
            valid = store.valid_access_token(secret) is not None
        return JSONResponse({"provider": provider.id, "kind": kind, "valid": valid})

    @app.post("/__lab/api/register-client")
    async def register_client(request: Request):
        form = await _form(request)
        store = credentials.load(provider.id)
        redirect_uris = [u.strip() for u in form.get("redirect_uris", "").split(",") if u.strip()]
        scopes = [s for s in form.get("scopes", "").split() if s]
        store.create_client(form.get("name", "client"), redirect_uris, scopes)
        return RedirectResponse("/__lab/clients", status_code=303)

    @app.post("/__lab/api/revoke-anchor")
    async def revoke_anchor(request: Request):
        form = await _form(request)
        credentials.load(provider.id).revoke_mandate_anchor(form.get("anchor"))
        return RedirectResponse("/__lab/credentials", status_code=303)

    # ---------- OAuth surface ----------
    if provider.category in ("oauth2_client_credentials", "oauth2_authorization_code"):
        _install_oauth(app, provider)

    # ---------- MCP surface ----------
    if provider.category == "mcp":
        @app.post("/mcp")
        async def mcp_endpoint(request: Request):
            try:
                principal = auth.authenticate(provider, request)
            except auth.AuthError as exc:
                activity.record("anonymous", "rejected", "mcp", exc.status)
                return _auth_error_response(exc, provider)
            message = await request.json()

            def run_tool(name: str, arguments: dict) -> dict:
                return domain.dispatch(provider, state, name, arguments, principal)

            response = mcp.handle(provider, message, principal, run_tool)
            activity.record(str(principal.get("principal")), principal.get("auth"),
                           message.get("method", "mcp"), 200)
            if response is None:
                return Response(status_code=202)
            return JSONResponse(response)

    # ---------- streaming surface (SSE) ----------
    if provider.protocol == "sse":
        _install_sse(app, provider, state)

    # ---------- domain operations ----------
    @app.api_route("/api/{operation}", methods=["GET", "POST"])
    async def domain_operation(operation: str, request: Request):
        if operation not in provider.operations:
            return JSONResponse(status_code=404, content={"error": "unknown_operation", "message": operation})
        try:
            principal = auth.authenticate(provider, request)
        except auth.AuthError as exc:
            activity.record("anonymous", "rejected", operation, exc.status)
            return _auth_error_response(exc, provider)
        payload: dict = {}
        if request.method == "POST":
            try:
                body = await request.json()
                if isinstance(body, dict):
                    payload = body
            except Exception:
                payload = {}
        try:
            data = domain.dispatch(provider, state, operation, payload, principal)
        except domain.DomainError as exc:
            activity.record(str(principal.get("principal")), principal.get("auth"), operation, exc.status)
            return JSONResponse(status_code=exc.status,
                                content={"error": exc.code, "message": exc.message})
        activity.record(str(principal.get("principal")), principal.get("auth"), operation, 200)
        return JSONResponse({"provider": provider.id, "operation": operation, "data": data})

    return app


def _install_sse(app: FastAPI, provider: catalog.Provider, state) -> None:
    """Expose a Server-Sent Events stream for real-time providers like market data."""
    import asyncio

    from sse_starlette.sse import EventSourceResponse

    @app.get("/stream")
    async def stream(request: Request):
        try:
            principal = auth.authenticate(provider, request)
        except auth.AuthError as exc:
            return _auth_error_response(exc, provider)
        symbol = request.query_params.get("symbol", "USD/EUR")
        count = int(request.query_params.get("ticks", 20))

        async def publisher():
            try:
                window = domain.dispatch(provider, state, "stream_rates",
                                         {"symbol": symbol, "ticks": count}, principal)
            except domain.DomainError as exc:
                yield {"event": "error",
                       "data": json_dumps({"error": exc.code, "message": exc.message})}
                return
            yield {"event": "subscribed",
                   "data": json_dumps({"symbol": window["symbol"], "channel": window["channel"],
                                       "count": window["count"]})}
            for i, tick in enumerate(window["ticks"]):
                if await request.is_disconnected():
                    break
                yield {"event": "tick", "id": str(tick["seq"]), "data": json_dumps(tick)}
                if (i + 1) % 5 == 0:
                    yield {"event": "heartbeat",
                           "data": json_dumps({"ts": tick["timestamp"], "seq": tick["seq"]})}
                await asyncio.sleep(0.05)

        return EventSourceResponse(publisher())


def _install_oauth(app: FastAPI, provider: catalog.Provider) -> None:
    @app.get("/.well-known/oauth-authorization-server")
    async def metadata(request: Request):
        base = str(request.base_url).rstrip("/")
        doc = {
            "issuer": base,
            "token_endpoint": f"{base}/oauth/token",
            "revocation_endpoint": f"{base}/oauth/revoke",
            "introspection_endpoint": f"{base}/oauth/introspect",
            "scopes_supported": list(provider.scopes),
            "response_types_supported": ["code"] if provider.category == "oauth2_authorization_code" else [],
            "response_modes_supported": ["query"],
            "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
            "grant_types_supported": [],
        }
        if provider.category == "oauth2_client_credentials":
            doc["grant_types_supported"] = ["client_credentials"]
            if provider.audience:
                doc["resource"] = provider.audience
                doc["resource_indicators_supported"] = True
        else:
            doc["authorization_endpoint"] = f"{base}/oauth/authorize"
            doc["grant_types_supported"] = ["authorization_code", "refresh_token"]
            doc["code_challenge_methods_supported"] = ["S256"] if provider.use_pkce else []
        return JSONResponse(doc)

    if provider.category == "oauth2_authorization_code":
        @app.get("/oauth/authorize", response_class=HTMLResponse)
        async def authorize(request: Request):
            store = credentials.load(provider.id)
            q = request.query_params
            error = _authorize_error(provider, store, dict(q))
            if error is not None:
                return error
            client = store.find_client(q.get("client_id", ""))
            redirect_uri = q.get("redirect_uri", client["redirectUris"][0] if client["redirectUris"] else "")
            params = {key: q.get(key, "") for key in
                      ("client_id", "scope", "state", "code_challenge")}
            params["redirect_uri"] = redirect_uri
            params["code_challenge_method"] = q.get("code_challenge_method", "S256")
            return HTMLResponse(ui.consent_page(provider, params))

        @app.post("/oauth/authorize")
        async def authorize_decision(request: Request):
            store = credentials.load(provider.id)
            form = await _form(request)
            error = _authorize_error(provider, store, form)
            if error is not None:
                return error
            code = store.create_auth_code(
                form.get("client_id"), form.get("redirect_uri"), form.get("scope", ""),
                form.get("code_challenge") or None, subject="resource-owner",
            )
            sep = "&" if "?" in form.get("redirect_uri", "") else "?"
            target = f"{form.get('redirect_uri')}{sep}code={code}&state={form.get('state','')}"
            return RedirectResponse(target, status_code=303)

    @app.post("/oauth/token")
    async def token(request: Request):
        store = credentials.load(provider.id)
        form = await _form(request)
        grant = form.get("grant_type")
        client_id, client_secret = _client_auth(request, form)
        client = store.find_client(client_id) if client_id else None

        if grant == "client_credentials":
            if client is None or client["clientSecret"] != client_secret:
                return _oauth_error(401, "invalid_client")
            scope = form.get("scope", " ".join(provider.scopes))
            granted = set(client.get("scopes") or provider.scopes)
            if not set(scope.split()).issubset(granted):
                return _oauth_error(400, "invalid_scope",
                                    "requested scope exceeds the grant for this client")
            audience = None
            if provider.audience:
                requested = form.get("resource") or form.get("audience") or provider.audience
                if requested != provider.audience:
                    return _oauth_error(400, "invalid_target",
                                        f"unknown or unauthorized resource indicator {requested!r}")
                audience = provider.audience
            issued = store.issue_token(client_id, scope, audience=audience)
            return _token_response(issued)

        if grant == "authorization_code":
            record = store.consume_auth_code(form.get("code", ""))
            if record is None:
                return _oauth_error(400, "invalid_grant")
            if client is None or client["clientSecret"] != client_secret:
                return _oauth_error(401, "invalid_client")
            if record["clientId"] != client_id:
                return _oauth_error(400, "invalid_grant", "code was issued to another client")
            if form.get("redirect_uri", record["redirectUri"]) != record["redirectUri"]:
                return _oauth_error(400, "invalid_grant", "redirect_uri mismatch")
            if provider.use_pkce or record.get("codeChallenge"):
                if not _pkce_ok(form.get("code_verifier", ""), record.get("codeChallenge") or ""):
                    return _oauth_error(400, "invalid_grant", "PKCE verification failed")
            issued = store.issue_token(client_id, record["scope"], subject=record["subject"],
                                       refresh=provider.offline_access)
            return _token_response(issued)

        if grant == "refresh_token":
            issued = store.refresh(form.get("refresh_token", ""))
            if issued is None:
                return _oauth_error(400, "invalid_grant")
            return _token_response(issued)

        return _oauth_error(400, "unsupported_grant_type")

    @app.post("/oauth/revoke")
    async def revoke(request: Request):
        store = credentials.load(provider.id)
        form = await _form(request)
        client_id, client_secret = _client_auth(request, form)
        client = store.find_client(client_id) if client_id else None
        if client is None or client["clientSecret"] != client_secret:
            return _oauth_error(401, "invalid_client")
        store.revoke_access_token(form.get("token", ""))
        return Response(status_code=200)

    @app.post("/oauth/introspect")
    async def introspect(request: Request):
        store = credentials.load(provider.id)
        form = await _form(request)
        client_id, client_secret = _client_auth(request, form)
        client = store.find_client(client_id) if client_id else None
        if client is None or client["clientSecret"] != client_secret:
            return _oauth_error(401, "invalid_client")
        token = store.valid_access_token(form.get("token", ""))
        if token is None:
            return JSONResponse({"active": False})
        return JSONResponse({
            "active": True,
            "client_id": token["clientId"],
            "scope": token["scope"],
            "sub": token.get("subject"),
            "aud": token.get("audience"),
            "token_type": "Bearer",
            "exp": token["expiresAt"],
            "iat": token["createdAt"],
        })


def _authorize_error(provider: catalog.Provider, store, params: dict) -> JSONResponse | None:
    """Validate an authorization request the way a real provider would, before consent."""
    client = store.find_client(params.get("client_id", ""))
    if client is None:
        return JSONResponse(status_code=400, content={"error": "invalid_client"})
    if params.get("response_type", "code") != "code":
        return JSONResponse(status_code=400, content={"error": "unsupported_response_type"})
    redirect_uri = params.get("redirect_uri")
    if redirect_uri and client["redirectUris"] and redirect_uri not in client["redirectUris"]:
        return JSONResponse(status_code=400, content={"error": "invalid_redirect_uri"})
    if provider.use_pkce:
        if not params.get("code_challenge"):
            return JSONResponse(status_code=400,
                                content={"error": "invalid_request", "error_description": "code_challenge required"})
        if params.get("code_challenge_method", "S256") != "S256":
            return JSONResponse(status_code=400,
                                content={"error": "invalid_request", "error_description": "code_challenge_method must be S256"})
    return None


def _client_auth(request: Request, form) -> tuple[str, str]:
    header = request.headers.get("Authorization", "")
    if header.lower().startswith("basic "):
        try:
            decoded = base64.b64decode(header[6:]).decode()
            cid, _, secret = decoded.partition(":")
            return cid, secret
        except Exception:
            return "", ""
    return form.get("client_id", ""), form.get("client_secret", "")


def _pkce_ok(verifier: str, challenge: str) -> bool:
    digest = hashlib.sha256(verifier.encode()).digest()
    computed = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return computed == challenge


def _token_response(issued: dict) -> JSONResponse:
    body = {
        "access_token": issued["accessToken"],
        "token_type": "Bearer",
        "expires_in": 3600,
        "scope": issued["scope"],
    }
    if "refreshToken" in issued:
        body["refresh_token"] = issued["refreshToken"]
    return JSONResponse(body)


def _oauth_error(status: int, code: str, description: str | None = None) -> JSONResponse:
    body = {"error": code}
    if description:
        body["error_description"] = description
    return JSONResponse(status_code=status, content=body)
