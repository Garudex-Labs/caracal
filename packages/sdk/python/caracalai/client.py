"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal: drop-in bound client wrapping zone, application, subject token, and coordinator.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import os
import threading
import time
import uuid
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any, TypeVar
from collections.abc import AsyncGenerator, Awaitable, Callable, Mapping
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
    ApprovalRequired,
    ApprovalState,
    CaracalError,
    CaracalEvent,
    ClientCredentials,
    ClientSecretExchanger,
    CredentialsResolver,
    EventHook,
    MintedMandate,
    TokenSource,
    decode_jwt_exp,
    decode_jwt_payload,
    emit_event,
)
from .coordinator import (
    CoordinatorClient,
    DelegationConstraints,
    DelegationRequest,
    StartSessionRequest,
    list_inbound_delegations,
    sync_create_delegation,
    sync_start_coordinator_session,
    sync_terminate_session,
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
    Authority,
    Delegation,
    LifecycleHook,
    SessionHandle,
    accept_delegation,
    attach_session,
    delegate,
    session,
    start_session,
)

DEFAULT_STS_URL = "http://localhost:8080"
DEFAULT_COORDINATOR_URL = "http://localhost:4000"
DEFAULT_GATEWAY_URL = "http://localhost:8081"

LIFECYCLE_SCOPE = "agent:lifecycle"
APP_MANDATE_TTL_SECONDS = 900
APP_AUTHORITY_REFRESH_MARGIN_SECONDS = 60.0
# Each authority entry owns two sessions. Nineteen entries leave room for ten
# ordinary sessions and the next two-session provisioning cycle.
APP_AUTHORITY_CACHE_CAP = 19

_T = TypeVar("_T")
APP_SESSION_TTL_BUFFER_SECONDS = 120
_CREDENTIAL_FINGERPRINT_KEY = os.urandom(32)


@dataclass(frozen=True)
class _AppAuthority:
    resource_id: str
    zone_id: str
    application_id: str
    credential_generation: str
    target_session_id: str
    delegation_id: str
    expires_at: float
    sessions: tuple[str, ...]


if TYPE_CHECKING:
    from .http import ASGIApp, CaracalASGIMiddleware, TokenVerifier


@dataclass
class ResourceBinding:
    resource_id: str
    upstream_prefix: str


@dataclass(frozen=True)
class FederatedSubject:
    """A federated Subject and the mandate proving it.

    ``subject_authority_record_id`` anchors Coordinator attribution when
    attached to a Session; it does not alone propagate the user ``sub`` to
    later mints. ``token`` is the Subject's mandate for user-facing flows.
    """

    subject_authority_record_id: str
    token: str
    expires_in_seconds: int


@dataclass(frozen=True)
class GatewayTarget:
    url: str
    headers: dict[str, str]


class CaracalConfig:
    """Bound configuration for a Caracal client.

    `subject_token` may be supplied either as a static string or implicitly via
    `token_source`: a callable returning a fresh STS access token on demand.
    Exactly one must be provided. `default_ttl_seconds` applies to sessions run
    with `session()` only; a session started with `start_coordinator_session()` lives by
    its heartbeat lease instead.
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
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


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


def _production_env(env: Mapping[str, str]) -> bool:
    """CARACAL_ENV is the language-neutral gate every Caracal SDK honors."""
    return env.get("CARACAL_ENV") == "production"


_insecure_config_warned = False


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
    global _insecure_config_warned
    if not value:
        return
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise RuntimeError(
            f"Caracal SDK: {name} must be an absolute http or https URL: {value}"
        )
    if not _production_env(env):
        return
    if env.get("CARACAL_ALLOW_INSECURE_CONFIG_URLS") == "true":
        # The override disables the https requirement for the whole control
        # plane, so its presence in production must be loud and unmissable.
        if not _insecure_config_warned:
            _insecure_config_warned = True
            logging.getLogger("caracalai").warning(
                "caracal: CARACAL_ALLOW_INSECURE_CONFIG_URLS is active in "
                "production; control-plane traffic may travel over plaintext "
                "http - remove the override once TLS is in place"
            )
        return
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
    return _service_url(env, "CARACAL_STS_URL", DEFAULT_STS_URL)


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
    raise RuntimeError(
        "caracal.toml requires app_client_secret or app_client_secret_file"
    )


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


def _task_metadata(task: str | None, metadata: JsonObject | None) -> JsonObject | None:
    """Folds the task option into session metadata; an explicit task wins over
    a metadata task the caller also set."""
    if task is None:
        return metadata
    return {**(metadata or {}), "task": task}


def _validate_subject_token(token: str) -> None:
    """Local sanity check on a static bootstrap subject token. Rejects JWTs
    signed with ``alg: none`` - the platform never issues them, so the shape
    only appears in forgeries and miswired test fixtures - and JWTs whose
    `exp` claim is already in the past. Opaque tokens are accepted unchanged.
    Signature verification is the verifier's responsibility."""
    import base64
    import time

    parts = token.split(".")
    if len(parts) == 3:
        try:
            padded = parts[0] + "=" * (-len(parts[0]) % 4)
            header = json.loads(base64.urlsafe_b64decode(padded))
            alg = header.get("alg")
        except (ValueError, AttributeError):
            alg = None
        if isinstance(alg, str) and alg.lower() == "none":
            raise RuntimeError(
                'CARACAL_BOOTSTRAP_TOKEN uses alg "none": unsigned tokens are '
                "never valid; supply a token minted by the platform"
            )
    exp = decode_jwt_exp(token)
    if exp is None:
        return
    if exp <= time.time():
        raise RuntimeError(
            "CARACAL_BOOTSTRAP_TOKEN is expired or has an invalid `exp` claim: "
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

    bindings = sort_bindings_longest_first(_resolve_bindings([], e))
    gateway_url = _service_url(e, "CARACAL_GATEWAY_URL", DEFAULT_GATEWAY_URL)

    client_secret = _client_secret_from_env(e, zone_id, application_id)
    sts_url = _sts_url(e)
    subject_token = e.get("CARACAL_BOOTSTRAP_TOKEN")
    default_ttl = _default_ttl_from_env(e)

    if client_secret and subject_token:
        raise RuntimeError(
            "Caracal: configure exactly one of CARACAL_APP_CLIENT_SECRET and "
            "CARACAL_BOOTSTRAP_TOKEN"
        )
    if client_secret:
        resource_ids = _resource_ids_from_env(e, bindings)
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
            "Caracal.from_env: provide CARACAL_APP_CLIENT_SECRET or CARACAL_BOOTSTRAP_TOKEN"
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
    coordinator_http_client: httpx.AsyncClient | None = None,
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
    if default_ttl_seconds is not None and (
        isinstance(default_ttl_seconds, bool)
        or not isinstance(default_ttl_seconds, int)
        or default_ttl_seconds <= 0
    ):
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
            if not r.resource_id.strip():
                raise ValueError(
                    "Caracal.from_client_secret: resource IDs must be non-empty"
                )
            if not _is_absolute_url(r.upstream_prefix):
                raise ValueError(
                    "Caracal.from_client_secret: upstream_prefix must be an "
                    f"absolute http or https URL: {r.upstream_prefix}"
                )
            bindings.append(r)
            resource_ids.append(r.resource_id)
        else:
            resource_id = str(r)
            if not resource_id.strip():
                raise ValueError(
                    "Caracal.from_client_secret: resource IDs must be non-empty"
                )
            resource_ids.append(resource_id)
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
        coordinator=CoordinatorClient(
            base_url=coordinator_url, http_client=coordinator_http_client
        ),
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
    if path is None:
        raise ValueError("Caracal.from_config requires an explicit path")
    cfg_path = Path(path)
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
        or e.get("CARACAL_STS_URL")
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
    )
    bindings = sort_bindings_longest_first(_resolve_bindings(credential_bindings, e))
    resource_ids = list(
        dict.fromkeys(credential_ids + [b.resource_id for b in bindings])
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
    env: Mapping[str, str] | None = None,
) -> CaracalConfig:
    e = env if env is not None else os.environ
    path = e.get("CARACAL_CONFIG")
    if path:
        return _config_from_file(path, e)
    return _config_from_env(env)


class Caracal:
    def __init__(self, config: CaracalConfig | None = None) -> None:
        """Create a Caracal client.

        With no arguments, load `CARACAL_CONFIG` when set, otherwise load
        `CARACAL_*` environment variables. No implicit profile paths are read.
        """
        self.config = config if config is not None else _detect_config()
        self._session_start_hooks: list[LifecycleHook] = []
        self._session_end_hooks: list[LifecycleHook] = []
        self._event_hooks: list[EventHook] = []
        self.config.coordinator.on_event = self._emit_event
        if self.config.exchanger is not None:
            self.config.exchanger.on_event = self._emit_event
        self._fetch_clients: dict[
            tuple[bool, tuple[str, ...] | None], httpx.AsyncClient
        ] = {}
        self._app_mandates: dict[str, _AppAuthority] = {}
        self._app_mandate_locks: dict[str, tuple[threading.Lock, int]] = {}
        self._app_provision = threading.Semaphore(1)
        self._app_mandate_guard = threading.Lock()
        self._app_generation = 0
        self._unverified_boundary_warned = False

    @classmethod
    def from_client_secret(
        cls,
        *,
        coordinator_url: str,
        sts_url: str,
        zone_id: str,
        application_id: str,
        client_secret: str,
        resources: list[str | ResourceBinding] | None = None,
        gateway_url: str | None = None,
        default_ttl_seconds: int | None = None,
        http_client: httpx.Client | None = None,
        coordinator_http_client: httpx.AsyncClient | None = None,
    ) -> Caracal:
        """Build a Caracal client that exchanges an application client_secret
        for an STS access token and refreshes the token automatically.

        `resources` may be either a list of resource IDs (the STS audiences) or
        a list of ResourceBinding objects (when gateway routing is also
        required). When ResourceBinding objects are supplied their
        `resource_id`s are used as the STS audiences. Mandate-only clients
        (:meth:`mint_mandate`, :meth:`application_transport`) may omit
        resources; session and lifecycle paths require at least one.
        `default_ttl_seconds` bounds sessions that do not pass an explicit TTL.
        """
        return cls(
            _config_from_client_secret(
                coordinator_url=coordinator_url,
                sts_url=sts_url,
                zone_id=zone_id,
                application_id=application_id,
                client_secret=client_secret,
                resources=resources,
                gateway_url=gateway_url,
                default_ttl_seconds=default_ttl_seconds,
                http_client=http_client,
                coordinator_http_client=coordinator_http_client,
            )
        )

    def on_session_start(self, cb: LifecycleHook) -> Callable[[], None]:
        self._session_start_hooks.append(cb)

        def remove() -> None:
            with suppress(ValueError):
                self._session_start_hooks.remove(cb)

        return remove

    def on_session_end(self, cb: LifecycleHook) -> Callable[[], None]:
        self._session_end_hooks.append(cb)

        def remove() -> None:
            with suppress(ValueError):
                self._session_end_hooks.remove(cb)

        return remove

    def on_event(self, cb: EventHook) -> Callable[[], None]:
        """Subscribe to control-plane operation events: token exchanges (with
        cache outcome), approval waits, and coordinator calls, each carrying
        outcome and duration. Bridge them to any metrics or tracing system; a
        hook that raises is ignored and never disturbs the operation that
        emitted the event. Returns a disposer that removes the hook."""
        self._event_hooks.append(cb)

        def remove() -> None:
            with suppress(ValueError):
                self._event_hooks.remove(cb)

        return remove

    def identity(self) -> tuple[str, str]:
        """The zone and application this client acts as. Useful for logging
        and metric labels."""
        if self.config.zone_id and self.config.application_id:
            return self.config.zone_id, self.config.application_id
        assert self.config.exchanger is not None
        return self.config.exchanger.identity()

    def _emit_event(self, event: CaracalEvent) -> None:
        for h in self._event_hooks:
            emit_event(h, event)

    async def _fire(self, hooks: list[LifecycleHook], ctx: CaracalContext) -> None:
        for h in hooks:
            await h(ctx)

    @asynccontextmanager
    async def session(
        self,
        *,
        authority: Authority | None = None,
        ttl_seconds: int | None = None,
        subject_authority_record_id: str | None = None,
        parent_session_id: str | None = None,
        parent_ctx: CaracalContext | None = None,
        task: str | None = None,
        metadata: JsonObject | None = None,
        labels: list[str] | None = None,
        trace_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> AsyncGenerator[CaracalContext, None]:
        """Run the block inside a governed session: a bounded identity Caracal
        establishes around whatever the block executes - an AI agent step, a
        job, a tool call, any code. The session inherits this application's
        effective authority by default; pass
        ``authority=Authority.narrow([...])`` to bound it to a subset of
        scopes. ``task`` records what the session is for in operator terms
        (stored as ``metadata.task``). Ordinary code should omit
        ``idempotency_key``; when a queue, webhook, workflow, or scheduler
        supplies a stable operation id, reusing it with identical inputs
        replays session creation and changed inputs fail with a conflict. It
        does not suppress this block or make downstream effects exactly once."""
        on_start: LifecycleHook | None = (
            (lambda c: self._fire(self._session_start_hooks, c))
            if self._session_start_hooks
            else None
        )
        on_end: LifecycleHook | None = (
            (lambda c: self._fire(self._session_end_hooks, c))
            if self._session_end_hooks
            else None
        )

        subject_token = await self.config.asubject_token()
        invalidate = (
            self.config.exchanger.invalidate
            if self.config.exchanger is not None
            else None
        )

        async with session(
            coordinator=self.config.coordinator,
            zone_id=self.config.zone_id,
            application_id=self.config.application_id,
            subject_token=subject_token,
            token_source=self.config._token_source,
            invalidate=invalidate,
            subject_authority_record_id=subject_authority_record_id,
            parent_session_id=parent_session_id,
            parent_ctx=parent_ctx,
            authority=authority,
            ttl_seconds=(
                ttl_seconds
                if ttl_seconds is not None
                else self.config.default_ttl_seconds
            ),
            metadata=_task_metadata(task, metadata),
            labels=labels,
            trace_id=trace_id,
            idempotency_key=idempotency_key,
            on_session_start=on_start,
            on_session_end=on_end,
        ) as ctx:
            yield ctx

    async def start_session(
        self,
        *,
        authority: Authority | None = None,
        ttl_seconds: int | None = None,
        subject_authority_record_id: str | None = None,
        parent_session_id: str | None = None,
        parent_ctx: CaracalContext | None = None,
        task: str | None = None,
        metadata: JsonObject | None = None,
        labels: list[str] | None = None,
        trace_id: str | None = None,
        idempotency_key: str | None = None,
        heartbeat_interval: float | None = None,
        on_lease_lost: Callable[[BaseException], None] | None = None,
        on_state_change: Callable[[str], None] | None = None,
    ) -> SessionHandle:
        """Start a governed session that outlives a block and return a handle
        the caller owns.

        Unlike :meth:`session`, the session is not retired when a block exits:
        a background task renews the lease by default and the handle is
        retired with :meth:`SessionHandle.aclose`. Use for daemons and workers
        that outlive a single request. Pass
        ``authority=Authority.narrow([...])`` to bound the handle to a subset
        of scopes. Leave ``heartbeat_interval`` unset to derive the renewal
        cadence from the server lease, pass a positive value to fix it, or
        zero to renew manually; ``on_lease_lost`` fires once if the
        coordinator reports the session permanently gone;
        ``on_session_end`` hooks registered on the client run inside
        :meth:`SessionHandle.aclose` before the session terminates."""
        on_start: LifecycleHook | None = (
            (lambda c: self._fire(self._session_start_hooks, c))
            if self._session_start_hooks
            else None
        )
        on_end: LifecycleHook | None = (
            (lambda c: self._fire(self._session_end_hooks, c))
            if self._session_end_hooks
            else None
        )

        subject_token = await self.config.asubject_token()
        invalidate = (
            self.config.exchanger.invalidate
            if self.config.exchanger is not None
            else None
        )

        return await start_session(
            coordinator=self.config.coordinator,
            zone_id=self.config.zone_id,
            application_id=self.config.application_id,
            subject_token=subject_token,
            token_source=self.config._token_source,
            invalidate=invalidate,
            subject_authority_record_id=subject_authority_record_id,
            parent_session_id=parent_session_id,
            parent_ctx=parent_ctx,
            authority=authority,
            ttl_seconds=ttl_seconds,
            metadata=_task_metadata(task, metadata),
            labels=labels,
            trace_id=trace_id,
            idempotency_key=idempotency_key,
            heartbeat_interval=heartbeat_interval,
            on_lease_lost=on_lease_lost,
            on_state_change=on_state_change,
            on_session_start=on_start,
            on_session_end=on_end,
        )

    async def attach_session(
        self,
        session_id: str,
        *,
        heartbeat_interval: float | None = None,
        on_lease_lost: Callable[[BaseException], None] | None = None,
        on_state_change: Callable[[str], None] | None = None,
    ) -> SessionHandle:
        """Re-attach to a service session that already exists - typically
        after a process restart, using a session id the previous holder
        persisted from :meth:`start_session`. The session is validated with an
        immediate lease renewal (a session the coordinator no longer holds
        live fails with :class:`CoordinatorError`), and the returned handle
        renews and retires it exactly like one from :meth:`start_session`.
        Delegations bound by the previous holder are re-presented with
        :meth:`accept_delegation`."""
        on_end: LifecycleHook | None = (
            (lambda c: self._fire(self._session_end_hooks, c))
            if self._session_end_hooks
            else None
        )
        zone_id, application_id = self.identity()
        return await attach_session(
            coordinator=self.config.coordinator,
            zone_id=zone_id,
            application_id=application_id,
            subject_token=await self.config.asubject_token(),
            session_id=session_id,
            token_source=self.config._token_source,
            invalidate=(
                self.config.exchanger.invalidate
                if self.config.exchanger is not None
                else None
            ),
            heartbeat_interval=heartbeat_interval,
            on_lease_lost=on_lease_lost,
            on_state_change=on_state_change,
            on_session_end=on_end,
        )

    async def delegate(
        self,
        *,
        to_session_id: str,
        to_application_id: str,
        scopes: list[str],
        resource_id: str | None = None,
        constraints: DelegationConstraints | None = None,
        ttl_seconds: int | None = None,
    ) -> Delegation:
        """Delegate a slice of the bound session's authority to a peer session.

        The caller is the issuer and its own context is unchanged; hand the
        returned ``delegation_id`` to the receiving session, which presents
        the delegation with :meth:`accept_delegation`."""
        return await delegate(
            coordinator=self.config.coordinator,
            to_session_id=to_session_id,
            to_application_id=to_application_id,
            resource_id=resource_id,
            scopes=scopes,
            constraints=constraints,
            ttl_seconds=ttl_seconds,
        )

    @asynccontextmanager
    async def accept_delegation(
        self, delegation_id: str, *, validate: bool = False
    ) -> AsyncGenerator[CaracalContext, None]:
        """Present a delegation issued to the bound session: binds a derived
        context carrying the delegation for the duration of the block. Pass
        ``validate=True`` to confirm with the coordinator that the delegation
        is live for the bound session before presenting it, at the cost of
        one control-plane call."""
        ctx = current()
        if ctx is None:
            raise RuntimeError(
                "accept_delegation requires a Caracal context bound on this path"
            )
        start = time.monotonic()

        def emit(ok: bool) -> None:
            self._emit_event(
                CaracalEvent(
                    type="delegation.accept",
                    ok=ok,
                    duration_ms=(time.monotonic() - start) * 1000.0,
                    delegation_id=delegation_id,
                    session_id=ctx.session_id or "",
                )
            )

        if validate:
            if not ctx.session_id:
                raise RuntimeError(
                    "accept_delegation validation requires an active session in context"
                )
            inbound = await list_inbound_delegations(
                self.config.coordinator, ctx.subject_token, ctx.zone_id, ctx.session_id
            )
            match = next((d for d in inbound if d.delegation_id == delegation_id), None)
            if match is None or match.status != "active":
                emit(False)
                raise RuntimeError(
                    f"accept_delegation: delegation {delegation_id} is not live for "
                    f"session {ctx.session_id}; confirm the issuer created it for "
                    "this session and it has not been revoked"
                )
        emit(True)
        accepted = accept_delegation(ctx, delegation_id)
        token = _ctx_var.set(accepted)
        try:
            yield accepted
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
        as_application: bool = False,
        ctx: CaracalContext | None = None,
    ) -> dict[str, str]:
        """Project a Caracal context into outbound HTTP headers: the bound
        contextvar by default, or ``ctx`` when the caller owns the context on
        another task or thread.

        When no context is available this would return the
        bootstrap application subject token. Doing so silently leaks the
        application's own identity from background tasks that escape the
        contextvar (asyncio task groups, thread pools, framework background
        runners). Callers therefore MUST opt in via ``as_application=True``
        when they intentionally want to call as the application's own
        (un-delegated) identity. Bind a child context explicitly with
        :meth:`bind` before fan-out to keep delegation semantics intact.
        """
        if ctx is None:
            ctx = current()
        if ctx is None:
            if not as_application:
                raise RuntimeError(
                    "Caracal.headers(): no CaracalContext is bound to the current "
                    "task. Refusing to fall back to the bootstrap subject token. "
                    "Bind a child context with `async with caracal.bind(parent_ctx):` "
                    "before fan-out, or pass `as_application=True` to explicitly "
                    "call as the application's own identity."
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
        as_application: bool = False,
        ctx: CaracalContext | None = None,
    ) -> dict[str, str]:
        """Async counterpart to :meth:`headers`: resolves refreshable tokens on
        a worker thread so an STS exchange never blocks the event loop."""
        if ctx is None:
            ctx = current()
        if ctx is None or (ctx.own_token and self.config._token_source is not None):
            token = await self.config.asubject_token()
            if ctx is None:
                if not as_application:
                    raise RuntimeError(
                        "Caracal.aheaders(): no CaracalContext is bound to the current "
                        "task. Refusing to fall back to the bootstrap subject token. "
                        "Bind a child context with `async with caracal.bind(parent_ctx):` "
                        "before fan-out, or pass `as_application=True` to explicitly "
                        "call as the application's own identity."
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
        as_application: bool = False,
        verifier: TokenVerifier | None = None,
    ) -> AsyncGenerator[CaracalContext, None]:
        if (
            verifier is None
            and not self._unverified_boundary_warned
            and _production_env(os.environ)
        ):
            self._unverified_boundary_warned = True
            logging.getLogger("caracalai").warning(
                "caracal: inbound context is being bound without a verifier in "
                "production; the envelope is propagation-only - pass verifier= "
                "or keep this boundary behind a verifier such as the Gateway or "
                "caracalai_identity"
            )

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
            if not as_application:
                raise MissingTokenError(
                    "Caracal.bind_from_headers(): inbound request is missing a bearer token. "
                    "Pass as_application=True only for trusted ingress that should "
                    "run as the application's own identity."
                )
            env.subject_token = await self.config.asubject_token()
            root_injected = True
        elif verifier is not None:
            claims = await verifier(env.subject_token)
        if claims is not None:
            if claims.session_id is not None:
                env.session_id = claims.session_id
            if claims.delegation_id is not None:
                env.delegation_id = claims.delegation_id
            if claims.parent_delegation_id is not None:
                env.parent_delegation_id = claims.parent_delegation_id
            if claims.subject_authority_record_id is not None:
                env.subject_authority_record_id = claims.subject_authority_record_id
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
        client, and the coordinator's HTTP client, and drop cached application
        mandates so nothing stale is served after shutdown. The sessions
        backing released application transports are terminated best-effort -
        any that termination misses retire on their own TTL. Idempotent."""
        for client in self._fetch_clients.values():
            if not client.is_closed:
                await client.aclose()
        self._fetch_clients.clear()
        with self._app_mandate_guard:
            self._app_generation += 1
            entries = [e for e in self._app_mandates.values() if e.sessions]
            self._app_mandates.clear()
            locks = [record[0] for record in self._app_mandate_locks.values()]
        for lock in locks:
            await asyncio.to_thread(lock.acquire)
            lock.release()
        with self._app_mandate_guard:
            self._app_mandate_locks.clear()
        exchanger = self.config.exchanger
        if exchanger is not None and entries:
            try:
                zone_id, _ = exchanger.identity()
                bootstrap = (
                    await asyncio.to_thread(
                        exchanger.mint_mandate,
                        resource=entries[0].resource_id,
                        scopes=[LIFECYCLE_SCOPE],
                    )
                ).token
                for entry in entries:
                    for session_id in entry.sessions:
                        with suppress(Exception):
                            await asyncio.to_thread(
                                sync_terminate_session,
                                self.config.coordinator,
                                exchanger._http,
                                bootstrap,
                                zone_id,
                                session_id,
                            )
            except Exception:
                logging.getLogger("caracalai").warning(
                    "close could not retire application-transport sessions; "
                    "the coordinator TTL sweeper will",
                    exc_info=True,
                )
        if exchanger is not None:
            exchanger.invalidate()
            await exchanger.aclose()
        await self.config.coordinator.aclose()

    def context_middleware(
        self,
        *,
        as_application: bool = False,
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

            caracal = Caracal()
            app = FastAPI()

            async def verify(token: str) -> None:
                await verify_token(
                    token, issuer=ISSUER, audience=AUDIENCE, expected_zone_id=ZONE_ID
                )

            app.add_middleware(caracal.context_middleware(verifier=verify))
        """
        from .http import CaracalASGIMiddleware

        outer = self

        def factory(app: ASGIApp) -> CaracalASGIMiddleware:
            return CaracalASGIMiddleware(
                app, outer, as_application=as_application, verifier=verifier
            )

        return factory

    def transport(
        self,
        *,
        as_application: bool = False,
        ctx: CaracalContext | None = None,
        scopes: list[str] | None = None,
        propagation: str = "always",
        **kwargs: Any,
    ) -> httpx.AsyncClient:
        """Returns an httpx.AsyncClient that auto-injects the envelope on every request
        and rewrites resource-bound calls through the configured Caracal gateway. Pass
        to any provider SDK that accepts a custom httpx client.

        Per-request identity is taken from the bound :class:`CaracalContext`, or from
        ``ctx`` when the caller owns the context on another task or thread. If a
        request fires with no context available, the call raises ``RuntimeError``
        unless the transport was created with ``as_application=True`` (the
        application's own identity).

        Pass ``scopes`` to send a scoped resource mandate instead of the raw subject
        token on gateway-routed requests: the SDK mints (and caches) a mandate
        audienced to the target resource and narrowed to those scopes, carrying the
        context's session and delegation. Requires client-secret credentials.

        ``propagation="gateway-only"`` keeps the Caracal context envelope off
        requests to hosts that are not gateway-routed, for transports that also
        talk to third parties which must not see caracal.* correlation ids.

        The client keeps httpx's default 5-second timeout; pass ``timeout=`` to
        size it for the upstream being called.
        """
        return httpx.AsyncClient(
            auth=self._gateway_auth(
                as_application=as_application,
                ctx=ctx,
                scopes=scopes,
                propagation=propagation,
                label="transport",
            ),
            **kwargs,
        )

    def _gateway_auth(
        self,
        *,
        as_application: bool,
        ctx: CaracalContext | None,
        scopes: list[str] | None,
        label: str,
        propagation: str = "always",
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
                if bound is None and not as_application:
                    raise RuntimeError(
                        f"Caracal.{label}(): request fired with no CaracalContext "
                        "bound. Bind a child context, pass `ctx=`, or opt in with "
                        "`as_application=True`."
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
                if propagation == "gateway-only" and not gateway_bound:
                    return
                env = to_envelope(bound) if bound is not None else Envelope(hop=0)
                encode_envelope(
                    env,
                    lambda n, v: request.headers.__setitem__(n, v),
                    lambda n: request.headers.get(n),
                )

            def sync_auth_flow(self, request: httpx.Request):
                bound, resource, gateway_bound = self._begin(request)
                token = (
                    outer.config.exchanger.mint_mandate(
                        resource=resource,
                        scopes=scopes,
                        session_id=bound.session_id if bound else None,
                        delegation_id=bound.delegation_id if bound else None,
                        cache=False,
                    ).token
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
                if resource is not None and scopes and outer.config.exchanger is None:
                    raise RuntimeError(
                        f"Caracal.{label}(): scopes require client-secret credentials"
                    )
                token = (
                    (
                        await asyncio.to_thread(
                            outer.config.exchanger.mint_mandate,
                            resource=resource,
                            scopes=scopes,
                            session_id=bound.session_id if bound else None,
                            delegation_id=bound.delegation_id if bound else None,
                            cache=False,
                        )
                    ).token
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

    def gateway_request(self, resource_id: str, path: str = "/") -> GatewayTarget:
        if not self.config.gateway_url:
            raise RuntimeError("Caracal.gateway_request: gateway_url is not configured")
        if not resource_id.strip():
            raise ValueError("Caracal.gateway_request: resource_id is required")
        return GatewayTarget(
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
    ) -> MintedMandate:
        """Mint a resource mandate for the current session: a short-lived token
        audienced to ``resource_id`` and narrowed to ``scopes``, carrying the
        session and delegation of the bound :class:`CaracalContext` (or
        ``ctx`` when the caller owns the context on another task or thread).
        The STS evaluates policy against that session's authority, so a
        narrowed child can mint only what its delegation allows. Results are
        cached per resource, scope set, and session identity, and refreshed
        before expiry. Returns the mandate token with its remaining lifetime.

        When a scope is approval-gated the mint raises
        :class:`caracalai.ApprovalRequired`; retry with ``approval_id`` set to
        the returned approval id once an authenticated approver has satisfied
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
        try:
            return exchanger.mint_mandate(
                resource=resource_id,
                scopes=scopes,
                session_id=bound.session_id if bound else None,
                delegation_id=bound.delegation_id if bound else None,
                ttl_seconds=ttl_seconds,
                approval_id=approval_id,
            )
        except CaracalError as err:
            raise _lifecycle_authority_hint(err, bound)

    def federate_subject(
        self, id_token: str, *, ttl_seconds: int | None = None
    ) -> FederatedSubject:
        """Exchange an end user's identity token from a zone-trusted external
        issuer for the Subject's Caracal Authority record. The returned
        ``subject_authority_record_id`` anchors governed work to that user
        (``session(subject_authority_record_id=...)``), and the returned token is the
        user's own mandate for user-facing flows such as approval decisions.
        Never cached: each federation is an explicit identity event, recorded
        in the audit stream. Requires client-secret credentials and a subject
        issuer registered on the zone."""
        exchanger = self.config.exchanger
        if exchanger is None:
            raise RuntimeError(
                "Caracal.federate_subject requires client-secret credentials; "
                "build the client with from_client_secret, from_config, or "
                "CARACAL_APP_CLIENT_SECRET."
            )
        minted = exchanger.federate_subject(id_token, ttl_seconds=ttl_seconds)
        payload = decode_jwt_payload(minted.token) or {}
        authority_record_id = payload.get("sid")
        if not isinstance(authority_record_id, str) or not authority_record_id:
            raise RuntimeError(
                "Caracal.federate_subject: the minted Subject mandate carries "
                "no authority record ID"
            )
        return FederatedSubject(
            subject_authority_record_id=authority_record_id,
            token=minted.token,
            expires_in_seconds=minted.expires_in_seconds,
        )

    def wait_for_approval(
        self, approval_id: str, *, timeout_seconds: float = 300.0
    ) -> ApprovalState:
        """Long-poll the approval raised by an approval-gated
        :meth:`mint_mandate` until an approver decides it, it expires, or the
        timeout elapses. Returns the final lifecycle state: ``approved`` means
        a retry with ``approval_id`` will mint; ``rejected``, ``expired``, and
        ``consumed`` are terminal; ``pending`` means the timeout elapsed with
        no decision.

        Requires client-secret credentials."""
        exchanger = self.config.exchanger
        if exchanger is None:
            raise RuntimeError(
                "Caracal.wait_for_approval requires client-secret credentials; "
                "build the client with from_client_secret, from_config, or "
                "CARACAL_APP_CLIENT_SECRET."
            )
        return exchanger.wait_for_approval(approval_id, timeout_seconds=timeout_seconds)

    async def with_approval(
        self,
        fn: Callable[[str | None], Awaitable[_T]],
        *,
        timeout_seconds: float = 300.0,
    ) -> _T:
        """Run an approval-gated operation end to end. ``fn`` is invoked once
        with ``None``; when it raises :class:`caracalai.ApprovalRequired` the
        client long-polls the challenge and, on approval, invokes ``fn`` again
        with the approval id so the retried mint consumes the decision. Any
        other outcome (rejected, expired, consumed, or the wait timing out)
        re-raises the original :class:`ApprovalRequired`, whose
        ``approval_id`` lets the caller resume the wait later.

            mandate = await caracal.with_approval(
                lambda approval_id: asyncio.to_thread(
                    caracal.mint_mandate,
                    "resource://pipernet",
                    ["funds:transfer"],
                    approval_id=approval_id,
                )
            )
        """
        try:
            return await fn(None)
        except ApprovalRequired as err:
            exchanger = self.config.exchanger
            assert exchanger is not None
            state = await exchanger.await_approval(
                err.approval_id, timeout_seconds=timeout_seconds
            )
            if state != "approved":
                raise
            return await fn(err.approval_id)

    async def fetch(
        self,
        resource_id: str,
        path: str = "/",
        *,
        method: str = "GET",
        headers: Mapping[str, str] | None = None,
        as_application: bool = False,
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

        Requests reuse a pooled client per ``(as_application, scopes)`` shape, so
        repeated fetches share connections. ``aclose()`` releases the pool.
        httpx's default 5-second timeout applies; pass ``timeout=`` per request
        to size it for the upstream.
        """
        request = self.gateway_request(resource_id, path)
        merged = {**(headers or {}), **request.headers}
        if transport is not None:
            async with self.transport(
                as_application=as_application,
                ctx=ctx,
                scopes=scopes,
                transport=transport,
            ) as client:
                return await client.request(
                    method, request.url, headers=merged, **request_kwargs
                )
        key = (as_application, tuple(sorted(set(scopes))) if scopes else None)
        client = self._fetch_clients.get(key)
        if client is None or client.is_closed:
            client = self.transport(as_application=as_application, scopes=scopes)
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
        as_application: bool = False,
        ctx: CaracalContext | None = None,
        scopes: list[str] | None = None,
        propagation: str = "always",
        **kwargs: Any,
    ) -> httpx.Client:
        """Sync counterpart to transport(): returns an httpx.Client that auto-injects
        the envelope on every request and rewrites resource-bound calls through the
        configured Caracal gateway. Use with sync httpx-based SDKs.

        See :meth:`transport` for the ``as_application``, ``ctx``, ``scopes``,
        and ``propagation`` semantics.
        """
        return httpx.Client(
            auth=self._gateway_auth(
                as_application=as_application,
                ctx=ctx,
                scopes=scopes,
                propagation=propagation,
                label="sync_transport",
            ),
            **kwargs,
        )

    def application_transport(
        self,
        resource_id: str,
        *,
        scopes: list[str],
        labels: list[str] | None = None,
        mandate_ttl_seconds: int | None = None,
        **kwargs: Any,
    ) -> httpx.AsyncClient:
        """Returns an httpx.AsyncClient pinned to one resource, calling as the
        application's own identity rather than a bound session context: the
        SDK starts a source and target session, delegates ``scopes`` between
        them constrained to ``resource_id``, and mints the mandate against
        that delegation, so every call is attributable to a live, bounded
        session even with no inbound context. Requests to the resource's bound
        upstream (or any absolute URL) are rewritten through the configured
        gateway; requests already addressed to the gateway pass through.

        Authority state is cached per application identity, resource, scope
        set, effective labels, and mandate TTL. Every request mints a fresh
        replay-protected mandate against that cached session/delegation pair;
        concurrent requests share provisioning but never a bearer.
        ``labels`` tag the started sessions (default: the application id).
        ``mandate_ttl_seconds`` bounds each mandate; sessions outlive it by a
        fixed buffer.

        Requires client-secret credentials."""
        return httpx.AsyncClient(
            auth=self._app_auth(
                resource_id,
                scopes=scopes,
                labels=labels,
                mandate_ttl_seconds=mandate_ttl_seconds,
                label="application_transport",
            ),
            **kwargs,
        )

    def sync_application_transport(
        self,
        resource_id: str,
        *,
        scopes: list[str],
        labels: list[str] | None = None,
        mandate_ttl_seconds: int | None = None,
        **kwargs: Any,
    ) -> httpx.Client:
        """Sync counterpart to :meth:`application_transport`: returns an
        httpx.Client authorizing every request with a mandate minted under the
        application's own identity. See :meth:`application_transport` for the
        cycle, caching, and routing semantics."""
        return httpx.Client(
            auth=self._app_auth(
                resource_id,
                scopes=scopes,
                labels=labels,
                mandate_ttl_seconds=mandate_ttl_seconds,
                label="sync_application_transport",
            ),
            **kwargs,
        )

    def _app_auth(
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
            else APP_MANDATE_TTL_SECONDS
        )
        outer = self

        class _AppAuth(httpx.Auth):
            requires_request_body = False

            def _finish(self, request: httpx.Request, mandate: str) -> None:
                request.headers["Authorization"] = f"Bearer {mandate}"
                request.headers["X-Caracal-Resource"] = resource_id
                rewritten = outer._route_through_gateway(request.url, resource_id)
                if rewritten is not None:
                    request.url = httpx.URL(rewritten[0])
                    request.headers["host"] = request.url.netloc.decode("ascii")

            def sync_auth_flow(self, request: httpx.Request):
                authority = outer._app_mandate(
                    resource_id, granted, labels, mandate_ttl
                )
                mandate = outer.config.exchanger.mint_mandate(
                    resource=resource_id,
                    scopes=granted,
                    session_id=authority.target_session_id,
                    delegation_id=authority.delegation_id,
                    ttl_seconds=mandate_ttl,
                    cache=False,
                ).token
                self._finish(request, mandate)
                yield request

            async def async_auth_flow(self, request: httpx.Request):
                authority = await asyncio.to_thread(
                    outer._app_mandate, resource_id, granted, labels, mandate_ttl
                )
                mandate = (
                    await asyncio.to_thread(
                        outer.config.exchanger.mint_mandate,
                        resource=resource_id,
                        scopes=granted,
                        session_id=authority.target_session_id,
                        delegation_id=authority.delegation_id,
                        ttl_seconds=mandate_ttl,
                        cache=False,
                    )
                ).token
                self._finish(request, mandate)
                yield request

        return _AppAuth()

    def _app_mandate_cached(self, key: str) -> _AppAuthority | None:
        with self._app_mandate_guard:
            cached = self._app_mandates.get(key)
            if (
                cached is not None
                and cached.expires_at - time.time()
                > APP_AUTHORITY_REFRESH_MARGIN_SECONDS
            ):
                return cached
        return None

    def _app_mandate_lock(self, key: str) -> threading.Lock:
        with self._app_mandate_guard:
            record = self._app_mandate_locks.get(key)
            lock = record[0] if record is not None else threading.Lock()
            self._app_mandate_locks[key] = (lock, (record[1] if record else 0) + 1)
            return lock

    def _release_app_mandate_lock(self, key: str, lock: threading.Lock) -> None:
        with self._app_mandate_guard:
            record = self._app_mandate_locks.get(key)
            if record is None or record[0] is not lock:
                return
            if record[1] == 1:
                del self._app_mandate_locks[key]
            else:
                self._app_mandate_locks[key] = (lock, record[1] - 1)

    def _app_mandate(
        self,
        resource_id: str,
        scopes: list[str],
        labels: list[str] | None,
        mandate_ttl: int,
    ) -> _AppAuthority:
        exchanger = self.config.exchanger
        assert exchanger is not None
        zone_id, application_id = exchanger.identity()
        credential_generation = exchanger.credential_generation()
        session_labels = labels if labels else [application_id]
        encoded_labels = json.dumps(session_labels, separators=(",", ":"))
        with self._app_mandate_guard:
            generation = self._app_generation
            now = time.time()
            stale_keys = [
                key
                for key, entry in self._app_mandates.items()
                if entry.expires_at <= now
                or (
                    entry.zone_id == zone_id
                    and entry.application_id == application_id
                    and entry.credential_generation != credential_generation
                )
            ]
            stale = [self._app_mandates.pop(key) for key in stale_keys]
        for entry in stale:
            self._retire_app_authority(entry)
        key = (
            f"{generation}::{zone_id}::{application_id}::"
            f"{credential_generation}::"
            f"{resource_id}::{' '.join(scopes)}::"
            f"{encoded_labels}::{mandate_ttl}"
        )
        cached = self._app_mandate_cached(key)
        if cached is not None:
            return cached
        lock = self._app_mandate_lock(key)
        try:
            with lock:
                cached = self._app_mandate_cached(key)
                if cached is not None:
                    return cached
                with self._app_provision:
                    authority = self._app_mandate_cycle(
                        zone_id,
                        application_id,
                        credential_generation,
                        resource_id,
                        scopes,
                        labels,
                        mandate_ttl,
                    )
                evicted: list[_AppAuthority] = []
                with self._app_mandate_guard:
                    if generation != self._app_generation:
                        evicted.append(authority)
                    else:
                        self._app_mandates[key] = authority
                    if len(self._app_mandates) > APP_AUTHORITY_CACHE_CAP:
                        now = time.time()
                        for k in [
                            k
                            for k, v in self._app_mandates.items()
                            if v.expires_at <= now and k != key
                        ]:
                            evicted.append(self._app_mandates.pop(k))
                        while len(self._app_mandates) > APP_AUTHORITY_CACHE_CAP:
                            evicted_key = next(iter(self._app_mandates))
                            if evicted_key == key:
                                break
                            evicted.append(self._app_mandates.pop(evicted_key))
                for entry in evicted:
                    self._retire_app_authority(entry)
                return authority
        finally:
            self._release_app_mandate_lock(key, lock)

    def _app_mandate_cycle(
        self,
        zone_id: str,
        application_id: str,
        credential_generation: str,
        resource_id: str,
        scopes: list[str],
        labels: list[str] | None,
        mandate_ttl: int,
    ) -> _AppAuthority:
        exchanger = self.config.exchanger
        assert exchanger is not None
        session_ttl = mandate_ttl + APP_SESSION_TTL_BUFFER_SECONDS
        bootstrap = exchanger.mint_mandate(
            resource=resource_id, scopes=[LIFECYCLE_SCOPE]
        ).token
        coordinator = self.config.coordinator
        http = exchanger._http
        session_labels = labels if labels else [application_id]
        sessions: list[str] = []
        try:
            source = sync_start_coordinator_session(
                coordinator,
                http,
                bootstrap,
                StartSessionRequest(
                    zone_id=zone_id,
                    application_id=application_id,
                    ttl_seconds=session_ttl,
                    labels=session_labels,
                    idempotency_key=str(uuid.uuid4()),
                ),
            )
            sessions.append(source.session_id)
            target = sync_start_coordinator_session(
                coordinator,
                http,
                bootstrap,
                StartSessionRequest(
                    zone_id=zone_id,
                    application_id=application_id,
                    ttl_seconds=session_ttl,
                    labels=session_labels,
                    idempotency_key=str(uuid.uuid4()),
                ),
            )
            sessions.append(target.session_id)
            edge = sync_create_delegation(
                coordinator,
                http,
                bootstrap,
                DelegationRequest(
                    zone_id=zone_id,
                    issuer_application_id=application_id,
                    source_session_id=source.session_id,
                    target_session_id=target.session_id,
                    receiver_application_id=application_id,
                    scopes=list(scopes),
                    constraints=DelegationConstraints(resources=[resource_id]),
                    ttl_seconds=session_ttl,
                ),
            )
            return _AppAuthority(
                resource_id=resource_id,
                zone_id=zone_id,
                application_id=application_id,
                credential_generation=credential_generation,
                target_session_id=target.session_id,
                delegation_id=edge.delegation_id,
                expires_at=time.time() + session_ttl,
                sessions=tuple(sessions),
            )
        except BaseException:
            for session_id in sessions:
                with suppress(Exception):
                    sync_terminate_session(
                        coordinator, http, bootstrap, zone_id, session_id
                    )
            raise

    def _retire_app_authority(self, authority: _AppAuthority) -> None:
        exchanger = self.config.exchanger
        assert exchanger is not None
        try:
            bootstrap = exchanger.mint_mandate(
                resource=authority.resource_id, scopes=[LIFECYCLE_SCOPE]
            ).token
            for session_id in authority.sessions:
                with suppress(Exception):
                    sync_terminate_session(
                        self.config.coordinator,
                        exchanger._http,
                        bootstrap,
                        authority.zone_id,
                        session_id,
                    )
        except Exception:
            logging.getLogger("caracalai").warning(
                "could not retire application-transport sessions; the coordinator TTL sweeper will",
                exc_info=True,
            )

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


def _task_metadata(task: str | None, metadata: JsonObject | None) -> JsonObject | None:
    """Folds the task option into session metadata; an explicit task wins over
    a metadata.task the caller also set."""
    if task is None:
        return metadata
    return {**(metadata or {}), "task": task}


def _lifecycle_authority_hint(
    err: CaracalError, ctx: CaracalContext | None
) -> CaracalError:
    """A policy deny for a session that carries no delegation is almost always
    the lifecycle-only-authority trap: under the platform decision contract,
    resource mandates only mint over a delegation. Attach the remediation so
    the developer does not need the policy model to decode the deny."""
    if err.code != "access_denied" or ctx is None:
        return err
    if not ctx.session_id or ctx.delegation_id:
        return err
    err.add_note(
        "hint: the bound session has no delegation, so it holds lifecycle-only "
        "authority; narrow the session with Authority.narrow, accept one with "
        "accept_delegation, or call as the application with application_transport "
        "(decision contract: https://docs.caracal.run/concepts/policy/)"
    )
    return err


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
    # Dot segments could climb out of a base-pathed gateway once the URL
    # normalizes, so the path must arrive already resolved.
    if any(segment in (".", "..") for segment in pathname.split("/")):
        raise ValueError("Caracal.gateway_request: path must not contain dot segments")
    base_path = gw.path.rstrip("/")
    return urlunparse((gw.scheme, gw.netloc, base_path + pathname, "", query, ""))
