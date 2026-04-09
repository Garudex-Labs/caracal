"""CLI commands for MCP tool registry lifecycle management."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

import click

from caracal.core.authority import AuthorityEvaluator
from caracal.db.connection import get_db_manager
from caracal.exceptions import CaracalError
from caracal.mcp.adapter import MCPAdapter


class _NoopMeteringCollector:
    def collect_event(self, _event) -> None:
        return None


@contextmanager
def _tool_registry_adapter(config) -> Iterator[MCPAdapter]:
    db_manager = get_db_manager(config)
    try:
        with db_manager.session_scope() as db_session:
            yield MCPAdapter(
                authority_evaluator=AuthorityEvaluator(db_session),
                metering_collector=_NoopMeteringCollector(),
            )
    finally:
        db_manager.close()


@click.command("register")
@click.option("--tool-id", required=True, help="Explicit tool identifier")
@click.option("--provider-name", required=True, help="Workspace provider name")
@click.option("--resource-scope", required=True, help="Canonical provider resource scope")
@click.option("--action-scope", required=True, help="Canonical provider action scope")
@click.option("--provider-definition-id", required=False, help="Provider definition identifier")
@click.option("--action-method", required=False, help="Expected HTTP method for action contract")
@click.option("--action-path-prefix", required=False, help="Expected HTTP path prefix for action contract")
@click.option(
    "--execution-mode",
    type=click.Choice(["local", "mcp_forward"], case_sensitive=False),
    default="mcp_forward",
    show_default=True,
    help="Execution routing mode for this tool",
)
@click.option("--mcp-server-name", required=False, help="Named upstream MCP server for forward routing")
@click.option("--inactive", is_flag=True, help="Register tool as inactive")
@click.option("--actor-principal-id", required=True, help="Actor principal UUID for audit ledger")
@click.pass_context
def register(
    ctx,
    tool_id: str,
    provider_name: str,
    resource_scope: str,
    action_scope: str,
    provider_definition_id: str,
    action_method: str,
    action_path_prefix: str,
    execution_mode: str,
    mcp_server_name: str,
    inactive: bool,
    actor_principal_id: str,
) -> None:
    """Register or update a tool in persisted MCP registry."""
    try:
        with _tool_registry_adapter(ctx.obj.config) as adapter:
            row = adapter.register_tool(
                tool_id=tool_id,
                active=not inactive,
                actor_principal_id=actor_principal_id,
                provider_name=provider_name,
                resource_scope=resource_scope,
                action_scope=action_scope,
                provider_definition_id=provider_definition_id,
                action_method=action_method,
                action_path_prefix=action_path_prefix,
                execution_mode=execution_mode,
                mcp_server_name=mcp_server_name,
            )

        click.echo("Tool registration saved")
        click.echo(f"Tool ID:  {row.tool_id}")
        click.echo(f"Active:   {'yes' if row.active else 'no'}")
    except CaracalError as exc:
        raise click.ClickException(str(exc)) from exc


@click.command("list")
@click.option("--all", "include_inactive", is_flag=True, help="Include inactive tools")
@click.pass_context
def list_tools(ctx, include_inactive: bool) -> None:
    """List registered tools from persisted MCP registry."""
    try:
        with _tool_registry_adapter(ctx.obj.config) as adapter:
            rows = adapter.list_registered_tools(include_inactive=include_inactive)

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
@click.option("--actor-principal-id", required=True, help="Actor principal UUID for audit ledger")
@click.pass_context
def deactivate(ctx, tool_id: str, actor_principal_id: str) -> None:
    """Deactivate an existing registered tool."""
    try:
        with _tool_registry_adapter(ctx.obj.config) as adapter:
            row = adapter.deactivate_tool(
                tool_id=tool_id,
                actor_principal_id=actor_principal_id,
            )

        click.echo("Tool deactivated")
        click.echo(f"Tool ID:  {row.tool_id}")
        click.echo("Active:   no")
    except CaracalError as exc:
        raise click.ClickException(str(exc)) from exc


@click.command("reactivate")
@click.option("--tool-id", required=True, help="Tool identifier to reactivate")
@click.option("--actor-principal-id", required=True, help="Actor principal UUID for audit ledger")
@click.pass_context
def reactivate(ctx, tool_id: str, actor_principal_id: str) -> None:
    """Reactivate an existing registered tool."""
    try:
        with _tool_registry_adapter(ctx.obj.config) as adapter:
            row = adapter.reactivate_tool(
                tool_id=tool_id,
                actor_principal_id=actor_principal_id,
            )

        click.echo("Tool reactivated")
        click.echo(f"Tool ID:  {row.tool_id}")
        click.echo("Active:   yes")
    except CaracalError as exc:
        raise click.ClickException(str(exc)) from exc
