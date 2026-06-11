"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Per-provider credential store with create, validate, and revoke lifecycle persisted separately for verification flows.
"""
from __future__ import annotations

import json
import secrets
import threading
import time
import uuid
from pathlib import Path

from _mock.providerlab import catalog, jwtmini, mandate

STORE_DIR = Path(__file__).resolve().parent / "_store"
SEED_INDEX = STORE_DIR / "_seed_index.json"
ZONE = "lynx-zone"

_locks: dict[str, threading.Lock] = {}
_cache: dict[str, "ProviderStore"] = {}
_index_lock = threading.Lock()


def _now() -> int:
    return int(time.time())


def _lock_for(provider_id: str) -> threading.Lock:
    if provider_id not in _locks:
        _locks[provider_id] = threading.Lock()
    return _locks[provider_id]


class ProviderStore:
    """Mutable credential state for one provider, backed by a JSON file."""

    def __init__(self, provider: catalog.Provider):
        self.provider = provider
        self.path = STORE_DIR / f"{provider.id}.json"
        self.data: dict = {}
        self._load()

    # ---- persistence ----
    def _load(self) -> None:
        if self.path.exists():
            self.data = json.loads(self.path.read_text(encoding="utf-8"))
            self._ensure_seed_mandate()
            return
        self._bootstrap()

    def _save(self) -> None:
        STORE_DIR.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, indent=2), encoding="utf-8")

    def _bootstrap(self) -> None:
        p = self.provider
        self.data = {
            "provider": p.id,
            "brand": p.brand,
            "category": p.category,
            "zone": ZONE,
            "signing_key": secrets.token_urlsafe(32),
            "revoked": [],
            "apiKeys": [],
            "bearerTokens": [],
            "clients": [],
            "tokens": [],
            "authCodes": {},
            "seed": {},
        }
        self._seed()
        self._save()
        self._write_index()

    def _seed(self) -> None:
        """Create one canonical credential per provider so verification flows have known values."""
        p = self.provider
        seed: dict = {"resource": f"resource://{p.id}", "scopes": list(p.scopes)}
        if catalog.apikey_auth(p):
            rec = self._new_api_key("seed-key")
            seed["apiKey"] = rec["apiKey"]
            seed["location"] = p.apikey_location
            seed["field"] = p.apikey_field
        elif catalog.bearer_auth(p):
            rec = self._new_bearer("seed-token", prefix="sk_live_" if p.category == "sdk" else "bt_")
            seed["bearerToken"] = rec["accessToken"]
            seed["header"] = p.auth_header
            seed["scheme"] = p.auth_scheme
        elif p.category in ("oauth2_client_credentials", "oauth2_authorization_code"):
            client = self._new_client(
                "seed-client",
                redirect_uris=["http://127.0.0.1:8000/callback"],
                scopes=list(p.scopes),
            )
            seed["clientId"] = client["clientId"]
            seed["clientSecret"] = client["clientSecret"]
            seed["tokenEndpoint"] = "/oauth/token"
            if p.audience:
                seed["audience"] = p.audience
            if p.category == "oauth2_authorization_code":
                seed["authorizationEndpoint"] = "/oauth/authorize"
        elif p.category == "caracal_mandate" or (p.category == "mcp" and p.mcp_auth == "mandate"):
            seed["mandate"] = self._mint_seed_mandate()
            seed["zone"] = ZONE
        elif p.category == "mcp" and p.mcp_auth == "bearer":
            rec = self._new_bearer("seed-token")
            seed["bearerToken"] = rec["accessToken"]
        elif p.category == "none":
            seed["credential"] = None
            seed["note"] = "internal provider; no upstream credential"
        self.data["seed"] = seed

    def _mint_seed_mandate(self) -> str:
        p = self.provider
        claims = mandate.MandateClaims(
            zone=ZONE,
            resource=p.id,
            scopes=list(p.scopes),
            subject="lynx-bootstrap",
            session_id=f"sid_{uuid.uuid4().hex[:12]}",
            root_session_id=f"root_{uuid.uuid4().hex[:12]}",
            agent_session_id=f"agent_{uuid.uuid4().hex[:12]}" if p.require_delegation else None,
            delegation_edge_id=f"edge_{uuid.uuid4().hex[:12]}" if p.require_delegation else None,
            ttl_seconds=86400,
        )
        return mandate.sign(claims, self.data["signing_key"])

    def _ensure_seed_mandate(self) -> None:
        """A persisted seed mandate outlives its TTL between runs; mint a fresh one
        whenever the stored token is expired, near expiry, or unverifiable."""
        seed = self.data.get("seed", {})
        if "mandate" not in seed:
            return
        try:
            claims = jwtmini.decode(
                seed["mandate"], self.data["signing_key"], verify_exp=False
            )
            valid = int(claims.get("exp", 0)) - _now() > 60
        except jwtmini.JwtError:
            valid = False
        if valid:
            return
        seed["mandate"] = self._mint_seed_mandate()
        self._save()
        self._write_index()

    def _write_index(self) -> None:
        with _index_lock:
            STORE_DIR.mkdir(parents=True, exist_ok=True)
            index = {}
            if SEED_INDEX.exists():
                index = json.loads(SEED_INDEX.read_text(encoding="utf-8"))
            index[self.provider.id] = {
                "brand": self.provider.brand,
                "category": self.provider.category,
                "port": self.provider.port,
                "seed": self.data["seed"],
            }
            SEED_INDEX.write_text(json.dumps(index, indent=2), encoding="utf-8")

    # ---- creators ----
    def _new_api_key(self, label: str) -> dict:
        rec = {
            "keyId": f"key_{uuid.uuid4().hex[:12]}",
            "apiKey": f"ak_{secrets.token_urlsafe(24)}",
            "label": label,
            "createdAt": _now(),
            "revoked": False,
        }
        self.data["apiKeys"].append(rec)
        return rec

    def _new_bearer(self, label: str, prefix: str = "bt_") -> dict:
        rec = {
            "tokenId": f"tok_{uuid.uuid4().hex[:12]}",
            "accessToken": f"{prefix}{secrets.token_urlsafe(28)}",
            "label": label,
            "createdAt": _now(),
            "revoked": False,
        }
        self.data["bearerTokens"].append(rec)
        return rec

    def _new_client(self, name: str, redirect_uris: list[str], scopes: list[str]) -> dict:
        rec = {
            "clientId": f"cid_{uuid.uuid4().hex[:16]}",
            "clientSecret": f"cs_{secrets.token_urlsafe(28)}",
            "name": name,
            "scopes": scopes,
            "redirectUris": redirect_uris,
            "createdAt": _now(),
            "revoked": False,
        }
        self.data["clients"].append(rec)
        return rec

    # ---- public lifecycle ----
    def create_api_key(self, label: str) -> dict:
        rec = self._new_api_key(label)
        self._save()
        return rec

    def create_bearer(self, label: str) -> dict:
        rec = self._new_bearer(label)
        self._save()
        return rec

    def create_client(self, name: str, redirect_uris: list[str], scopes: list[str]) -> dict:
        rec = self._new_client(name, redirect_uris, scopes)
        self._save()
        return rec

    def revoke(self, kind: str, identifier: str) -> bool:
        collection = {
            "apiKey": ("apiKeys", "keyId"),
            "bearer": ("bearerTokens", "tokenId"),
            "client": ("clients", "clientId"),
        }.get(kind)
        if collection is None:
            return False
        field, id_key = collection
        for rec in self.data[field]:
            if rec[id_key] == identifier:
                rec["revoked"] = True
                rec["revokedAt"] = _now()
                self._save()
                return True
        return False

    def rotate(self, kind: str, identifier: str) -> dict | None:
        """Roll a credential the way real platforms do: mint a fresh secret,
        carry the label, and revoke the superseded one so the old value stops
        working immediately."""
        spec = {
            "apiKey": ("apiKeys", "keyId", self._new_api_key),
            "bearer": ("bearerTokens", "tokenId", self._new_bearer),
            "client": ("clients", "clientId", None),
        }.get(kind)
        if spec is None:
            return None
        field, id_key, maker = spec
        for rec in self.data[field]:
            if rec[id_key] == identifier and not rec["revoked"]:
                if kind == "client":
                    rec["clientSecret"] = f"cs_{secrets.token_urlsafe(28)}"
                    rec["secretRotatedAt"] = _now()
                    self._save()
                    return rec
                fresh = maker(rec["label"])
                fresh["rotatedFrom"] = identifier
                rec["revoked"] = True
                rec["revokedAt"] = _now()
                rec["rotatedTo"] = fresh[id_key]
                self._save()
                return fresh
        return None

    def touch(self, kind: str, presented: str) -> None:
        """Record last-use telemetry on the matching credential. Kept in memory
        (the store is process-cached) so the hot path stays free of disk I/O."""
        spec = {
            "apiKey": ("apiKeys", "apiKey"),
            "bearer": ("bearerTokens", "accessToken"),
        }.get(kind)
        if spec is None:
            return
        field, value_key = spec
        for rec in self.data[field]:
            if rec[value_key] == presented:
                rec["lastUsedAt"] = _now()
                rec["useCount"] = rec.get("useCount", 0) + 1
                return

    def touch_client(self, client_id: str) -> None:
        """Record last-use telemetry on an OAuth client whenever one of its access
        tokens authenticates a call, matching the API key and bearer paths."""
        for rec in self.data["clients"]:
            if rec["clientId"] == client_id:
                rec["lastUsedAt"] = _now()
                rec["useCount"] = rec.get("useCount", 0) + 1
                return

    def revoked_history(self) -> list[dict]:
        """Flatten every revoked credential across kinds for an audit history view."""
        history: list[dict] = []
        for kind, field, id_key in (("apiKey", "apiKeys", "keyId"),
                                     ("bearer", "bearerTokens", "tokenId"),
                                     ("client", "clients", "clientId")):
            for rec in self.data[field]:
                if rec.get("revoked"):
                    history.append({
                        "kind": kind,
                        "id": rec[id_key],
                        "label": rec.get("label") or rec.get("name", ""),
                        "revokedAt": rec.get("revokedAt"),
                        "rotatedTo": rec.get("rotatedTo"),
                    })
        history.sort(key=lambda r: r.get("revokedAt") or 0, reverse=True)
        return history

    def revoke_mandate_anchor(self, anchor: str) -> None:
        if anchor not in self.data["revoked"]:
            self.data["revoked"].append(anchor)
            self._save()

    # ---- validators ----
    def find_api_key(self, presented: str) -> dict | None:
        for rec in self.data["apiKeys"]:
            if rec["apiKey"] == presented and not rec["revoked"]:
                return rec
        return None

    def valid_api_key(self, presented: str) -> bool:
        return self.find_api_key(presented) is not None

    def find_bearer(self, presented: str) -> dict | None:
        for rec in self.data["bearerTokens"]:
            if rec["accessToken"] == presented and not rec["revoked"]:
                return rec
        return None

    def valid_bearer(self, presented: str) -> bool:
        return self.find_bearer(presented) is not None

    def find_client(self, client_id: str) -> dict | None:
        for rec in self.data["clients"]:
            if rec["clientId"] == client_id and not rec["revoked"]:
                return rec
        return None

    # ---- oauth issuance ----
    def issue_token(self, client_id: str, scope: str, *, subject: str = "service",
                    refresh: bool = False, audience: str | None = None) -> dict:
        cutoff = _now() - 86400
        self.data["tokens"] = [
            t for t in self.data["tokens"]
            if t["expiresAt"] >= cutoff or (t.get("refreshToken") and not t.get("refreshConsumed"))
        ]
        token = {
            "accessToken": f"at_{secrets.token_urlsafe(28)}",
            "tokenType": "Bearer",
            "clientId": client_id,
            "scope": scope,
            "subject": subject,
            "audience": audience,
            "expiresAt": _now() + 3600,
            "createdAt": _now(),
        }
        if refresh:
            token["refreshToken"] = f"rt_{secrets.token_urlsafe(28)}"
        self.data["tokens"].append(token)
        self._save()
        return token

    def valid_access_token(self, presented: str) -> dict | None:
        for t in self.data["tokens"]:
            if t["accessToken"] == presented and t["expiresAt"] >= _now() and not t.get("revoked"):
                return t
        return None

    def revoke_access_token(self, presented: str) -> bool:
        for t in self.data["tokens"]:
            if t["accessToken"] == presented and not t.get("revoked"):
                t["revoked"] = True
                t["revokedAt"] = _now()
                self._save()
                return True
        return False

    def refresh(self, refresh_token: str) -> dict | None:
        """Exchange a refresh token, rotating it the way QuickBooks and Xero do:
        each refresh token is single-use, so the presented one is consumed and a
        fresh refresh token is issued alongside the new access token. Replaying a
        consumed refresh token no longer grants a session."""
        for t in self.data["tokens"]:
            if t.get("refreshToken") == refresh_token and not t.get("refreshConsumed"):
                t["refreshConsumed"] = True
                t["refreshConsumedAt"] = _now()
                return self.issue_token(t["clientId"], t["scope"], subject=t["subject"],
                                        refresh=True, audience=t.get("audience"))
        return None

    def create_auth_code(self, client_id: str, redirect_uri: str, scope: str,
                         code_challenge: str | None, subject: str) -> str:
        code = f"ac_{secrets.token_urlsafe(20)}"
        self.data["authCodes"][code] = {
            "clientId": client_id,
            "redirectUri": redirect_uri,
            "scope": scope,
            "codeChallenge": code_challenge,
            "subject": subject,
            "expiresAt": _now() + 120,
        }
        self._save()
        return code

    def consume_auth_code(self, code: str) -> dict | None:
        record = self.data["authCodes"].pop(code, None)
        now = _now()
        self.data["authCodes"] = {
            c: r for c, r in self.data["authCodes"].items() if r["expiresAt"] >= now
        }
        self._save()
        if record is None or record["expiresAt"] < now:
            return None
        return record


def load(provider_id: str) -> ProviderStore:
    with _lock_for(provider_id):
        if provider_id not in _cache:
            _cache[provider_id] = ProviderStore(catalog.get(provider_id))
        return _cache[provider_id]
