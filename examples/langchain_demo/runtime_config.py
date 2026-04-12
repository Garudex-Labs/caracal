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
class ScenarioConfig:
    """Configuration for scenario system."""
    default_scenario: str = "default"
    scenarios_path: str | None = None
    auto_load: bool = True


@dataclass(frozen=True)
class UIConfig:
    """Configuration for web UI."""
    host: str = "127.0.0.1"
    port: int = 8000
    enable_websocket: bool = True
    websocket_ping_interval: int = 30
    max_message_history: int = 1000
    enable_logs_panel: bool = True
    enable_tool_panel: bool = True
    enable_caracal_panel: bool = True


@dataclass(frozen=True)
class LoggingConfig:
    """Configuration for logging."""
    level: str = "INFO"
    format: str = "detailed"  # simple, detailed, json
    log_to_file: bool = False
    log_file_path: str | None = None
    max_file_size_mb: int = 10
    backup_count: int = 3


@dataclass(frozen=True)
class MockSystemConfig:
    """Configuration for mock system."""
    enabled: bool = True
    config_path: str | None = None
    cache_responses: bool = True
    simulate_delays: bool = True
    default_llm_provider: str = "openai"


@dataclass(frozen=True)
class AgentConfig:
    """Configuration for agent system."""
    max_iterations: int = 10
    timeout_seconds: int = 300
    enable_sub_agents: bool = True
    max_delegation_depth: int = 3


@dataclass(frozen=True)
class DemoRuntimeConfig:
    path: Path
    caracal: CaracalRuntimeConfig
    modes: dict[str, ModeConfig]
    scenario: ScenarioConfig = ScenarioConfig()
    ui: UIConfig = UIConfig()
    logging: LoggingConfig = LoggingConfig()
    mock_system: MockSystemConfig = MockSystemConfig()
    agent: AgentConfig = AgentConfig()


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


def _load_scenario_config(payload: dict[str, Any]) -> ScenarioConfig:
    """Load scenario configuration section."""
    if not isinstance(payload, dict):
        return ScenarioConfig()
    
    default_scenario = payload.get("default_scenario", "default")
    if not isinstance(default_scenario, str) or not default_scenario.strip():
        raise DemoConfigurationError(
            "scenario.default_scenario must be a non-empty string"
        )
    
    scenarios_path = _optional_str(payload, "scenarios_path")
    if scenarios_path and not Path(scenarios_path).exists():
        raise DemoConfigurationError(
            f"scenario.scenarios_path does not exist: {scenarios_path}"
        )
    
    auto_load = payload.get("auto_load", True)
    if not isinstance(auto_load, bool):
        raise DemoConfigurationError(
            "scenario.auto_load must be a boolean"
        )
    
    return ScenarioConfig(
        default_scenario=default_scenario,
        scenarios_path=scenarios_path,
        auto_load=auto_load
    )


def _load_ui_config(payload: dict[str, Any]) -> UIConfig:
    """Load UI configuration section."""
    if not isinstance(payload, dict):
        return UIConfig()
    
    host = payload.get("host", "127.0.0.1")
    if not isinstance(host, str) or not host.strip():
        raise DemoConfigurationError(
            "ui.host must be a non-empty string"
        )
    
    port = payload.get("port", 8000)
    if not isinstance(port, int) or port < 1 or port > 65535:
        raise DemoConfigurationError(
            "ui.port must be an integer between 1 and 65535"
        )
    
    websocket_ping_interval = payload.get("websocket_ping_interval", 30)
    if not isinstance(websocket_ping_interval, int) or websocket_ping_interval < 1:
        raise DemoConfigurationError(
            "ui.websocket_ping_interval must be a positive integer"
        )
    
    max_message_history = payload.get("max_message_history", 1000)
    if not isinstance(max_message_history, int) or max_message_history < 1:
        raise DemoConfigurationError(
            "ui.max_message_history must be a positive integer"
        )
    
    return UIConfig(
        host=host,
        port=port,
        enable_websocket=payload.get("enable_websocket", True),
        websocket_ping_interval=websocket_ping_interval,
        max_message_history=max_message_history,
        enable_logs_panel=payload.get("enable_logs_panel", True),
        enable_tool_panel=payload.get("enable_tool_panel", True),
        enable_caracal_panel=payload.get("enable_caracal_panel", True)
    )


def _load_logging_config(payload: dict[str, Any]) -> LoggingConfig:
    """Load logging configuration section."""
    if not isinstance(payload, dict):
        return LoggingConfig()
    
    level = payload.get("level", "INFO").upper()
    valid_levels = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")
    if level not in valid_levels:
        raise DemoConfigurationError(
            f"logging.level must be one of {valid_levels}, got: {level}"
        )
    
    format_type = payload.get("format", "detailed")
    valid_formats = ("simple", "detailed", "json")
    if format_type not in valid_formats:
        raise DemoConfigurationError(
            f"logging.format must be one of {valid_formats}, got: {format_type}"
        )
    
    log_to_file = payload.get("log_to_file", False)
    log_file_path = _optional_str(payload, "log_file_path")
    
    if log_to_file and not log_file_path:
        raise DemoConfigurationError(
            "logging.log_file_path is required when log_to_file is true"
        )
    
    max_file_size_mb = payload.get("max_file_size_mb", 10)
    if not isinstance(max_file_size_mb, int) or max_file_size_mb < 1:
        raise DemoConfigurationError(
            "logging.max_file_size_mb must be a positive integer"
        )
    
    backup_count = payload.get("backup_count", 3)
    if not isinstance(backup_count, int) or backup_count < 0:
        raise DemoConfigurationError(
            "logging.backup_count must be a non-negative integer"
        )
    
    return LoggingConfig(
        level=level,
        format=format_type,
        log_to_file=log_to_file,
        log_file_path=log_file_path,
        max_file_size_mb=max_file_size_mb,
        backup_count=backup_count
    )


def _load_mock_system_config(payload: dict[str, Any]) -> MockSystemConfig:
    """Load mock system configuration section."""
    if not isinstance(payload, dict):
        return MockSystemConfig()
    
    config_path = _optional_str(payload, "config_path")
    if config_path and not Path(config_path).exists():
        raise DemoConfigurationError(
            f"mock_system.config_path does not exist: {config_path}"
        )
    
    default_llm_provider = payload.get("default_llm_provider", "openai")
    if not isinstance(default_llm_provider, str) or not default_llm_provider.strip():
        raise DemoConfigurationError(
            "mock_system.default_llm_provider must be a non-empty string"
        )
    
    return MockSystemConfig(
        enabled=payload.get("enabled", True),
        config_path=config_path,
        cache_responses=payload.get("cache_responses", True),
        simulate_delays=payload.get("simulate_delays", True),
        default_llm_provider=default_llm_provider
    )


def _load_agent_config(payload: dict[str, Any]) -> AgentConfig:
    """Load agent configuration section."""
    if not isinstance(payload, dict):
        return AgentConfig()
    
    max_iterations = payload.get("max_iterations", 10)
    if not isinstance(max_iterations, int) or max_iterations < 1:
        raise DemoConfigurationError(
            "agent.max_iterations must be a positive integer"
        )
    
    timeout_seconds = payload.get("timeout_seconds", 300)
    if not isinstance(timeout_seconds, int) or timeout_seconds < 1:
        raise DemoConfigurationError(
            "agent.timeout_seconds must be a positive integer"
        )
    
    max_delegation_depth = payload.get("max_delegation_depth", 3)
    if not isinstance(max_delegation_depth, int) or max_delegation_depth < 1:
        raise DemoConfigurationError(
            "agent.max_delegation_depth must be a positive integer"
        )
    
    return AgentConfig(
        max_iterations=max_iterations,
        timeout_seconds=timeout_seconds,
        enable_sub_agents=payload.get("enable_sub_agents", True),
        max_delegation_depth=max_delegation_depth
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
        scenario=_load_scenario_config(payload.get("scenario", {})),
        ui=_load_ui_config(payload.get("ui", {})),
        logging=_load_logging_config(payload.get("logging", {})),
        mock_system=_load_mock_system_config(payload.get("mock_system", {})),
        agent=_load_agent_config(payload.get("agent", {}))
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
        "scenario": {
            "default_scenario": config.scenario.default_scenario,
            "scenarios_path": config.scenario.scenarios_path,
            "auto_load": config.scenario.auto_load
        },
        "ui": {
            "host": config.ui.host,
            "port": config.ui.port,
            "enable_websocket": config.ui.enable_websocket
        },
        "logging": {
            "level": config.logging.level,
            "format": config.logging.format,
            "log_to_file": config.logging.log_to_file
        },
        "mock_system": {
            "enabled": config.mock_system.enabled,
            "cache_responses": config.mock_system.cache_responses,
            "simulate_delays": config.mock_system.simulate_delays
        },
        "agent": {
            "max_iterations": config.agent.max_iterations,
            "timeout_seconds": config.agent.timeout_seconds,
            "enable_sub_agents": config.agent.enable_sub_agents
        }
    }


def validate_config(config: DemoRuntimeConfig) -> list[str]:
    """
    Validate a configuration object and return a list of validation errors.
    
    Args:
        config: DemoRuntimeConfig to validate
        
    Returns:
        List of validation error messages (empty if valid)
    """
    errors = []
    
    # Validate Caracal configuration
    if not config.caracal.base_url:
        errors.append("caracal.base_url is required")
    elif not config.caracal.base_url.startswith(("http://", "https://")):
        errors.append("caracal.base_url must start with http:// or https://")
    
    if not config.caracal.api_key:
        errors.append("caracal.api_key is required (check environment variable)")
    
    # Validate modes
    for mode_name, mode in config.modes.items():
        if not mode.mandates:
            errors.append(f"modes.{mode_name}.mandates is required")
        else:
            required_roles = {"orchestrator", "finance", "ops"}
            missing_roles = required_roles - set(mode.mandates.keys())
            if missing_roles:
                errors.append(
                    f"modes.{mode_name}.mandates is missing roles: {', '.join(missing_roles)}"
                )
    
    # Validate scenario configuration
    if config.scenario.scenarios_path:
        scenarios_path = Path(config.scenario.scenarios_path)
        if not scenarios_path.exists():
            errors.append(f"scenario.scenarios_path does not exist: {config.scenario.scenarios_path}")
        elif not scenarios_path.is_dir():
            errors.append(f"scenario.scenarios_path is not a directory: {config.scenario.scenarios_path}")
    
    # Validate UI configuration
    if config.ui.port < 1 or config.ui.port > 65535:
        errors.append(f"ui.port must be between 1 and 65535, got: {config.ui.port}")
    
    if config.ui.websocket_ping_interval < 1:
        errors.append(f"ui.websocket_ping_interval must be positive, got: {config.ui.websocket_ping_interval}")
    
    if config.ui.max_message_history < 1:
        errors.append(f"ui.max_message_history must be positive, got: {config.ui.max_message_history}")
    
    # Validate logging configuration
    if config.logging.log_to_file and not config.logging.log_file_path:
        errors.append("logging.log_file_path is required when log_to_file is true")
    
    if config.logging.max_file_size_mb < 1:
        errors.append(f"logging.max_file_size_mb must be positive, got: {config.logging.max_file_size_mb}")
    
    if config.logging.backup_count < 0:
        errors.append(f"logging.backup_count must be non-negative, got: {config.logging.backup_count}")
    
    # Validate mock system configuration
    if config.mock_system.config_path:
        mock_config_path = Path(config.mock_system.config_path)
        if not mock_config_path.exists():
            errors.append(f"mock_system.config_path does not exist: {config.mock_system.config_path}")
    
    # Validate agent configuration
    if config.agent.max_iterations < 1:
        errors.append(f"agent.max_iterations must be positive, got: {config.agent.max_iterations}")
    
    if config.agent.timeout_seconds < 1:
        errors.append(f"agent.timeout_seconds must be positive, got: {config.agent.timeout_seconds}")
    
    if config.agent.max_delegation_depth < 1:
        errors.append(f"agent.max_delegation_depth must be positive, got: {config.agent.max_delegation_depth}")
    
    return errors


def validate_config_file(config_path: Path | None = None) -> dict[str, Any]:
    """
    Validate a configuration file and return validation results.
    
    Args:
        config_path: Path to config file (uses default if None)
        
    Returns:
        Dictionary with validation results including:
        - valid: bool indicating if config is valid
        - errors: list of error messages
        - warnings: list of warning messages
    """
    if config_path is None:
        config_path = resolve_config_path()
    
    if not config_path.exists():
        return {
            "valid": False,
            "errors": [f"Configuration file not found: {config_path}"],
            "warnings": []
        }
    
    try:
        config = load_demo_runtime_config(require_api_key=False)
    except DemoConfigurationError as e:
        return {
            "valid": False,
            "errors": [str(e)],
            "warnings": []
        }
    except Exception as e:
        return {
            "valid": False,
            "errors": [f"Failed to load configuration: {e}"],
            "warnings": []
        }
    
    errors = validate_config(config)
    warnings = []
    
    # Add warnings for optional but recommended settings
    if not config.caracal.workspace_id:
        warnings.append("caracal.workspace_id is not set (recommended)")
    
    if not config.logging.log_to_file:
        warnings.append("logging.log_to_file is disabled (recommended for debugging)")
    
    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings
    }
