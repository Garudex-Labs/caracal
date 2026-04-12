"""Manual runtime configuration loader for the demo app."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent / "demo_config.json"
TEMPLATE_CONFIG_PATH = Path(__file__).resolve().parent / "demo_config.example.json"


class DemoConfigurationError(RuntimeError):
    """Raised when the manual demo configuration is missing or invalid."""


@dataclass(frozen=True)
class CaracalRuntimeConfig:
    base_url: str
    api_key: str
    organization_id: str | None = None
    workspace_id: str | None = None
    project_id: str | None = None


@dataclass(frozen=True)
class ModeConfig:
    mandates: dict[str, str]
    revoker_id: str | None = None
    source_mandate_id: str | None = None
    principal_ids: dict[str, str] | None = None


@dataclass(frozen=True)
class DemoRuntimeConfig:
    path: Path
    caracal: CaracalRuntimeConfig
    modes: dict[str, ModeConfig]


def resolve_config_path() -> Path:
    candidate = os.environ.get("LANGCHAIN_DEMO_CONFIG")
    return Path(candidate).expanduser().resolve() if candidate else DEFAULT_CONFIG_PATH


def _required_str(container: dict[str, Any], key: str, *, context: str) -> str:
    value = str(container.get(key) or "").strip()
    if not value:
        raise DemoConfigurationError(f"Missing required value '{key}' in {context}")
    return value


def _optional_str(container: dict[str, Any], key: str) -> str | None:
    value = str(container.get(key) or "").strip()
    return value or None


def _load_mode_config(name: str, payload: dict[str, Any]) -> ModeConfig:
    mandates_payload = payload.get("mandates")
    if not isinstance(mandates_payload, dict):
        raise DemoConfigurationError(f"Mode '{name}' is missing a mandates object")

    mandates = {
        role: _required_str(mandates_payload, role, context=f"modes.{name}.mandates")
        for role in ("orchestrator", "finance", "ops")
    }
    principal_ids_payload = payload.get("principal_ids")
    principal_ids: dict[str, str] | None = None
    if isinstance(principal_ids_payload, dict):
        principal_ids = {
            role: _required_str(principal_ids_payload, role, context=f"modes.{name}.principal_ids")
            for role in ("orchestrator", "finance", "ops")
            if str(principal_ids_payload.get(role) or "").strip()
        }

    return ModeConfig(
        mandates=mandates,
        revoker_id=_optional_str(payload, "revoker_id"),
        source_mandate_id=_optional_str(payload, "source_mandate_id"),
        principal_ids=principal_ids,
    )


def load_demo_runtime_config(*, require_api_key: bool = True) -> DemoRuntimeConfig:
    path = resolve_config_path()
    if not path.exists():
        raise DemoConfigurationError(
            "Demo config file not found. Copy "
            f"{TEMPLATE_CONFIG_PATH} to {path} and fill in the mandate IDs from the CLI setup steps."
        )

    payload = json.loads(path.read_text(encoding="utf-8"))
    caracal_payload = payload.get("caracal")
    modes_payload = payload.get("modes")
    if not isinstance(caracal_payload, dict):
        raise DemoConfigurationError("demo_config.json is missing a top-level 'caracal' object")
    if not isinstance(modes_payload, dict):
        raise DemoConfigurationError("demo_config.json is missing a top-level 'modes' object")

    api_key_env = _required_str(caracal_payload, "api_key_env", context="caracal")
    api_key = str(os.environ.get(api_key_env) or "").strip()
    if require_api_key and not api_key:
        raise DemoConfigurationError(
            f"Environment variable '{api_key_env}' is required for the demo app to call Caracal."
        )

    config = DemoRuntimeConfig(
        path=path,
        caracal=CaracalRuntimeConfig(
            base_url=_required_str(caracal_payload, "base_url", context="caracal"),
            api_key=api_key,
            organization_id=_optional_str(caracal_payload, "organization_id"),
            workspace_id=_optional_str(caracal_payload, "workspace_id"),
            project_id=_optional_str(caracal_payload, "project_id"),
        ),
        modes={
            "mock": _load_mode_config("mock", dict(modes_payload.get("mock") or {})),
            "real": _load_mode_config("real", dict(modes_payload.get("real") or {})),
        },
    )
    return config


def config_status() -> dict[str, Any]:
    path = resolve_config_path()
    if not path.exists():
        return {
            "configured": False,
            "config_path": str(path),
            "template_path": str(TEMPLATE_CONFIG_PATH),
            "message": "Create a demo config file from the example template and populate mandate IDs.",
        }

    try:
        config = load_demo_runtime_config(require_api_key=False)
    except Exception as exc:  # pragma: no cover - surfaced directly to UI
        return {
            "configured": False,
            "config_path": str(path),
            "template_path": str(TEMPLATE_CONFIG_PATH),
            "message": str(exc),
        }

    return {
        "configured": True,
        "config_path": str(config.path),
        "template_path": str(TEMPLATE_CONFIG_PATH),
        "caracal_base_url": config.caracal.base_url,
        "workspace_id": config.caracal.workspace_id,
        "organization_id": config.caracal.organization_id,
        "project_id": config.caracal.project_id,
        "modes": {
            name: {
                "roles": sorted(mode.mandates.keys()),
                "revoker_id": mode.revoker_id,
                "source_mandate_id": mode.source_mandate_id,
                "principal_ids": sorted((mode.principal_ids or {}).keys()),
            }
            for name, mode in config.modes.items()
        },
    }
