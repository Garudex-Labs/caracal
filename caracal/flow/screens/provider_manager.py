"""
Provider Manager screen.

Provider configuration is workspace-local in open-source mode and
provider-definition-driven across all flows.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Confirm, Prompt
from rich.table import Table

from caracal.deployment import ConfigManager, EditionManager
from caracal.flow.components.menu import Menu, MenuItem
from caracal.flow.state import FlowState, RecentAction
from caracal.flow.theme import Colors, Icons
from caracal.provider.workspace import (
    load_workspace_provider_registry,
    save_workspace_provider_registry,
)


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
                MenuItem("add", "Add Provider", "Configure provider + secure credentials", Icons.ADD),
                MenuItem("remove", "Remove Provider", "Delete provider configuration", Icons.DELETE),
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
        elif result.key == "remove":
            _remove_provider(console, state)


def _active_workspace(config_manager: ConfigManager) -> str:
    workspace = config_manager.get_default_workspace_name()
    if workspace:
        return workspace
    workspaces = config_manager.list_workspaces()
    if workspaces:
        return workspaces[0]
    raise RuntimeError("No workspaces found. Run 'caracal init' first.")


def _list_providers(console: Console) -> None:
    config_manager = ConfigManager()
    workspace = _active_workspace(config_manager)
    providers = load_workspace_provider_registry(config_manager, workspace)

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
    table.add_column("Service", style=Colors.NEUTRAL)
    table.add_column("Auth", style=Colors.NEUTRAL)
    table.add_column("Endpoint", style=Colors.DIM)
    table.add_column("Scopes", style=Colors.DIM)

    for name in sorted(providers.keys()):
        entry = providers[name]
        resources = entry.get("resources", [])
        actions = entry.get("actions", [])
        table.add_row(
            name,
            str(entry.get("provider_definition") or "custom"),
            str(entry.get("service_type") or "api"),
            str(entry.get("auth_scheme") or "api_key"),
            str(entry.get("base_url") or "configured"),
            f"{len(resources)} resources / {len(actions)} actions",
        )

    console.print(table)
    console.print()
    Prompt.ask("Press Enter to continue", default="")


def _add_provider(console: Console, state: FlowState) -> None:
    edition_manager = EditionManager()
    if edition_manager.is_enterprise():
        console.print(
            f"  [{Colors.WARNING}]{Icons.WARNING} Enterprise mode detected.[/] "
            f"[{Colors.DIM}]Register providers in the gateway vault/registry.[/]"
        )
        Prompt.ask("Press Enter to continue", default="")
        return

    config_manager = ConfigManager()
    workspace = _active_workspace(config_manager)

    console.clear()
    console.print(
        Panel(
            f"[{Colors.PRIMARY}]Add Provider[/]",
            subtitle=f"[{Colors.HINT}]Workspace: {workspace}[/]",
            border_style=Colors.INFO,
        )
    )
    console.print()

    name = Prompt.ask(f"[{Colors.INFO}]Provider name[/]").strip()
    definition_choice = Prompt.ask(
        f"[{Colors.INFO}]Provider definition ID[/]",
        default=name,
    ).strip() or name
    service_type = Prompt.ask(
        f"[{Colors.INFO}]Service type[/]",
        default="api",
    ).strip() or "api"
    auth_scheme = Prompt.ask(
        f"[{Colors.INFO}]Auth scheme[/]",
        choices=["none", "api-key", "bearer", "basic", "header"],
        default="api-key",
    ).replace("-", "_")
    base_url = Prompt.ask(
        f"[{Colors.INFO}]Base URL[/]",
        default="",
    ).strip()

    credential_ref: Optional[str] = None
    if auth_scheme != "none":
        credential_value = Prompt.ask(f"[{Colors.INFO}]Credential[/]", password=True).strip()
        if not credential_value:
            console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Credential is required for authenticated providers.[/]")
            Prompt.ask("Press Enter to continue", default="")
            return
        credential_ref = f"provider_{name}_credential"
        config_manager.store_secret(credential_ref, credential_value, workspace)

    resources: dict[str, dict] = {}
    while True:
        resource_id = Prompt.ask(
            f"[{Colors.INFO}]Resource ID[/] (leave blank to stop)",
            default="",
        ).strip()
        if not resource_id:
            break
        if resource_id in resources:
            console.print(f"  [{Colors.WARNING}]Resource '{resource_id}' already exists, skipping.[/]")
            continue
        description = Prompt.ask(
            f"[{Colors.INFO}]Resource description[/]",
            default=resource_id,
        ).strip() or resource_id
        resources[resource_id] = {"description": description, "actions": {}}

    if not resources:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} At least one resource is required.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    while True:
        resource_choices = ", ".join(sorted(resources.keys()))
        action_resource = Prompt.ask(
            f"[{Colors.INFO}]Action resource[/] (leave blank to stop) [{resource_choices}]",
            default="",
        ).strip()
        if not action_resource:
            break
        if action_resource not in resources:
            console.print(
                f"  [{Colors.ERROR}]{Icons.ERROR} Unknown resource '{action_resource}'. Choose one of: {resource_choices}[/]"
            )
            continue
        action_id = Prompt.ask(f"[{Colors.INFO}]Action ID[/]").strip()
        method = Prompt.ask(
            f"[{Colors.INFO}]HTTP method[/]",
            choices=["GET", "POST", "PUT", "PATCH", "DELETE"],
            default="POST",
        ).strip().upper()
        path_prefix = Prompt.ask(
            f"[{Colors.INFO}]Path prefix[/]",
            default="/",
        ).strip()
        if not path_prefix.startswith("/"):
            console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Path prefix must start with '/'.[/]")
            continue
        resources[action_resource]["actions"][action_id] = {
            "description": action_id,
            "method": method,
            "path_prefix": path_prefix,
        }

    for resource_id, payload in resources.items():
        if not payload["actions"]:
            console.print(
                f"  [{Colors.ERROR}]{Icons.ERROR} Resource '{resource_id}' has no actions. Add at least one action per resource.[/]"
            )
            Prompt.ask("Press Enter to continue", default="")
            return

    definition_payload = {
        "definition_id": definition_choice,
        "service_type": service_type,
        "display_name": name,
        "auth_scheme": auth_scheme,
        "default_base_url": base_url or None,
        "resources": resources,
    }
    resource_ids = sorted(resources.keys())
    action_ids = sorted(
        {action_id for payload in resources.values() for action_id in payload["actions"].keys()}
    )

    providers = load_workspace_provider_registry(config_manager, workspace)
    providers[name] = {
        "name": name,
        "service_type": service_type,
        "provider_definition": definition_choice,
        "definition": definition_payload,
        "base_url": base_url or None,
        "auth_scheme": auth_scheme,
        "credential_ref": credential_ref,
        "healthcheck_path": "/health",
        "timeout_seconds": 30,
        "max_retries": 3,
        "rate_limit_rpm": None,
        "version": None,
        "tags": [],
        "capabilities": [],
        "access_policy": {"scopes": []},
        "auth_metadata": {},
        "default_headers": {},
        "metadata": {},
        "resources": resource_ids,
        "actions": action_ids,
        "enforce_scoped_requests": True,
        "created_at": providers.get(name, {}).get("created_at", datetime.utcnow().isoformat()),
        "updated_at": datetime.utcnow().isoformat(),
    }
    save_workspace_provider_registry(config_manager, workspace, providers)

    console.print()
    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Provider '{name}' added.[/]")
    if state:
        state.add_recent_action(
            RecentAction.create("provider_add", f"Added provider {name}", success=True)
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
    save_workspace_provider_registry(config_manager, workspace, providers)

    credential_ref = removed.get("credential_ref")
    vault = config_manager._load_vault(workspace)
    if credential_ref and credential_ref in vault:
        del vault[credential_ref]
    for legacy_key in (f"provider_{selected}_api_key", f"provider_{selected}_credential"):
        if legacy_key in vault:
            del vault[legacy_key]
    config_manager._save_vault(workspace, vault)

    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Provider '{selected}' removed.[/]")
    if state:
        state.add_recent_action(
            RecentAction.create("provider_remove", f"Removed provider {selected}", success=True)
        )
    Prompt.ask("Press Enter to continue", default="")
