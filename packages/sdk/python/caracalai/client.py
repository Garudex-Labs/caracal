"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal: drop-in bound client wrapping zone, application, subject token, and coordinator.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import sys
import threading
import time
import uuid
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any
from collections.abc import AsyncGenerator, Callable, Mapping
from urllib.parse import urlparse, urlunparse

import httpx

from .context import (
    CaracalContext,
    VerifiedClaims,
    _ctx_var,
    current,
    from_envelope,
    to_envelope,
)
from caracalai_oauth import (
    CaracalEvent,
    ClientCredentials,
    ClientSecretExchanger,
    CredentialsResolver,
    EventHook,
    TokenSource,
    decode_jwt_exp,
    emit_event,
)
from .coordinator import (
    CoordinatorClient,
    DelegationConstraints,
    DelegationRequest,
    DelegationResponse,
    SpawnRequest,
    sync_create_delegation,
    sync_spawn_agent,
    sync_terminate_agent,
)
from .envelope import (
    HEADER_AUTHORIZATION,
    Envelope,
    decode_envelope,
    encode_envelope,
    to_headers,
)
from .errors import MissingTokenError
from .json_types import JsonObject
from .primitives import (
    Grant,
    LifecycleHook,
    ServiceAgent,
    adopt_delegation,
    delegate,
    spawn,
    spawn_service,
)

DEFAULT_STS_URL = "http://localhost:8080"
DEFAULT_COORDINATOR_URL = "http://localhost:4000"
DEFAULT_GATEWAY_URL = "http://localhost:8081"

LIFECYCLE_SCOPE = "agent:lifecycle"
GOVERNED_MANDATE_TTL_SECONDS = 900
GOVERNED_REFRESH_MARGIN_SECONDS = 60.0
GOVERNED_SESSION_TTL_BUFFER_SECONDS = 120

if TYPE_CHECKING:
    from .http import ASGIApp, CaracalASGIMiddleware, TokenVerifier


@dataclass
class ResourceBinding:
    resource_id: str
    upstream_prefix: str


@dataclass(frozen=True)
class GatewayRequest:
    url: str
    headers: dict[str, str]


class CaracalConfig:
    """Bound configuration for a Caracal client.

    `subject_token` may be supplied either as a static string or implicitly via
    `token_source`: a callable returning a fresh STS access token on demand.
    Exactly one must be provided. `default_ttl_seconds` applies to task spawns
    only; a service session lives by its heartbeat lease instead.
    """

    def __init__(
        self,
        *,
        coordinator: CoordinatorClient,
        zone_id: str | None = None,
        application_id: str | None = None,
        subject_token: str | None = None,
        token_source: TokenSource | None = None,
        gateway_url: str | None = None,
        resources: list[ResourceBinding] | None = None,
        default_ttl_seconds: int | None = None,
        exchanger: ClientSecretExchanger | None = None,
    ) -> None:
        if (subject_token is None) == (token_source is None):
            raise ValueError(
                "CaracalConfig requires exactly one of subject_token or token_source"
            )
        self.coordinator = coordinator
        self.zone_id = zone_id
        self.application_id = application_id
        self._static_token = subject_token
        self._token_source = token_source
        self.gateway_url = gateway_url
        self.resources = sort_bindings_longest_first(resources or [])
        self.default_ttl_seconds = default_ttl_seconds
        self.exchanger = exchanger

    @property
    def subject_token(self) -> str:
        if self._token_source is not None:
            return self._token_source()
        assert self._static_token is not None
        return self._static_token

    async def asubject_token(self) -> str:
        """Resolve the subject token without blocking the event loop: a token
        source may perform a synchronous STS exchange, so it runs on a worker
        thread."""
        if self._token_source is not None:
            return await asyncio.to_thread(self._token_source)
        assert self._static_token is not None
        return self._static_token


def sort_bindings_longest_first(
    bindings: list[ResourceBinding],
) -> list[ResourceBinding]:
    """Sort resource bindings by upstream prefix length descending so the most
    specific prefix wins during gateway routing. Stable across equal lengths."""
    return sorted(bindings, key=lambda b: len(b.upstream_prefix), reverse=True)


def _parse_resource_bindings(raw: str | None) -> list[ResourceBinding]:
    if not raw:
        return []
    out: list[ResourceBinding] = []
    errors: list[str] = []
    for index, entry in enumerate(raw.split(","), start=1):
        trimmed = entry.strip()
        if not trimmed:
            continue
        idx = trimmed.find("=")
        if idx <= 0:
            errors.append(f"entry {index} must use resource_id=upstream_prefix")
            continue
        rid = trimmed[:idx].strip()
        prefix = trimmed[idx + 1 :].strip()
        if not rid or not prefix:
            errors.append(
                f"entry {index} must contain non-empty resource_id and upstream_prefix"
            )
            continue
        if not _is_absolute_url(prefix):
            errors.append(f"entry {index} upstream_prefix must be an absolute URL")
            continue
        out.append(ResourceBinding(resource_id=rid, upstream_prefix=prefix))
    if errors:
        raise ValueError("invalid CARACAL_RESOURCES:\n  - " + "\n  - ".join(errors))
    return out


def _load_resource_bindings_file(path: str | None) -> list[ResourceBinding]:
    if not path:
        return []

    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return _validate_resource_bindings(data, source=f"CARACAL_RESOURCES_FILE={path!r}")


_BINDING_FIELDS = frozenset({"resource_id", "upstream_prefix"})


def _is_absolute_url(value: str) -> bool:
    parsed = urlparse(value)
    return bool(parsed.scheme and parsed.netloc)


def _validate_resource_bindings(data: object, *, source: str) -> list[ResourceBinding]:
    """Strictly validate resource binding data loaded from JSON/TOML.

    Accepts either a flat ``{resource_id: upstream_prefix}`` dict or a list
    of ``{"resource_id": ..., "upstream_prefix": ...}`` records. Every entry
    must carry both fields as non-empty strings; any deviation raises
    ``ValueError`` listing every bad entry's position so misconfiguration
    surfaces at start-up instead of as a downstream 404.
    """
    errors: list[str] = []
    out: list[ResourceBinding] = []

    if isinstance(data, dict):
        for key, value in data.items():
            if not isinstance(key, str) or not key:
                errors.append(f"{source}: key {key!r} is not a non-empty string")
                continue
            if not isinstance(value, str) or not value:
                errors.append(
                    f"{source}: entry {key!r}: upstream_prefix must be a non-empty string"
                )
                continue
            if not _is_absolute_url(value):
                errors.append(
                    f"{source}: entry {key!r}: upstream_prefix must be an absolute URL"
                )
                continue
            out.append(ResourceBinding(resource_id=key, upstream_prefix=value))
    elif isinstance(data, list):
        for idx, entry in enumerate(data):
            if not isinstance(entry, dict):
                errors.append(
                    f"{source}[{idx}]: entry must be an object, got {type(entry).__name__}"
                )
                continue
            extra = set(entry) - _BINDING_FIELDS
            if extra:
                errors.append(
                    f"{source}[{idx}]: unknown field(s) {sorted(extra)!r}; "
                    f"expected exactly {sorted(_BINDING_FIELDS)!r}"
                )
                continue
            missing = _BINDING_FIELDS - set(entry)
            if missing:
                errors.append(f"{source}[{idx}]: missing field(s) {sorted(missing)!r}")
                continue
            rid, prefix = entry["resource_id"], entry["upstream_prefix"]
            if not isinstance(rid, str) or not rid:
                errors.append(
                    f"{source}[{idx}]: resource_id must be a non-empty string"
                )
                continue
            if not isinstance(prefix, str) or not prefix:
                errors.append(
                    f"{source}[{idx}]: upstream_prefix must be a non-empty string"
                )
                continue
            if not _is_absolute_url(prefix):
                errors.append(
                    f"{source}[{idx}]: upstream_prefix must be an absolute URL"
                )
                continue
            out.append(ResourceBinding(resource_id=rid, upstream_prefix=prefix))
    else:
        raise ValueError(
            f"{source}: unsupported shape {type(data).__name__}; "
            f"expected object or array of {{resource_id, upstream_prefix}}"
        )

    if errors:
        raise ValueError("invalid resource bindings:\n  - " + "\n  - ".join(errors))
    return out


def _resolve_bindings(
    credential_bindings: list[ResourceBinding],
    env: Mapping[str, str],
) -> list[ResourceBinding]:
    """Single source of truth for resource binding resolution.

    Unions bindings from three sources: provisioned credential manifests, the
    JSON file pointed to by ``CARACAL_RESOURCES_FILE``, and the flat
    ``CARACAL_RESOURCES`` env var: validates each, and returns a
    deduplicated list. Later sources override earlier ones on conflict.
    """
    seen: dict[str, ResourceBinding] = {}

    for b in credential_bindings:
        seen[b.resource_id] = b

    for b in _load_resource_bindings_file(env.get("CARACAL_RESOURCES_FILE")):
        seen[b.resource_id] = b

    for b in _parse_resource_bindings(env.get("CARACAL_RESOURCES")):
        seen[b.resource_id] = b

    return list(seen.values())


def _resource_ids_from_env(
    env: Mapping[str, str], bindings: list[ResourceBinding]
) -> list[str]:
    """Union of explicitly requested STS audiences and every gateway-bound
    resource. Binding-derived ids always join the audience set so a routed
    resource can never be silently absent from the exchanged token."""
    explicit = env.get("CARACAL_APP_RESOURCES")
    ids = [s.strip() for s in explicit.split(",") if s.strip()] if explicit else []
    return list(dict.fromkeys(ids + [b.resource_id for b in bindings]))


def _default_config_path_for(env: Mapping[str, str]):
    from pathlib import Path

    explicit = env.get("CARACAL_CONFIG")
    if explicit:
        return Path(explicit)
    return _default_config_dir(env) / "caracal.toml"


def _default_config_dir(env: Mapping[str, str]):
    from pathlib import Path

    if env.get("CARACAL_CONFIG_HOME"):
        return Path(env["CARACAL_CONFIG_HOME"])
    if env.get("XDG_CONFIG_HOME"):
        return Path(env["XDG_CONFIG_HOME"]) / "caracal"
    if os.name == "nt":
        return (
            Path(
                env.get("APPDATA")
                or env.get("LOCALAPPDATA")
                or Path.home() / "AppData" / "Roaming"
            )
            / "Caracal"
        )
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Caracal"
    return Path.home() / ".config" / "caracal"


def _safe_path_segment(value: str) -> str:
    import re

    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip()).strip("_")
    return safe or "default"


def _default_credential_dir(env: Mapping[str, str], zone_id: str, application_id: str):
    return (
        _default_config_dir(env)
        / "runtime"
        / _safe_path_segment(zone_id)
        / _safe_path_segment(application_id)
    )


def _default_client_secret_path(
    env: Mapping[str, str], zone_id: str, application_id: str
):
    return _default_credential_dir(env, zone_id, application_id) / "client-secret"


def _default_run_credentials_path(
    env: Mapping[str, str], zone_id: str, application_id: str
):
    return _default_credential_dir(env, zone_id, application_id) / "credentials.json"


def _existing_local_file(path, env: Mapping[str, str]):
    if _production_env(env):
        return None
    return path if path.exists() else None


def _production_env(env: Mapping[str, str]) -> bool:
    """CARACAL_ENV is the language-neutral gate every Caracal SDK honors."""
    return env.get("CARACAL_ENV") == "production"


def _is_loopback_host(host: str | None) -> bool:
    if host is None:
        return False
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _assert_production_transport(
    name: str, value: str | None, env: Mapping[str, str]
) -> None:
    if not value or not _production_env(env):
        return
    if env.get("CARACAL_ALLOW_INSECURE_CONFIG_URLS") == "true":
        return
    parsed = urlparse(value)
    if parsed.scheme == "https":
        return
    if parsed.scheme == "http" and _is_loopback_host(parsed.hostname):
        return
    raise RuntimeError(
        f"Caracal SDK: {name} must use https in production; http is limited "
        "to loopback hosts unless CARACAL_ALLOW_INSECURE_CONFIG_URLS=true"
    )


def _default_ttl_from_env(env: Mapping[str, str]) -> int | None:
    raw = env.get("CARACAL_DEFAULT_TTL_SECONDS")
    if not raw:
        return None
    try:
        ttl = int(raw)
    except ValueError:
        ttl = 0
    if ttl <= 0:
        raise RuntimeError(
            "Caracal: CARACAL_DEFAULT_TTL_SECONDS must be a positive integer"
        )
    return ttl


def _read_secret_path(path, source: str) -> str:
    if not path.exists():
        raise RuntimeError(f"{source} secret file does not exist: {path}")
    if os.name != "nt" and path.stat().st_mode & 0o077:
        raise RuntimeError(
            f"{source} secret file must be readable only by its owner: {path}"
        )
    secret = path.read_text().strip()
    if not secret:
        raise RuntimeError(f"{source} secret file is empty: {path}")
    return secret


def _required_str(cfg: dict, key: str) -> str:
    v = cfg.get(key)
    if not isinstance(v, str) or not v:
        raise RuntimeError(f"caracal.toml missing required field {key!r}")
    return v


def _service_url(env: Mapping[str, str], key: str, default: str) -> str:
    value = env.get(key)
    if value:
        return value
    if _production_env(env):
        raise RuntimeError(f"Caracal SDK: {key} is required in production")
    return default


def _sts_url(env: Mapping[str, str]) -> str:
    return (
        env.get("CARACAL_STS_URL")
        or env.get("CARACAL_ZONE_URL")
        or _service_url(env, "CARACAL_STS_URL", DEFAULT_STS_URL)
    )


def _client_secret_from_config(
    cfg: dict, cfg_path, env: Mapping[str, str], zone_id: str, application_id: str
) -> str:
    from pathlib import Path

    value = cfg.get("app_client_secret")
    file_value = cfg.get("app_client_secret_file")
    if value and file_value:
        raise RuntimeError(
            "caracal.toml must set only one of 'app_client_secret' or "
            "'app_client_secret_file'"
        )
    if isinstance(value, str) and value:
        if os.name != "nt" and cfg_path.stat().st_mode & 0o077:
            raise RuntimeError(
                f"{cfg_path} carries an inline app_client_secret and must be "
                "readable only by its owner"
            )
        return value
    if isinstance(file_value, str) and file_value:
        return _read_secret_path(Path(file_value), "caracal.toml")
    local_path = _existing_local_file(
        _default_client_secret_path(env, zone_id, application_id),
        env,
    )
    if local_path is None:
        raise RuntimeError(
            "caracal.toml missing client secret; local dev/stable auto-detects "
            f"{_default_client_secret_path(env, zone_id, application_id)} when it exists"
        )
    return _read_secret_path(local_path, "caracal.toml")


def _client_secret_from_env(
    env: Mapping[str, str], zone_id: str, application_id: str
) -> str | None:
    from pathlib import Path

    value = env.get("CARACAL_APP_CLIENT_SECRET")
    file_value = env.get("CARACAL_APP_CLIENT_SECRET_FILE")
    if value and file_value:
        raise RuntimeError(
            "Caracal.from_env must set only one of CARACAL_APP_CLIENT_SECRET or "
            "CARACAL_APP_CLIENT_SECRET_FILE"
        )
    if file_value:
        return _read_secret_path(Path(file_value), "Caracal.from_env")
    if value:
        return value
    local_path = _existing_local_file(
        _default_client_secret_path(env, zone_id, application_id), env
    )
    if local_path is not None:
        return _read_secret_path(local_path, "Caracal.from_env")
    return None


def _credential_entries(value: object, *, source: str) -> list[dict[str, str]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise RuntimeError(f"{source} must be an array")
    entries: list[dict[str, str]] = []
    for idx, entry in enumerate(value):
        if not isinstance(entry, dict):
            raise RuntimeError(f"{source}[{idx}] must be a table")
        resource = entry.get("resource")
        if not isinstance(resource, str) or not resource:
            raise RuntimeError(f"{source}[{idx}].resource is required")
        upstream = entry.get("upstream_prefix")
        record = {"resource": resource}
        if isinstance(upstream, str) and upstream:
            record["upstream_prefix"] = upstream
        entries.append(record)
    return entries


def _resource_bindings_from_credentials(
    credentials: list[dict[str, str]],
) -> tuple[list[str], list[ResourceBinding]]:
    ids: list[str] = []
    bindings: list[ResourceBinding] = []
    seen: set[str] = set()
    for credential in credentials:
        resource = credential["resource"]
        if resource in seen:
            continue
        seen.add(resource)
        ids.append(resource)
        upstream = credential.get("upstream_prefix")
        if upstream:
            bindings.append(ResourceBinding(resource, upstream))
    return ids, bindings


def _credential_manifest_from_env(
    env: Mapping[str, str], zone_id: str, application_id: str
) -> list[dict[str, str]]:
    file_value = env.get("CARACAL_RUN_CREDENTIALS_FILE")
    inline = env.get("CARACAL_RUN_CREDENTIALS")
    if file_value and inline:
        raise RuntimeError(
            "Caracal.from_env must set only one of CARACAL_RUN_CREDENTIALS or "
            "CARACAL_RUN_CREDENTIALS_FILE"
        )
    if not file_value and not inline:
        local_path = _existing_local_file(
            _default_run_credentials_path(env, zone_id, application_id), env
        )
        if local_path is None:
            return []
        file_value = str(local_path)
    if file_value:
        with open(file_value, encoding="utf-8") as fh:
            data = json.load(fh)
    else:
        data = json.loads(inline or "")
    manifest = {"credentials": data} if isinstance(data, list) else data
    if not isinstance(manifest, dict):
        raise RuntimeError(
            "Caracal.from_env credential manifest must be an array or object"
        )
    return _credential_entries(
        manifest.get("credentials"), source="CARACAL_RUN_CREDENTIALS.credentials"
    ) + _credential_entries(
        manifest.get("optional_credentials"),
        source="CARACAL_RUN_CREDENTIALS.optional_credentials",
    )


def _validate_subject_token(token: str) -> None:
    """Local sanity check on a static bootstrap subject token. Rejects JWTs
    whose `exp` claim is already in the past. Opaque tokens are accepted
    unchanged. Signature verification is the verifier's responsibility."""
    import time

    exp = decode_jwt_exp(token)
    if exp is None:
        return
    if exp <= time.time():
        raise RuntimeError(
            "CARACAL_SUBJECT_TOKEN is expired or has an invalid `exp` claim: "
            "refresh the bootstrap token before starting the application"
        )


def _config_from_env(env: Mapping[str, str] | None = None) -> CaracalConfig:
    e = env if env is not None else os.environ
    coordinator_url = _service_url(
        e, "CARACAL_COORDINATOR_URL", DEFAULT_COORDINATOR_URL
    )
    zone_id = e.get("CARACAL_ZONE_ID")
    application_id = e.get("CARACAL_APPLICATION_ID")
    missing = [
        k
        for k, v in {
            "CARACAL_ZONE_ID": zone_id,
            "CARACAL_APPLICATION_ID": application_id,
        }.items()
        if not v
    ]
    if missing:
        raise RuntimeError(f"Caracal.from_env: missing {', '.join(missing)}")

    credential_ids, credential_bindings = _resource_bindings_from_credentials(
        _credential_manifest_from_env(e, zone_id, application_id)
    )
    bindings = sort_bindings_longest_first(_resolve_bindings(credential_bindings, e))
    gateway_url = _service_url(e, "CARACAL_GATEWAY_URL", DEFAULT_GATEWAY_URL)

    client_secret = _client_secret_from_env(e, zone_id, application_id)
    sts_url = _sts_url(e)
    subject_token = e.get("CARACAL_SUBJECT_TOKEN")
    default_ttl = _default_ttl_from_env(e)

    if client_secret:
        resource_ids = list(
            dict.fromkeys(credential_ids + _resource_ids_from_env(e, bindings))
        )
        if not resource_ids:
            raise RuntimeError(
                "Caracal.from_env: client-secret mode requires resources via "
                "CARACAL_APP_RESOURCES, CARACAL_RESOURCES, or CARACAL_RESOURCES_FILE"
            )
        binding_by_resource = {b.resource_id: b for b in bindings}
        return _config_from_client_secret(
            coordinator_url=coordinator_url,
            sts_url=sts_url,
            zone_id=zone_id,
            application_id=application_id,
            client_secret=client_secret,
            resources=[
                binding_by_resource.get(resource_id, resource_id)
                for resource_id in resource_ids
            ],
            gateway_url=gateway_url,
            default_ttl_seconds=default_ttl,
            env=e,
        )

    if not subject_token:
        raise RuntimeError(
            "Caracal.from_env: provide CARACAL_APP_CLIENT_SECRET or CARACAL_SUBJECT_TOKEN"
        )
    _validate_subject_token(subject_token)
    _assert_production_transport("CARACAL_COORDINATOR_URL", coordinator_url, e)
    _assert_production_transport("CARACAL_GATEWAY_URL", gateway_url, e)
    return CaracalConfig(
        coordinator=CoordinatorClient(base_url=coordinator_url),
        zone_id=zone_id,
        application_id=application_id,
        subject_token=subject_token,
        gateway_url=gateway_url,
        resources=bindings,
        default_ttl_seconds=default_ttl,
    )


def _config_from_client_secret(
    *,
    coordinator_url: str,
    sts_url: str,
    zone_id: str | None = None,
    application_id: str | None = None,
    client_secret: str | None = None,
    credentials: CredentialsResolver | None = None,
    resources: list[str | ResourceBinding] | None = None,
    gateway_url: str | None = None,
    scope: str = "agent:lifecycle",
    default_ttl_seconds: int | None = None,
    http_client: httpx.Client | None = None,
    env: Mapping[str, str] | None = None,
) -> CaracalConfig:
    transport_env = env if env is not None else os.environ
    if credentials is not None and (zone_id or application_id or client_secret):
        raise ValueError(
            "Caracal.from_client_secret: pass either credentials or the "
            "zone_id/application_id/client_secret triple, not both"
        )
    checks = [("coordinator_url", coordinator_url), ("sts_url", sts_url)]
    if credentials is None:
        checks += [
            ("zone_id", zone_id),
            ("application_id", application_id),
            ("client_secret", client_secret),
        ]
    missing = [name for name, value in checks if not value]
    if missing:
        raise ValueError(f"Caracal.from_client_secret missing {', '.join(missing)}")
    if default_ttl_seconds is not None and default_ttl_seconds <= 0:
        raise ValueError(
            "Caracal.from_client_secret: default_ttl_seconds must be a positive integer"
        )
    _assert_production_transport("coordinator_url", coordinator_url, transport_env)
    _assert_production_transport("sts_url", sts_url, transport_env)
    _assert_production_transport("gateway_url", gateway_url, transport_env)
    bindings: list[ResourceBinding] = []
    resource_ids: list[str] = []
    for r in resources or []:
        if isinstance(r, ResourceBinding):
            bindings.append(r)
            resource_ids.append(r.resource_id)
        else:
            resource_ids.append(str(r))
    if credentials is not None:
        resolver = credentials
    else:
        static = ClientCredentials(
            zone_id=zone_id or "",
            application_id=application_id or "",
            client_secret=client_secret or "",
        )

        def resolver() -> ClientCredentials:
            return static

    exchanger = ClientSecretExchanger(
        sts_url=sts_url,
        credentials=resolver,
        resources=resource_ids,
        scope=scope,
        http_client=http_client,
    )
    return CaracalConfig(
        coordinator=CoordinatorClient(base_url=coordinator_url),
        zone_id=zone_id,
        application_id=application_id,
        token_source=exchanger.get_token,
        gateway_url=gateway_url,
        resources=bindings,
        default_ttl_seconds=default_ttl_seconds,
        exchanger=exchanger,
    )


def _config_from_file(
    path: str | os.PathLike[str] | None = None,
    env: Mapping[str, str] | None = None,
) -> CaracalConfig:
    import tomllib
    from pathlib import Path

    e = env if env is not None else os.environ
    cfg_path = Path(path) if path is not None else _default_config_path_for(e)
    if not cfg_path.exists():
        raise RuntimeError(
            f"Caracal config not found at {cfg_path}; provision a zone "
            "and application in the Console and author "
            "caracal.toml with the returned ids."
        )
    cfg = tomllib.loads(cfg_path.read_text())

    zone_id = _required_str(cfg, "zone_id")
    application_id = _required_str(cfg, "application_id")
    client_secret = _client_secret_from_config(
        cfg, cfg_path, e, zone_id, application_id
    )
    sts_url = (
        cfg.get("sts_url")
        or cfg.get("zone_url")
        or e.get("CARACAL_STS_URL")
        or e.get("CARACAL_ZONE_URL")
        or _service_url(e, "CARACAL_STS_URL", DEFAULT_STS_URL)
    )
    coordinator_url = (
        cfg.get("coordinator_url")
        or e.get("CARACAL_COORDINATOR_URL")
        or _service_url(e, "CARACAL_COORDINATOR_URL", DEFAULT_COORDINATOR_URL)
    )
    gateway_url = (
        cfg.get("gateway_url")
        or e.get("CARACAL_GATEWAY_URL")
        or _service_url(e, "CARACAL_GATEWAY_URL", DEFAULT_GATEWAY_URL)
    )
    ttl_value = cfg.get("default_ttl_seconds")
    if ttl_value is not None and (not isinstance(ttl_value, int) or ttl_value <= 0):
        raise RuntimeError(
            f"{cfg_path}: default_ttl_seconds must be a positive integer"
        )
    default_ttl = ttl_value if ttl_value is not None else _default_ttl_from_env(e)

    credential_ids, credential_bindings = _resource_bindings_from_credentials(
        _credential_entries(cfg.get("credentials"), source=f"{cfg_path}.credentials")
        + _credential_entries(
            cfg.get("optional_credentials"), source=f"{cfg_path}.optional_credentials"
        )
        + _credential_manifest_from_env(e, zone_id, application_id)
    )
    bindings = sort_bindings_longest_first(_resolve_bindings(credential_bindings, e))
    resource_ids = list(
        dict.fromkeys(credential_ids + [b.resource_id for b in bindings])
    )
    if not resource_ids:
        raise RuntimeError(
            "Caracal.from_config: at least one resource binding is required via "
            "caracal.toml credentials, CARACAL_RESOURCES, or CARACAL_RESOURCES_FILE"
        )
    binding_by_resource = {b.resource_id: b for b in bindings}
    resources: list[str | ResourceBinding] = [
        binding_by_resource.get(resource_id, resource_id)
        for resource_id in resource_ids
    ]

    return _config_from_client_secret(
        coordinator_url=coordinator_url,
        sts_url=sts_url,
        zone_id=zone_id,
        application_id=application_id,
        client_secret=client_secret,
        resources=resources,
        gateway_url=gateway_url,
        default_ttl_seconds=default_ttl,
        env=e,
    )


def _detect_config(
    config_path: str | os.PathLike[str] | None = None,
    env: Mapping[str, str] | None = None,
) -> CaracalConfig:
    if config_path is not None:
        return _config_from_file(config_path, env)
    e = env if env is not None else os.environ
    default = _default_config_path_for(e)
    if e.get("CARACAL_CONFIG") and not default.exists():
        raise RuntimeError(f"Caracal config not found at {default}")
    if default.exists():
        return _config_from_file(default, env)
    return _config_from_env(env)


class Caracal:
    def __init__(
        self,
        config: CaracalConfig | None = None,
        *,
        config_path: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
    ) -> None:
        """Create a Caracal client.

        With no arguments, credentials are auto-detected: `CARACAL_CONFIG` or
        the default `caracal.toml` profile when present, otherwise `CARACAL_*`
        environment variables. Pass `config_path` to force a profile file, or
        a `CaracalConfig` for full programmatic control.
        """
        if config is not None and (config_path is not None or env is not None):
            raise ValueError("Caracal: pass either config or config_path/env, not both")
        self.config = config if config is not None else _detect_config(config_path, env)
        self._agent_start_hooks: list[LifecycleHook] = []
        self._agent_end_hooks: list[LifecycleHook] = []
        self._event_hooks: list[EventHook] = []
        self.config.coordinator.on_event = self._emit_event
        if self.config.exchanger is not None:
            self.config.exchanger.on_event = self._emit_event
        self._fetch_clients: dict[
            tuple[bool, tuple[str, ...] | None], httpx.AsyncClient
        ] = {}
        self._governed_mandates: dict[str, tuple[str, float]] = {}
        self._governed_locks: dict[str, threading.Lock] = {}
        self._governed_guard = threading.Lock()

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Caracal:
        """Build a Caracal client from environment variables.

        Two authentication shapes are supported:

        * **Static subject token**: set `CARACAL_SUBJECT_TOKEN` directly.
        * **Application client secret**: set `CARACAL_APP_CLIENT_SECRET`; the SDK
          exchanges the secret for a fresh access token on demand and refreshes
          it before expiry.

        Required in both modes: `CARACAL_ZONE_ID`, `CARACAL_APPLICATION_ID`.
        """
        return cls(_config_from_env(env))

    @classmethod
    def from_client_secret(
        cls,
        *,
        coordinator_url: str,
        sts_url: str,
        zone_id: str | None = None,
        application_id: str | None = None,
        client_secret: str | None = None,
        credentials: CredentialsResolver | None = None,
        resources: list[str | ResourceBinding] | None = None,
        gateway_url: str | None = None,
        scope: str = "agent:lifecycle",
        default_ttl_seconds: int | None = None,
        http_client: httpx.Client | None = None,
    ) -> Caracal:
        """Build a Caracal client that exchanges an application client_secret
        for an STS access token and refreshes the token automatically.

        Credentials come either from the static
        ``zone_id``/``application_id``/``client_secret`` triple or from
        ``credentials``: a callable returning :class:`ClientCredentials` (or
        ``None``) invoked before every exchange, so secret rotation and
        identity swaps take effect without rebuilding the client. When the
        resolver returns no usable credential the client raises
        :class:`caracalai.CredentialsUnavailableError` without contacting the
        platform. Pass exactly one of the two shapes.

        `resources` may be either a list of resource IDs (the STS audiences) or
        a list of ResourceBinding objects (when gateway routing is also
        required). When ResourceBinding objects are supplied their
        `resource_id`s are used as the STS audiences. Mandate-only clients
        (:meth:`mint_mandate`, :meth:`governed_transport`) may omit resources;
        spawn and lifecycle paths require at least one. `default_ttl_seconds`
        bounds task spawns that do not pass an explicit TTL.
        """
        return cls(
            _config_from_client_secret(
                coordinator_url=coordinator_url,
                sts_url=sts_url,
                zone_id=zone_id,
                application_id=application_id,
                client_secret=client_secret,
                credentials=credentials,
                resources=resources,
                gateway_url=gateway_url,
                scope=scope,
                default_ttl_seconds=default_ttl_seconds,
                http_client=http_client,
            )
        )

    @classmethod
    def from_config(cls, path: str | os.PathLike[str] | None = None) -> Caracal:
        """Build a Caracal client from a `caracal.toml` authored from
        Console values. The config supplies zone, application, client_secret,
        and resource bindings; tokens are exchanged on demand."""
        return cls(_config_from_file(path))

    def on_agent_start(self, cb: LifecycleHook) -> None:
        self._agent_start_hooks.append(cb)

    def on_agent_end(self, cb: LifecycleHook) -> None:
        self._agent_end_hooks.append(cb)

    def on_event(self, cb: EventHook) -> None:
        """Subscribe to control-plane operation events: token exchanges (with
        cache outcome), approval waits, and coordinator calls, each carrying
        outcome and duration. Bridge them to any metrics or tracing system; a
        hook that raises is ignored and never disturbs the operation that
        emitted the event."""
        self._event_hooks.append(cb)

    def _emit_event(self, event: CaracalEvent) -> None:
        for h in self._event_hooks:
            emit_event(h, event)

    async def _fire(self, hooks: list[LifecycleHook], ctx: CaracalContext) -> None:
        for h in hooks:
            await h(ctx)

    @asynccontextmanager
    async def spawn(
        self,
        *,
        grant: Grant | None = None,
        ttl_seconds: int | None = None,
        subject_session_id: str | None = None,
        parent_id: str | None = None,
        parent_ctx: CaracalContext | None = None,
        metadata: JsonObject | None = None,
        labels: list[str] | None = None,
        trace_id: str | None = None,
    ) -> AsyncGenerator[CaracalContext, None]:
        """Spawn a child agent. The child inherits this application's authority
        by default; pass ``grant=Grant.narrow([...])`` to issue a bounded
        delegation edge so the child holds only a subset of scopes."""
        on_start: LifecycleHook | None = (
            (lambda c: self._fire(self._agent_start_hooks, c))
            if self._agent_start_hooks
            else None
        )
        on_end: LifecycleHook | None = (
            (lambda c: self._fire(self._agent_end_hooks, c))
            if self._agent_end_hooks
            else None
        )

        subject_token = await self.config.asubject_token()
        invalidate = (
            self.config.exchanger.invalidate
            if self.config.exchanger is not None
            else None
        )

        async with spawn(
            coordinator=self.config.coordinator,
            zone_id=self.config.zone_id,
            application_id=self.config.application_id,
            subject_token=subject_token,
            token_source=self.config._token_source,
            invalidate=invalidate,
            subject_session_id=subject_session_id,
            parent_id=parent_id,
            parent_ctx=parent_ctx,
            grant=grant,
            ttl_seconds=(
                ttl_seconds
                if ttl_seconds is not None
                else self.config.default_ttl_seconds
            ),
            metadata=metadata,
            labels=labels,
            trace_id=trace_id,
            on_agent_start=on_start,
            on_agent_end=on_end,
        ) as ctx:
            yield ctx

    async def spawn_service(
        self,
        *,
        grant: Grant | None = None,
        ttl_seconds: int | None = None,
        subject_session_id: str | None = None,
        parent_id: str | None = None,
        parent_ctx: CaracalContext | None = None,
        metadata: JsonObject | None = None,
        labels: list[str] | None = None,
        trace_id: str | None = None,
        heartbeat_interval: float | None = None,
        on_lease_lost: Callable[[BaseException], None] | None = None,
    ) -> ServiceAgent:
        """Start a long-lived service agent and return a handle the caller owns.

        Unlike :meth:`spawn`, the session is not retired when a block exits: a
        background task renews the lease by default and the handle is retired
        with :meth:`ServiceAgent.aclose`. Use for daemons and workers that
        outlive a single request. Pass ``grant=Grant.narrow([...])`` to issue a
        bounded delegation edge so the handle holds only a subset of scopes.
        Leave ``heartbeat_interval`` unset to derive the renewal cadence from
        the server lease, pass a positive value to fix it, or zero to renew
        manually; ``on_lease_lost`` fires once if the coordinator reports the
        session permanently gone; ``on_agent_end`` hooks registered on the
        client run inside :meth:`ServiceAgent.aclose` before the session
        terminates."""
        on_start: LifecycleHook | None = (
            (lambda c: self._fire(self._agent_start_hooks, c))
            if self._agent_start_hooks
            else None
        )
        on_end: LifecycleHook | None = (
            (lambda c: self._fire(self._agent_end_hooks, c))
            if self._agent_end_hooks
            else None
        )

        subject_token = await self.config.asubject_token()
        invalidate = (
            self.config.exchanger.invalidate
            if self.config.exchanger is not None
            else None
        )

        return await spawn_service(
            coordinator=self.config.coordinator,
            zone_id=self.config.zone_id,
            application_id=self.config.application_id,
            subject_token=subject_token,
            token_source=self.config._token_source,
            invalidate=invalidate,
            subject_session_id=subject_session_id,
            parent_id=parent_id,
            parent_ctx=parent_ctx,
            grant=grant,
            ttl_seconds=ttl_seconds,
            metadata=metadata,
            labels=labels,
            trace_id=trace_id,
            heartbeat_interval=heartbeat_interval,
            on_lease_lost=on_lease_lost,
            on_agent_start=on_start,
            on_agent_end=on_end,
        )

    async def delegate(
        self,
        *,
        to: str,
        to_application_id: str,
        scopes: list[str],
        resource_id: str | None = None,
        constraints: DelegationConstraints | None = None,
        ttl_seconds: int | None = None,
    ) -> DelegationResponse:
        """Create a delegation edge from the bound agent session to a peer.

        The caller is the issuer and its own context is unchanged; hand the
        returned ``delegation_edge_id`` to the receiving session, which
        presents the edge with :meth:`adopt_delegation`."""
        return await delegate(
            coordinator=self.config.coordinator,
            to_agent_session_id=to,
            to_application_id=to_application_id,
            resource_id=resource_id,
            scopes=scopes,
            constraints=constraints,
            ttl_seconds=ttl_seconds,
        )

    @asynccontextmanager
    async def adopt_delegation(
        self, delegation_edge_id: str
    ) -> AsyncGenerator[CaracalContext, None]:
        """Present a delegation edge issued to the bound agent session: binds a
        derived context carrying the edge for the duration of the block."""
        ctx = current()
        if ctx is None:
            raise RuntimeError(
                "adopt_delegation requires a Caracal context bound on this path"
            )
        adopted = adopt_delegation(ctx, delegation_edge_id)
        token = _ctx_var.set(adopted)
        try:
            yield adopted
        finally:
            _ctx_var.reset(token)

    @asynccontextmanager
    async def bind(
        self,
        ctx: CaracalContext,
    ) -> AsyncGenerator[CaracalContext, None]:
        """Rebind an existing CaracalContext into the current async task.

        Use when handing a child context off to a background task (e.g.
        `asyncio.create_task`): the contextvar from the parent task is not
        visible there, so the receiving coroutine must reattach explicitly.
        """
        token = _ctx_var.set(ctx)
        try:
            yield ctx
        finally:
            _ctx_var.reset(token)

    def headers(
        self,
        *,
        allow_root: bool = False,
        ctx: CaracalContext | None = None,
    ) -> dict[str, str]:
        """Project a Caracal context into outbound HTTP headers: the bound
        contextvar by default, or ``ctx`` when the caller owns the context on
        another task or thread.

        When no context is available this would return the
        bootstrap application subject token. Doing so silently leaks root
        identity from background tasks that escape the contextvar (asyncio
        task groups, thread pools, framework background runners). Callers
        therefore MUST opt in via ``allow_root=True`` when they intentionally
        want service-level (un-delegated) credentials. Bind a child context
        explicitly with :meth:`bind` before fan-out to keep delegation
        semantics intact.
        """
        if ctx is None:
            ctx = current()
        if ctx is None:
            if not allow_root:
                raise RuntimeError(
                    "Caracal.headers(): no CaracalContext is bound to the current "
                    "task. Refusing to fall back to the bootstrap subject token. "
                    "Bind a child context with `async with caracal.bind(parent_ctx):` "
                    "before fan-out, or pass `allow_root=True` to explicitly use "
                    "the application's service identity."
                )
            out = to_headers(Envelope(hop=0))
            out[HEADER_AUTHORIZATION] = f"Bearer {self.config.subject_token}"
            return out
        out = to_headers(to_envelope(ctx))
        token = (
            self.config.subject_token
            if ctx.own_token and self.config._token_source is not None
            else ctx.subject_token
        )
        out[HEADER_AUTHORIZATION] = f"Bearer {token}"
        return out

    async def aheaders(
        self,
        *,
        allow_root: bool = False,
        ctx: CaracalContext | None = None,
    ) -> dict[str, str]:
        """Async counterpart to :meth:`headers`: resolves refreshable tokens on
        a worker thread so an STS exchange never blocks the event loop."""
        if ctx is None:
            ctx = current()
        if ctx is None or (ctx.own_token and self.config._token_source is not None):
            token = await self.config.asubject_token()
            if ctx is None:
                if not allow_root:
                    raise RuntimeError(
                        "Caracal.aheaders(): no CaracalContext is bound to the current "
                        "task. Refusing to fall back to the bootstrap subject token. "
                        "Bind a child context with `async with caracal.bind(parent_ctx):` "
                        "before fan-out, or pass `allow_root=True` to explicitly use "
                        "the application's service identity."
                    )
                out = to_headers(Envelope(hop=0))
                out[HEADER_AUTHORIZATION] = f"Bearer {token}"
                return out
            out = to_headers(to_envelope(ctx))
            out[HEADER_AUTHORIZATION] = f"Bearer {token}"
            return out
        out = to_headers(to_envelope(ctx))
        out[HEADER_AUTHORIZATION] = f"Bearer {ctx.subject_token}"
        return out

    @asynccontextmanager
    async def bind_from_headers(
        self,
        headers: Mapping[str, str],
        *,
        allow_root: bool = False,
        verifier: TokenVerifier | None = None,
    ) -> AsyncGenerator[CaracalContext, None]:
        def get(name: str) -> str | None:
            lower = name.lower()
            for k, v in headers.items():
                if k.lower() == lower:
                    return v
            return None

        env = decode_envelope(get)
        claims: VerifiedClaims | None = None
        root_injected = False
        if not env.subject_token:
            if not allow_root:
                raise MissingTokenError(
                    "Caracal.bind_from_headers(): inbound request is missing a bearer token. "
                    "Pass allow_root=True only for trusted service-root ingress."
                )
            env.subject_token = await self.config.asubject_token()
            root_injected = True
        elif verifier is not None:
            claims = await verifier(env.subject_token)
        if claims is not None:
            if claims.agent_session_id is not None:
                env.agent_session_id = claims.agent_session_id
            if claims.delegation_edge_id is not None:
                env.delegation_edge_id = claims.delegation_edge_id
            if claims.parent_edge_id is not None:
                env.parent_edge_id = claims.parent_edge_id
            if claims.session_id is not None:
                env.session_id = claims.session_id
            if claims.hop is not None:
                env.hop = claims.hop
        ctx = from_envelope(
            env,
            zone_id=(
                claims.zone_id
                if claims is not None and claims.zone_id is not None
                else self.config.zone_id
            ),
            application_id=(
                claims.application_id
                if claims is not None and claims.application_id is not None
                else self.config.application_id
            ),
        )
        if root_injected:
            ctx = replace(ctx, own_token=True)
        token = _ctx_var.set(ctx)
        try:
            yield ctx
        finally:
            _ctx_var.reset(token)

    def current(self) -> CaracalContext | None:
        return current()

    async def aclose(self) -> None:
        """Release pooled fetch clients, the credential exchanger's HTTP
        client, and the coordinator's HTTP client. Idempotent."""
        for client in self._fetch_clients.values():
            if not client.is_closed:
                await client.aclose()
        self._fetch_clients.clear()
        if self.config.exchanger is not None:
            self.config.exchanger.close()
        await self.config.coordinator.aclose()

    def context_middleware(
        self,
        *,
        allow_root: bool = False,
        verifier: TokenVerifier | None = None,
    ) -> Callable[[ASGIApp], CaracalASGIMiddleware]:
        """ASGI middleware factory for the inbound request boundary.

        Without ``verifier`` it only binds the inbound envelope into request
        context (propagation): it does not check JWT signatures, audience,
        scopes, token use, or revocation. Use this when a Gateway already
        enforced the mandate upstream.

        Pass ``verifier`` to enforce at the boundary. The callable receives the
        bearer token and must raise on failure; back it with
        ``caracalai_identity.verify_token`` so the application sees a request
        only after the mandate is proven. Return :class:`VerifiedClaims` from
        the verifier to stamp token-proven attribution over the caller-supplied
        envelope. The SDK never inspects token internals itself. This middleware
        is framework-agnostic and runs on any ASGI app (FastAPI, Starlette,
        Quart, Django ASGI).

        Install at module load: `app.add_middleware()` only registers middleware
        before Starlette/FastAPI startup, so this cannot be called from inside a
        `lifespan` context manager.

            from caracalai_identity import verify_token

            caracal = Caracal.from_env()
            app = FastAPI()

            async def verify(token: str) -> None:
                await verify_token(token, issuer=ISSUER, audience=AUDIENCE)

            app.add_middleware(caracal.context_middleware(verifier=verify))
        """
        from .http import CaracalASGIMiddleware

        outer = self

        def factory(app: ASGIApp) -> CaracalASGIMiddleware:
            return CaracalASGIMiddleware(
                app, outer, allow_root=allow_root, verifier=verifier
            )

        return factory

    def transport(
        self,
        *,
        allow_root: bool = False,
        ctx: CaracalContext | None = None,
        scopes: list[str] | None = None,
        **kwargs: Any,
    ) -> httpx.AsyncClient:
        """Returns an httpx.AsyncClient that auto-injects the envelope on every request
        and rewrites resource-bound calls through the configured Caracal gateway. Pass
        to any provider SDK that accepts a custom httpx client.

        Per-request identity is taken from the bound :class:`CaracalContext`, or from
        ``ctx`` when the caller owns the context on another task or thread. If a
        request fires with no context available, the call raises ``RuntimeError``
        unless the transport was created with ``allow_root=True`` (service-level
        identity).

        Pass ``scopes`` to send a scoped resource mandate instead of the raw subject
        token on gateway-routed requests: the SDK mints (and caches) a mandate
        audienced to the target resource and narrowed to those scopes, carrying the
        context's agent session and delegation edge. Requires client-secret
        credentials.

        The client keeps httpx's default 5-second timeout; pass ``timeout=`` to
        size it for the upstream being called.
        """
        return httpx.AsyncClient(
            auth=self._gateway_auth(
                allow_root=allow_root, ctx=ctx, scopes=scopes, label="transport"
            ),
            **kwargs,
        )

    def _gateway_auth(
        self,
        *,
        allow_root: bool,
        ctx: CaracalContext | None,
        scopes: list[str] | None,
        label: str,
    ) -> httpx.Auth:
        outer = self

        class _CaracalAuth(httpx.Auth):
            requires_request_body = False

            def _begin(
                self, request: httpx.Request
            ) -> tuple[CaracalContext | None, str | None, bool]:
                rewritten = outer._route_through_gateway(
                    request.url, request.headers.get("X-Caracal-Resource")
                )
                bound = ctx if ctx is not None else current()
                resource = None
                gateway_bound = False
                if rewritten is not None:
                    request.url = httpx.URL(rewritten[0])
                    request.headers["host"] = request.url.netloc.decode("ascii")
                    request.headers["X-Caracal-Resource"] = rewritten[1]
                    resource = rewritten[1]
                    gateway_bound = True
                elif outer._targets_gateway(request.url):
                    resource = request.headers.get("X-Caracal-Resource")
                    gateway_bound = True
                if bound is None and not allow_root:
                    raise RuntimeError(
                        f"Caracal.{label}(): request fired with no CaracalContext "
                        "bound. Bind a child context, pass `ctx=`, or opt in with "
                        "`allow_root=True`."
                    )
                return bound, resource, gateway_bound

            def _finish(
                self,
                request: httpx.Request,
                bound: CaracalContext | None,
                gateway_bound: bool,
                token: str | None,
            ) -> None:
                if gateway_bound:
                    if token is None:
                        assert bound is not None
                        token = bound.subject_token
                    request.headers["Authorization"] = f"Bearer {token}"
                env = to_envelope(bound) if bound is not None else Envelope(hop=0)
                encode_envelope(
                    env,
                    lambda n, v: request.headers.__setitem__(n, v),
                    lambda n: request.headers.get(n),
                )

            def sync_auth_flow(self, request: httpx.Request):
                bound, resource, gateway_bound = self._begin(request)
                token = (
                    outer.mint_mandate(resource, scopes, ctx=bound)
                    if resource is not None and scopes
                    else None
                )
                if (
                    token is None
                    and gateway_bound
                    and (
                        bound is None
                        or (bound.own_token and outer.config._token_source is not None)
                    )
                ):
                    token = outer.config.subject_token
                self._finish(request, bound, gateway_bound, token)
                yield request

            async def async_auth_flow(self, request: httpx.Request):
                bound, resource, gateway_bound = self._begin(request)
                token = (
                    await asyncio.to_thread(
                        outer.mint_mandate, resource, scopes, ctx=bound
                    )
                    if resource is not None and scopes
                    else None
                )
                if (
                    token is None
                    and gateway_bound
                    and (
                        bound is None
                        or (bound.own_token and outer.config._token_source is not None)
                    )
                ):
                    token = await outer.config.asubject_token()
                self._finish(request, bound, gateway_bound, token)
                yield request

        return _CaracalAuth()

    def _targets_gateway(self, url: httpx.URL) -> bool:
        gw = self.config.gateway_url
        if not gw:
            return False
        g = urlparse(gw)
        parsed = urlparse(str(url))
        return parsed.scheme == g.scheme and parsed.netloc == g.netloc

    def gateway_request(self, resource_id: str, path: str = "/") -> GatewayRequest:
        if not self.config.gateway_url:
            raise RuntimeError("Caracal.gateway_request: gateway_url is not configured")
        if not resource_id.strip():
            raise ValueError("Caracal.gateway_request: resource_id is required")
        return GatewayRequest(
            url=_join_gateway_path(self.config.gateway_url, path),
            headers={"X-Caracal-Resource": resource_id},
        )

    def mint_mandate(
        self,
        resource_id: str,
        scopes: list[str],
        *,
        ctx: CaracalContext | None = None,
        ttl_seconds: int | None = None,
        approval_id: str | None = None,
    ) -> str:
        """Mint a resource mandate for the current agent: a short-lived token
        audienced to ``resource_id`` and narrowed to ``scopes``, carrying the
        agent session and delegation edge of the bound :class:`CaracalContext`
        (or ``ctx`` when the caller owns the context on another task or
        thread). The STS evaluates policy against that agent's authority, so a
        narrowed child can mint only what its delegation edge allows. Results
        are cached per resource, scope set, and agent identity, and refreshed
        before expiry.

        When a scope is approval-gated the mint raises
        :class:`caracalai.ApprovalRequired`; retry with ``approval_id`` set to
        the returned challenge id once an authenticated approver has satisfied
        it.

        Requires client-secret credentials (:meth:`from_client_secret`,
        :meth:`from_config`, or ``CARACAL_APP_CLIENT_SECRET``)."""
        exchanger = self.config.exchanger
        if exchanger is None:
            raise RuntimeError(
                "Caracal.mint_mandate requires client-secret credentials; "
                "build the client with from_client_secret, from_config, or "
                "CARACAL_APP_CLIENT_SECRET."
            )
        bound = ctx if ctx is not None else current()
        return exchanger.mint_mandate(
            resource=resource_id,
            scopes=scopes,
            agent_session_id=bound.agent_session_id if bound else None,
            delegation_edge_id=bound.delegation_edge_id if bound else None,
            ttl_seconds=ttl_seconds,
            approval_id=approval_id,
        )

    def wait_for_approval(
        self, challenge_id: str, *, timeout_seconds: float = 300.0
    ) -> str:
        """Long-poll the approval challenge raised by an approval-gated
        :meth:`mint_mandate` until an approver decides it, it expires, or the
        timeout elapses. Returns the final lifecycle state: ``approved`` means
        a retry with ``approval_id`` will mint; ``rejected`` and ``expired``
        are terminal; ``pending`` means the timeout elapsed with no decision.

        Requires client-secret credentials."""
        exchanger = self.config.exchanger
        if exchanger is None:
            raise RuntimeError(
                "Caracal.wait_for_approval requires client-secret credentials; "
                "build the client with from_client_secret, from_config, or "
                "CARACAL_APP_CLIENT_SECRET."
            )
        return exchanger.wait_for_approval(
            challenge_id, timeout_seconds=timeout_seconds
        )

    async def fetch(
        self,
        resource_id: str,
        path: str = "/",
        *,
        method: str = "GET",
        headers: Mapping[str, str] | None = None,
        allow_root: bool = False,
        ctx: CaracalContext | None = None,
        scopes: list[str] | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        **request_kwargs: Any,
    ) -> httpx.Response:
        """One-call happy path: send a request to ``path`` on ``resource_id`` through
        the Gateway with Caracal context and authority injected. Extra keyword
        arguments (``json``, ``content``, ``params``, ``timeout``, ...) pass through
        to the underlying httpx request. The resource header always wins over any
        caller-supplied ``X-Caracal-Resource``.

        Pass ``ctx`` to call with an explicitly owned context (thread pools,
        executors, background tasks) instead of the bound contextvar. Pass ``scopes``
        to authorize with a scoped resource mandate minted for ``resource_id``
        instead of the raw subject token; requires client-secret credentials.

        Requests reuse a pooled client per ``(allow_root, scopes)`` shape, so
        repeated fetches share connections. ``aclose()`` releases the pool.
        httpx's default 5-second timeout applies; pass ``timeout=`` per request
        to size it for the upstream.
        """
        request = self.gateway_request(resource_id, path)
        merged = {**(headers or {}), **request.headers}
        if transport is not None:
            async with self.transport(
                allow_root=allow_root, ctx=ctx, scopes=scopes, transport=transport
            ) as client:
                return await client.request(
                    method, request.url, headers=merged, **request_kwargs
                )
        key = (allow_root, tuple(sorted(set(scopes))) if scopes else None)
        client = self._fetch_clients.get(key)
        if client is None or client.is_closed:
            client = self.transport(allow_root=allow_root, scopes=scopes)
            self._fetch_clients[key] = client
        if ctx is not None:
            async with self.bind(ctx):
                return await client.request(
                    method, request.url, headers=merged, **request_kwargs
                )
        return await client.request(
            method, request.url, headers=merged, **request_kwargs
        )

    def sync_transport(
        self,
        *,
        allow_root: bool = False,
        ctx: CaracalContext | None = None,
        scopes: list[str] | None = None,
        **kwargs: Any,
    ) -> httpx.Client:
        """Sync counterpart to transport(): returns an httpx.Client that auto-injects
        the envelope on every request and rewrites resource-bound calls through the
        configured Caracal gateway. Use with sync httpx-based SDKs.

        See :meth:`transport` for the ``allow_root``, ``ctx``, and ``scopes``
        semantics.
        """
        return httpx.Client(
            auth=self._gateway_auth(
                allow_root=allow_root, ctx=ctx, scopes=scopes, label="sync_transport"
            ),
            **kwargs,
        )

    def governed_transport(
        self,
        resource_id: str,
        *,
        scopes: list[str],
        labels: list[str] | None = None,
        mandate_ttl_seconds: int | None = None,
        **kwargs: Any,
    ) -> httpx.AsyncClient:
        """Returns an httpx.AsyncClient that authorizes every request with a
        governed mandate minted under this application's own authority: the SDK
        spawns a source and target agent session, delegates ``scopes`` between
        them constrained to ``resource_id``, and mints the mandate against that
        delegation edge, so every call is attributable to a live, bounded
        session even with no inbound context. Requests to the resource's bound
        upstream (or any absolute URL) are rewritten through the configured
        gateway; requests already addressed to the gateway pass through.

        The mandate is cached per application identity, resource, and scope
        set, refreshed before expiry with a fresh session cycle; concurrent
        requests share one in-flight cycle. ``labels`` tag the spawned sessions
        (default: the application id). ``mandate_ttl_seconds`` bounds each
        mandate; sessions outlive it by a fixed buffer.

        Requires client-secret credentials."""
        return httpx.AsyncClient(
            auth=self._governed_auth(
                resource_id,
                scopes=scopes,
                labels=labels,
                mandate_ttl_seconds=mandate_ttl_seconds,
                label="governed_transport",
            ),
            **kwargs,
        )

    def sync_governed_transport(
        self,
        resource_id: str,
        *,
        scopes: list[str],
        labels: list[str] | None = None,
        mandate_ttl_seconds: int | None = None,
        **kwargs: Any,
    ) -> httpx.Client:
        """Sync counterpart to :meth:`governed_transport`: returns an
        httpx.Client authorizing every request with a governed mandate minted
        under this application's own authority. See :meth:`governed_transport`
        for the cycle, caching, and routing semantics."""
        return httpx.Client(
            auth=self._governed_auth(
                resource_id,
                scopes=scopes,
                labels=labels,
                mandate_ttl_seconds=mandate_ttl_seconds,
                label="sync_governed_transport",
            ),
            **kwargs,
        )

    def _governed_auth(
        self,
        resource_id: str,
        *,
        scopes: list[str],
        labels: list[str] | None,
        mandate_ttl_seconds: int | None,
        label: str,
    ) -> httpx.Auth:
        if self.config.exchanger is None:
            raise RuntimeError(
                f"Caracal.{label} requires client-secret credentials; "
                "build the client with from_client_secret, from_config, or "
                "CARACAL_APP_CLIENT_SECRET."
            )
        if not resource_id.strip():
            raise ValueError(f"Caracal.{label}: resource_id is required")
        if not scopes:
            raise ValueError(f"Caracal.{label}: scopes are required")
        granted = sorted(set(scopes))
        mandate_ttl = (
            mandate_ttl_seconds
            if mandate_ttl_seconds is not None
            else GOVERNED_MANDATE_TTL_SECONDS
        )
        outer = self

        class _GovernedAuth(httpx.Auth):
            requires_request_body = False

            def _finish(self, request: httpx.Request, mandate: str) -> None:
                request.headers["Authorization"] = f"Bearer {mandate}"
                request.headers["X-Caracal-Resource"] = resource_id
                rewritten = outer._route_through_gateway(request.url, resource_id)
                if rewritten is not None:
                    request.url = httpx.URL(rewritten[0])
                    request.headers["host"] = request.url.netloc.decode("ascii")

            def sync_auth_flow(self, request: httpx.Request):
                self._finish(
                    request,
                    outer._governed_mandate(resource_id, granted, labels, mandate_ttl),
                )
                yield request

            async def async_auth_flow(self, request: httpx.Request):
                mandate = await asyncio.to_thread(
                    outer._governed_mandate, resource_id, granted, labels, mandate_ttl
                )
                self._finish(request, mandate)
                yield request

        return _GovernedAuth()

    def _governed_cached(self, key: str) -> str | None:
        with self._governed_guard:
            cached = self._governed_mandates.get(key)
            if (
                cached is not None
                and cached[1] - time.time() > GOVERNED_REFRESH_MARGIN_SECONDS
            ):
                return cached[0]
        return None

    def _governed_lock(self, key: str) -> threading.Lock:
        with self._governed_guard:
            lock = self._governed_locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._governed_locks[key] = lock
            return lock

    def _governed_mandate(
        self,
        resource_id: str,
        scopes: list[str],
        labels: list[str] | None,
        mandate_ttl: int,
    ) -> str:
        exchanger = self.config.exchanger
        assert exchanger is not None
        zone_id, application_id = exchanger.identity()
        key = f"{zone_id}::{application_id}::{resource_id}::{' '.join(scopes)}"
        cached = self._governed_cached(key)
        if cached is not None:
            return cached
        with self._governed_lock(key):
            cached = self._governed_cached(key)
            if cached is not None:
                return cached
            token, exp = self._governed_cycle(
                zone_id, application_id, resource_id, scopes, labels, mandate_ttl
            )
            with self._governed_guard:
                self._governed_mandates[key] = (token, exp)
            return token

    def _governed_cycle(
        self,
        zone_id: str,
        application_id: str,
        resource_id: str,
        scopes: list[str],
        labels: list[str] | None,
        mandate_ttl: int,
    ) -> tuple[str, float]:
        exchanger = self.config.exchanger
        assert exchanger is not None
        session_ttl = mandate_ttl + GOVERNED_SESSION_TTL_BUFFER_SECONDS
        bootstrap = exchanger.mint_mandate(
            resource=resource_id, scopes=[LIFECYCLE_SCOPE]
        )
        coordinator = self.config.coordinator
        http = exchanger._http
        session_labels = labels if labels else [application_id]
        spawned: list[str] = []
        try:
            source = sync_spawn_agent(
                coordinator,
                http,
                bootstrap,
                SpawnRequest(
                    zone_id=zone_id,
                    application_id=application_id,
                    ttl_seconds=session_ttl,
                    labels=session_labels,
                    idempotency_key=str(uuid.uuid4()),
                ),
            )
            spawned.append(source.agent_session_id)
            target = sync_spawn_agent(
                coordinator,
                http,
                bootstrap,
                SpawnRequest(
                    zone_id=zone_id,
                    application_id=application_id,
                    ttl_seconds=session_ttl,
                    labels=session_labels,
                    idempotency_key=str(uuid.uuid4()),
                ),
            )
            spawned.append(target.agent_session_id)
            edge = sync_create_delegation(
                coordinator,
                http,
                bootstrap,
                DelegationRequest(
                    zone_id=zone_id,
                    issuer_application_id=application_id,
                    source_session_id=source.agent_session_id,
                    target_session_id=target.agent_session_id,
                    receiver_application_id=application_id,
                    scopes=list(scopes),
                    constraints=DelegationConstraints(resources=[resource_id]),
                    ttl_seconds=session_ttl,
                ),
            )
            token = exchanger.mint_mandate(
                resource=resource_id,
                scopes=list(scopes),
                agent_session_id=target.agent_session_id,
                delegation_edge_id=edge.delegation_edge_id,
                ttl_seconds=mandate_ttl,
            )
            exp = decode_jwt_exp(token) or (time.time() + mandate_ttl)
            return token, exp
        except BaseException:
            for agent_session_id in spawned:
                with suppress(Exception):
                    sync_terminate_agent(
                        coordinator, http, bootstrap, zone_id, agent_session_id
                    )
            raise

    def _route_through_gateway(
        self,
        target: httpx.URL | str,
        explicit_resource: str | None,
    ) -> tuple[str, str] | None:
        gw = self.config.gateway_url
        if not gw:
            return None
        target_url = str(target)
        try:
            parsed = urlparse(target_url)
        except ValueError:
            return None
        if not parsed.scheme or not parsed.netloc:
            return None
        gw_parsed = urlparse(gw)
        if parsed.scheme == gw_parsed.scheme and parsed.netloc == gw_parsed.netloc:
            return None
        binding: ResourceBinding | None = None
        if explicit_resource:
            for b in self.config.resources:
                if b.resource_id == explicit_resource:
                    binding = b
                    break
        else:
            for b in self.config.resources:
                if _url_matches_prefix(parsed, b.upstream_prefix):
                    binding = b
                    break
            if binding is None:
                return None
        suffix = parsed.path or "/"
        if binding is not None:
            prefix = urlparse(binding.upstream_prefix)
            if (
                prefix.path
                and prefix.path != "/"
                and parsed.path.startswith(prefix.path)
            ):
                trimmed = parsed.path[len(prefix.path) :] or "/"
                if not trimmed.startswith("/"):
                    trimmed = "/" + trimmed
                suffix = trimmed
        base_path = gw_parsed.path.rstrip("/")
        rewritten = urlunparse(
            (
                gw_parsed.scheme,
                gw_parsed.netloc,
                base_path + suffix,
                "",
                parsed.query,
                "",
            )
        )
        rid = binding.resource_id if binding is not None else (explicit_resource or "")
        return rewritten, rid


def _url_matches_prefix(target, prefix: str) -> bool:
    p = urlparse(prefix)
    if p.scheme != target.scheme or p.netloc != target.netloc:
        return False
    if not p.path or p.path == "/":
        return True
    if target.path == p.path:
        return True
    pp = p.path if p.path.endswith("/") else p.path + "/"
    return target.path.startswith(pp)


def _join_gateway_path(gateway_url: str, path: str) -> str:
    parsed_path = urlparse(path)
    if parsed_path.scheme or parsed_path.netloc:
        raise ValueError(
            "Caracal.gateway_request: path must be relative to the configured gateway"
        )
    gw = urlparse(gateway_url)
    normalized = path if path.startswith("/") else f"/{path}"
    split = normalized.split("?", 1)
    pathname = split[0] or "/"
    query = split[1] if len(split) == 2 else ""
    base_path = gw.path.rstrip("/")
    return urlunparse((gw.scheme, gw.netloc, base_path + pathname, "", query, ""))
