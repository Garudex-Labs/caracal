"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal: drop-in bound client wrapping zone, application, subject token, and coordinator.
"""

from __future__ import annotations

import json
import os
import sys
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from collections.abc import AsyncGenerator, Callable, Mapping
from urllib.parse import urlparse, urlunparse

import httpx

from .context import (
    CaracalContext,
    _ctx_var,
    current,
    from_envelope,
    to_envelope,
)
from .auth import ClientSecretExchanger, TokenSource, _decode_jwt_exp
from .coordinator import CoordinatorClient, DelegationConstraints
from .envelope import decode_envelope, to_headers
from .json_types import JsonObject
from .primitives import (
    Grant,
    LifecycleHook,
    ServiceAgent,
    delegate,
    spawn,
    spawn_service,
)

DEFAULT_STS_URL = "http://localhost:8080"
DEFAULT_COORDINATOR_URL = "http://localhost:4000"
DEFAULT_GATEWAY_URL = "http://localhost:8081"

if TYPE_CHECKING:
    from .http import ASGIApp, CaracalContextASGIMiddleware, Verifier


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
    Exactly one must be provided.
    """

    def __init__(
        self,
        *,
        coordinator: CoordinatorClient,
        zone_id: str,
        application_id: str,
        subject_token: str | None = None,
        token_source: TokenSource | None = None,
        gateway_url: str | None = None,
        resources: list[ResourceBinding] | None = None,
        default_ttl_seconds: int | None = None,
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

    @property
    def subject_token(self) -> str:
        if self._token_source is not None:
            return self._token_source()
        assert self._static_token is not None
        return self._static_token


def sort_bindings_longest_first(bindings: list[ResourceBinding]) -> list[ResourceBinding]:
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
            errors.append(f"entry {index} must contain non-empty resource_id and upstream_prefix")
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
    import json

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
                errors.append(f"{source}: entry {key!r}: upstream_prefix must be a non-empty string")
                continue
            if not _is_absolute_url(value):
                errors.append(f"{source}: entry {key!r}: upstream_prefix must be an absolute URL")
                continue
            out.append(ResourceBinding(resource_id=key, upstream_prefix=value))
    elif isinstance(data, list):
        for idx, entry in enumerate(data):
            if not isinstance(entry, dict):
                errors.append(f"{source}[{idx}]: entry must be an object, got {type(entry).__name__}")
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
                errors.append(f"{source}[{idx}]: resource_id must be a non-empty string")
                continue
            if not isinstance(prefix, str) or not prefix:
                errors.append(f"{source}[{idx}]: upstream_prefix must be a non-empty string")
                continue
            if not _is_absolute_url(prefix):
                errors.append(f"{source}[{idx}]: upstream_prefix must be an absolute URL")
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
    cfg_credentials: list[object] | None,
    env: Mapping[str, str],
    *,
    cfg_source: str,
) -> list[ResourceBinding]:
    """Single source of truth for resource binding resolution.

    Unions bindings from three sources: TOML credentials block, JSON file
    pointed to by ``CARACAL_RESOURCES_FILE``, and the flat
    ``CARACAL_RESOURCES`` env var: validates each, and returns a
    deduplicated list. Later sources override earlier ones on conflict.
    """
    seen: dict[str, ResourceBinding] = {}

    if cfg_credentials:
        cred_records: list[dict[str, str]] = []
        for idx, cred in enumerate(cfg_credentials):
            if not isinstance(cred, dict):
                raise ValueError(f"{cfg_source}.credentials[{idx}]: must be a table")
            rid = cred.get("resource")
            prefix = cred.get("upstream_prefix")
            if rid and prefix:
                cred_records.append({"resource_id": str(rid), "upstream_prefix": str(prefix)})
        for b in _validate_resource_bindings(cred_records, source=f"{cfg_source}.credentials"):
            seen[b.resource_id] = b

    for b in _load_resource_bindings_file(env.get("CARACAL_RESOURCES_FILE")):
        seen[b.resource_id] = b

    for b in _parse_resource_bindings(env.get("CARACAL_RESOURCES")):
        seen[b.resource_id] = b

    return list(seen.values())


def _resource_ids_from_env(env: Mapping[str, str], bindings: list[ResourceBinding]) -> list[str]:
    explicit = env.get("CARACAL_APP_RESOURCES")
    if explicit:
        ids = [s.strip() for s in explicit.split(",") if s.strip()]
        if ids:
            return ids
    if bindings:
        return [b.resource_id for b in bindings]
    return []


def _default_config_path():
    from pathlib import Path

    explicit = os.environ.get("CARACAL_CONFIG")
    if explicit:
        return Path(explicit)
    return _default_config_dir(os.environ) / "caracal.toml"


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
        return Path(env.get("APPDATA") or env.get("LOCALAPPDATA") or Path.home() / "AppData" / "Roaming") / "Caracal"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Caracal"
    return Path.home() / ".config" / "caracal"


def _safe_path_segment(value: str) -> str:
    import re

    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip()).strip("_")
    return safe or "default"


def _default_credential_dir(env: Mapping[str, str], zone_id: str, application_id: str):
    return _default_config_dir(env) / "runtime" / _safe_path_segment(zone_id) / _safe_path_segment(application_id)


def _default_client_secret_path(env: Mapping[str, str], zone_id: str, application_id: str):
    return _default_credential_dir(env, zone_id, application_id) / "client-secret"


def _default_run_credentials_path(env: Mapping[str, str], zone_id: str, application_id: str):
    return _default_credential_dir(env, zone_id, application_id) / "credentials.json"


def _existing_local_file(path, env: Mapping[str, str]):
    if env.get("NODE_ENV") == "production":
        return None
    return path if path.exists() else None


def _read_secret_path(path, source: str) -> str:
    if not path.exists():
        raise RuntimeError(f"{source} secret file does not exist: {path}")
    if os.name != "nt" and path.stat().st_mode & 0o022:
        raise RuntimeError(f"{source} secret file is group/world writable: {path}")
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
    if env.get("NODE_ENV") == "production":
        raise RuntimeError(f"Caracal SDK: {key} is required when NODE_ENV=production")
    return default


def _sts_url(env: Mapping[str, str]) -> str:
    return (
        env.get("CARACAL_STS_URL")
        or env.get("CARACAL_ZONE_URL")
        or _service_url(env, "CARACAL_STS_URL", DEFAULT_STS_URL)
    )


def _client_secret_from_config(cfg: dict, zone_id: str, application_id: str) -> str:
    from pathlib import Path

    value = cfg.get("app_client_secret")
    file_value = cfg.get("app_client_secret_file")
    if value and file_value:
        raise RuntimeError(
            "caracal.toml must set only one of 'app_client_secret' or "
            "'app_client_secret_file'"
        )
    if isinstance(value, str) and value:
        return value
    if isinstance(file_value, str) and file_value:
        return _read_secret_path(Path(file_value), "caracal.toml")
    local_path = _existing_local_file(
        _default_client_secret_path(os.environ, zone_id, application_id),
        os.environ,
    )
    if local_path is None:
        raise RuntimeError(
            "caracal.toml missing client secret; local dev/stable auto-detects "
            f"{_default_client_secret_path(os.environ, zone_id, application_id)} when it exists"
        )
    return _read_secret_path(local_path, "caracal.toml")


def _client_secret_from_env(env: Mapping[str, str], zone_id: str, application_id: str) -> str | None:
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
    local_path = _existing_local_file(_default_client_secret_path(env, zone_id, application_id), env)
    if local_path is not None:
        return _read_secret_path(local_path, "Caracal.from_env")
    return value


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


def _resource_bindings_from_credentials(credentials: list[dict[str, str]]) -> tuple[list[str], list[ResourceBinding]]:
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


def _credential_manifest_from_env(env: Mapping[str, str], zone_id: str, application_id: str) -> list[dict[str, str]]:
    file_value = env.get("CARACAL_RUN_CREDENTIALS_FILE")
    inline = env.get("CARACAL_RUN_CREDENTIALS")
    if file_value and inline:
        raise RuntimeError(
            "Caracal.from_env must set only one of CARACAL_RUN_CREDENTIALS or "
            "CARACAL_RUN_CREDENTIALS_FILE"
        )
    if not file_value and not inline:
        local_path = _existing_local_file(_default_run_credentials_path(env, zone_id, application_id), env)
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
        raise RuntimeError("Caracal.from_env credential manifest must be an array or object")
    return (
        _credential_entries(manifest.get("credentials"), source="CARACAL_RUN_CREDENTIALS.credentials")
        + _credential_entries(manifest.get("optional_credentials"), source="CARACAL_RUN_CREDENTIALS.optional_credentials")
    )


def _validate_subject_token(token: str) -> None:
    """Local sanity check on a static bootstrap subject token. Rejects JWTs
    whose `exp` claim is already in the past. Opaque tokens are accepted
    unchanged. Signature verification is the verifier's responsibility."""
    import time

    exp = _decode_jwt_exp(token)
    if exp is None:
        return
    if exp <= time.time():
        raise RuntimeError(
            "CARACAL_SUBJECT_TOKEN is expired or has an invalid `exp` claim: "
            "refresh the bootstrap token before starting the application"
        )


def _config_from_env(env: Mapping[str, str] | None = None) -> CaracalConfig:
    e = env if env is not None else os.environ
    coordinator_url = _service_url(e, "CARACAL_COORDINATOR_URL", DEFAULT_COORDINATOR_URL)
    zone_id = e.get("CARACAL_ZONE_ID")
    application_id = e.get("CARACAL_APPLICATION_ID")
    missing = [
        k for k, v in {
            "CARACAL_ZONE_ID": zone_id,
            "CARACAL_APPLICATION_ID": application_id,
        }.items() if not v
    ]
    if missing:
        raise RuntimeError(f"Caracal.from_env: missing {', '.join(missing)}")

    credential_ids, credential_bindings = _resource_bindings_from_credentials(
        _credential_manifest_from_env(e, zone_id, application_id)
    )
    bindings = sort_bindings_longest_first(
        credential_bindings + _resolve_bindings(None, e, cfg_source="env")
    )
    gateway_url = _service_url(e, "CARACAL_GATEWAY_URL", DEFAULT_GATEWAY_URL)

    client_secret = _client_secret_from_env(e, zone_id, application_id)
    sts_url = _sts_url(e)
    subject_token = e.get("CARACAL_SUBJECT_TOKEN")

    if client_secret:
        resources = _resource_ids_from_env(e, bindings)
        if credential_ids:
            resources = list(dict.fromkeys(credential_ids + resources))
        if not resources:
            raise RuntimeError(
                "Caracal.from_env: client-secret mode requires resources via "
                "CARACAL_APP_RESOURCES, CARACAL_RESOURCES, or CARACAL_RESOURCES_FILE"
            )
        exchanger = ClientSecretExchanger(
            sts_url=sts_url,
            zone_id=zone_id,
            application_id=application_id,
            client_secret=client_secret,
            resources=resources,
        )
        return CaracalConfig(
            coordinator=CoordinatorClient(base_url=coordinator_url),
            zone_id=zone_id,
            application_id=application_id,
            token_source=exchanger.get_token,
            gateway_url=gateway_url,
            resources=bindings,
        )

    if not subject_token:
        raise RuntimeError(
            "Caracal.from_env: provide CARACAL_APP_CLIENT_SECRET or CARACAL_SUBJECT_TOKEN"
        )
    _validate_subject_token(subject_token)
    return CaracalConfig(
        coordinator=CoordinatorClient(base_url=coordinator_url),
        zone_id=zone_id,
        application_id=application_id,
        subject_token=subject_token,
        gateway_url=gateway_url,
        resources=bindings,
    )


def _config_from_client_secret(
    *,
    coordinator_url: str,
    sts_url: str,
    zone_id: str,
    application_id: str,
    client_secret: str,
    resources: list[str | ResourceBinding],
    gateway_url: str | None = None,
    scope: str = "agent:lifecycle",
    http_client: httpx.Client | None = None,
) -> CaracalConfig:
    bindings: list[ResourceBinding] = []
    resource_ids: list[str] = []
    for r in resources:
        if isinstance(r, ResourceBinding):
            bindings.append(r)
            resource_ids.append(r.resource_id)
        else:
            resource_ids.append(str(r))
    if not resource_ids:
        raise ValueError("from_client_secret requires at least one resource")
    exchanger = ClientSecretExchanger(
        sts_url=sts_url,
        zone_id=zone_id,
        application_id=application_id,
        client_secret=client_secret,
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
    )


def _config_from_file(path: str | os.PathLike[str] | None = None) -> CaracalConfig:
    import tomllib
    from pathlib import Path

    cfg_path = Path(path) if path is not None else _default_config_path()
    if not cfg_path.exists():
        raise RuntimeError(
            f"Caracal config not found at {cfg_path}; provision a zone "
            "and application in the Console and author "
            "caracal.toml with the returned ids."
        )
    cfg = tomllib.loads(cfg_path.read_text())

    zone_id = _required_str(cfg, "zone_id")
    application_id = _required_str(cfg, "application_id")
    client_secret = _client_secret_from_config(cfg, zone_id, application_id)
    sts_url = (
        cfg.get("sts_url")
        or cfg.get("zone_url")
        or os.environ.get("CARACAL_STS_URL")
        or os.environ.get("CARACAL_ZONE_URL")
        or _service_url(os.environ, "CARACAL_STS_URL", DEFAULT_STS_URL)
    )
    coordinator_url = (
        cfg.get("coordinator_url")
        or os.environ.get("CARACAL_COORDINATOR_URL")
        or _service_url(os.environ, "CARACAL_COORDINATOR_URL", DEFAULT_COORDINATOR_URL)
    )
    gateway_url = (
        cfg.get("gateway_url")
        or os.environ.get("CARACAL_GATEWAY_URL")
        or _service_url(os.environ, "CARACAL_GATEWAY_URL", DEFAULT_GATEWAY_URL)
    )

    credential_ids, credential_bindings = _resource_bindings_from_credentials(
        _credential_entries(cfg.get("credentials"), source=f"{cfg_path}.credentials")
        + _credential_entries(cfg.get("optional_credentials"), source=f"{cfg_path}.optional_credentials")
        + _credential_manifest_from_env(os.environ, zone_id, application_id)
    )
    bindings = sort_bindings_longest_first(
        credential_bindings + _resolve_bindings([], os.environ, cfg_source=str(cfg_path))
    )
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
    )


def _detect_config(
    config_path: str | os.PathLike[str] | None = None,
    env: Mapping[str, str] | None = None,
) -> CaracalConfig:
    if config_path is not None:
        return _config_from_file(config_path)
    e = env if env is not None else os.environ
    default = _default_config_path_for(e)
    if e.get("CARACAL_CONFIG") and not default.exists():
        raise RuntimeError(f"Caracal config not found at {default}")
    if default.exists():
        return _config_from_file(default)
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
        zone_id: str,
        application_id: str,
        client_secret: str,
        resources: list[str | ResourceBinding],
        gateway_url: str | None = None,
        scope: str = "agent:lifecycle",
        http_client: httpx.Client | None = None,
    ) -> Caracal:
        """Build a Caracal client that exchanges an application client_secret
        for an STS access token and refreshes the token automatically.

        `resources` may be either a list of resource IDs (the STS audiences) or
        a list of ResourceBinding objects (when gateway routing is also
        required). When ResourceBinding objects are supplied their
        `resource_id`s are used as the STS audiences.
        """
        return cls(_config_from_client_secret(
            coordinator_url=coordinator_url,
            sts_url=sts_url,
            zone_id=zone_id,
            application_id=application_id,
            client_secret=client_secret,
            resources=resources,
            gateway_url=gateway_url,
            scope=scope,
            http_client=http_client,
        ))

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

    async def _fire(self, hooks: list[LifecycleHook], ctx: CaracalContext) -> None:
        for h in hooks:
            await h(ctx)

    @asynccontextmanager
    async def spawn(
        self,
        *,
        grant: Grant | None = None,
        ttl_seconds: int | None = None,
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
            (lambda c: self._fire(self._agent_start_hooks, c)) if self._agent_start_hooks else None
        )
        on_end: LifecycleHook | None = (
            (lambda c: self._fire(self._agent_end_hooks, c)) if self._agent_end_hooks else None
        )
        async with spawn(
            coordinator=self.config.coordinator,
            zone_id=self.config.zone_id,
            application_id=self.config.application_id,
            subject_token=self.config.subject_token,
            parent_id=parent_id,
            parent_ctx=parent_ctx,
            grant=grant,
            ttl_seconds=ttl_seconds if ttl_seconds is not None else self.config.default_ttl_seconds,
            metadata=metadata,
            labels=labels,
            trace_id=trace_id,
            on_agent_start=on_start,
            on_agent_end=on_end,
        ) as ctx:
            yield ctx

    async def service(
        self,
        *,
        ttl_seconds: int | None = None,
        parent_id: str | None = None,
        parent_ctx: CaracalContext | None = None,
        metadata: JsonObject | None = None,
        labels: list[str] | None = None,
        trace_id: str | None = None,
        heartbeat_interval: float | None = None,
    ) -> ServiceAgent:
        """Start a long-lived service agent and return a handle the caller owns.

        Unlike :meth:`spawn`, the session is not retired when a block exits: keep
        it alive by calling :meth:`ServiceAgent.heartbeat` and retire it with
        :meth:`ServiceAgent.aclose`. Use for daemons and workers that outlive a
        single request. Pass ``heartbeat_interval`` to renew the lease from a
        background task so it survives long provider/resource streams."""
        on_start: LifecycleHook | None = (
            (lambda c: self._fire(self._agent_start_hooks, c)) if self._agent_start_hooks else None
        )
        return await spawn_service(
            coordinator=self.config.coordinator,
            zone_id=self.config.zone_id,
            application_id=self.config.application_id,
            subject_token=self.config.subject_token,
            parent_id=parent_id,
            parent_ctx=parent_ctx,
            ttl_seconds=ttl_seconds if ttl_seconds is not None else self.config.default_ttl_seconds,
            metadata=metadata,
            labels=labels,
            trace_id=trace_id,
            heartbeat_interval=heartbeat_interval,
            on_agent_start=on_start,
        )

    @asynccontextmanager
    async def delegate(
        self,
        *,
        to: str,
        to_application_id: str,
        scopes: list[str],
        resource_id: str | None = None,
        constraints: DelegationConstraints | None = None,
        ttl_seconds: int | None = None,
    ) -> AsyncGenerator[CaracalContext, None]:
        async with delegate(
            coordinator=self.config.coordinator,
            to_agent_session_id=to,
            to_application_id=to_application_id,
            resource_id=resource_id,
            scopes=scopes,
            constraints=constraints,
            ttl_seconds=ttl_seconds,
        ) as ctx:
            yield ctx

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

    def headers(self, *, allow_root: bool = False) -> dict[str, str]:
        """Project the current Caracal context into outbound HTTP headers.

        When no context is bound to the current task this would return the
        bootstrap application subject token. Doing so silently leaks root
        identity from background tasks that escape the contextvar (asyncio
        task groups, thread pools, framework background runners). Callers
        therefore MUST opt in via ``allow_root=True`` when they intentionally
        want service-level (un-delegated) credentials. Bind a child context
        explicitly with :meth:`bind` before fan-out to keep delegation
        semantics intact.
        """
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
            from .envelope import Envelope

            return to_headers(Envelope(subject_token=self.config.subject_token, hop=0))
        return to_headers(to_envelope(ctx))

    @asynccontextmanager
    async def bind_from_headers(
        self,
        headers: Mapping[str, str],
        *,
        allow_root: bool = False,
    ) -> AsyncGenerator[CaracalContext, None]:
        def get(name: str) -> str | None:
            lower = name.lower()
            for k, v in headers.items():
                if k.lower() == lower:
                    return v
            return None

        env = decode_envelope(get)
        if not env.subject_token:
            if not allow_root:
                raise RuntimeError(
                    "Caracal.bind_from_headers(): inbound request is missing a bearer token. "
                    "Pass allow_root=True only for trusted service-root ingress."
                )
            env.subject_token = self.config.subject_token
        ctx = from_envelope(
            env,
            zone_id=self.config.zone_id,
            client_id=self.config.application_id,
        )
        token = _ctx_var.set(ctx)
        try:
            yield ctx
        finally:
            _ctx_var.reset(token)

    def current(self) -> CaracalContext | None:
        return current()

    async def close(self) -> None:
        """Release the coordinator's HTTP client. Idempotent."""
        await self.config.coordinator.close()

    def context_middleware(
        self,
        *,
        allow_root: bool = False,
        verifier: Verifier | None = None,
    ) -> Callable[[ASGIApp], CaracalContextASGIMiddleware]:
        """ASGI middleware factory for the inbound request boundary.

        Without ``verifier`` it only binds the inbound envelope into request
        context (propagation): it does not check JWT signatures, audience,
        scopes, token use, or revocation. Use this when a Gateway already
        enforced the mandate upstream.

        Pass ``verifier`` to enforce at the boundary. The callable receives the
        bearer token and must raise on failure; back it with
        ``caracalai_identity.verify_token`` so the application sees a request
        only after the mandate is proven. The SDK never inspects token internals
        itself. This middleware is framework-agnostic and runs on any ASGI app
        (FastAPI, Starlette, Quart, Django ASGI).

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
        from .http import CaracalContextASGIMiddleware

        outer = self

        def factory(app: ASGIApp) -> CaracalContextASGIMiddleware:
            return CaracalContextASGIMiddleware(
                app, outer, allow_root=allow_root, verifier=verifier
            )

        return factory

    def transport(self, *, allow_root: bool = False, **kwargs: Any) -> httpx.AsyncClient:
        """Returns an httpx.AsyncClient that auto-injects the envelope on every request
        and rewrites resource-bound calls through the configured Caracal gateway. Pass
        to any provider SDK that accepts a custom httpx client.

        Per-request identity is taken from the bound :class:`CaracalContext`. If a
        request fires with no context bound, the call raises ``RuntimeError`` unless
        the transport was created with ``allow_root=True`` (service-level identity).
        """
        outer = self
        root_allowed = allow_root

        class _CaracalAuth(httpx.Auth):
            requires_request_body = False

            def auth_flow(self, request: httpx.Request):
                rewritten = outer._route_through_gateway(
                    request.url, request.headers.get("X-Caracal-Resource")
                )
                ctx = current()
                if rewritten is not None:
                    request.url = httpx.URL(rewritten[0])
                    request.headers["host"] = request.url.host
                    request.headers["X-Caracal-Resource"] = rewritten[1]
                    if ctx is not None:
                        token = ctx.subject_token
                    elif root_allowed:
                        token = outer.config.subject_token
                    else:
                        raise RuntimeError(
                            "Caracal.transport(): gateway-routed request fired with "
                            "no CaracalContext bound. Bind a child context before "
                            "fan-out or build the transport with `allow_root=True`."
                        )
                    request.headers["Authorization"] = f"Bearer {token}"
                for k, v in outer.headers(allow_root=root_allowed).items():
                    if k not in request.headers:
                        request.headers[k] = v
                yield request

        return httpx.AsyncClient(auth=_CaracalAuth(), **kwargs)

    def gateway_request(self, resource_id: str, path: str = "/") -> GatewayRequest:
        if not self.config.gateway_url:
            raise RuntimeError("Caracal.gateway_request: gateway_url is not configured")
        if not resource_id.strip():
            raise ValueError("Caracal.gateway_request: resource_id is required")
        return GatewayRequest(
            url=_join_gateway_path(self.config.gateway_url, path),
            headers={"X-Caracal-Resource": resource_id},
        )

    async def fetch(
        self,
        resource_id: str,
        path: str = "/",
        *,
        method: str = "GET",
        headers: Mapping[str, str] | None = None,
        allow_root: bool = False,
        transport: httpx.AsyncBaseTransport | None = None,
        **request_kwargs: Any,
    ) -> httpx.Response:
        """One-call happy path: send a request to ``path`` on ``resource_id`` through
        the Gateway with Caracal context and authority injected. Extra keyword
        arguments (``json``, ``content``, ``params``, ``timeout``, ...) pass through
        to the underlying httpx request. The resource header always wins over any
        caller-supplied ``X-Caracal-Resource``.
        """
        request = self.gateway_request(resource_id, path)
        merged = {**(headers or {}), **request.headers}
        client_kwargs: dict[str, Any] = {} if transport is None else {"transport": transport}
        async with self.transport(allow_root=allow_root, **client_kwargs) as client:
            return await client.request(method, request.url, headers=merged, **request_kwargs)

    def sync_transport(self, *, allow_root: bool = False, **kwargs: Any) -> httpx.Client:
        """Sync counterpart to transport(): returns an httpx.Client that auto-injects
        the envelope on every request and rewrites resource-bound calls through the
        configured Caracal gateway. Use with sync httpx-based SDKs.

        See :meth:`transport` for the ``allow_root`` semantics.
        """
        outer = self
        root_allowed = allow_root

        class _CaracalSyncAuth(httpx.Auth):
            requires_request_body = False

            def sync_auth_flow(self, request: httpx.Request):
                rewritten = outer._route_through_gateway(
                    request.url, request.headers.get("X-Caracal-Resource")
                )
                ctx = current()
                if rewritten is not None:
                    request.url = httpx.URL(rewritten[0])
                    request.headers["host"] = request.url.host
                    request.headers["X-Caracal-Resource"] = rewritten[1]
                    if ctx is not None:
                        token = ctx.subject_token
                    elif root_allowed:
                        token = outer.config.subject_token
                    else:
                        raise RuntimeError(
                            "Caracal.sync_transport(): gateway-routed request fired "
                            "with no CaracalContext bound. Bind a child context "
                            "before fan-out or build the transport with `allow_root=True`."
                        )
                    request.headers["Authorization"] = f"Bearer {token}"
                for k, v in outer.headers(allow_root=root_allowed).items():
                    if k not in request.headers:
                        request.headers[k] = v
                yield request

        return httpx.Client(auth=_CaracalSyncAuth(), **kwargs)

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
            if prefix.path and prefix.path != "/" and parsed.path.startswith(prefix.path):
                trimmed = parsed.path[len(prefix.path) :] or "/"
                if not trimmed.startswith("/"):
                    trimmed = "/" + trimmed
                suffix = trimmed
        base_path = gw_parsed.path.rstrip("/")
        rewritten = urlunparse(
            (gw_parsed.scheme, gw_parsed.netloc, base_path + suffix, "", parsed.query, "")
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
        raise ValueError("Caracal.gateway_request: path must be relative to the configured gateway")
    gw = urlparse(gateway_url)
    normalized = path if path.startswith("/") else f"/{path}"
    split = normalized.split("?", 1)
    pathname = split[0] or "/"
    query = split[1] if len(split) == 2 else ""
    base_path = gw.path.rstrip("/")
    return urlunparse((gw.scheme, gw.netloc, base_path + pathname, "", query, ""))
