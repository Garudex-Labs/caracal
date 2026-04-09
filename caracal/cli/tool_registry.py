"""CLI commands for MCP tool registry lifecycle management."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

import click

from caracal.core.authority import AuthorityEvaluator
from caracal.db.connection import get_db_manager
from caracal.deployment import ConfigManager
from caracal.exceptions import CaracalError
from caracal.mcp.adapter import MCPAdapter
from caracal.mcp.tool_registry_contract import validate_active_tool_mappings
from caracal.provider.definitions import build_action_scope, build_resource_scope
from caracal.provider.workspace import load_workspace_provider_registry


class _NoopMeteringCollector:
    def collect_event(self, _event) -> None:
        return None


def _resolve_workspace_name(workspace: str | None) -> str:
    resolved_workspace = str(workspace or "").strip()
    if resolved_workspace:
        return resolved_workspace

    default_workspace = ConfigManager().get_default_workspace_name()
    if default_workspace:
        return default_workspace

    raise click.ClickException("No default workspace found. Pass --workspace explicitly.")


@contextmanager
def _tool_registry_adapter(config) -> Iterator[MCPAdapter]:
    mcp_server_url = None
    mcp_server_urls: dict[str, str] = {}

    mcp_adapter_config = getattr(config, "mcp_adapter", None)
    for idx, server_entry in enumerate(getattr(mcp_adapter_config, "mcp_server_urls", []) or []):
        if isinstance(server_entry, dict):
            name = str(server_entry.get("name") or f"server-{idx}").strip()
            url = str(server_entry.get("url") or "").strip()
            if name and url:
                mcp_server_urls[name] = url
        else:
            url = str(server_entry or "").strip()
            if url:
                mcp_server_urls[f"server-{idx}"] = url

    if mcp_server_urls:
        mcp_server_url = next(iter(mcp_server_urls.values()))

    db_manager = get_db_manager(config)
    try:
        with db_manager.session_scope() as db_session:
            yield MCPAdapter(
                authority_evaluator=AuthorityEvaluator(db_session),
                metering_collector=_NoopMeteringCollector(),
                mcp_server_url=mcp_server_url,
                mcp_server_urls=mcp_server_urls,
            )
    finally:
        db_manager.close()


@click.command("register")
@click.option("--tool-id", required=True, help="Explicit tool identifier")
@click.option("--workspace", required=False, help="Workspace name (defaults to current workspace)")
@click.option("--provider-name", required=True, help="Workspace provider name")
@click.option("--resource-id", required=True, help="Provider resource identifier")
@click.option("--action-id", required=True, help="Provider action identifier under selected resource")
@click.option("--provider-definition-id", required=False, help="Provider definition identifier")
@click.option(
    "--execution-mode",
    type=click.Choice(["local", "mcp_forward"], case_sensitive=False),
    default="mcp_forward",
    show_default=True,
    help="Execution routing mode for this tool",
)
@click.option("--mcp-server-name", required=False, help="Named upstream MCP server for forward routing")
@click.option("--workspace-name", required=False, help="Optional workspace identity for deterministic binding")
@click.option(
    "--tool-type",
    type=click.Choice(["direct_api", "logic"], case_sensitive=False),
    default="direct_api",
    show_default=True,
    help="Tool behavior type",
)
@click.option("--handler-ref", required=False, help="Handler reference for logic tools (module:function)")
@click.option("--mapping-version", required=False, help="Optional mapping fingerprint/version")
@click.option(
    "--allowed-downstream-scope",
    "allowed_downstream_scopes",
    multiple=True,
    help="Provider scope approved for logic-tool downstream calls (repeatable)",
)
@click.option("--inactive", is_flag=True, help="Register tool as inactive")
@click.option("--actor-principal-id", required=True, help="Actor principal UUID for audit ledger")
@click.pass_context
def register(
    ctx,
    tool_id: str,
    workspace: str,
    provider_name: str,
    resource_id: str,
    action_id: str,
    provider_definition_id: str,
    execution_mode: str,
    mcp_server_name: str,
    workspace_name: str,
    tool_type: str,
    handler_ref: str,
    mapping_version: str,
    allowed_downstream_scopes: tuple[str, ...],
    inactive: bool,
    actor_principal_id: str,
) -> None:
    """Register or update a tool in persisted MCP registry."""
    try:
        config_manager = ConfigManager()
        resolved_workspace = workspace or config_manager.get_default_workspace_name()
        if not resolved_workspace:
            raise click.ClickException("No default workspace found. Pass --workspace explicitly.")

        providers = load_workspace_provider_registry(config_manager, resolved_workspace)
        provider_entry = providers.get(provider_name)
        if not provider_entry:
            raise click.ClickException(
                f"Provider '{provider_name}' is not configured in workspace '{resolved_workspace}'"
            )

        definition = provider_entry.get("definition")
        if not isinstance(definition, dict):
            raise click.ClickException(
                f"Provider '{provider_name}' has no scoped definition; cannot register tool mapping"
            )

        resources = dict(definition.get("resources") or {})
        selected_resource = resources.get(resource_id)
        if not isinstance(selected_resource, dict):
            raise click.ClickException(
                f"Provider '{provider_name}' has no resource '{resource_id}'"
            )

        actions = dict(selected_resource.get("actions") or {})
        selected_action = actions.get(action_id)
        if not isinstance(selected_action, dict):
            raise click.ClickException(
                f"Resource '{resource_id}' has no action '{action_id}' for provider '{provider_name}'"
            )

        resolved_provider_definition_id = (
            provider_definition_id
            or str(provider_entry.get("provider_definition") or provider_name)
        )

        with _tool_registry_adapter(ctx.obj.config) as adapter:
            row = adapter.register_tool(
                tool_id=tool_id,
                active=not inactive,
                actor_principal_id=actor_principal_id,
                provider_name=provider_name,
                resource_scope=build_resource_scope(provider_name, resource_id),
                action_scope=build_action_scope(provider_name, action_id),
                provider_definition_id=resolved_provider_definition_id,
                action_method=str(selected_action.get("method") or "").strip().upper() or None,
                action_path_prefix=str(selected_action.get("path_prefix") or "").strip() or None,
                execution_mode=execution_mode,
                mcp_server_name=mcp_server_name,
                workspace_name=workspace_name or resolved_workspace,
                tool_type=tool_type,
                handler_ref=handler_ref,
                mapping_version=mapping_version,
                allowed_downstream_scopes=list(allowed_downstream_scopes),
            )

        click.echo("Tool registration saved")
        click.echo(f"Tool ID:  {row.tool_id}")
        click.echo(f"Active:   {'yes' if row.active else 'no'}")
    except CaracalError as exc:
        raise click.ClickException(str(exc)) from exc


@click.command("list")
@click.option("--all", "include_inactive", is_flag=True, help="Include inactive tools")
@click.option("--workspace", required=False, help="Workspace name (defaults to current workspace)")
@click.pass_context
def list_tools(ctx, include_inactive: bool, workspace: str | None) -> None:
    """List registered tools from persisted MCP registry."""
    try:
        resolved_workspace = _resolve_workspace_name(workspace)
        with _tool_registry_adapter(ctx.obj.config) as adapter:
            rows = adapter.list_registered_tools(
                include_inactive=include_inactive,
                workspace_name=resolved_workspace,
            )

        if not rows:
            click.echo("No registered tools found.")
            return

        click.echo(f"Total tools: {len(rows)}")
        click.echo("")
        click.echo(f"{'Tool ID':<64}  {'Status':<8}")
        click.echo("-" * 74)
        for row in rows:
            click.echo(f"{row.tool_id:<64}  {('active' if row.active else 'inactive'):<8}")
    except CaracalError as exc:
        raise click.ClickException(str(exc)) from exc


@click.command("deactivate")
@click.option("--tool-id", required=True, help="Tool identifier to deactivate")
@click.option("--workspace", required=False, help="Workspace name (defaults to current workspace)")
@click.option("--actor-principal-id", required=True, help="Actor principal UUID for audit ledger")
@click.pass_context
def deactivate(ctx, tool_id: str, workspace: str | None, actor_principal_id: str) -> None:
    """Deactivate an existing registered tool."""
    try:
        resolved_workspace = _resolve_workspace_name(workspace)
        with _tool_registry_adapter(ctx.obj.config) as adapter:
            row = adapter.deactivate_tool(
                tool_id=tool_id,
                actor_principal_id=actor_principal_id,
                workspace_name=resolved_workspace,
            )

        click.echo("Tool deactivated")
        click.echo(f"Tool ID:  {row.tool_id}")
        click.echo("Active:   no")
    except CaracalError as exc:
        raise click.ClickException(str(exc)) from exc


@click.command("reactivate")
@click.option("--tool-id", required=True, help="Tool identifier to reactivate")
@click.option("--workspace", required=False, help="Workspace name (defaults to current workspace)")
@click.option("--actor-principal-id", required=True, help="Actor principal UUID for audit ledger")
@click.pass_context
def reactivate(ctx, tool_id: str, workspace: str | None, actor_principal_id: str) -> None:
    """Reactivate an existing registered tool."""
    try:
        resolved_workspace = _resolve_workspace_name(workspace)
        with _tool_registry_adapter(ctx.obj.config) as adapter:
            row = adapter.reactivate_tool(
                tool_id=tool_id,
                actor_principal_id=actor_principal_id,
                workspace_name=resolved_workspace,
            )

        click.echo("Tool reactivated")
        click.echo(f"Tool ID:  {row.tool_id}")
        click.echo("Active:   yes")
    except CaracalError as exc:
        raise click.ClickException(str(exc)) from exc


@click.command("preflight")
@click.pass_context
def preflight(ctx) -> None:
    """Run full tool mapping consistency checks and fail non-zero on drift."""
    try:
        with _tool_registry_adapter(ctx.obj.config) as adapter:
            session = adapter.authority_evaluator.db_session
            issues = validate_active_tool_mappings(
                db_session=session,
                named_server_urls=dict(getattr(adapter, "_mcp_server_urls", {}) or {}),
                has_default_forward_target=bool(getattr(adapter, "mcp_server_url", None)),
            )

        if issues:
            click.echo("Tool mapping preflight failed:")
            for issue in issues:
                click.echo(f"- {issue['tool_id']} [{issue['check']}]: {issue['message']}")
            raise click.ClickException("Tool mapping preflight failed")

        click.echo("Tool mapping preflight passed")
    except CaracalError as exc:
        raise click.ClickException(str(exc)) from exc
