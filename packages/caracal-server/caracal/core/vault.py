"""
Caracal vault client backed by Infisical-compatible HTTP APIs.

Hard-cut requirements:
- secret storage and retrieval are delegated to vault APIs only
- no in-process secret storage backends
- local mode is forbidden when hardcut mode is enabled
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4

import httpx

from caracal.core.vault_key_material import generate_asymmetric_keypair_pem

from caracal.logging_config import get_logger

logger = get_logger(__name__)

_RATE_LIMIT_WINDOW = 60.0
_RATE_LIMIT_DEFAULT = 120
_HEALTH_CACHE_TTL_SECONDS = 15.0
_LOCAL_MODE_VALUES = {"local", "dev", "development"}
_MANAGED_MODE_VALUES = {"managed", "cloud"}
_RETRYABLE_STATUS_CODES = {429, 503}
_LOCAL_BOOTSTRAP_TOKEN_MARKERS = {"dev-local-token", "enterprise-local-token"}
_LOCAL_BOOTSTRAP_VAULT_HOSTS = {"localhost", "127.0.0.1", "vault"}


def _truncate_detail(detail: str, limit: int = 300) -> str:
    normalized = (detail or "").strip()
    if not normalized:
        return ""
    if len(normalized) <= limit:
        return normalized
    return normalized[:limit] + "..."


def _json_object(response: httpx.Response) -> dict[str, Any]:
    if not response.content:
        return {}
    try:
        payload = response.json()
    except ValueError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _extract_string(payload: dict[str, Any], *paths: tuple[str, ...]) -> Optional[str]:
    for path in paths:
        cursor: Any = payload
        found = True
        for key in path:
            if isinstance(cursor, dict) and key in cursor:
                cursor = cursor[key]
            else:
                found = False
                break
        if found and isinstance(cursor, str) and cursor.strip():
            return cursor.strip()
    return None


def _is_local_bootstrap_token(token: str) -> bool:
    return (token or "").strip().lower() in _LOCAL_BOOTSTRAP_TOKEN_MARKERS


def _is_local_bootstrap_vault_url(base_url: str) -> bool:
    try:
        parsed = urllib.parse.urlparse((base_url or "").strip())
    except Exception:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    host = (parsed.hostname or "").strip().lower()
    return host in _LOCAL_BOOTSTRAP_VAULT_HOSTS


def _save_recovered_vault_token(token: str) -> None:
    """Persist a machine identity token to CARACAL_HOME/.env for future sidecar restarts."""
    caracal_home = os.environ.get("CARACAL_HOME", "").strip()
    if not caracal_home:
        return
    env_path = Path(caracal_home) / ".env"
    key = "CARACAL_VAULT_RECOVERED_IDENTITY_TOKEN"
    try:
        existing = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
        lines = existing.splitlines(keepends=True)
        replaced = False
        new_lines: list[str] = []
        for line in lines:
            stripped = line.strip()
            if "=" in stripped and stripped.split("=", 1)[0].strip() == key:
                new_lines.append(f"{key}={token}\n")
                replaced = True
            else:
                new_lines.append(line)
        if not replaced:
            if new_lines and not new_lines[-1].endswith("\n"):
                new_lines.append("\n")
            new_lines.append(f"{key}={token}\n")
        env_path.write_text("".join(new_lines), encoding="utf-8")
        logger.debug("Saved recovered vault identity token to %s", env_path)
    except Exception as exc:
        logger.debug("Could not persist recovered vault token to %s: %s", env_path, exc)


def _resolve_local_sidecar_token_and_project(
    *,
    base_url: str,
    current_project: str,
) -> tuple[str, str]:
    email = (
        _read_env_or_dotenv("CARACAL_VAULT_BOOTSTRAP_EMAIL")
        or "admin@caracal.local"
    ).strip()
    password = (
        _read_env_or_dotenv("CARACAL_VAULT_BOOTSTRAP_PASSWORD")
        or "CaracalVaultDev123!"
    ).strip()
    desired_org = (
        _read_env_or_dotenv("CARACAL_VAULT_BOOTSTRAP_ORGANIZATION")
        or "caracal-local"
    ).strip()
    desired_project_slug = (
        current_project
        or _read_env_or_dotenv("CARACAL_VAULT_BOOTSTRAP_PROJECT_SLUG")
        or "caracal"
    ).strip()

    if not email or not password:
        raise VaultConfigurationError(
            "Local vault bootstrap credentials are incomplete. "
            "Set CARACAL_VAULT_BOOTSTRAP_EMAIL and CARACAL_VAULT_BOOTSTRAP_PASSWORD."
        )

    headers = {"Content-Type": "application/json"}
    with httpx.Client(
        base_url=base_url.rstrip("/"),
        timeout=httpx.Timeout(10.0),
    ) as bootstrap_client:
        bootstrap_response = bootstrap_client.post(
            "/api/v1/admin/bootstrap",
            json={
                "email": email,
                "password": password,
                "organization": desired_org,
            },
            headers=headers,
        )
        if bootstrap_response.status_code not in {200, 201, 400, 404, 409}:
            raise VaultConfigurationError(
                "Local vault bootstrap failed: "
                f"{bootstrap_response.status_code} {_truncate_detail(bootstrap_response.text)}"
            )

        # ── MACHINE IDENTITY TOKEN ────────────────────────────────────────────
        # Infisical v0.159+ returns a machine identity token in the bootstrap
        # response (identity.credentials.token) on 200/201.  Use it directly
        # and skip email/password login, which always fails on fresh volumes
        # because Infisical bootstrap populates user_encryption_keys.hashedPassword
        # (SRP) but not users.hashedPassword (bcrypt) that /api/v3/auth/login
        # requires.
        base_token: Optional[str] = None
        bootstrap_org_id: Optional[str] = None

        if bootstrap_response.status_code in {200, 201}:
            bp = _json_object(bootstrap_response)
            identity_obj = bp.get("identity") or {}
            if isinstance(identity_obj, dict):
                creds_obj = identity_obj.get("credentials") or {}
                if isinstance(creds_obj, dict):
                    candidate = (creds_obj.get("token") or "").strip()
                    if candidate:
                        base_token = candidate
                        _save_recovered_vault_token(candidate)
                        logger.info("Vault bootstrap succeeded — using machine identity token.")
            org_obj = bp.get("organization") or {}
            if isinstance(org_obj, dict):
                bootstrap_org_id = (org_obj.get("id") or "").strip() or None

        if base_token is None:
            # Vault already initialised — try a token saved by a previous bootstrap.
            saved = (_read_env_or_dotenv("CARACAL_VAULT_RECOVERED_IDENTITY_TOKEN") or "").strip()
            if saved:
                base_token = saved
                logger.debug("Using saved vault identity token from runtime env.")

        if base_token is None:
            # Final fallback: email/password login (requires users.hashedPassword
            # to be set in the vault DB — may fail on fresh Infisical installs).
            login_response = bootstrap_client.post(
                "/api/v3/auth/login",
                json={"email": email, "password": password},
                headers=headers,
            )
            if login_response.status_code != 200:
                raise VaultConfigurationError(
                    "Local vault login failed during token recovery: "
                    f"{login_response.status_code} {_truncate_detail(login_response.text)}"
                )
            login_payload = _json_object(login_response)
            base_token = _extract_string(
                login_payload,
                ("accessToken",),
                ("access_token",),
                ("token",),
            )
            if base_token is None:
                raise VaultConfigurationError(
                    "Local vault login succeeded but did not return an access token."
                )

        # Resolve organisation ID.  When the bootstrap response already carried
        # the org (fresh-install case) skip the extra API round-trip.
        organization_id: str = bootstrap_org_id or ""
        skip_org_select = False

        if not organization_id:
            org_response = bootstrap_client.get(
                "/api/v1/organization",
                headers={"Authorization": f"Bearer {base_token}"},
            )
            if org_response.status_code == 403:
                # Machine identity tokens are org-scoped and cannot call the org
                # endpoint. Skip org resolution and select-organization entirely.
                logger.debug(
                    "Vault org endpoint returned 403 — assuming machine identity token, "
                    "skipping org resolution."
                )
                skip_org_select = True
            elif org_response.status_code != 200:
                raise VaultConfigurationError(
                    "Failed to resolve local vault organization context: "
                    f"{org_response.status_code} {_truncate_detail(org_response.text)}"
                )
            else:
                org_payload = _json_object(org_response)
                organizations = org_payload.get("organizations")
                if not isinstance(organizations, list) or not organizations:
                    raise VaultConfigurationError(
                        "Local vault organization lookup did not return any organizations."
                    )

                selected_org: Optional[dict[str, Any]] = None
                desired_org_lower = desired_org.lower()
                for organization in organizations:
                    if not isinstance(organization, dict):
                        continue
                    candidates = {
                        str(organization.get("id") or "").strip().lower(),
                        str(organization.get("slug") or "").strip().lower(),
                        str(organization.get("name") or "").strip().lower(),
                    }
                    if desired_org_lower in candidates:
                        selected_org = organization
                        break
                if selected_org is None:
                    selected_org = organizations[0] if isinstance(organizations[0], dict) else None
                if selected_org is None:
                    raise VaultConfigurationError("Unable to resolve a valid local vault organization.")

                organization_id = str(selected_org.get("id") or "").strip()
                if not organization_id:
                    raise VaultConfigurationError("Local vault organization is missing an id.")

        scoped_token: Optional[str] = None
        if skip_org_select:
            scoped_token = base_token
        else:
            select_response = bootstrap_client.post(
                "/api/v3/auth/select-organization",
                json={"organizationId": organization_id},
                headers={
                    "Authorization": f"Bearer {base_token}",
                    "Content-Type": "application/json",
                },
            )
            # Machine identity tokens are already org-scoped; select-organization is
            # a user-session concept and may return non-200 for identity tokens.
            # In that case fall back to using base_token directly.
            if select_response.status_code == 200:
                scoped_payload = _json_object(select_response)
                scoped_token = _extract_string(
                    scoped_payload,
                    ("token",),
                    ("accessToken",),
                    ("access_token",),
                )
            if scoped_token is None:
                logger.debug(
                    "select-organization returned %d — using base token directly.",
                    select_response.status_code,
                )
                scoped_token = base_token

        auth_headers = {"Authorization": f"Bearer {scoped_token}", "Content-Type": "application/json"}

        project_response = bootstrap_client.get("/api/v1/projects", headers=auth_headers)
        if project_response.status_code != 200:
            raise VaultConfigurationError(
                "Failed to resolve local vault project context: "
                f"{project_response.status_code} {_truncate_detail(project_response.text)}"
            )
        projects_payload = _json_object(project_response)
        projects = projects_payload.get("projects")
        if not isinstance(projects, list):
            projects = []

        selected_project: Optional[dict[str, Any]] = None
        desired_project_lower = desired_project_slug.lower()
        for project in projects:
            if not isinstance(project, dict):
                continue
            candidates = {
                str(project.get("id") or "").strip().lower(),
                str(project.get("slug") or "").strip().lower(),
                str(project.get("name") or "").strip().lower(),
            }
            if desired_project_lower in candidates:
                selected_project = project
                break

        if selected_project is None:
            create_response = bootstrap_client.post(
                "/api/v1/projects",
                headers=auth_headers,
                json={
                    "projectName": desired_project_slug.replace("-", " ").title() or "Caracal",
                    "projectDescription": "Caracal OSS runtime project",
                    "slug": desired_project_slug,
                },
            )
            if create_response.status_code in {200, 201}:
                created_payload = _json_object(create_response)
                if isinstance(created_payload.get("project"), dict):
                    selected_project = created_payload["project"]
            elif create_response.status_code == 409:
                refresh_response = bootstrap_client.get("/api/v1/projects", headers=auth_headers)
                if refresh_response.status_code == 200:
                    refreshed_payload = _json_object(refresh_response)
                    refreshed_projects = refreshed_payload.get("projects")
                    if isinstance(refreshed_projects, list):
                        for project in refreshed_projects:
                            if not isinstance(project, dict):
                                continue
                            if str(project.get("slug") or "").strip().lower() == desired_project_lower:
                                selected_project = project
                                break
            else:
                raise VaultConfigurationError(
                    "Failed to create local vault project context: "
                    f"{create_response.status_code} {_truncate_detail(create_response.text)}"
                )

        if selected_project is None:
            raise VaultConfigurationError(
                "Local vault project context is unavailable after bootstrap/login."
            )

        project_id = str(selected_project.get("id") or "").strip()
        if not project_id:
            raise VaultConfigurationError("Local vault project context is missing an id.")

    return scoped_token, project_id


def _read_env_or_dotenv(name: str) -> Optional[str]:
    value = os.environ.get(name)
    if value:
        return value

    candidates: list[Path] = [Path.cwd() / ".env"]

    # CARACAL_HOME/.env is written by bootstrap and vault.py itself at runtime.
    # Must be searched before generic cwd/repo-root paths.
    caracal_home = os.environ.get("CARACAL_HOME", "").strip()
    if caracal_home:
        candidates.insert(0, Path(caracal_home) / ".env")

    try:
        from caracal.flow.workspace import get_workspace

        candidates.append(get_workspace().root / ".env")
    except Exception:
        pass

    repo_root = Path(__file__).resolve().parents[3]
    candidates.extend(
        [
            repo_root / ".env",
            Path(__file__).resolve().parents[2] / ".env",
        ]
    )

    cwd_resolved = Path.cwd().resolve()
    for parent in [cwd_resolved] + list(cwd_resolved.parents):
        candidates.append(parent / ".env")

    seen: set[Path] = set()
    for env_path in candidates:
        try:
            resolved = env_path.resolve()
        except Exception:
            resolved = env_path
        if resolved in seen:
            continue
        seen.add(resolved)

        if not env_path.exists():
            continue

        try:
            for line in env_path.read_text().splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith("#") or "=" not in stripped:
                    continue
                key, raw_value = stripped.split("=", 1)
                if key.strip() != name:
                    continue
                parsed = raw_value.strip()
                if parsed and parsed[0] in ('"', "'") and parsed[-1:] == parsed[0]:
                    parsed = parsed[1:-1]
                elif " #" in parsed:
                    parsed = parsed.split(" #", 1)[0].strip()
                if parsed:
                    return parsed
        except Exception:
            continue

    return None


class VaultError(Exception):
    """Base class for vault errors."""


class GatewayContextRequired(VaultError):
    """Raised when CaracalVault is accessed outside the gateway context."""


class SecretNotFound(VaultError):
    """Raised when a requested secret does not exist."""


class VaultRateLimitExceeded(VaultError):
    """Raised when workspace rate limit is exceeded."""


class VaultConfigurationError(VaultError):
    """Raised when vault configuration is incomplete or invalid."""


class VaultUnavailableError(VaultError):
    """Raised when vault service is unavailable after bounded retries."""


@dataclass
class VaultEntry:
    entry_id: str
    workspace_id: str
    env_id: str
    secret_name: str
    ciphertext_b64: str
    iv_b64: str
    encrypted_dek_b64: str
    dek_iv_b64: str
    key_version: int
    created_at: str
    updated_at: str


@dataclass
class VaultAuditEvent:
    event_id: str
    workspace_id: str
    env_id: str
    secret_name: str
    operation: str
    key_version: int
    actor: str
    timestamp: str
    success: bool
    error_code: Optional[str] = None


@dataclass
class RotationResult:
    secrets_rotated: int
    secrets_failed: int
    new_key_version: int
    duration_seconds: float


@dataclass
class _VaultConfig:
    base_url: str
    token: str
    mode: str
    default_project: str
    default_environment: str
    default_secret_path: str
    hardcut_enabled: bool
    request_timeout_seconds: float
    retry_max_attempts: int
    retry_backoff_seconds: float


def _load_vault_config() -> _VaultConfig:
    base_url = (_read_env_or_dotenv("CARACAL_VAULT_URL") or "").strip()
    token = (_read_env_or_dotenv("CARACAL_VAULT_TOKEN") or "").strip()
    mode = (_read_env_or_dotenv("CARACAL_VAULT_MODE") or "managed").strip().lower()
    default_project = (
        _read_env_or_dotenv("CARACAL_VAULT_WORKSPACE_ID")
        or _read_env_or_dotenv("CARACAL_VAULT_WORKSPACE_SLUG")
        or ""
    ).strip()
    default_environment = (
        _read_env_or_dotenv("CARACAL_VAULT_ENVIRONMENT")
        or _read_env_or_dotenv("CARACAL_VAULT_ENV")
        or "dev"
    ).strip()
    default_secret_path = (_read_env_or_dotenv("CARACAL_VAULT_SECRET_PATH") or "/").strip() or "/"

    hardcut_enabled = True
    retry_attempts_raw = (_read_env_or_dotenv("CARACAL_VAULT_RETRY_MAX_ATTEMPTS") or "3").strip()
    retry_backoff_raw = (_read_env_or_dotenv("CARACAL_VAULT_RETRY_BACKOFF_SECONDS") or "0.2").strip()

    try:
        retry_max_attempts = max(1, int(retry_attempts_raw))
    except ValueError:
        raise VaultConfigurationError(
            "CARACAL_VAULT_RETRY_MAX_ATTEMPTS must be a positive integer."
        )

    try:
        retry_backoff_seconds = max(0.0, float(retry_backoff_raw))
    except ValueError:
        raise VaultConfigurationError(
            "CARACAL_VAULT_RETRY_BACKOFF_SECONDS must be a non-negative number."
        )

    is_local_mode = mode in _LOCAL_MODE_VALUES
    is_managed_mode = mode in _MANAGED_MODE_VALUES
    if not is_local_mode and not is_managed_mode:
        raise VaultConfigurationError(
            "CARACAL_VAULT_MODE must be one of: managed, local, dev, development."
        )

    if is_local_mode:
        raise VaultConfigurationError(
            "CARACAL_VAULT_MODE local/dev is forbidden in runtime paths."
        )

    if token and _is_local_bootstrap_token(token) and _is_local_bootstrap_vault_url(base_url):
        recovered_token, recovered_project = _resolve_local_sidecar_token_and_project(
            base_url=base_url,
            current_project=default_project,
        )
        token = recovered_token
        if recovered_project:
            default_project = recovered_project
            os.environ["CARACAL_VAULT_WORKSPACE_ID"] = recovered_project
        os.environ["CARACAL_VAULT_TOKEN"] = recovered_token

    if not base_url:
        raise VaultConfigurationError("CARACAL_VAULT_URL is required for vault operations.")
    if not token:
        raise VaultConfigurationError("CARACAL_VAULT_TOKEN is required for vault operations.")

    return _VaultConfig(
        base_url=base_url.rstrip("/"),
        token=token,
        mode=mode,
        default_project=default_project,
        default_environment=default_environment,
        default_secret_path=default_secret_path,
        hardcut_enabled=hardcut_enabled,
        request_timeout_seconds=10.0,
        retry_max_attempts=retry_max_attempts,
        retry_backoff_seconds=retry_backoff_seconds,
    )


@dataclass
class _RateBucket:
    tokens: float
    last_refill: float


class _VaultRateLimiter:
    def __init__(self, limit: int = _RATE_LIMIT_DEFAULT, window: float = _RATE_LIMIT_WINDOW):
        self._limit = limit
        self._window = window
        self._buckets: dict[str, _RateBucket] = {}
        self._lock = threading.Lock()

    def check(self, workspace_id: str) -> None:
        with self._lock:
            now = time.monotonic()
            bucket = self._buckets.get(workspace_id)
            if bucket is None:
                self._buckets[workspace_id] = _RateBucket(tokens=self._limit - 1, last_refill=now)
                return
            elapsed = now - bucket.last_refill
            bucket.tokens = min(self._limit, bucket.tokens + elapsed * (self._limit / self._window))
            bucket.last_refill = now
            if bucket.tokens < 1:
                raise VaultRateLimitExceeded(
                    f"Vault rate limit exceeded for workspace {workspace_id}. "
                    f"Limit: {self._limit} requests per {int(self._window)}s."
                )
            bucket.tokens -= 1


_VAULT_ACCESS_CONTEXT_FLAG = threading.local()


def _assert_vault_access_context() -> None:
    if not getattr(_VAULT_ACCESS_CONTEXT_FLAG, "active", False):
        raise GatewayContextRequired(
            "CaracalVault may only be accessed from within an explicit vault access context. "
            "Direct application layer access is forbidden."
        )


class vault_access_context:  # noqa: N801
    def __enter__(self) -> "vault_access_context":
        _VAULT_ACCESS_CONTEXT_FLAG.depth = getattr(_VAULT_ACCESS_CONTEXT_FLAG, "depth", 0) + 1
        _VAULT_ACCESS_CONTEXT_FLAG.active = True
        return self

    def __exit__(self, *_) -> None:
        _VAULT_ACCESS_CONTEXT_FLAG.depth = getattr(_VAULT_ACCESS_CONTEXT_FLAG, "depth", 1) - 1
        if _VAULT_ACCESS_CONTEXT_FLAG.depth <= 0:
            _VAULT_ACCESS_CONTEXT_FLAG.active = False


class CaracalVault:
    """Vault client facade used by runtime, CLI, and SDK flows."""

    def __init__(
        self,
        client: Optional[httpx.Client] = None,
        rate_limit: int = _RATE_LIMIT_DEFAULT,
    ) -> None:
        self._config = _load_vault_config()
        self._client = client or httpx.Client(
            base_url=self._config.base_url,
            timeout=httpx.Timeout(self._config.request_timeout_seconds),
            headers={
                "Authorization": f"Bearer {self._config.token}",
                "Content-Type": "application/json",
            },
        )
        self._rl = _VaultRateLimiter(limit=rate_limit)
        self._audit: list[VaultAuditEvent] = []
        self._audit_lock = threading.Lock()
        self._last_health_check_at = 0.0
        self._health_ok = False

    def _resolve_context(self, workspace_id: str, env_id: str) -> tuple[str, str, str]:
        project_id = (workspace_id or self._config.default_project).strip()
        environment = (env_id or self._config.default_environment).strip()
        secret_path = self._config.default_secret_path
        if not project_id:
            raise VaultConfigurationError(
                "Vault workspace context is missing. Provide workspace_id or set CARACAL_VAULT_WORKSPACE_ID."
            )
        if not environment:
            raise VaultConfigurationError("Vault environment context is missing.")
        return project_id, environment, secret_path

    @staticmethod
    def _normalize_secret_path(secret_path: str) -> str:
        normalized = (secret_path or "/").strip()
        if not normalized:
            normalized = "/"
        if not normalized.startswith("/"):
            normalized = f"/{normalized}"
        return normalized.rstrip("/") or "/"

    def _resolve_secret_locator(self, secret_path: str, name: str) -> tuple[str, str]:
        normalized_path = self._normalize_secret_path(secret_path)
        normalized_name = (name or "").strip().strip("/")
        if not normalized_name:
            raise VaultConfigurationError("Vault secret name must not be empty.")

        segments = [segment.strip() for segment in normalized_name.split("/") if segment.strip()]
        if not segments:
            raise VaultConfigurationError("Vault secret name must not be empty.")

        if any(seg in (".", "..") for seg in segments):
            raise VaultConfigurationError("Vault secret names must not contain path traversal segments.")

        name = segments[-1]
        if len(segments) == 1:
            return normalized_path, name

        nested_path = "/".join(segments[:-1])
        if normalized_path == "/":
            resolved_path = f"/{nested_path}"
        else:
            resolved_path = f"{normalized_path}/{nested_path}"
        return self._normalize_secret_path(resolved_path), name

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[dict[str, Any]] = None,
        payload: Optional[dict[str, Any]] = None,
        allowed_statuses: set[int],
    ) -> httpx.Response:
        attempts = self._config.retry_max_attempts
        backoff = self._config.retry_backoff_seconds
        last_http_exc: Optional[Exception] = None

        for attempt in range(1, attempts + 1):
            try:
                response = self._client.request(method=method, url=path, params=params, json=payload)
            except httpx.HTTPError as exc:
                last_http_exc = exc
                if attempt >= attempts:
                    raise VaultUnavailableError(
                        f"Vault API request failed after {attempts} attempts: {method} {path} ({exc})"
                    ) from exc
                if backoff > 0:
                    time.sleep(backoff * attempt)
                continue

            if response.status_code in allowed_statuses:
                return response

            detail = response.text.strip()
            if len(detail) > 400:
                detail = detail[:400] + "..."

            if response.status_code in _RETRYABLE_STATUS_CODES:
                if attempt >= attempts:
                    raise VaultUnavailableError(
                        f"Vault API unavailable after {attempts} attempts: {method} {path} -> "
                        f"{response.status_code} {detail}"
                    )
                if backoff > 0:
                    time.sleep(backoff * attempt)
                continue

            raise VaultError(
                f"Vault API request failed: {method} {path} -> "
                f"{response.status_code} {detail}"
            )

        # Defensive fallback; loop always returns or raises.
        if last_http_exc is not None:
            raise VaultUnavailableError(
                f"Vault API request failed: {method} {path} ({last_http_exc})"
            )
        raise VaultUnavailableError(f"Vault API request failed: {method} {path}")

    @staticmethod
    def _json(response: httpx.Response) -> dict[str, Any]:
        if not response.content:
            return {}
        try:
            decoded = response.json()
        except ValueError:
            return {}
        return decoded if isinstance(decoded, dict) else {}

    def _ensure_service_health(self) -> None:
        now = time.monotonic()
        if self._health_ok and (now - self._last_health_check_at) < _HEALTH_CACHE_TTL_SECONDS:
            return

        self._last_health_check_at = now
        for endpoint in ("/health", "/api/status"):
            try:
                response = self._request("GET", endpoint, allowed_statuses={200, 404})
                if response.status_code == 200:
                    self._health_ok = True
                    return
            except VaultError:
                continue

        self._health_ok = False
        if self._config.hardcut_enabled:
            raise VaultError("Vault service is unreachable; hardcut mode requires healthy vault backend.")

    @staticmethod
    def _extract_secret_value(payload: dict[str, Any]) -> Optional[str]:
        candidates = [
            ("secret", "secretValue"),
            ("secret", "secret_value"),
            ("secretValue",),
            ("secret_value",),
            ("data", "secret", "secretValue"),
            ("data", "secretValue"),
        ]
        for path in candidates:
            cursor: Any = payload
            found = True
            for key in path:
                if isinstance(cursor, dict) and key in cursor:
                    cursor = cursor[key]
                else:
                    found = False
                    break
            if found and isinstance(cursor, str):
                return cursor
        return None

    @staticmethod
    def _extract_secret_names(payload: dict[str, Any]) -> list[str]:
        names: list[str] = []

        def _append_from(item: Any) -> None:
            if not isinstance(item, dict):
                return
            for key in ("secretKey", "secret_key", "name", "key"):
                value = item.get(key)
                if isinstance(value, str) and value.strip():
                    names.append(value.strip())
                    return

        for key in ("secrets", "data", "items"):
            value = payload.get(key)
            if isinstance(value, list):
                for item in value:
                    _append_from(item)

        if isinstance(payload.get("secret"), dict):
            _append_from(payload["secret"])

        return sorted(set(names))

    @staticmethod
    def _extract_string_value(payload: dict[str, Any], *paths: tuple[str, ...]) -> Optional[str]:
        for path in paths:
            cursor: Any = payload
            found = True
            for key in path:
                if isinstance(cursor, dict) and key in cursor:
                    cursor = cursor[key]
                else:
                    found = False
                    break
            if found and isinstance(cursor, str) and cursor.strip():
                return cursor.strip()
        return None

    def _sign_jwt_via_vault_api(
        self,
        *,
        project_id: str,
        environment: str,
        secret_path: str,
        key_name: str,
        payload: dict[str, Any],
        headers: dict[str, Any],
        algorithm: str,
    ) -> str:
        endpoint = (_read_env_or_dotenv("CARACAL_VAULT_SIGN_JWT_ENDPOINT") or "/api/caracal/sign/jwt").strip()
        response = self._request(
            "POST",
            endpoint,
            payload={
                "projectId": project_id,
                "environment": environment,
                "secretPath": secret_path,
                "keyName": key_name,
                "algorithm": algorithm,
                "payload": payload,
                "headers": headers,
            },
            allowed_statuses={200, 201},
        )
        token = self._extract_string_value(
            self._json(response),
            ("signedJwt",),
            ("signed_token",),
            ("token",),
            ("jwt",),
            ("data", "signedJwt"),
            ("data", "token"),
        )
        if token is None:
            raise VaultError("Vault sign_jwt response did not contain a signed token.")
        return token

    def _sign_canonical_payload_via_vault_api(
        self,
        *,
        project_id: str,
        environment: str,
        secret_path: str,
        key_name: str,
        payload: dict[str, Any],
    ) -> str:
        endpoint = (
            _read_env_or_dotenv("CARACAL_VAULT_SIGN_CANONICAL_PAYLOAD_ENDPOINT")
            or "/api/caracal/sign/canonical-payload"
        ).strip()
        response = self._request(
            "POST",
            endpoint,
            payload={
                "projectId": project_id,
                "environment": environment,
                "secretPath": secret_path,
                "keyName": key_name,
                "payload": payload,
            },
            allowed_statuses={200, 201},
        )
        signature = self._extract_string_value(
            self._json(response),
            ("signatureHex",),
            ("signature",),
            ("data", "signatureHex"),
            ("data", "signature"),
        )
        if signature is None:
            raise VaultError(
                "Vault sign_canonical_payload response did not contain a signature."
            )
        return signature

    def _bootstrap_asymmetric_keypair_via_vault_api(
        self,
        *,
        project_id: str,
        environment: str,
        secret_path: str,
        private_key_name: str,
        public_key_name: str,
        algorithm: str,
    ) -> None:
        endpoint = (
            _read_env_or_dotenv("CARACAL_VAULT_BOOTSTRAP_KEYPAIR_ENDPOINT")
            or "/api/caracal/keys/bootstrap"
        ).strip()
        self._request(
            "POST",
            endpoint,
            payload={
                "projectId": project_id,
                "environment": environment,
                "secretPath": secret_path,
                "privateKeyName": private_key_name,
                "publicKeyName": public_key_name,
                "algorithm": algorithm,
            },
            allowed_statuses={200, 201, 202, 409},
        )

    @staticmethod
    def _is_missing_bootstrap_endpoint(error: VaultError) -> bool:
        payload = str(error)
        return (
            "POST /api/caracal/keys/bootstrap" in payload
            and "-> 404" in payload
        )

    @staticmethod
    def _is_missing_sign_endpoint(error: VaultError) -> bool:
        payload = str(error)
        return "POST /api/caracal/sign/" in payload and "-> 404" in payload

    @staticmethod
    def _sign_canonical_payload_locally(private_key_pem: str, payload: dict[str, Any]) -> str:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        private_key = serialization.load_pem_private_key(private_key_pem.encode(), password=None)
        signature_bytes = private_key.sign(canonical, ec.ECDSA(hashes.SHA256()))
        return signature_bytes.hex()

    @staticmethod
    def _sign_jwt_locally(private_key_pem: str, payload: dict[str, Any], algorithm: str) -> str:
        import jwt as pyjwt
        return pyjwt.encode(payload, private_key_pem, algorithm=algorithm)

    def _bootstrap_asymmetric_keypair_via_secret_upsert(
        self,
        *,
        project_id: str,
        environment: str,
        secret_path: str,
        private_key_name: str,
        public_key_name: str,
        algorithm: str,
    ) -> None:
        private_exists = self._secret_exists(
            project_id,
            environment,
            secret_path,
            private_key_name,
        )
        public_exists = self._secret_exists(
            project_id,
            environment,
            secret_path,
            public_key_name,
        )

        if private_exists and public_exists:
            return
        if private_exists != public_exists:
            raise VaultError(
                "Asymmetric keypair bootstrap cannot continue: vault keypair state is inconsistent."
            )

        private_pem, public_pem = generate_asymmetric_keypair_pem(algorithm)
        self._upsert_secret(project_id, environment, secret_path, private_key_name, private_pem)
        self._upsert_secret(project_id, environment, secret_path, public_key_name, public_pem)

    def _secret_exists(self, project_id: str, environment: str, secret_path: str, name: str) -> bool:
        try:
            self._get_secret_value(project_id, environment, secret_path, name)
            return True
        except SecretNotFound:
            return False

    def _ensure_secret_folder_path(self, project_id: str, environment: str, secret_path: str) -> None:
        normalized_path = self._normalize_secret_path(secret_path)
        if normalized_path == "/":
            return

        segments = [segment for segment in normalized_path.strip("/").split("/") if segment]
        current_path = "/"

        for segment in segments:
            response = self._request(
                "POST",
                "/api/v2/folders",
                payload={
                    "projectId": project_id,
                    "environment": environment,
                    "name": segment,
                    "path": current_path,
                },
                allowed_statuses={200, 201, 400, 404, 405},
            )

            if response.status_code == 400:
                detail = (response.text or "").lower()
                if "already exists" not in detail:
                    raise VaultError(
                        "Vault folder creation failed for "
                        f"'{current_path}/{segment}'."
                    )

            if current_path == "/":
                current_path = f"/{segment}"
            else:
                current_path = f"{current_path}/{segment}"

    def _upsert_secret(self, project_id: str, environment: str, secret_path: str, name: str, value: str) -> str:
        self._ensure_secret_folder_path(project_id, environment, secret_path)

        v4_body = {
            "projectId": project_id,
            "environment": environment,
            "secretPath": secret_path,
            "secretValue": value,
            "skipMultilineEncoding": False,
        }
        response = self._request(
            "PATCH",
            f"/api/v4/secrets/{name}",
            payload=v4_body,
            allowed_statuses={200, 201, 404, 405},
        )
        if response.status_code in {200, 201}:
            payload = self._json(response)
            return str((payload.get("secret") or {}).get("id") or payload.get("id") or name)

        batch_response = self._request(
            "POST",
            "/api/v4/secrets/batch",
            payload={
                "projectId": project_id,
                "environment": environment,
                "secretPath": secret_path,
                "secrets": [{"secretKey": name, "secretValue": value}],
            },
            allowed_statuses={200, 201, 404, 405, 409},
        )
        if batch_response.status_code in {200, 201}:
            payload = self._json(batch_response)
            created = payload.get("secrets")
            if isinstance(created, list) and created and isinstance(created[0], dict):
                first = created[0]
                return str(first.get("id") or first.get("_id") or name)
            return name
        if batch_response.status_code == 409:
            retry_response = self._request(
                "PATCH",
                f"/api/v4/secrets/{name}",
                payload=v4_body,
                allowed_statuses={200, 201, 404, 405},
            )
            if retry_response.status_code in {200, 201}:
                payload = self._json(retry_response)
                return str((payload.get("secret") or {}).get("id") or payload.get("id") or name)

        patch_status = response.status_code
        batch_status = batch_response.status_code
        retry_status = None
        if batch_response.status_code == 409:
            retry_status = retry_response.status_code

        raise VaultError(
            "Vault v4 secret upsert failed. "
            f"PATCH /api/v4/secrets/{name} returned {patch_status}; "
            f"POST /api/v4/secrets/batch returned {batch_status}"
            + (
                f"; retry PATCH returned {retry_status}. "
                if retry_status is not None
                else ". "
            )
            + "Legacy /api/secrets fallback has been removed."
        )

    def _get_secret_value(self, project_id: str, environment: str, secret_path: str, name: str) -> str:
        response = self._request(
            "GET",
            f"/api/v4/secrets/{name}",
            params={
                "projectId": project_id,
                "environment": environment,
                "secretPath": secret_path,
            },
            allowed_statuses={200, 404},
        )

        if response.status_code == 404:
            raise SecretNotFound(
                f"Secret '{name}' not found in env '{environment}' for workspace '{project_id}'."
            )

        payload = self._json(response)
        value = self._extract_secret_value(payload)
        if value is None:
            raise VaultError(
                f"Vault API response did not contain secret value for '{name}'."
            )
        return value

    def _delete_secret(self, project_id: str, environment: str, secret_path: str, name: str) -> None:
        response = self._request(
            "DELETE",
            f"/api/v4/secrets/{name}",
            payload={
                "projectId": project_id,
                "environment": environment,
                "secretPath": secret_path,
            },
            allowed_statuses={200, 204, 404, 405},
        )
        if response.status_code in {200, 204}:
            return
        if response.status_code == 404:
            raise SecretNotFound(
                f"Secret '{name}' not found in env '{environment}' for workspace '{project_id}'."
            )

        raise VaultError(
            "Vault v4 secret delete failed. "
            f"DELETE /api/v4/secrets/{name} returned {response.status_code}. "
            "Legacy /api/secrets fallback has been removed."
        )

    def _list_secret_names(self, project_id: str, environment: str, secret_path: str) -> list[str]:
        response = self._request(
            "GET",
            "/api/v4/secrets",
            params={
                "projectId": project_id,
                "environment": environment,
                "secretPath": secret_path,
            },
            allowed_statuses={200, 404},
        )
        if response.status_code == 404:
            return []

        payload = self._json(response)
        return self._extract_secret_names(payload)

    def _audit_event(
        self,
        workspace_id: str,
        env_id: str,
        name: str,
        op: str,
        version: int,
        actor: str,
        success: bool,
        error_code: Optional[str] = None,
    ) -> None:
        event = VaultAuditEvent(
            event_id=str(uuid4()),
            workspace_id=workspace_id,
            env_id=env_id,
            secret_name=name,
            operation=op,
            key_version=version,
            actor=actor,
            timestamp=datetime.now(timezone.utc).isoformat(),
            success=success,
            error_code=error_code,
        )
        with self._audit_lock:
            self._audit.append(event)

    def put(self, workspace_id: str, env_id: str, name: str, plaintext: str, actor: str = "gateway") -> VaultEntry:
        _assert_vault_access_context()
        self._ensure_service_health()

        project_id, environment, secret_path = self._resolve_context(workspace_id, env_id)
        self._rl.check(project_id)
        secret_path, name = self._resolve_secret_locator(secret_path, name)
        existed = self._secret_exists(project_id, environment, secret_path, name)

        try:
            entry_id = self._upsert_secret(
                project_id,
                environment,
                secret_path,
                name,
                plaintext,
            )
            now = datetime.now(timezone.utc).isoformat()
            self._audit_event(workspace_id, env_id, name, "update" if existed else "create", 1, actor, True)
            return VaultEntry(
                entry_id=entry_id,
                workspace_id=workspace_id,
                env_id=env_id,
                secret_name=name,
                ciphertext_b64="",
                iv_b64="",
                encrypted_dek_b64="",
                dek_iv_b64="",
                key_version=1,
                created_at=now,
                updated_at=now,
            )
        except Exception as exc:
            self._audit_event(workspace_id, env_id, name, "create", 0, actor, False, type(exc).__name__)
            if isinstance(exc, VaultError):
                raise
            raise VaultError(f"Failed to store secret '{name}': {exc}") from exc

    def get(self, workspace_id: str, env_id: str, name: str, actor: str = "gateway") -> str:
        _assert_vault_access_context()
        self._ensure_service_health()

        project_id, environment, secret_path = self._resolve_context(workspace_id, env_id)
        self._rl.check(project_id)
        secret_path, name = self._resolve_secret_locator(secret_path, name)
        try:
            value = self._get_secret_value(project_id, environment, secret_path, name)
            self._audit_event(workspace_id, env_id, name, "read", 1, actor, True)
            return value
        except SecretNotFound:
            self._audit_event(workspace_id, env_id, name, "read", 0, actor, False, "SecretNotFound")
            raise
        except Exception as exc:
            self._audit_event(workspace_id, env_id, name, "read", 0, actor, False, type(exc).__name__)
            if isinstance(exc, VaultError):
                raise
            raise VaultError(f"Failed to retrieve secret '{name}': {exc}") from exc

    def sign_jwt(
        self,
        workspace_id: str,
        env_id: str,
        name: str,
        *,
        payload: dict[str, Any],
        headers: dict[str, Any],
        algorithm: str,
        actor: str = "gateway",
    ) -> str:
        _assert_vault_access_context()
        self._ensure_service_health()

        project_id, environment, secret_path = self._resolve_context(workspace_id, env_id)
        self._rl.check(project_id)
        secret_path, name = self._resolve_secret_locator(secret_path, name)
        try:
            try:
                token = self._sign_jwt_via_vault_api(
                    project_id=project_id,
                    environment=environment,
                    secret_path=secret_path,
                    key_name=name,
                    payload=payload,
                    headers=headers,
                    algorithm=algorithm,
                )
            except VaultError as exc:
                if not self._is_missing_sign_endpoint(exc):
                    raise
                logger.debug(
                    "Vault sign endpoint absent — falling back to local JWT signing."
                )
                private_key_pem = self._get_secret_value(
                    project_id, environment, secret_path, name
                )
                token = self._sign_jwt_locally(private_key_pem, payload, algorithm)
            self._audit_event(workspace_id, env_id, name, "sign_jwt", 1, actor, True)
            return token
        except Exception as exc:
            self._audit_event(workspace_id, env_id, name, "sign_jwt", 0, actor, False, type(exc).__name__)
            if isinstance(exc, VaultError):
                raise
            raise VaultError(f"Failed to sign JWT with vault-backed key '{name}': {exc}") from exc

    def sign_canonical_payload(
        self,
        workspace_id: str,
        env_id: str,
        name: str,
        *,
        payload: dict[str, Any],
        actor: str = "gateway",
    ) -> str:
        _assert_vault_access_context()
        self._rl.check(workspace_id)
        self._ensure_service_health()

        project_id, environment, secret_path = self._resolve_context(workspace_id, env_id)
        secret_path, name = self._resolve_secret_locator(secret_path, name)
        try:
            try:
                signature = self._sign_canonical_payload_via_vault_api(
                    project_id=project_id,
                    environment=environment,
                    secret_path=secret_path,
                    key_name=name,
                    payload=payload,
                )
            except VaultError as exc:
                if not self._is_missing_sign_endpoint(exc):
                    raise
                # Custom sign endpoint absent (vanilla Infisical) — fetch the
                # private key from vault secrets and sign locally.
                logger.debug(
                    "Vault sign endpoint absent — falling back to local ECDSA signing."
                )
                private_key_pem = self._get_secret_value(
                    project_id, environment, secret_path, name
                )
                signature = self._sign_canonical_payload_locally(private_key_pem, payload)
            self._audit_event(workspace_id, env_id, name, "sign_canonical_payload", 1, actor, True)
            return signature
        except Exception as exc:
            self._audit_event(
                workspace_id,
                env_id,
                name,
                "sign_canonical_payload",
                0,
                actor,
                False,
                type(exc).__name__,
            )
            if isinstance(exc, VaultError):
                raise
            raise VaultError(
                f"Failed to sign canonical payload with vault-backed key '{name}': {exc}"
            ) from exc

    def delete(self, workspace_id: str, env_id: str, name: str, actor: str = "gateway") -> None:
        _assert_vault_access_context()
        self._rl.check(workspace_id)
        self._ensure_service_health()

        project_id, environment, secret_path = self._resolve_context(workspace_id, env_id)
        secret_path, name = self._resolve_secret_locator(secret_path, name)
        try:
            self._delete_secret(project_id, environment, secret_path, name)
            self._audit_event(workspace_id, env_id, name, "delete", 1, actor, True)
        except SecretNotFound:
            self._audit_event(workspace_id, env_id, name, "delete", 0, actor, False, "SecretNotFound")
            raise

    def list_secrets(self, workspace_id: str, env_id: str, actor: str = "gateway") -> list[str]:
        _assert_vault_access_context()
        self._rl.check(workspace_id)
        self._ensure_service_health()

        project_id, environment, secret_path = self._resolve_context(workspace_id, env_id)
        try:
            names = self._list_secret_names(project_id, environment, secret_path)
            self._audit_event(workspace_id, env_id, "*", "list", 1, actor, True)
            return names
        except Exception as exc:
            self._audit_event(workspace_id, env_id, "*", "list", 0, actor, False, type(exc).__name__)
            if isinstance(exc, VaultError):
                raise
            raise VaultError(f"Failed to list secrets: {exc}") from exc

    def ensure_asymmetric_keypair(
        self,
        workspace_id: str,
        env_id: str,
        *,
        private_key_name: str,
        public_key_name: str,
        algorithm: str = "RS256",
        actor: str = "gateway",
    ) -> None:
        _assert_vault_access_context()
        self._rl.check(workspace_id)
        self._ensure_service_health()

        normalized_algorithm = str(algorithm or "RS256").strip().upper()
        if normalized_algorithm not in {"RS256", "ES256"}:
            raise VaultConfigurationError(
                f"Unsupported asymmetric key bootstrap algorithm: {normalized_algorithm!r}."
            )

        if private_key_name == public_key_name:
            raise VaultConfigurationError(
                "Vault bootstrap requires distinct private/public key references."
            )

        project_id, environment, secret_path = self._resolve_context(workspace_id, env_id)
        secret_path, private_key_name = self._resolve_secret_locator(secret_path, private_key_name)

        _, _, public_secret_path = self._resolve_context(workspace_id, env_id)
        public_secret_path, public_key_name = self._resolve_secret_locator(
            public_secret_path,
            public_key_name,
        )

        if secret_path != public_secret_path:
            raise VaultConfigurationError(
                "Vault bootstrap requires private/public keys to share the same secret path namespace."
            )

        try:
            try:
                self._bootstrap_asymmetric_keypair_via_vault_api(
                    project_id=project_id,
                    environment=environment,
                    secret_path=secret_path,
                    private_key_name=private_key_name,
                    public_key_name=public_key_name,
                    algorithm=normalized_algorithm,
                )
            except VaultError as exc:
                if not self._is_missing_bootstrap_endpoint(exc):
                    raise

                self._bootstrap_asymmetric_keypair_via_secret_upsert(
                    project_id=project_id,
                    environment=environment,
                    secret_path=secret_path,
                    private_key_name=private_key_name,
                    public_key_name=public_key_name,
                    algorithm=normalized_algorithm,
                )

            self._audit_event(workspace_id, env_id, private_key_name, "create", 1, actor, True)
            self._audit_event(workspace_id, env_id, public_key_name, "create", 1, actor, True)
        except Exception as exc:
            self._audit_event(
                workspace_id,
                env_id,
                private_key_name,
                "bootstrap_keypair",
                0,
                actor,
                False,
                type(exc).__name__,
            )
            self._audit_event(
                workspace_id,
                env_id,
                public_key_name,
                "bootstrap_keypair",
                0,
                actor,
                False,
                type(exc).__name__,
            )
            if isinstance(exc, VaultError):
                raise
            raise VaultError(
                "Failed to bootstrap asymmetric vault key material "
                f"({private_key_name}, {public_key_name}): {exc}"
            ) from exc

    def rotate_master_key(self, workspace_id: str, env_id: str, actor: str = "admin") -> RotationResult:
        _assert_vault_access_context()
        self._rl.check(workspace_id)
        self._ensure_service_health()

        rotate_endpoint = (_read_env_or_dotenv("CARACAL_VAULT_ROTATE_ENDPOINT") or "").strip()
        if not rotate_endpoint:
            raise VaultError(
                "Vault key rotation endpoint is not configured. "
                "Set CARACAL_VAULT_ROTATE_ENDPOINT to enable rotate_master_key."
            )

        project_id, environment, secret_path = self._resolve_context(workspace_id, env_id)
        started_at = time.monotonic()
        response = self._request(
            "POST",
            rotate_endpoint,
            payload={
                "projectId": project_id,
                "environment": environment,
                "secretPath": secret_path,
                "actor": actor,
            },
            allowed_statuses={200, 201, 202},
        )
        payload = self._json(response)

        rotated = int(payload.get("secrets_rotated") or payload.get("rotated") or 0)
        failed = int(payload.get("secrets_failed") or payload.get("failed") or 0)
        key_version = int(payload.get("new_key_version") or payload.get("key_version") or 0)

        self._audit_event(workspace_id, env_id, "*", "rotate", key_version, actor, failed == 0)

        return RotationResult(
            secrets_rotated=rotated,
            secrets_failed=failed,
            new_key_version=key_version,
            duration_seconds=round(time.monotonic() - started_at, 3),
        )

    def drain_audit_events(self) -> list[VaultAuditEvent]:
        with self._audit_lock:
            events, self._audit = self._audit[:], []
        return events


_vault_instance: Optional[CaracalVault] = None
_vault_lock = threading.Lock()


def get_vault() -> CaracalVault:
    global _vault_instance
    if _vault_instance is None:
        with _vault_lock:
            if _vault_instance is None:
                _vault_instance = CaracalVault()
    return _vault_instance
