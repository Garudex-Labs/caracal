"""Canonical enterprise runtime helpers for OSS deployment-owned clients."""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import platform
import socket
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse
from uuid import uuid4

logger = logging.getLogger(__name__)

_DEFAULT_ENTERPRISE_URL = "https://www.garudexlabs.com"
_ALLOWED_ENTERPRISE_HOSTS = {"localhost", "garudexlabs.com", "www.garudexlabs.com"}
_ENTERPRISE_CONFIG_WORKSPACE_KEY = "__enterprise_runtime__"


def _is_allowed_enterprise_host(host: str) -> bool:
    """Validate enterprise hostnames while allowing safe local/dev targets."""
    normalized = host.strip().lower()
    if not normalized:
        return False

    if normalized in _ALLOWED_ENTERPRISE_HOSTS:
        return True

    if normalized in {
        "127.0.0.1",
        "::1",
        "host.docker.internal",
        "host.containers.internal",
    }:
        return True

    try:
        addr = ipaddress.ip_address(normalized)
        return bool(addr.is_loopback or addr.is_private)
    except ValueError:
        return False


def _load_workspace_dotenv() -> Dict[str, str]:
    """Load key/value pairs from workspace .env (best-effort)."""
    env_data: Dict[str, str] = {}

    candidates = [Path(__file__).resolve().parents[2] / ".env"]

    try:
        from caracal.flow.workspace import get_workspace

        ws = get_workspace()
        candidates.append(ws.root / ".env")
    except Exception:
        pass

    candidates.append(Path.cwd() / ".env")

    for env_path in candidates:
        if not env_path.exists():
            continue
        try:
            for line in env_path.read_text().splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith("#") or "=" not in stripped:
                    continue

                key, value = stripped.split("=", 1)
                key = key.strip()
                value = value.strip()
                if value and value[0] in ('"', "'") and value[-1:] == value[0]:
                    value = value[1:-1]
                elif " #" in value:
                    value = value.split(" #", 1)[0].strip()

                env_data[key] = value

            break
        except OSError:
            continue

    return env_data


def _read_env(name: str) -> Optional[str]:
    """Resolve env var from process environment first, then workspace .env."""
    value = os.environ.get(name)
    if value is not None:
        return value
    return _load_workspace_dotenv().get(name)


def _normalize_enterprise_url(raw: Optional[str]) -> Optional[str]:
    """Normalize Enterprise URL and enforce host allowlist."""
    if not raw:
        return None

    value = raw.strip().strip("() ")
    if not value:
        return None

    if not value.startswith(("http://", "https://")):
        value = f"http://{value}"

    parsed = urlparse(value)
    host = (parsed.hostname or "").strip().lower()
    if not _is_allowed_enterprise_host(host):
        return None

    return value.rstrip("/")


def load_enterprise_config() -> Dict[str, Any]:
    """Load enterprise config from dedicated enterprise runtime persistence."""
    try:
        from caracal.config import load_config
        from caracal.db.connection import get_db_manager
        from caracal.db.models import EnterpriseRuntimeConfig

        db_manager = get_db_manager(load_config())
        try:
            with db_manager.session_scope() as session:
                row = session.query(EnterpriseRuntimeConfig).filter_by(
                    runtime_key=_ENTERPRISE_CONFIG_WORKSPACE_KEY
                ).first()
                if row and isinstance(row.config_data, dict):
                    return dict(row.config_data)
        finally:
            db_manager.close()
    except Exception as exc:
        logger.warning("Failed to load enterprise config from PostgreSQL: %s", exc)

    return {}


def save_enterprise_config(data: Dict[str, Any]) -> None:
    """Persist enterprise config to dedicated enterprise runtime persistence."""
    from caracal.config import load_config
    from caracal.db.connection import get_db_manager
    from caracal.db.models import EnterpriseRuntimeConfig

    db_manager = get_db_manager(load_config())
    try:
        with db_manager.session_scope() as session:
            row = session.query(EnterpriseRuntimeConfig).filter_by(
                runtime_key=_ENTERPRISE_CONFIG_WORKSPACE_KEY
            ).first()
            if row is None:
                row = EnterpriseRuntimeConfig(
                    runtime_key=_ENTERPRISE_CONFIG_WORKSPACE_KEY,
                    config_data={},
                )
                session.add(row)
                session.flush()

            row.config_data = dict(data)
    finally:
        db_manager.close()


def clear_enterprise_config() -> None:
    """Clear enterprise config from dedicated enterprise runtime persistence."""
    from caracal.config import load_config
    from caracal.db.connection import get_db_manager
    from caracal.db.models import EnterpriseRuntimeConfig

    db_manager = get_db_manager(load_config())
    try:
        with db_manager.session_scope() as session:
            row = session.query(EnterpriseRuntimeConfig).filter_by(
                runtime_key=_ENTERPRISE_CONFIG_WORKSPACE_KEY
            ).first()
            if row:
                session.delete(row)
    finally:
        db_manager.close()


def _get_or_create_client_instance_id() -> str:
    """Return a stable CLI client instance id stored in enterprise config."""
    cfg = load_enterprise_config()
    client_instance_id = cfg.get("client_instance_id")
    if isinstance(client_instance_id, str) and client_instance_id.strip():
        return client_instance_id.strip()

    client_instance_id = f"ccli-{uuid4()}"
    cfg["client_instance_id"] = client_instance_id
    save_enterprise_config(cfg)
    return client_instance_id


def _build_client_metadata() -> Dict[str, str]:
    """Build lightweight runtime metadata for enterprise-side traceability."""
    return {
        "source": "caracal-cli",
        "hostname": socket.gethostname(),
        "platform": platform.system().lower(),
        "platform_release": platform.release(),
        "python_version": platform.python_version(),
        "env_mode": (os.environ.get("CARACAL_ENV_MODE") or "dev").strip().lower(),
    }


def _post_json(url: str, payload: dict, timeout: int = 15) -> dict:
    """POST JSON to *url* and return the parsed response body."""
    import urllib.error
    import urllib.request

    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode() if exc.fp else ""
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            raise ConnectionError(f"HTTP {exc.code}: {body[:500]}") from exc
    except urllib.error.URLError as exc:
        raise ConnectionError(f"Cannot reach Enterprise API at {url}: {exc.reason}") from exc


def _get_json(url: str, headers: Optional[dict] = None, timeout: int = 15) -> dict:
    """GET JSON from *url*."""
    import urllib.error
    import urllib.request

    req = urllib.request.Request(url, headers=headers or {}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode() if exc.fp else ""
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            raise ConnectionError(f"HTTP {exc.code}: {body[:500]}") from exc
    except urllib.error.URLError as exc:
        raise ConnectionError(f"Cannot reach Enterprise API at {url}: {exc.reason}") from exc


def _resolve_api_url(override: Optional[str] = None) -> str:
    """Return the Enterprise API base URL from one canonical resolution chain."""
    normalized_override = _normalize_enterprise_url(override)
    if override is not None and normalized_override:
        return normalized_override

    if override is not None and not normalized_override:
        logger.warning(
            "Rejected unsupported enterprise URL override '%s'. Allowed hosts: localhost, garudexlabs.com",
            override,
        )

    persisted_cfg = load_enterprise_config()
    persisted_url = _normalize_enterprise_url(persisted_cfg.get("enterprise_api_url"))
    if persisted_url:
        return persisted_url

    enterprise_url = _normalize_enterprise_url(_read_env("CARACAL_ENTERPRISE_URL"))
    if enterprise_url:
        return enterprise_url

    env_mode = (_read_env("CARACAL_ENV_MODE") or "dev").strip().lower()
    if env_mode == "dev":
        dev_url = _normalize_enterprise_url(_read_env("CARACAL_ENTERPRISE_DEV_URL"))
        if dev_url:
            return dev_url

    return _normalize_enterprise_url(_DEFAULT_ENTERPRISE_URL) or _DEFAULT_ENTERPRISE_URL


def resolve_revocation_webhook_target(
    *,
    webhook_url_override: Optional[str] = None,
) -> tuple[Optional[str], Optional[str]]:
    """Resolve revocation webhook URL and sync API key from enterprise runtime config."""
    normalized_override = str(webhook_url_override or "").strip() or None

    config = load_enterprise_config()
    sync_api_key = str(config.get("sync_api_key") or "").strip() or None

    if normalized_override:
        return normalized_override, sync_api_key

    configured_base = str(config.get("enterprise_api_url") or "").strip() or None
    resolved_base = _resolve_api_url(configured_base)
    if not resolved_base:
        return None, sync_api_key

    return f"{resolved_base.rstrip('/')}/api/sync/revocation-events", sync_api_key
