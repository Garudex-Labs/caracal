"""
Provider Manager screen.

Provider configuration is workspace-local in open-source mode and
provider-definition-driven across all flows.
"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import datetime
import json
import os
from pathlib import Path
import re
from typing import Optional
from urllib.parse import urlparse

from prompt_toolkit import prompt as pt_prompt
from prompt_toolkit.filters import Condition
from prompt_toolkit.formatted_text import FormattedText
from prompt_toolkit.key_binding import KeyBindings
from rich.console import Console
from rich.panel import Panel
from rich.prompt import Confirm, Prompt
from rich.table import Table

from caracal.deployment import ConfigManager, get_deployment_edition_adapter
from caracal.deployment.exceptions import SecretNotFoundError
from caracal.flow.components.menu import Menu, MenuItem
from caracal.flow.components.prompt import FlowPrompt, FlowValidator
from caracal.flow.screens._workspace_helpers import get_active_workspace_name
from caracal.flow.state import FlowState, RecentAction
from caracal.flow.theme import Colors, Icons
from caracal.provider.catalog import (
    ActionStarter,
    AUTH_SCHEME_GUIDANCE as SHARED_AUTH_SCHEME_GUIDANCE,
    GATEWAY_ONLY_AUTH as SHARED_GATEWAY_ONLY_AUTH,
    HTTP_METHODS as SHARED_HTTP_METHODS,
    IDENTIFIER_RE as SHARED_IDENTIFIER_RE,
    PROVIDER_PATTERNS as SHARED_PROVIDER_PATTERNS,
    ProviderStarterPattern,
    ResourceStarter,
    SERVICE_TYPE_GUIDANCE as SHARED_SERVICE_TYPE_GUIDANCE,
    resource_payload_from_pattern as shared_resource_payload_from_pattern,
    ensure_identifier,
    ensure_path_prefix,
    build_provider_record,
    build_resources_from_pattern as shared_build_resources_from_pattern,
)
from caracal.provider.definitions import (
    build_action_scope,
    build_resource_scope,
    resolve_provider_definition_id,
)
from caracal.provider.credential_store import (
    delete_workspace_provider_credential,
    store_workspace_provider_credential,
)
from caracal.provider.workspace import (
    load_workspace_provider_registry,
    save_workspace_provider_registry,
    sync_workspace_provider_registry_runtime,
)
from caracal.mcp.tool_registry_contract import (
    list_tool_bindings_by_provider,
)


_IDENTIFIER_RE = SHARED_IDENTIFIER_RE
_HTTP_METHODS = SHARED_HTTP_METHODS
_SERVICE_TYPE_GUIDANCE = SHARED_SERVICE_TYPE_GUIDANCE
_AUTH_SCHEME_GUIDANCE = SHARED_AUTH_SCHEME_GUIDANCE
_PROVIDER_PATTERNS = SHARED_PROVIDER_PATTERNS
_GATEWAY_ONLY_AUTH = SHARED_GATEWAY_ONLY_AUTH



def _available_patterns(service_type: str) -> tuple[ProviderStarterPattern, ...]:
    return tuple(
        pattern
        for pattern in _PROVIDER_PATTERNS.get(service_type, ())
        if pattern.recommended_auth_scheme not in _GATEWAY_ONLY_AUTH
    )


def _resolve_pattern_by_key(pattern_key: Optional[str]) -> Optional[ProviderStarterPattern]:
    if not pattern_key:
        return None
    for patterns in _PROVIDER_PATTERNS.values():
        for pattern in patterns:
            if pattern.key == pattern_key:
                return pattern
    return None


def _provider_mode(entry: dict[str, object]) -> str:
    definition = entry.get("definition")
    has_resources = isinstance(definition, dict) and bool(definition.get("resources"))
    if entry.get("enforce_scoped_requests") and has_resources:
        return "scoped"
    return "passthrough"


def _provider_credential_status(entry: dict[str, object]) -> str:
    auth_scheme = str(entry.get("auth_scheme") or "none")
    if auth_scheme == "none":
        return "not required"
    return "configured" if entry.get("credential_ref") else "missing"


def _definition_payload_for_existing_resources(
    entry: dict[str, object],
    *,
    provider_name: str,
    service_type: str,
    definition_id: str,
    auth_scheme: str,
    base_url: Optional[str],
    metadata: dict[str, object],
) -> Optional[dict[str, object]]:
    definition = entry.get("definition")
    if not isinstance(definition, dict):
        return None
    resources = dict(definition.get("resources") or {})
    if not resources:
        return None
    return {
        "definition_id": definition_id,
        "service_type": service_type,
        "display_name": provider_name,
        "auth_scheme": auth_scheme,
        "default_base_url": base_url,
        "resources": resources,
        "metadata": dict(metadata),
    }


def show_provider_manager(console: Console, state: FlowState) -> None:
    """Display provider manager interface."""
    while True:
        console.clear()
        console.print(
            Panel(
                f"[{Colors.PRIMARY}]Provider Manager[/]",
                subtitle=f"[{Colors.HINT}]Provider-defined resource/action catalog[/]",
                border_style=Colors.INFO,
            )
        )
        console.print()

        menu = Menu(
            "Provider Operations",
            items=[
                MenuItem("list", "List Providers", "View configured providers", Icons.LIST),
                MenuItem("add", "Add Provider", "Create provider in passthrough or scoped mode", Icons.ADD),
                MenuItem("update", "Update Provider", "Edit connection details and scoped catalog", Icons.SETTINGS),
                MenuItem("download", "Download Provider JSON", "Export a provider as JSON", Icons.EXPORT),
                MenuItem("import", "Import Provider JSON", "Validate and import provider JSON", Icons.IMPORT),
                MenuItem("remove", "Remove Provider", "Delete provider configuration", Icons.DELETE),
                MenuItem("tools", "Tool Registry", "Manage persisted tool mappings", Icons.SETTINGS),
                MenuItem("back", "Back to Menu", "", Icons.ARROW_LEFT),
            ],
        )
        result = menu.run()
        if not result or result.key == "back":
            break
        if result.key == "list":
            _list_providers(console)
        elif result.key == "add":
            _add_provider(console, state)
        elif result.key == "update":
            _update_provider(console, state)
        elif result.key == "download":
            _download_provider(console, state)
        elif result.key == "import":
            _import_provider(console, state)
        elif result.key == "remove":
            _remove_provider(console, state)
        elif result.key == "tools":
            _manage_tool_registry(console, state)


def _active_workspace(config_manager: ConfigManager) -> str:
    workspace = get_active_workspace_name(config_manager)
    if workspace:
        return workspace
    raise RuntimeError("No workspaces found. Create one first with 'caracal workspace create <name>'.")


def _list_providers(console: Console) -> None:
    config_manager = ConfigManager()
    workspace = _active_workspace(config_manager)
    providers = load_workspace_provider_registry(config_manager, workspace)

    def _read_tool_bindings() -> dict[str, list[str]]:
        try:
            from caracal.db.connection import get_db_manager

            db_manager = get_db_manager()
            try:
                with db_manager.session_scope() as db_session:
                    return list_tool_bindings_by_provider(db_session=db_session)
            finally:
                db_manager.close()
        except Exception:
            return {}

    tool_bindings = _read_tool_bindings()

    console.clear()
    console.print(
        Panel(
            f"[{Colors.PRIMARY}]Configured Providers[/]",
            subtitle=f"[{Colors.HINT}]Workspace: {workspace}[/]",
            border_style=Colors.INFO,
        )
    )
    console.print()

    if not providers:
        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No providers configured.[/]")
        console.print()
        Prompt.ask("Press Enter to continue", default="")
        return

    table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
    table.add_column("Name", style=Colors.PRIMARY)
    table.add_column("Definition", style=Colors.NEUTRAL)
    table.add_column("Auth", style=Colors.NEUTRAL)
    table.add_column("Endpoint", style=Colors.DIM)
    table.add_column("Credential", style=Colors.DIM)
    table.add_column("Mode", style=Colors.DIM)
    table.add_column("Tools", style=Colors.DIM)

    for name in sorted(providers.keys()):
        entry = providers[name]
        provider_tools = list(tool_bindings.get(name, []))
        if not provider_tools:
            tools_text = "-"
        elif len(provider_tools) <= 2:
            tools_text = ", ".join(provider_tools)
        else:
            tools_text = f"{len(provider_tools)} tools ({', '.join(provider_tools[:2])}...)"

        table.add_row(
            name,
            str(entry.get("provider_definition") or "custom"),
            str(entry.get("auth_scheme") or "api_key"),
            str(entry.get("base_url") or "configured"),
            _provider_credential_status(entry),
            _provider_mode(entry),
            tools_text,
        )

    console.print(table)
    console.print()
    Prompt.ask("Press Enter to continue", default="")


class _NoopMeteringCollector:
    def collect_event(self, _event) -> None:
        return None


@contextmanager
def _tool_registry_adapter():
    from caracal.core.authority import AuthorityEvaluator
    from caracal.db.connection import get_db_manager
    from caracal.mcp.adapter import MCPAdapter

    db_manager = get_db_manager()
    try:
        with db_manager.session_scope() as db_session:
            yield MCPAdapter(
                authority_evaluator=AuthorityEvaluator(db_session),
                metering_collector=_NoopMeteringCollector(),
            )
    finally:
        db_manager.close()


def _persist_workspace_providers(
    config_manager: ConfigManager,
    workspace: str,
    providers: dict[str, dict],
) -> list[dict[str, str]]:
    """Persist workspace provider metadata and mirror it into runtime provider rows."""
    save_workspace_provider_registry(config_manager, workspace, providers)
    sync_result = sync_workspace_provider_registry_runtime(
        workspace=workspace,
        providers=providers,
    )
    return list(sync_result.get("impacted") or [])


def _manage_tool_registry(console: Console, state: FlowState) -> None:
    while True:
        console.clear()
        console.print(
            Panel(
                f"[{Colors.PRIMARY}]Tool Registry[/]",
                subtitle=f"[{Colors.HINT}]Persisted MCP tool mappings and execution modes[/]",
                border_style=Colors.INFO,
            )
        )
        console.print()

        menu = Menu(
            "Tool Registry Operations",
            items=[
                MenuItem("list", "List Tools", "View registered tool mappings", Icons.LIST),
                MenuItem("register", "Register Tool", "Create or update tool registration", Icons.ADD),
                MenuItem("invoke", "Invoke Tool", "Execute a registered tool via SDKBridge", Icons.SUCCESS),
                MenuItem("deactivate", "Deactivate Tool", "Disable registered tool", Icons.DELETE),
                MenuItem("reactivate", "Reactivate Tool", "Enable registered tool", Icons.SUCCESS),
                MenuItem("back", "Back", "", Icons.ARROW_LEFT),
            ],
        )
        result = menu.run()
        if not result or result.key == "back":
            return

        if result.key == "list":
            _tool_registry_list(console)
        elif result.key == "register":
            _tool_registry_register(console, state)
        elif result.key == "invoke":
            _tool_registry_invoke(console, state)
        elif result.key == "deactivate":
            _tool_registry_set_active(console, state, active=False)
        elif result.key == "reactivate":
            _tool_registry_set_active(console, state, active=True)


def _tool_registry_list(console: Console) -> None:
    config_manager = ConfigManager()
    workspace = _active_workspace(config_manager)

    with _tool_registry_adapter() as adapter:
        rows = adapter.list_registered_tools(
            include_inactive=True,
            workspace_name=workspace,
        )

    console.clear()
    console.print(
        Panel(
            f"[{Colors.PRIMARY}]Registered Tools[/]",
            subtitle=f"[{Colors.HINT}]Workspace: {workspace}[/]",
            border_style=Colors.INFO,
        )
    )
    console.print()

    if not rows:
        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No tool registrations found.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
    table.add_column("Tool ID", style=Colors.PRIMARY)
    table.add_column("Provider", style=Colors.NEUTRAL)
    table.add_column("Resource", style=Colors.DIM)
    table.add_column("Action", style=Colors.DIM)
    table.add_column("Mode", style=Colors.NEUTRAL)
    table.add_column("Target", style=Colors.DIM)
    table.add_column("Status", style=Colors.NEUTRAL)

    for row in rows:
        active = bool(getattr(row, "active", False))
        status_text = "active" if active else "inactive"
        status_style = Colors.SUCCESS if active else Colors.WARNING
        table.add_row(
            str(getattr(row, "tool_id", "")),
            str(getattr(row, "provider_name", "") or "-"),
            str(getattr(row, "resource_scope", "") or "-"),
            str(getattr(row, "action_scope", "") or "-"),
            str(getattr(row, "execution_mode", "") or "mcp_forward"),
            str(getattr(row, "mcp_server_name", "") or "-"),
            f"[{status_style}]{status_text}[/]",
        )

    console.print(table)
    console.print()
    Prompt.ask("Press Enter to continue", default="")


def _tool_registry_register(console: Console, state: FlowState) -> None:
    config_manager = ConfigManager()
    workspace = _active_workspace(config_manager)
    providers = load_workspace_provider_registry(config_manager, workspace)

    if not providers:
        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No providers configured. Add a provider first.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    scoped_provider_names: list[str] = []
    provider_resources: dict[str, dict[str, dict]] = {}
    for provider_name in sorted(providers.keys()):
        entry = dict(providers.get(provider_name) or {})
        definition = entry.get("definition")
        resources = dict(definition.get("resources") or {}) if isinstance(definition, dict) else {}
        if resources:
            scoped_provider_names.append(provider_name)
            provider_resources[provider_name] = resources

    if not scoped_provider_names:
        console.print(
            f"  [{Colors.WARNING}]{Icons.WARNING} No scoped providers available. Add resource/action definitions first.[/]"
        )
        Prompt.ask("Press Enter to continue", default="")
        return

    prompt = FlowPrompt(console)

    console.clear()
    console.print(
        Panel(
            f"[{Colors.PRIMARY}]Register Tool[/]",
            subtitle=f"[{Colors.HINT}]Tool registrations are the canonical execution contract[/]",
            border_style=Colors.INFO,
        )
    )
    console.print()

    tool_id = prompt.text(
        "Tool ID",
        validator=lambda value: _validate_non_empty("Tool ID", value),
    ).strip()
    provider_name = prompt.select("Provider", scoped_provider_names, default=scoped_provider_names[0])
    resource_choices = sorted(provider_resources[provider_name].keys())
    resource_id = prompt.select("Resource", resource_choices, default=resource_choices[0])

    action_payload = dict(provider_resources[provider_name][resource_id].get("actions") or {})
    action_choices = sorted(action_payload.keys())
    if not action_choices:
        console.print(
            f"  [{Colors.ERROR}]{Icons.ERROR} Resource '{resource_id}' has no actions defined.[/]"
        )
        Prompt.ask("Press Enter to continue", default="")
        return
    action_id = prompt.select("Action", action_choices, default=action_choices[0])

    selected_action = dict(action_payload.get(action_id) or {})
    resource_scope = build_resource_scope(provider_name, resource_id)
    action_scope = build_action_scope(provider_name, action_id)
    execution_mode = "mcp_forward"
    tool_type = prompt.select("Tool type", ["direct_api", "logic"], default="direct_api")
    handler_ref = None
    mcp_server_name = prompt.text("MCP server name (optional)", default="").strip() or None

    actor_principal_id = prompt.text(
        "Actor principal ID (UUID)",
        validator=lambda value: _validate_non_empty("Actor principal ID", value),
    ).strip()

    provider_entry = dict(providers.get(provider_name) or {})
    provider_definition_id = str(provider_entry.get("provider_definition") or provider_name).strip()

    with _tool_registry_adapter() as adapter:
        row = adapter.register_tool(
            tool_id=tool_id,
            active=True,
            actor_principal_id=actor_principal_id,
            provider_name=provider_name,
            resource_scope=resource_scope,
            action_scope=action_scope,
            provider_definition_id=provider_definition_id,
            action_method=str(selected_action.get("method") or "").strip().upper() or None,
            action_path_prefix=str(selected_action.get("path_prefix") or "").strip() or None,
            execution_mode=execution_mode,
            mcp_server_name=mcp_server_name,
            workspace_name=workspace,
            tool_type=tool_type,
            handler_ref=handler_ref,
            mapping_version=None,
            allowed_downstream_scopes=[],
        )

    console.print()
    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Tool '{row.tool_id}' saved.[/]")
    if state:
        state.add_recent_action(
            RecentAction.create("tool_register", f"Registered tool {row.tool_id}", success=True)
        )
    Prompt.ask("Press Enter to continue", default="")


def _tool_registry_set_active(console: Console, state: FlowState, *, active: bool) -> None:
    action_name = "Reactivate" if active else "Deactivate"
    config_manager = ConfigManager()
    workspace = _active_workspace(config_manager)

    with _tool_registry_adapter() as adapter:
        rows = adapter.list_registered_tools(
            include_inactive=True,
            workspace_name=workspace,
        )

    candidates = [
        row for row in rows
        if bool(getattr(row, "active", False)) is (not active)
    ]
    if not candidates:
        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No tools available for {action_name.lower()}.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    prompt = FlowPrompt(console)
    tool_choices = [str(row.tool_id) for row in candidates]
    selected_tool = prompt.select(f"{action_name} tool", tool_choices, default=tool_choices[0])
    actor_principal_id = prompt.text(
        "Actor principal ID (UUID)",
        validator=lambda value: _validate_non_empty("Actor principal ID", value),
    ).strip()

    with _tool_registry_adapter() as adapter:
        if active:
            row = adapter.reactivate_tool(
                tool_id=selected_tool,
                actor_principal_id=actor_principal_id,
                workspace_name=workspace,
            )
        else:
            row = adapter.deactivate_tool(
                tool_id=selected_tool,
                actor_principal_id=actor_principal_id,
                workspace_name=workspace,
            )

    status_text = "active" if bool(getattr(row, "active", False)) else "inactive"
    console.print()
    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Tool '{row.tool_id}' is now {status_text}.[/]")
    if state:
        state.add_recent_action(
            RecentAction.create(
                "tool_reactivate" if active else "tool_deactivate",
                f"{action_name}d tool {row.tool_id}",
                success=True,
            )
        )
    Prompt.ask("Press Enter to continue", default="")


def _tool_registry_invoke(console: Console, state: FlowState) -> None:
    config_manager = ConfigManager()
    workspace = _active_workspace(config_manager)

    with _tool_registry_adapter() as adapter:
        rows = adapter.list_registered_tools(
            include_inactive=False,
            workspace_name=workspace,
        )

    if not rows:
        console.print(
            f"  [{Colors.WARNING}]{Icons.WARNING} No active tools available to invoke.[/]"
        )
        Prompt.ask("Press Enter to continue", default="")
        return

    prompt = FlowPrompt(console)
    tool_choices = [str(getattr(row, "tool_id", "")) for row in rows if str(getattr(row, "tool_id", ""))]
    if not tool_choices:
        console.print(
            f"  [{Colors.WARNING}]{Icons.WARNING} No valid tool IDs found in active registrations.[/]"
        )
        Prompt.ask("Press Enter to continue", default="")
        return

    console.clear()
    console.print(
        Panel(
            f"[{Colors.PRIMARY}]Invoke Registered Tool[/]",
            subtitle=f"[{Colors.HINT}]Execution goes through SDKBridge -> /mcp/tool/call[/]",
            border_style=Colors.INFO,
        )
    )
    console.print()

    selected_tool = prompt.select("Tool", sorted(tool_choices), default=sorted(tool_choices)[0])
    mandate_id = prompt.text(
        "Mandate ID (UUID)",
        validator=lambda value: _validate_non_empty("Mandate ID", value),
    ).strip()

    raw_tool_args = prompt.text("Tool args JSON", default="{}").strip() or "{}"
    try:
        parsed_tool_args = json.loads(raw_tool_args)
    except json.JSONDecodeError as exc:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Invalid JSON for tool args: {exc}[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    if not isinstance(parsed_tool_args, dict):
        console.print(
            f"  [{Colors.ERROR}]{Icons.ERROR} Tool args must be a JSON object.[/]"
        )
        Prompt.ask("Press Enter to continue", default="")
        return

    correlation_id = prompt.text("Correlation ID (optional)", default="").strip() or None

    default_base_url = os.environ.get(
        "CCL_API_URL",
        f"http://localhost:{os.environ.get('CCL_API_PORT', '8080')}",
    )
    base_url = prompt.text("API base URL", default=default_base_url).strip() or default_base_url
    default_api_key = os.environ.get("CCL_SESS_TOKEN", "")
    api_key = prompt.text("AIS session token (Bearer)", default=default_api_key).strip() or None

    from caracal.flow.sdk_bridge import SDKBridge

    bridge = SDKBridge(api_key=api_key, base_url=base_url)
    bridge.checkout(workspace_id=workspace)

    try:
        result = asyncio.run(
            bridge.call_tool(
                tool_id=selected_tool,
                mandate_id=mandate_id,
                tool_args=parsed_tool_args,
                correlation_id=correlation_id,
            )
        )
    except Exception as exc:
        console.print()
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Tool invocation failed: {exc}[/]")
        Prompt.ask("Press Enter to continue", default="")
        return
    finally:
        bridge.close()

    console.print()
    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Tool invocation completed.[/]")
    console.print()
    console.print(
        Panel(
            json.dumps(result, indent=2, default=str),
            title=f"[bold {Colors.INFO}]Result[/]",
            border_style=Colors.PRIMARY,
        )
    )

    if state:
        state.add_recent_action(
            RecentAction.create(
                "tool_invoke",
                f"Invoked tool {selected_tool}",
                success=True,
            )
        )

    Prompt.ask("Press Enter to continue", default="")


def _add_provider(console: Console, state: FlowState) -> None:
    edition_adapter = get_deployment_edition_adapter()
    if not edition_adapter.allows_local_provider_management():
        console.print(
            f"  [{Colors.WARNING}]{Icons.WARNING} Enterprise mode detected.[/] "
            f"[{Colors.DIM}]Register providers in the gateway vault/registry.[/]"
        )
        Prompt.ask("Press Enter to continue", default="")
        return

    config_manager = ConfigManager()
    workspace = _active_workspace(config_manager)
    providers = load_workspace_provider_registry(config_manager, workspace)
    prompt = FlowPrompt(console)

    console.clear()
    _render_provider_shell(
        console,
        workspace,
        "Create provider in passthrough or scoped mode with explicit user-entered fields.",
    )

    mode = prompt.select("Execution mode", ["passthrough", "scoped"], default="passthrough")
    service_type = prompt.text(
        "Service type",
        validator=lambda value: _validate_non_empty("Service type", value),
    ).strip().lower()

    name = _prompt_identifier(
        prompt=prompt,
        console=console,
        label="Provider name",
        purpose="Stable identifier shown in the UI and used in scopes.",
        used_for="Policies, mandates, and execution requests reference this name.",
        example="openai-main",
        existing=providers.keys(),
    )
    definition_choice = resolve_provider_definition_id(
        service_type=service_type,
        requested_definition=name,
    )

    auth_scheme, base_url, credential_mode, credential_value, credential_ref, auth_header_name = _collect_connection_settings(
        console=console,
        prompt=prompt,
        provider_name=name,
        existing_entry=None,
        allow_gateway_only=False,
    )

    resources: dict[str, dict] = {}
    if mode == "scoped":
        resources = _collect_resource_catalog(
            console=console,
            prompt=prompt,
            workspace=workspace,
            provider_name=name,
            service_type=service_type,
            pattern=None,
            initial_resources={},
        )

    advanced = {
        "healthcheck_path": "/health",
        "timeout_seconds": 30,
        "max_retries": 3,
        "rate_limit_rpm": None,
        "version": None,
    }

    stored_credential_ref = None
    if auth_scheme != "none":
        stored_credential_ref = credential_ref

    _render_summary(
        console=console,
        workspace=workspace,
        provider_name=name,
        definition_id=definition_choice,
        service_type=service_type,
        pattern=None,
        auth_scheme=auth_scheme,
        base_url=base_url,
        auth_header_name=auth_header_name,
        credential_mode=credential_mode,
        credential_ref=stored_credential_ref,
        credential_value=credential_value,
        resources=resources,
        advanced=advanced,
        mode=mode,
    )

    if not Confirm.ask(f"[{Colors.INFO}]Save provider '{name}'?[/]", default=True):
        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Provider setup cancelled.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    if auth_scheme != "none" and credential_mode == "store-new" and credential_value is not None:
        stored_credential_ref = store_workspace_provider_credential(
            workspace=workspace,
            provider_id=name,
            value=credential_value,
        )

    providers[name] = build_provider_record(
        name=name,
        service_type=service_type,
        definition_id=definition_choice,
        auth_scheme=auth_scheme,
        base_url=base_url or None,
        resources=resources,
        healthcheck_path=str(advanced["healthcheck_path"]),
        timeout_seconds=int(advanced["timeout_seconds"]),
        max_retries=int(advanced["max_retries"]),
        rate_limit_rpm=advanced["rate_limit_rpm"],
        version=advanced["version"],
        tags=[],
        metadata={},
        auth_header_name=auth_header_name,
        credential_ref=stored_credential_ref,
        existing=providers.get(name),
        created_at=datetime.utcnow().isoformat(),
        enforce_scoped_requests=mode == "scoped",
    )
    _persist_workspace_providers(config_manager, workspace, providers)

    console.print()
    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Provider '{name}' added.[/]")
    if state:
        state.add_recent_action(
            RecentAction.create("provider_add", f"Added provider {name}", success=True)
        )
    Prompt.ask("Press Enter to continue", default="")


def _update_provider(console: Console, state: FlowState) -> None:
    config_manager = ConfigManager()
    workspace = _active_workspace(config_manager)
    providers = load_workspace_provider_registry(config_manager, workspace)

    console.clear()
    _render_provider_shell(
        console,
        workspace,
        "Update connection details, auth, runtime knobs, and passthrough/scoped mode.",
    )

    if not providers:
        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No providers configured.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    prompt = FlowPrompt(console)
    names = sorted(providers.keys())
    selected = prompt.select("Provider", names, default=names[0])
    entry = dict(providers[selected] or {})

    mode = prompt.select(
        "Execution mode",
        ["passthrough", "scoped"],
        default=_provider_mode(entry),
    )
    service_type = prompt.text(
        "Service type",
        default=str(entry.get("service_type") or "application"),
        validator=lambda value: _validate_non_empty("Service type", value),
    ).strip().lower()
    definition_choice = resolve_provider_definition_id(
        service_type=service_type,
        requested_definition=str(entry.get("provider_definition") or selected),
    )
    auth_scheme, base_url, credential_mode, credential_value, credential_ref, auth_header_name = _collect_connection_settings(
        console=console,
        prompt=prompt,
        provider_name=selected,
        existing_entry=entry,
        allow_gateway_only=False,
    )
    advanced = _collect_advanced_settings(
        console=console,
        prompt=prompt,
        defaults={
            "healthcheck_path": str(entry.get("healthcheck_path") or "/health"),
            "timeout_seconds": int(entry.get("timeout_seconds") or 30),
            "max_retries": int(entry.get("max_retries") or 3),
            "rate_limit_rpm": entry.get("rate_limit_rpm"),
            "version": entry.get("version"),
        },
    )
    resources = {}
    if mode == "scoped":
        existing_resources: dict[str, dict] = {}
        definition = entry.get("definition")
        if isinstance(definition, dict):
            existing_resources = dict(definition.get("resources") or {})
        resources = _collect_resource_catalog(
            console=console,
            prompt=prompt,
            workspace=workspace,
            provider_name=selected,
            service_type=service_type,
            pattern=None,
            initial_resources=existing_resources,
        )

    stored_credential_ref = entry.get("credential_ref")
    if auth_scheme == "none" or credential_mode == "clear":
        stored_credential_ref = None
    elif credential_mode == "existing-ref":
        stored_credential_ref = credential_ref
    elif credential_mode == "store-new":
        stored_credential_ref = None

    if auth_scheme != "none" and credential_mode == "clear":
        console.print(
            f"  [{Colors.ERROR}]{Icons.ERROR} Authenticated providers need a credential. "
            f"Switch auth to 'none' if you want to clear it.[/]"
        )
        Prompt.ask("Press Enter to continue", default="")
        return

    metadata = dict(entry.get("metadata") or {})
    metadata.pop("starter_pattern", None)
    definition_payload = None
    if mode == "scoped":
        definition_payload = {
            "definition_id": definition_choice,
            "service_type": service_type,
            "display_name": selected,
            "auth_scheme": auth_scheme,
            "default_base_url": base_url or None,
            "resources": resources,
            "metadata": metadata,
        }

    _render_summary(
        console=console,
        workspace=workspace,
        provider_name=selected,
        definition_id=definition_choice,
        service_type=service_type,
        pattern=None,
        auth_scheme=auth_scheme,
        base_url=base_url,
        auth_header_name=auth_header_name,
        credential_mode=credential_mode,
        credential_ref=stored_credential_ref,
        credential_value=credential_value,
        resources=resources,
        advanced=advanced,
        mode=mode,
    )

    if not Confirm.ask(f"[{Colors.INFO}]Update provider '{selected}'?[/]", default=True):
        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Provider update cancelled.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    if auth_scheme == "none" or credential_mode == "clear":
        existing_ref = entry.get("credential_ref")
        if existing_ref:
            try:
                delete_workspace_provider_credential(workspace, existing_ref)
            except SecretNotFoundError:
                pass
        stored_credential_ref = None
    elif credential_mode == "store-new" and credential_value is not None:
        stored_credential_ref = store_workspace_provider_credential(
            workspace=workspace,
            provider_id=selected,
            value=credential_value,
        )

    providers[selected] = build_provider_record(
        name=selected,
        service_type=service_type,
        definition_id=definition_choice,
        auth_scheme=auth_scheme,
        base_url=base_url or None,
        definition=definition_payload,
        healthcheck_path=str(advanced["healthcheck_path"]),
        timeout_seconds=int(advanced["timeout_seconds"]),
        max_retries=int(advanced["max_retries"]),
        rate_limit_rpm=advanced["rate_limit_rpm"],
        version=advanced["version"],
        tags=list(entry.get("tags") or []),
        metadata=metadata,
        auth_header_name=auth_header_name,
        credential_ref=stored_credential_ref,
        existing=entry,
        created_at=str(entry.get("created_at") or datetime.utcnow().isoformat()),
        enforce_scoped_requests=mode == "scoped",
    )
    impacted = _persist_workspace_providers(config_manager, workspace, providers)

    console.print()
    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Provider '{selected}' updated.[/]")
    if impacted:
        console.print(
            f"  [{Colors.WARNING}]{Icons.WARNING} Deactivated {len(impacted)} mapped tool(s) due provider mapping drift.[/]"
        )
        for item in impacted:
            console.print(f"    • {item['tool_id']}: {item['reason']}")
    if state:
        state.add_recent_action(
            RecentAction.create("provider_update", f"Updated provider {selected}", success=True)
        )
    Prompt.ask("Press Enter to continue", default="")


def _enrich_provider(console: Console, state: FlowState) -> None:
    config_manager = ConfigManager()
    workspace = _active_workspace(config_manager)
    providers = load_workspace_provider_registry(config_manager, workspace)

    console.clear()
    _render_provider_shell(
        console,
        workspace,
        "Add or edit the scoped resource/action catalog for an existing provider.",
    )

    if not providers:
        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No providers configured.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    prompt = FlowPrompt(console)
    names = sorted(providers.keys())
    selected = prompt.select("Provider", names, default=names[0])
    entry = dict(providers[selected] or {})
    service_type = _prompt_service_type(
        prompt,
        console,
        default=str(entry.get("service_type") or "application"),
    )
    pattern = None
    starter_mode = prompt.select(
        "Catalog starting point",
        ["current", "template", "blank"],
        default="current" if _provider_mode(entry) == "scoped" else "template",
    )
    if starter_mode == "template":
        pattern = _prompt_provider_pattern(prompt, console, service_type)

    initial_resources: dict[str, dict] = {}
    if starter_mode == "current":
        definition = entry.get("definition")
        if isinstance(definition, dict):
            initial_resources = dict(definition.get("resources") or {})
    elif starter_mode == "template" and pattern:
        initial_resources = _build_resources_from_pattern(pattern)

    resources = _collect_resource_catalog(
        console=console,
        prompt=prompt,
        workspace=workspace,
        provider_name=selected,
        service_type=service_type,
        pattern=pattern,
        initial_resources=initial_resources,
    )
    definition_choice = resolve_provider_definition_id(
        service_type=service_type,
        requested_definition=pattern.key if pattern else str(entry.get("provider_definition") or selected),
    )
    metadata = dict(entry.get("metadata") or {})
    template_id = entry.get("template_id")
    if pattern:
        metadata["starter_pattern"] = pattern.key
        template_id = pattern.key

    advanced = {
        "healthcheck_path": str(entry.get("healthcheck_path") or "/health"),
        "timeout_seconds": int(entry.get("timeout_seconds") or 30),
        "max_retries": int(entry.get("max_retries") or 3),
        "rate_limit_rpm": entry.get("rate_limit_rpm"),
        "version": entry.get("version"),
    }
    _render_summary(
        console=console,
        workspace=workspace,
        provider_name=selected,
        definition_id=definition_choice,
        service_type=service_type,
        pattern=pattern,
        auth_scheme=str(entry.get("auth_scheme") or "api_key"),
        base_url=str(entry.get("base_url") or ""),
        auth_header_name=(entry.get("auth_metadata") or {}).get("header_name"),
        credential_mode="keep-existing",
        credential_ref=entry.get("credential_ref"),
        credential_value=None,
        resources=resources,
        advanced=advanced,
        mode="scoped",
    )

    if not Confirm.ask(f"[{Colors.INFO}]Save scoped catalog for '{selected}'?[/]", default=True):
        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Scoped enrichment cancelled.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    definition_payload = {
        "definition_id": definition_choice,
        "service_type": service_type,
        "display_name": selected,
        "auth_scheme": str(entry.get("auth_scheme") or "api_key"),
        "default_base_url": entry.get("base_url"),
        "resources": resources,
        "metadata": metadata,
    }
    providers[selected] = build_provider_record(
        name=selected,
        service_type=service_type,
        definition_id=definition_choice,
        auth_scheme=str(entry.get("auth_scheme") or "api_key"),
        base_url=entry.get("base_url"),
        definition=definition_payload,
        healthcheck_path=str(entry.get("healthcheck_path") or "/health"),
        timeout_seconds=int(entry.get("timeout_seconds") or 30),
        max_retries=int(entry.get("max_retries") or 3),
        rate_limit_rpm=entry.get("rate_limit_rpm"),
        version=entry.get("version"),
        tags=list(entry.get("tags") or []),
        metadata=metadata,
        template_id=template_id,
        auth_header_name=(entry.get("auth_metadata") or {}).get("header_name"),
        credential_ref=entry.get("credential_ref"),
        existing=entry,
        created_at=str(entry.get("created_at") or datetime.utcnow().isoformat()),
        enforce_scoped_requests=True,
    )
    impacted = _persist_workspace_providers(config_manager, workspace, providers)

    console.print()
    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Provider '{selected}' enriched.[/]")
    if impacted:
        console.print(
            f"  [{Colors.WARNING}]{Icons.WARNING} Deactivated {len(impacted)} mapped tool(s) due provider mapping drift.[/]"
        )
        for item in impacted:
            console.print(f"    • {item['tool_id']}: {item['reason']}")
    if state:
        state.add_recent_action(
            RecentAction.create("provider_enrich", f"Enriched provider {selected}", success=True)
        )
    Prompt.ask("Press Enter to continue", default="")


def _collect_connection_settings(
    *,
    console: Console,
    prompt: FlowPrompt,
    provider_name: str,
    existing_entry: Optional[dict[str, object]],
    allow_gateway_only: bool,
) -> tuple[str, str, Optional[str], Optional[str], Optional[str], Optional[str]]:
    console.print()
    console.print(
        Panel(
            "Choose the connection contract Caracal will execute against. Each field explains what you should enter, the expected format, and how execution will use it.",
            title=f"[bold {Colors.INFO}]Connection + Auth[/]",
            border_style=Colors.PRIMARY,
        )
    )
    _render_auth_scheme_table(console, allow_gateway_only=allow_gateway_only)

    visible_auth_schemes = [
        scheme for scheme in sorted(_AUTH_SCHEME_GUIDANCE.keys())
        if allow_gateway_only or scheme not in _GATEWAY_ONLY_AUTH
    ]
    existing_auth = str(existing_entry.get("auth_scheme") or "") if existing_entry else ""
    suggested_auth = existing_auth or "api_key"
    if suggested_auth not in visible_auth_schemes:
        suggested_auth = visible_auth_schemes[0]
    auth_scheme = prompt.select(
        "Auth scheme",
        visible_auth_schemes,
        default=suggested_auth,
    )

    auth_info = _AUTH_SCHEME_GUIDANCE[auth_scheme]
    _print_field_help(
        console,
        purpose=auth_info["expects"],
        expected_format=f"Choose one of: {', '.join(visible_auth_schemes)}",
        used_for=auth_info["caracal_use"],
    )

    if allow_gateway_only and auth_scheme in _GATEWAY_ONLY_AUTH:
        console.print(
            Panel(
                "This auth scheme is stored correctly in open-source workspaces, but direct OSS broker execution does not translate it at runtime. Use the Enterprise gateway when you need token exchange or service-account mediation.",
                title=f"[bold {Colors.WARNING}]Gateway-Mediated Auth[/]",
                border_style=Colors.WARNING,
            )
        )

    _print_field_help(
        console,
        purpose="Base URL for the provider API or service root.",
        expected_format="Full http/https URL.",
        used_for="Caracal combines this with each action path prefix during execution.",
        example="https://api.example.com",
    )
    base_url = prompt.text(
        "Base URL",
        default=str(existing_entry.get("base_url") or "") if existing_entry else "",
        validator=_validate_required_url,
    )

    auth_header_name = None
    credential_mode = None
    credential_value = None
    credential_ref = None

    if auth_scheme == "header":
        _print_field_help(
            console,
            purpose="Exact HTTP header name that should receive the credential.",
            expected_format="Header token such as X-API-Key or Authorization.",
            used_for="Caracal writes the secret to this header for each request.",
            example="X-Provider-Key",
        )
        auth_header_name = prompt.text(
            "Header name",
            default=str((existing_entry.get("auth_metadata") or {}).get("header_name") or "") if existing_entry else "",
            validator=lambda value: _validate_non_empty("Header name", value),
        )

    if auth_scheme != "none":
        console.print(
            Panel(
                "Credential values are stored in the workspace vault. New credential capture is multiline-safe and hidden by default. Existing credential refs are available when you already manage secrets separately.",
                title=f"[bold {Colors.INFO}]Credential Handling[/]",
                border_style=Colors.PRIMARY,
            )
        )
        has_existing_ref = bool(existing_entry and existing_entry.get("credential_ref"))
        credential_choices = ["store-new", "existing-ref"]
        default_credential_mode = "store-new"
        if has_existing_ref:
            credential_choices = ["keep-existing"] + credential_choices + ["clear"]
            default_credential_mode = "keep-existing"
        credential_mode = prompt.select(
            "Credential source",
            credential_choices,
            default=default_credential_mode,
        )

        if credential_mode == "keep-existing":
            credential_ref = str(existing_entry.get("credential_ref") or "")
        elif credential_mode == "store-new":
            _print_field_help(
                console,
                purpose="Secret or token content for the provider. Multiline blocks are preserved exactly as typed.",
                expected_format="Any raw secret block, including tokens, PEM text, JSON, headers, quoted blocks, or line breaks.",
                used_for="Caracal encrypts it in the workspace vault and injects or forwards it according to the auth scheme.",
                example="API token, username:password, PEM, or JSON service credential.",
            )
            credential_value = _prompt_secret_block(
                console,
                label=f"Credential for {provider_name}",
            )
        else:
            _print_field_help(
                console,
                purpose="Reference to a secret already stored in the workspace vault.",
                expected_format="Existing secret key string.",
                used_for="Caracal resolves this reference at execution time instead of creating a new secret.",
                example=f"provider_{provider_name}_credential",
            )
            credential_ref = prompt.text(
                "Existing credential ref",
                default=str(existing_entry.get("credential_ref") or "") if existing_entry else "",
                validator=lambda value: _validate_non_empty("Credential ref", value),
            )

    return auth_scheme, base_url.strip(), credential_mode, credential_value, credential_ref, auth_header_name


def _collect_resource_catalog(
    *,
    console: Console,
    prompt: FlowPrompt,
    workspace: str,
    provider_name: str,
    service_type: str,
    pattern: Optional[ProviderStarterPattern],
    initial_resources: Optional[dict[str, dict]] = None,
) -> dict[str, dict]:
    console.print()
    console.print(
        Panel(
            "Resources and actions define the exact authority surface Caracal will expose. Resource IDs become provider-scoped resource scopes, action IDs become provider-scoped action scopes, and each action's method/path prefix is checked during execution.",
            title=f"[bold {Colors.INFO}]Resources + Actions[/]",
            border_style=Colors.PRIMARY,
        )
    )

    resources: dict[str, dict] = dict(initial_resources or {})
    if pattern and not resources:
        _render_pattern_preview(console, provider_name, pattern)
        if prompt.confirm("Start with the suggested starter catalog?", default=True):
            resources = _build_resources_from_pattern(pattern)

    while True:
        console.clear()
        _render_provider_shell(
            console,
            workspace,
            f"Catalog editor for provider '{provider_name}'.",
        )
        _render_catalog(console, provider_name, service_type, resources, pattern)

        choices = ["add-resource", "add-action"]
        if resources:
            choices.extend(["remove-action", "remove-resource"])
        choices.append("done")

        default_choice = "done" if _catalog_is_complete(resources) else choices[0]
        step = prompt.select("Catalog step", choices, default=default_choice)

        if step == "done":
            error = _validate_catalog(resources)
            if error:
                console.print(f"  [{Colors.ERROR}]{Icons.ERROR} {error}[/]")
                Prompt.ask("Press Enter to continue", default="")
                continue
            return resources
        if step == "add-resource":
            _add_resource_to_catalog(console, prompt, service_type, pattern, resources)
        elif step == "add-action":
            _add_action_to_catalog(console, prompt, service_type, pattern, resources)
        elif step == "remove-action":
            _remove_action_from_catalog(prompt, resources)
        elif step == "remove-resource":
            _remove_resource_from_catalog(prompt, resources)


def _collect_advanced_settings(
    *,
    console: Console,
    prompt: FlowPrompt,
    defaults: Optional[dict[str, object]] = None,
) -> dict[str, object]:
    advanced: dict[str, object] = {
        "healthcheck_path": "/health",
        "timeout_seconds": 30,
        "max_retries": 3,
        "rate_limit_rpm": None,
        "version": None,
    }
    if defaults:
        advanced.update(defaults)

    console.print()
    console.print(
        Panel(
            "Advanced settings stay optional. Keep the defaults for a fast setup, or open the section to tune health checks, retries, limits, and version labeling.",
            title=f"[bold {Colors.INFO}]Advanced Runtime Settings[/]",
            border_style=Colors.PRIMARY,
        )
    )

    if not prompt.confirm("Customize advanced settings?", default=False):
        return advanced

    _print_field_help(
        console,
        purpose="Endpoint used for provider health checks.",
        expected_format="Path beginning with '/'.",
        used_for="Caracal calls it when health or readiness checks are performed.",
        example="/health",
    )
    advanced["healthcheck_path"] = prompt.text(
        "Health check path",
        default=str(advanced["healthcheck_path"]),
        validator=_validate_path_prefix,
    )

    _print_field_help(
        console,
        purpose="Per-request timeout.",
        expected_format="Positive whole number of seconds.",
        used_for="Caracal stops execution when the upstream takes too long.",
        example="30",
    )
    advanced["timeout_seconds"] = int(
        prompt.number("Timeout seconds", default=int(advanced["timeout_seconds"]), min_value=1)
    )

    _print_field_help(
        console,
        purpose="Retry attempts after the initial failure.",
        expected_format="Whole number 0 or greater.",
        used_for="Controls how aggressively Caracal retries transient provider failures.",
        example="3",
    )
    advanced["max_retries"] = int(
        prompt.number("Max retries", default=int(advanced["max_retries"]), min_value=0)
    )

    _print_field_help(
        console,
        purpose="Optional client-side request cap.",
        expected_format="Blank or whole number requests per minute.",
        used_for="Applies local throttling before requests are sent upstream.",
        example="120",
    )
    rate_limit_raw = prompt.text(
        "Rate limit rpm",
        default=str(advanced["rate_limit_rpm"] or ""),
        validator=_validate_optional_int,
        required=False,
    )
    advanced["rate_limit_rpm"] = int(rate_limit_raw) if rate_limit_raw else None

    _print_field_help(
        console,
        purpose="Optional API or provider version label.",
        expected_format="Any short label.",
        used_for="Stored with the provider config for operator clarity and future migrations.",
        example="2026-03",
    )
    version = prompt.text("Version label", default=str(advanced["version"] or ""), required=False)
    advanced["version"] = version or None

    return advanced


def _prompt_service_type(prompt: FlowPrompt, console: Console, default: str = "application") -> str:
    console.print()
    console.print(
        Panel(
            "Pick a broad provider category to unlock starter patterns and examples. These are curated defaults, not fixed system types. If your provider does not fit cleanly, choose 'custom' and enter your own service type identifier.",
            title=f"[bold {Colors.INFO}]Service Type[/]",
            border_style=Colors.PRIMARY,
        )
    )
    table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
    table.add_column("Type", style=Colors.PRIMARY)
    table.add_column("Use For", style=Colors.NEUTRAL)
    table.add_column("Example IDs", style=Colors.DIM)
    table.add_column("Caracal Use", style=Colors.DIM)
    for service_type, info in _SERVICE_TYPE_GUIDANCE.items():
        table.add_row(service_type, info["purpose"], info["examples"], info["caracal_use"])
    console.print(table)
    choice = prompt.select(
        "Service type",
        list(_SERVICE_TYPE_GUIDANCE.keys()) + ["custom"],
        default=default if default in _SERVICE_TYPE_GUIDANCE else "custom",
    )
    if choice != "custom":
        return choice

    return _prompt_identifier(
        prompt=prompt,
        console=console,
        label="Custom service type",
        purpose="A custom category label for providers that do not fit the curated starter list.",
        used_for="Stored with the provider definition so operators can group and search similar providers consistently.",
        example="erp, crm, search, browser-automation",
    )


def _prompt_provider_pattern(
    prompt: FlowPrompt,
    console: Console,
    service_type: str,
) -> Optional[ProviderStarterPattern]:
    patterns = list(_available_patterns(service_type))
    if not patterns:
        return None

    console.print()
    console.print(
        Panel(
            "Starter patterns provide structured defaults, examples, and action shapes for common provider setups. Pick one to start faster, or choose 'custom' for a blank catalog.",
            title=f"[bold {Colors.INFO}]Starter Pattern[/]",
            border_style=Colors.PRIMARY,
        )
    )
    table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
    table.add_column("Key", style=Colors.PRIMARY)
    table.add_column("Pattern", style=Colors.NEUTRAL)
    table.add_column("Best For", style=Colors.NEUTRAL)
    table.add_column("Starter Resources", style=Colors.DIM)
    for pattern in patterns:
        table.add_row(
            pattern.key,
            pattern.label,
            pattern.description,
            ", ".join(resource.resource_id for resource in pattern.resources),
        )
    table.add_row("custom", "Custom catalog", "Start empty and define every resource/action yourself.", "-")
    console.print(table)

    choice = prompt.select(
        "Starter pattern",
        [pattern.key for pattern in patterns] + ["custom"],
        default=patterns[0].key,
    )
    if choice == "custom":
        return None
    return next(pattern for pattern in patterns if pattern.key == choice)


def _prompt_identifier(
    *,
    prompt: FlowPrompt,
    console: Console,
    label: str,
    purpose: str,
    used_for: str,
    example: str,
    default: str = "",
    existing: Optional[object] = None,
) -> str:
    _print_field_help(
        console,
        purpose=purpose,
        expected_format="Letters, numbers, '.', '-', '_' only.",
        used_for=used_for,
        example=example,
    )
    existing_values = {str(item) for item in existing} if existing else set()
    return prompt.text(
        label,
        default=default,
        validator=lambda value: _validate_identifier_value(label, value, existing_values),
    )


def _print_field_help(
    console: Console,
    *,
    purpose: str,
    expected_format: str,
    used_for: str,
    example: Optional[str] = None,
) -> None:
    message = (
        f"  [{Colors.HINT}]What:[/] [{Colors.DIM}]{purpose}[/]\n"
        f"  [{Colors.HINT}]Format:[/] [{Colors.DIM}]{expected_format}[/]\n"
        f"  [{Colors.HINT}]Used for:[/] [{Colors.DIM}]{used_for}[/]"
    )
    if example:
        message += f"\n  [{Colors.HINT}]Example:[/] [{Colors.DIM}]{example}[/]"
    console.print(message)


def _render_provider_shell(console: Console, workspace: str, subtitle: str) -> None:
    console.print(
        Panel(
            f"[{Colors.PRIMARY}]Provider Lifecycle[/]",
            subtitle=f"[{Colors.HINT}]Workspace: {workspace} | {subtitle}[/]",
            border_style=Colors.INFO,
        )
    )
    console.print()


def _render_auth_scheme_table(console: Console, *, allow_gateway_only: bool) -> None:
    table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
    table.add_column("Scheme", style=Colors.PRIMARY)
    table.add_column("Input Expected", style=Colors.NEUTRAL)
    table.add_column("Execution Behavior", style=Colors.DIM)
    for scheme, info in _AUTH_SCHEME_GUIDANCE.items():
        if not allow_gateway_only and scheme in _GATEWAY_ONLY_AUTH:
            continue
        table.add_row(scheme, info["expects"], info["caracal_use"])
    console.print(table)


def _render_pattern_preview(
    console: Console,
    provider_name: str,
    pattern: ProviderStarterPattern,
) -> None:
    console.print()
    console.print(
        Panel(
            f"Pattern: [bold]{pattern.label}[/]\n"
            f"Recommended auth: [bold]{pattern.recommended_auth_scheme}[/]\n"
            f"Base URL example: [bold]{pattern.base_url_example}[/]\n"
            f"Why it helps: {pattern.description}\n\n"
            f"Scopes will look like [bold]{build_resource_scope(provider_name, pattern.resources[0].resource_id)}[/] and "
            f"[bold]{build_action_scope(provider_name, pattern.resources[0].actions[0].action_id)}[/].",
            title=f"[bold {Colors.INFO}]Starter Catalog Preview[/]",
            border_style=Colors.PRIMARY,
        )
    )
    action_table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
    action_table.add_column("Resource", style=Colors.PRIMARY)
    action_table.add_column("Action", style=Colors.NEUTRAL)
    action_table.add_column("Method", style=Colors.NEUTRAL)
    action_table.add_column("Path Prefix", style=Colors.DIM)
    for resource in pattern.resources:
        for action in resource.actions:
            action_table.add_row(resource.resource_id, action.action_id, action.method, action.path_prefix)
    console.print(action_table)


def _render_catalog(
    console: Console,
    provider_name: str,
    service_type: str,
    resources: dict[str, dict],
    pattern: Optional[ProviderStarterPattern],
) -> None:
    console.print(
        Panel(
            "Every resource must have at least one action. Caracal validates method + path_prefix against requests, and policies or mandates reference the generated provider scopes directly.",
            title=f"[bold {Colors.INFO}]Current Catalog[/]",
            border_style=Colors.PRIMARY,
        )
    )

    if not resources:
        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No resources defined yet.[/]")
        examples = _resource_examples(service_type, pattern)
        console.print(
            f"  [{Colors.DIM}]Examples for {service_type}: {', '.join(examples)}. "
            f"Resources become scopes like {build_resource_scope(provider_name, examples[0])}.[/]"
        )
        console.print()
        return

    resource_table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
    resource_table.add_column("Resource", style=Colors.PRIMARY)
    resource_table.add_column("Description", style=Colors.NEUTRAL)
    resource_table.add_column("Actions", style=Colors.NEUTRAL)
    resource_table.add_column("Resource Scope", style=Colors.DIM)
    for resource_id in sorted(resources.keys()):
        payload = resources[resource_id]
        resource_table.add_row(
            resource_id,
            str(payload.get("description") or resource_id),
            ", ".join(sorted(payload.get("actions", {}).keys())) or "-",
            build_resource_scope(provider_name, resource_id),
        )
    console.print(resource_table)
    console.print()

    action_table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
    action_table.add_column("Resource", style=Colors.PRIMARY)
    action_table.add_column("Action", style=Colors.NEUTRAL)
    action_table.add_column("Method", style=Colors.NEUTRAL)
    action_table.add_column("Path Prefix", style=Colors.DIM)
    action_table.add_column("Action Scope", style=Colors.DIM)
    for resource_id in sorted(resources.keys()):
        actions = resources[resource_id].get("actions", {})
        for action_id in sorted(actions.keys()):
            action = actions[action_id]
            action_table.add_row(
                resource_id,
                action_id,
                str(action.get("method") or "POST"),
                str(action.get("path_prefix") or "/"),
                build_action_scope(provider_name, action_id),
            )
    console.print(action_table)
    console.print()
    console.print(
        f"  [{Colors.DIM}]Mandates, policies, delegation scopes, and execution enforcement all depend on these exact IDs. Use stable names, not temporary UI labels.[/]"
    )


def _add_resource_to_catalog(
    console: Console,
    prompt: FlowPrompt,
    service_type: str,
    pattern: Optional[ProviderStarterPattern],
    resources: dict[str, dict],
) -> None:
    examples = _resource_examples(service_type, pattern)
    _print_field_help(
        console,
        purpose="Logical provider surface such as a capability, entity family, or endpoint group.",
        expected_format="Letters, numbers, '.', '-', '_' only.",
        used_for="Caracal turns it into a provider resource scope and uses it in policies and mandate checks.",
        example=examples[0],
    )
    resource_id = prompt.text(
        "Resource ID",
        validator=lambda value: _validate_identifier_value("Resource ID", value, resources.keys()),
    )
    _print_field_help(
        console,
        purpose="Short explanation shown to operators when reviewing the provider catalog.",
        expected_format="Free text.",
        used_for="Stored in the structured definition to make the catalog self-explanatory.",
        example="Ticket records managed through the external CRM API.",
    )
    description = prompt.text("Resource description", default=resource_id, required=False) or resource_id
    resources[resource_id] = {"description": description, "actions": {}}

    starter_resource = _find_pattern_resource(pattern, resource_id)
    if starter_resource and prompt.confirm(
        f"Apply suggested actions for resource '{resource_id}'?",
        default=True,
    ):
        resources[resource_id] = shared_resource_payload_from_pattern(starter_resource)


def _add_action_to_catalog(
    console: Console,
    prompt: FlowPrompt,
    service_type: str,
    pattern: Optional[ProviderStarterPattern],
    resources: dict[str, dict],
) -> None:
    if not resources:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Add a resource first.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    resource_id = prompt.select(
        "Attach action to resource",
        sorted(resources.keys()),
        default=sorted(resources.keys())[0],
    )
    action_starters = _remaining_action_starters(pattern, resource_id, resources)
    selected_starter = None
    if action_starters:
        table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
        table.add_column("Starter", style=Colors.PRIMARY)
        table.add_column("Method", style=Colors.NEUTRAL)
        table.add_column("Path Prefix", style=Colors.DIM)
        for starter in action_starters:
            table.add_row(starter.action_id, starter.method, starter.path_prefix)
        console.print(table)
        starter_choice = prompt.select(
            "Action starter",
            [starter.action_id for starter in action_starters] + ["custom"],
            default=action_starters[0].action_id,
        )
        if starter_choice != "custom":
            selected_starter = next(
                starter for starter in action_starters if starter.action_id == starter_choice
            )

    action_examples = _action_examples(service_type, pattern, resource_id)
    _print_field_help(
        console,
        purpose="Verb or capability exposed on the selected resource.",
        expected_format="Letters, numbers, '.', '-', '_' only.",
        used_for="Caracal turns it into a provider action scope and matches it against policies, delegation, and execution checks.",
        example=selected_starter.action_id if selected_starter else action_examples[0],
    )
    action_id = prompt.text(
        "Action ID",
        default=selected_starter.action_id if selected_starter else "",
        validator=lambda value: _validate_identifier_value(
            "Action ID",
            value,
            resources[resource_id]["actions"].keys(),
        ),
    )

    _print_field_help(
        console,
        purpose="Readable explanation of the action.",
        expected_format="Free text.",
        used_for="Stored with the provider definition to explain the action surface to operators.",
        example="Create a ticket in the upstream system.",
    )
    description = prompt.text(
        "Action description",
        default=selected_starter.description if selected_starter else action_id,
        required=False,
    ) or action_id

    _print_field_help(
        console,
        purpose="HTTP method used when this action executes.",
        expected_format="GET, POST, PUT, PATCH, or DELETE.",
        used_for="Caracal validates the outgoing request method against this definition.",
        example=selected_starter.method if selected_starter else "POST",
    )
    method = prompt.select(
        "HTTP method",
        _HTTP_METHODS,
        default=selected_starter.method if selected_starter else "POST",
    )

    _print_field_help(
        console,
        purpose="Path prefix beneath the base URL for requests using this action.",
        expected_format="Path starting with '/'.",
        used_for="Caracal checks that execution requests stay within this path boundary.",
        example=selected_starter.path_prefix if selected_starter else "/v1/resource",
    )
    path_prefix = prompt.text(
        "Path prefix",
        default=selected_starter.path_prefix if selected_starter else "/",
        validator=_validate_path_prefix,
    )

    resources[resource_id]["actions"][action_id] = {
        "description": description,
        "method": method,
        "path_prefix": path_prefix,
    }


def _remove_action_from_catalog(prompt: FlowPrompt, resources: dict[str, dict]) -> None:
    resource_id = prompt.select("Resource", sorted(resources.keys()), default=sorted(resources.keys())[0])
    action_ids = sorted(resources[resource_id]["actions"].keys())
    if not action_ids:
        return
    action_id = prompt.select("Action", action_ids, default=action_ids[0])
    del resources[resource_id]["actions"][action_id]


def _remove_resource_from_catalog(prompt: FlowPrompt, resources: dict[str, dict]) -> None:
    resource_id = prompt.select("Remove resource", sorted(resources.keys()), default=sorted(resources.keys())[0])
    del resources[resource_id]


def _render_summary(
    *,
    console: Console,
    workspace: str,
    provider_name: str,
    definition_id: str,
    service_type: str,
    pattern: Optional[ProviderStarterPattern],
    auth_scheme: str,
    base_url: str,
    auth_header_name: Optional[str],
    credential_mode: Optional[str],
    credential_ref: Optional[str],
    credential_value: Optional[str],
    resources: dict[str, dict],
    advanced: dict[str, object],
    mode: str,
) -> None:
    console.clear()
    _render_provider_shell(console, workspace, "Review the complete provider contract before it is saved.")

    summary = Table(show_header=False, box=None, padding=(0, 2))
    summary.add_column("Field", style=Colors.DIM)
    summary.add_column("Value", style=Colors.NEUTRAL)
    summary.add_row("Provider name", provider_name)
    summary.add_row("Definition ID", definition_id)
    summary.add_row("Service type", service_type)
    summary.add_row("Auth scheme", auth_scheme)
    summary.add_row("Mode", mode)
    summary.add_row("Base URL", base_url or "(not set)")
    if auth_header_name:
        summary.add_row("Header name", auth_header_name)
    if auth_scheme != "none":
        if credential_mode == "store-new":
            summary.add_row("Credential", _masked_secret_summary(credential_value or ""))
            summary.add_row("Secret ref", credential_ref or "(generated)")
        elif credential_mode == "keep-existing":
            summary.add_row("Credential", f"Keep existing ref: {credential_ref}")
        elif credential_mode == "clear":
            summary.add_row("Credential", "Remove configured credential")
        else:
            summary.add_row("Credential", f"Existing secret ref: {credential_ref}")
    summary.add_row("Health path", str(advanced["healthcheck_path"]))
    summary.add_row("Timeout", f"{advanced['timeout_seconds']} seconds")
    summary.add_row("Retries", str(advanced["max_retries"]))
    summary.add_row("Rate limit", str(advanced["rate_limit_rpm"] or "not set"))
    summary.add_row("Version", str(advanced["version"] or "not set"))
    console.print(summary)
    console.print()

    _render_catalog(console, provider_name, service_type, resources, pattern)
    console.print()

    if resources:
        first_resource = next(iter(sorted(resources.keys())))
        first_action = next(iter(sorted(resources[first_resource]["actions"].keys())))
        console.print(
            Panel(
                f"Policy / mandate resource scope example:\n[bold]{build_resource_scope(provider_name, first_resource)}[/]\n\n"
                f"Policy / mandate action scope example:\n[bold]{build_action_scope(provider_name, first_action)}[/]\n\n"
                "These exact scopes control what principals can request, delegate, and execute. The method/path definitions above constrain how runtime requests are matched to those scopes.",
                title=f"[bold {Colors.INFO}]Authority Preview[/]",
                border_style=Colors.PRIMARY,
            )
        )
    else:
        console.print(
            Panel(
                "This provider will be saved in passthrough mode. You can update it later and switch to scoped mode when you want resource/action enforcement.",
                title=f"[bold {Colors.INFO}]Passthrough Mode[/]",
                border_style=Colors.PRIMARY,
            )
        )


def _catalog_is_complete(resources: dict[str, dict]) -> bool:
    return bool(resources) and all(payload.get("actions") for payload in resources.values())


def _validate_catalog(resources: dict[str, dict]) -> Optional[str]:
    if not resources:
        return "At least one resource is required."
    for resource_id, payload in resources.items():
        if not payload.get("actions"):
            return f"Resource '{resource_id}' has no actions. Add at least one action per resource."
    return None


def _build_resources_from_pattern(pattern: ProviderStarterPattern) -> dict[str, dict]:
    return shared_build_resources_from_pattern(pattern)


def _resource_examples(service_type: str, pattern: Optional[ProviderStarterPattern]) -> list[str]:
    if pattern:
        return [resource.resource_id for resource in pattern.resources]
    for starter_pattern in _available_patterns(service_type):
        return [resource.resource_id for resource in starter_pattern.resources]
    return ["records"]


def _action_examples(
    service_type: str,
    pattern: Optional[ProviderStarterPattern],
    resource_id: str,
) -> list[str]:
    if pattern:
        starter_resource = _find_pattern_resource(pattern, resource_id)
        if starter_resource:
            return [action.action_id for action in starter_resource.actions]
    for starter_pattern in _available_patterns(service_type):
        starter_resource = _find_pattern_resource(starter_pattern, resource_id)
        if starter_resource:
            return [action.action_id for action in starter_resource.actions]
        if starter_pattern.resources:
            return [action.action_id for action in starter_pattern.resources[0].actions]
    return ["invoke"]


def _find_pattern_resource(
    pattern: Optional[ProviderStarterPattern],
    resource_id: str,
) -> Optional[ResourceStarter]:
    if not pattern:
        return None
    for resource in pattern.resources:
        if resource.resource_id == resource_id:
            return resource
    return None


def _remaining_action_starters(
    pattern: Optional[ProviderStarterPattern],
    resource_id: str,
    resources: dict[str, dict],
) -> list[ActionStarter]:
    starter_resource = _find_pattern_resource(pattern, resource_id)
    if not starter_resource:
        return []
    existing_actions = set(resources[resource_id]["actions"].keys())
    return [action for action in starter_resource.actions if action.action_id not in existing_actions]


def _prompt_secret_block(console: Console, *, label: str) -> str:
    console.print(
        Panel(
            "Hidden by default. Press F2 to reveal or hide the full secret. Enter inserts line breaks. Press Ctrl+S when the secret block is complete. The exact text you paste or type is preserved, including newlines, separators, quoted blocks, PEM markers, and header-style content.",
            title=f"[bold {Colors.INFO}]Secure Credential Input[/]",
            border_style=Colors.PRIMARY,
        )
    )

    hidden = [True]

    @Condition
    def is_hidden():
        return hidden[0]

    bindings = KeyBindings()

    @bindings.add("f2")
    def _toggle_visibility(event) -> None:
        hidden[0] = not hidden[0]

    @bindings.add("c-s")
    def _accept_secret(event) -> None:
        event.current_buffer.validate_and_handle()

    prompt_text = FormattedText(
        [
            (Colors.HINT, f"  {Icons.ARROW_RIGHT} "),
            (Colors.NEUTRAL, label),
            ("", ": "),
        ]
    )

    def bottom_toolbar() -> FormattedText:
        visibility = "hidden" if hidden[0] else "visible"
        return FormattedText(
            [
                (
                    Colors.DIM,
                    f"Enter keeps line breaks. Ctrl+S saves the exact secret block. F2 toggles visibility. Currently {visibility}.",
                )
            ]
        )

    secret = pt_prompt(
        prompt_text,
        multiline=True,
        is_password=is_hidden,
        key_bindings=bindings,
        validator=FlowValidator(lambda value: (bool(value), "Credential is required")),
        validate_while_typing=False,
        bottom_toolbar=bottom_toolbar,
    )
    console.print(f"  [{Colors.DIM}]Captured: {_masked_secret_summary(secret)}[/]")
    return secret


def _masked_secret_summary(secret: str) -> str:
    line_count = secret.count("\n") + 1 if secret else 0
    suffix = "s" if line_count != 1 else ""
    return f"**** ({len(secret)} chars across {line_count} line{suffix})"


def _validate_identifier_value(
    field_name: str,
    value: str,
    existing_values: Optional[object] = None,
) -> tuple[bool, str]:
    candidate = value.strip()
    if not candidate:
        return False, f"{field_name} is required"
    existing = {str(item) for item in existing_values} if existing_values else set()
    if candidate in existing:
        return False, f"{field_name} '{candidate}' already exists"
    try:
        ensure_identifier(field_name, candidate)
        return True, ""
    except ValueError:
        pass
    suggestion = _suggest_identifier(candidate)
    if suggestion and _IDENTIFIER_RE.match(suggestion):
        return (
            False,
            f"Invalid {field_name.lower()}. Allowed: letters, numbers, '.', '-', '_'. Try '{suggestion}'.",
        )
    return False, f"Invalid {field_name.lower()}. Allowed: letters, numbers, '.', '-', '_'."


def _validate_http_url(value: str, *, allow_blank: bool) -> tuple[bool, str]:
    candidate = value.strip()
    if not candidate:
        return (True, "") if allow_blank else (False, "Base URL is required")

    parsed = urlparse(candidate)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        return True, ""

    return (
        False,
        "Enter a full http/https URL or leave blank" if allow_blank else "Enter a full http/https URL",
    )


def _validate_url_or_blank(value: str) -> tuple[bool, str]:
    return _validate_http_url(value, allow_blank=True)


def _validate_required_url(value: str) -> tuple[bool, str]:
    return _validate_http_url(value, allow_blank=False)


def _validate_path_prefix(value: str) -> tuple[bool, str]:
    if not value.strip():
        return False, "Path prefix is required"
    try:
        ensure_path_prefix(value)
        return True, ""
    except ValueError:
        return False, "Path prefix must start with '/'"


def _validate_optional_int(value: str) -> tuple[bool, str]:
    candidate = value.strip()
    if not candidate:
        return True, ""
    if candidate.isdigit():
        return True, ""
    return False, "Enter a whole number or leave blank"


def _validate_non_empty(field_name: str, value: str) -> tuple[bool, str]:
    if value.strip():
        return True, ""
    return False, f"{field_name} is required"


def _suggest_identifier(raw: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", raw.strip())
    cleaned = re.sub(r"-{2,}", "-", cleaned)
    cleaned = cleaned.strip("-._")
    return cleaned.lower()


def _download_provider(console: Console, state: FlowState) -> None:
    config_manager = ConfigManager()
    workspace = _active_workspace(config_manager)
    providers = load_workspace_provider_registry(config_manager, workspace)

    console.clear()
    console.print(
        Panel(
            f"[{Colors.PRIMARY}]Download Provider JSON[/]",
            subtitle=f"[{Colors.HINT}]Workspace: {workspace}[/]",
            border_style=Colors.INFO,
        )
    )
    console.print()

    if not providers:
        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No providers configured.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    names = sorted(providers.keys())
    selected = Prompt.ask(f"[{Colors.INFO}]Provider[/]", choices=names, default=names[0])
    output_path = Prompt.ask(
        f"[{Colors.INFO}]Output path[/]",
        default=f"{selected}.provider.json",
    ).strip()
    if not output_path:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Output path is required.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    payload = {
        "provider": providers[selected],
        "workspace": workspace,
        "exported_at": datetime.utcnow().isoformat(),
    }
    output = Path(output_path).expanduser()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Provider '{selected}' exported to {output}.[/]")
    if state:
        state.add_recent_action(
            RecentAction.create("provider_download", f"Downloaded provider {selected}", success=True)
        )
    Prompt.ask("Press Enter to continue", default="")


def _import_provider(console: Console, state: FlowState) -> None:
    edition_adapter = get_deployment_edition_adapter()
    if not edition_adapter.allows_local_provider_management():
        console.print(
            f"  [{Colors.WARNING}]{Icons.WARNING} Enterprise mode detected.[/] "
            f"[{Colors.DIM}]Register providers in the gateway vault/registry.[/]"
        )
        Prompt.ask("Press Enter to continue", default="")
        return

    config_manager = ConfigManager()
    workspace = _active_workspace(config_manager)
    providers = load_workspace_provider_registry(config_manager, workspace)

    console.clear()
    console.print(
        Panel(
            f"[{Colors.PRIMARY}]Import Provider JSON[/]",
            subtitle=f"[{Colors.HINT}]Workspace: {workspace}[/]",
            border_style=Colors.INFO,
        )
    )
    console.print()

    input_path = Prompt.ask(f"[{Colors.INFO}]Input JSON path[/]", default="").strip()
    if not input_path:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Input path is required.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    try:
        raw_payload = json.loads(Path(input_path).expanduser().read_text(encoding="utf-8"))
    except Exception as exc:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Failed to read JSON: {exc}[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    payload = raw_payload.get("provider") if isinstance(raw_payload, dict) and isinstance(raw_payload.get("provider"), dict) else raw_payload
    if not isinstance(payload, dict):
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} JSON must be an object or include a 'provider' object.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    provider_name = str(payload.get("provider_id") or payload.get("name") or "").strip()
    if not provider_name:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Provider name is required in JSON.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    if provider_name in providers and not Confirm.ask(
        f"[{Colors.WARNING}]Provider '{provider_name}' exists. Replace it?[/]",
        default=False,
    ):
        console.print("  Import cancelled.")
        Prompt.ask("Press Enter to continue", default="")
        return

    service_type = str(payload.get("service_type") or "").strip().lower()
    if not service_type:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} service_type is required in JSON.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    auth_scheme = str(payload.get("auth_scheme") or "").strip()
    if auth_scheme not in _AUTH_SCHEME_GUIDANCE:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Unknown auth_scheme '{auth_scheme}'.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return
    if auth_scheme in _GATEWAY_ONLY_AUTH:
        console.print(
            f"  [{Colors.ERROR}]{Icons.ERROR} Auth scheme '{auth_scheme}' requires enterprise gateway execution.[/]"
        )
        Prompt.ask("Press Enter to continue", default="")
        return

    base_url = str(payload.get("base_url") or "").strip()
    valid_url, message = _validate_required_url(base_url)
    if not valid_url:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} {message}[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    definition_id = resolve_provider_definition_id(
        service_type=service_type,
        requested_definition=str(payload.get("provider_definition") or provider_name),
    )

    metadata = dict(payload.get("metadata") or {})
    metadata.pop("starter_pattern", None)

    scoped_mode = bool(payload.get("enforce_scoped_requests"))
    definition_payload = payload.get("definition")
    resources: dict[str, dict] = {}
    if isinstance(definition_payload, dict):
        resources = dict(definition_payload.get("resources") or {})
    if not scoped_mode and resources:
        scoped_mode = True

    definition = None
    if scoped_mode:
        if not resources:
            console.print(
                f"  [{Colors.ERROR}]{Icons.ERROR} Scoped providers require definition.resources in JSON.[/]"
            )
            Prompt.ask("Press Enter to continue", default="")
            return
        definition = {
            "definition_id": definition_id,
            "service_type": service_type,
            "display_name": provider_name,
            "auth_scheme": auth_scheme,
            "default_base_url": base_url,
            "resources": resources,
            "metadata": metadata,
        }

    credential_ref = payload.get("credential_ref")
    if auth_scheme == "none":
        credential_ref = None
    elif not credential_ref:
        if not Confirm.ask(
            f"[{Colors.WARNING}]No credential_ref found. Capture credential now?[/]",
            default=True,
        ):
            console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Authenticated providers need a credential.[/]")
            Prompt.ask("Press Enter to continue", default="")
            return
        credential_value = _prompt_secret_block(console, label=f"Credential for {provider_name}")
        credential_ref = store_workspace_provider_credential(
            workspace=workspace,
            provider_id=provider_name,
            value=credential_value,
        )

    existing = providers.get(provider_name)
    providers[provider_name] = build_provider_record(
        name=provider_name,
        service_type=service_type,
        definition_id=definition_id,
        auth_scheme=auth_scheme,
        base_url=base_url,
        definition=definition,
        healthcheck_path=str(payload.get("healthcheck_path") or "/health"),
        timeout_seconds=int(payload.get("timeout_seconds") or 30),
        max_retries=int(payload.get("max_retries") or 3),
        rate_limit_rpm=payload.get("rate_limit_rpm"),
        version=payload.get("version"),
        tags=list(payload.get("tags") or []),
        metadata=metadata,
        auth_header_name=(payload.get("auth_metadata") or {}).get("header_name"),
        credential_ref=credential_ref,
        existing=existing,
        created_at=str((existing or {}).get("created_at") or payload.get("created_at") or datetime.utcnow().isoformat()),
        enforce_scoped_requests=scoped_mode,
    )
    impacted = _persist_workspace_providers(config_manager, workspace, providers)

    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Provider '{provider_name}' imported.[/]")
    if impacted:
        console.print(
            f"  [{Colors.WARNING}]{Icons.WARNING} Deactivated {len(impacted)} mapped tool(s) due provider mapping drift.[/]"
        )
        for item in impacted:
            console.print(f"    • {item['tool_id']}: {item['reason']}")
    if state:
        state.add_recent_action(
            RecentAction.create("provider_import", f"Imported provider {provider_name}", success=True)
        )
    Prompt.ask("Press Enter to continue", default="")


def _remove_provider(console: Console, state: FlowState) -> None:
    config_manager = ConfigManager()
    workspace = _active_workspace(config_manager)
    providers = load_workspace_provider_registry(config_manager, workspace)

    console.clear()
    console.print(
        Panel(
            f"[{Colors.PRIMARY}]Remove Provider[/]",
            subtitle=f"[{Colors.HINT}]Workspace: {workspace}[/]",
            border_style=Colors.INFO,
        )
    )
    console.print()

    if not providers:
        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No providers configured.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    names = sorted(providers.keys())
    selected = Prompt.ask(
        f"[{Colors.INFO}]Provider name[/]",
        choices=names,
        default=names[0],
    )

    if not Confirm.ask(f"[{Colors.WARNING}]Remove provider '{selected}'?[/]", default=False):
        return

    removed = providers.pop(selected)
    impacted = _persist_workspace_providers(config_manager, workspace, providers)

    credential_ref = removed.get("credential_ref")
    if credential_ref:
        try:
            delete_workspace_provider_credential(workspace, credential_ref)
        except SecretNotFoundError:
            pass

    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Provider '{selected}' removed.[/]")
    if impacted:
        console.print(
            f"  [{Colors.WARNING}]{Icons.WARNING} Deactivated {len(impacted)} mapped tool(s) due provider removal.[/]"
        )
        for item in impacted:
            console.print(f"    • {item['tool_id']}: {item['reason']}")
    if state:
        state.add_recent_action(
            RecentAction.create("provider_remove", f"Removed provider {selected}", success=True)
        )
    Prompt.ask("Press Enter to continue", default="")
