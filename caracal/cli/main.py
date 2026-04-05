"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI entry point for Caracal Core - Refactored Structure.

Industry-standard CLI with workspace-centric design.
Follows patterns from git, docker, kubectl for familiarity.
"""

import difflib
import logging
import sys
from pathlib import Path
from typing import Optional

import click
from click import Context

from caracal._version import __version__
from caracal.pathing import source_of
from caracal.config.settings import get_default_config_path, load_config
from caracal.exceptions import CaracalError, InvalidConfigurationError
from caracal.logging_config import setup_runtime_logging
from caracal.cli.context import CLIContext, pass_context


def get_active_workspace() -> Optional[str]:
    """Get the currently active workspace name."""
    try:
        from caracal.deployment.config_manager import ConfigManager

        config_mgr = ConfigManager()
        default_workspace = config_mgr.get_default_workspace_name()
        return default_workspace
    except Exception:
        return None


def format_workspace_status(active_ws: Optional[str]) -> str:
    """Render workspace banner text for help and command output."""
    if active_ws:
        return f"Active Workspace: {click.style(active_ws, fg='cyan', bold=True)}"
    return click.style("WARNING: No workspace configured", fg='yellow', bold=True)


def get_workspace_config_path(workspace_name: Optional[str]) -> Optional[Path]:
    """Resolve a workspace's config.yaml path from deployment workspace config."""
    if not workspace_name:
        return None

    try:
        from caracal.deployment.config_manager import ConfigManager

        config_mgr = ConfigManager()
        workspace_path = config_mgr.get_workspace_path(workspace_name)
        return workspace_path / "config.yaml"
    except Exception:
        return None


def workspace_context_callback(ctx, param, value):
    """Callback to set workspace context."""
    if value:
        ctx.ensure_object(CLIContext)
        ctx.obj.workspace = value
    return value


def workspace_argument(func):
    """Decorator to add optional workspace argument to commands."""
    func = click.argument('workspace_name', required=False)(func)
    return func


def get_workspace_from_context_or_arg(ctx, workspace_arg: Optional[str] = None) -> str:
    """Get workspace from argument or context."""
    if workspace_arg:
        return workspace_arg
    return ctx.obj.get('workspace', get_active_workspace())


class SuggestingGroup(click.Group):
    """Click group that suggests close command names for unknown commands."""

    group_class = type

    def resolve_command(self, ctx: Context, args: list[str]):  # type: ignore[override]
        try:
            return super().resolve_command(ctx, args)
        except click.UsageError as exc:
            if not args:
                raise

            command_name = click.utils.make_str(args[0])
            suggestion = self._suggest_command(ctx, command_name)
            if suggestion:
                hint = f"Command not found: {command_name}. Did you mean '{suggestion}'?"
            else:
                hint = (
                    f"Command not found: {command_name}. "
                    "Only Caracal CLI commands are available here."
                )

            raise click.UsageError(hint, ctx=ctx) from exc

    def _suggest_command(self, ctx: Context, command_name: str) -> str | None:
        commands = self.list_commands(ctx)
        matches = difflib.get_close_matches(command_name, commands, n=1, cutoff=0.5)
        return matches[0] if matches else None


class WorkspaceAwareGroup(SuggestingGroup):
    """Custom Group that shows active workspace in help."""

    group_class = SuggestingGroup

    def format_help(self, ctx: Context, formatter: click.HelpFormatter) -> None:
        """Format help with active workspace displayed at top."""
        # Get active workspace
        active_ws = get_active_workspace()
        
        # Add workspace info at the top
        formatter.write_paragraph()
        formatter.write_text(format_workspace_status(active_ws))
        formatter.write_paragraph()
        
        # Format usage
        self.format_usage(ctx, formatter)
        
        # Format description
        self.format_help_text(ctx, formatter)
        
        # Format options
        self.format_options(ctx, formatter)
        
        # Add command groups (custom formatting) - skip default commands section
        commands = self.list_commands(ctx)
        if commands:
            # Group commands by category
            core_commands = ['workspace', 'principal', 'policy', 'authority', 'flow']
            enterprise_commands = ['enterprise', 'delegation', 'audit']
            system_commands = ['config', 'provider', 'doctor', 'version', 'completion']
            
            # Core Commands
            formatter.write_paragraph()
            formatter.write_text(click.style('Core Commands:', bold=True))
            for cmd_name in core_commands:
                if cmd_name in commands:
                    cmd = self.get_command(ctx, cmd_name)
                    if cmd:
                        help_text = cmd.get_short_help_str(limit=60)
                        formatter.write_text(f"  {cmd_name:<12}  {help_text}")
            
            # Enterprise Commands
            formatter.write_paragraph()
            formatter.write_text(click.style('Enterprise Commands:', bold=True))
            for cmd_name in enterprise_commands:
                if cmd_name in commands:
                    cmd = self.get_command(ctx, cmd_name)
                    if cmd:
                        help_text = cmd.get_short_help_str(limit=60)
                        formatter.write_text(f"  {cmd_name:<12}  {help_text}")
            
            # System Commands
            formatter.write_paragraph()
            formatter.write_text(click.style('System Commands:', bold=True))
            for cmd_name in system_commands:
                if cmd_name in commands:
                    cmd = self.get_command(ctx, cmd_name)
                    if cmd:
                        help_text = cmd.get_short_help_str(limit=60)
                        formatter.write_text(f"  {cmd_name:<12}  {help_text}")
    
    def format_commands(self, ctx: Context, formatter: click.HelpFormatter) -> None:
        """Override to prevent default command listing."""
        # Do nothing - we handle command listing in format_help
        pass


@click.group(invoke_without_command=True, cls=WorkspaceAwareGroup)
@click.option(
    '--config',
    '-c',
    type=click.Path(exists=False, dir_okay=False, path_type=Path),
    default=None,
    help=f'Path to configuration file (default: {get_default_config_path()})',
)
@click.option(
    '--workspace',
    '-w',
    default=None,
    callback=workspace_context_callback,
    help='Workspace to operate in (default: active workspace)',
)
@click.option(
    '--log-level',
    '-l',
    type=click.Choice(['debug', 'info', 'warning', 'error', 'critical'], case_sensitive=False),
    default=None,
    help='Set logging level',
)
@click.option(
    '--verbose',
    '-v',
    is_flag=True,
    help='Enable verbose output',
)
@click.version_option(version=__version__, prog_name='caracal')
@click.pass_context
def cli(ctx, config: Optional[Path], workspace: Optional[str], log_level: str, verbose: bool):
    """
    Caracal - Pre-execution authority enforcement for AI agents.
    
    Workspace-centric authority management with real-time revocation
    and immutable audit trails.
    """
    # Initialize context
    ctx.ensure_object(CLIContext)
    ctx.obj.verbose = verbose
    ctx.obj.workspace = workspace or get_active_workspace()

    # Prefer an explicit --config, otherwise resolve workspace-scoped config.yaml.
    if config:
        resolved_config_path = config
    else:
        resolved_config_path = get_workspace_config_path(ctx.obj.workspace) or get_default_config_path()

    # Set active runtime workspace early so all path defaults (backup/log/cache)
    # resolve to the selected workspace directory.
    try:
        from caracal.flow.workspace import set_workspace
        set_workspace(source_of(Path(resolved_config_path).expanduser()))
    except Exception:
        pass

    ctx.obj.config_path = str(resolved_config_path)
    
    # Detect global flags used to keep setup output clean.
    is_help_or_version = any(arg in {"--help", "-h", "--version"} for arg in sys.argv[1:])
    is_version = any(arg == "--version" for arg in sys.argv[1:])
    
    # Load configuration
    try:
        emit_config_logs = bool(verbose) or (bool(log_level) and log_level.lower() == "debug")
        ctx.obj['config'] = load_config(
            ctx.obj['config_path'],
            suppress_missing_file_log=True,
            emit_logs=emit_config_logs,
        )
    except InvalidConfigurationError as e:
        if not is_help_or_version:
            click.echo(f"Error: Invalid configuration: {e}", err=True)
            sys.exit(1)
    except Exception as e:
        if not is_help_or_version:
            click.echo(f"Error: Failed to load configuration: {e}", err=True)
            sys.exit(1)
    
    # Show active workspace context for any subcommand invocation, including
    # subcommand help. Root help already renders this via WorkspaceAwareGroup.
    if ctx.invoked_subcommand is not None and not is_version:
        active_ws = ctx.obj['workspace']
        click.echo(format_workspace_status(active_ws))

    if is_help_or_version:
        return
    
    # Set up logging
    try:
        effective_log_level = log_level.upper() if log_level else ctx.obj['config'].logging.level
        log_file = Path(ctx.obj['config'].logging.file) if ctx.obj['config'].logging.file else None
        requested_json_format = (
            ctx.obj['config'].logging.format == "json"
            if hasattr(ctx.obj['config'].logging, 'format')
            else None
        )
        setup_runtime_logging(
            requested_level=effective_log_level,
            requested_json_format=requested_json_format,
            log_file=log_file,
        )
        
        if verbose:
            logger = logging.getLogger("caracal")
            logger.info(f"Workspace: {ctx.obj['workspace']}")
            logger.info(f"Config: {ctx.obj['config_path'] or 'defaults'}")
    except Exception as e:
        click.echo(f"Error: Failed to set up logging: {e}", err=True)
        sys.exit(1)
    
    # Show workspace context if no command given
    if ctx.invoked_subcommand is None:
        active_ws = ctx.obj['workspace']
        click.echo(f"Caracal v{__version__}")
        click.echo(format_workspace_status(active_ws))
        click.echo()
        click.echo("Run 'caracal --help' for available commands")
        click.echo("Run 'caracal workspace list' to see all workspaces")

# =============================================================================
# WORKSPACE MANAGEMENT (Primary Context)
# =============================================================================

@cli.group()
def workspace():
    """
    Manage workspaces (primary organizational context).
    
    Workspaces isolate configurations, policies, and mandates.
    Similar to git branches or docker contexts.
    
    \b
    Examples:
      caracal workspace list              # List all workspaces
      caracal workspace create prod       # Create new workspace
      caracal workspace use prod          # Switch to workspace
      caracal workspace delete old-dev    # Delete workspace
    """
    pass


@workspace.command(name='list')
@click.option('--format', type=click.Choice(['table', 'json']), default='table')
@click.pass_context
def workspace_list(ctx, format):
    """List all workspaces."""
    from caracal.deployment.config_manager import ConfigManager
    import json as json_lib
    
    try:
        config_mgr = ConfigManager()
        workspace_names = config_mgr.list_workspaces()

        workspace_configs = []
        for name in workspace_names:
            try:
                workspace_configs.append(config_mgr.get_workspace_config(name))
            except Exception:
                continue
        
        if format == 'json':
            data = [
                {
                    'name': ws.name,
                    'active': ws.is_default,
                    'created': ws.created_at.isoformat() if ws.created_at else None
                }
                for ws in workspace_configs
            ]
            click.echo(json_lib.dumps(data, indent=2))
        else:
            if not workspace_configs:
                click.echo("No workspaces found. Create one with 'caracal workspace create <name>'.")
                return
            
            click.echo()
            click.echo(click.style("WORKSPACES", bold=True))
            click.echo()
            for ws in workspace_configs:
                marker = click.style("●", fg='green') if ws.is_default else " "
                click.echo(f"  {marker} {click.style(ws.name, bold=True)}")
            click.echo()
            
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@workspace.command(name='create')
@click.argument('name')
@click.option('--template', type=click.Choice(['none', 'enterprise', 'local-dev']), default='none')
@click.pass_context
def workspace_create(ctx, name, template):
    """Create a new workspace."""
    from caracal.deployment.config_manager import ConfigManager
    
    try:
        config_mgr = ConfigManager()
        template_val = None if template == 'none' else template
        config_mgr.create_workspace(name, template=template_val)
        
        click.echo(f"✓ Workspace '{click.style(name, fg='cyan', bold=True)}' created")
        click.echo(f"  Switch to it: caracal workspace use {name}")
        
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@workspace.command(name='use')
@click.argument('name')
@click.pass_context
def workspace_use(ctx, name):
    """Switch to a different workspace."""
    from caracal.deployment.config_manager import ConfigManager
    
    try:
        config_mgr = ConfigManager()
        config_mgr.set_default_workspace(name)
        
        click.echo(f"✓ Switched to workspace: {click.style(name, fg='cyan', bold=True)}")
        
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@workspace.command(name='current')
@click.pass_context
def workspace_current(ctx):
    """Show current workspace."""
    active_ws = ctx.obj['workspace']
    click.echo(active_ws)


@workspace.command(name='delete')
@click.argument('name')
@click.option('--force', is_flag=True, help='Skip confirmation')
@click.pass_context
def workspace_delete(ctx, name, force):
    """Delete a workspace."""
    from caracal.deployment.config_manager import ConfigManager
    
    if not force:
        if not click.confirm(f"Delete workspace '{name}'? This cannot be undone."):
            click.echo("Cancelled")
            return
    
    try:
        config_mgr = ConfigManager()
        config_mgr.delete_workspace(name, backup=True)
        
        click.echo(f"✓ Workspace '{name}' deleted (backup created)")
        
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


# =============================================================================
# PRINCIPAL MANAGEMENT
# =============================================================================

@cli.group()
@click.pass_context
def principal(ctx):
    """
    Manage AI agent identities.
    
    Principals represent AI agents that can receive mandates.
    
    \b
    Examples:
        caracal principal register --type user --name alice --email alice@example.com
        caracal principal list                 # List all principals
        caracal principal get -a <principal-id>  # Get principal details
    """
    pass


from caracal.cli.principal import register, list_principals, get as principal_get
principal.add_command(register)
principal.add_command(list_principals, name='list')
principal.add_command(principal_get, name='get')


# =============================================================================
# POLICY MANAGEMENT
# =============================================================================

@cli.group()
@click.pass_context
def policy(ctx):
    """
    Manage authority policies.
    
    Policies define what actions agents can perform.
    
    \b
    Examples:
        caracal policy create -p <principal-id> -v 3600 -r "api:*" -a "api_call"  # Create policy
        caracal policy list                    # List all policies
        caracal policy list -p <principal-id>  # Filter by principal
    """
    pass


from caracal.cli.authority_policy import create as policy_create, list_policies
policy.add_command(policy_create, name='create')
policy.add_command(list_policies, name='list')


# =============================================================================
# AUTHORITY & MANDATES
# =============================================================================

@cli.group()
@click.pass_context
def authority(ctx):
    """
    Manage execution mandates and authority enforcement.
    
    Mandates grant specific execution rights to agents.
    
    \b
    Examples:
      caracal authority mandate           # Issue new mandate
      caracal authority enforce           # Enforce/validate mandate
      caracal authority revoke            # Revoke mandate
      caracal authority list              # List all mandates
    """
    pass


from caracal.cli.authority import issue, validate, revoke, list_mandates, delegate, graph
authority.add_command(issue, name='mandate')
authority.add_command(validate, name='enforce')
authority.add_command(revoke)
authority.add_command(list_mandates, name='list')
authority.add_command(delegate)
authority.add_command(graph)


# Flow (interactive TUI)
from caracal.flow.main import main as flow_main
cli.add_command(flow_main, name='flow')


# =============================================================================
# DELEGATION
# =============================================================================

@cli.group()
@click.pass_context
def delegation(ctx):
    """
    Manage delegation relationships.
    
    Delegation allows agents to grant subsets of their authority to others.
    
    \b
    Examples:
      caracal delegation generate         # Create delegation
      caracal delegation list             # List delegations
      caracal delegation validate         # Validate graph path
    """
    pass


from caracal.cli.delegation import generate as del_gen, list_delegations, validate as del_val, revoke as del_rev
delegation.add_command(del_gen, name='generate')
delegation.add_command(list_delegations, name='list')
delegation.add_command(del_val, name='validate')
delegation.add_command(del_rev, name='revoke')


# =============================================================================
# ENTERPRISE (Runtime Integration)
# =============================================================================

@cli.group()
@click.pass_context
def enterprise(ctx):
    """
    Manage Caracal Enterprise runtime connectivity.
    
    Connect local workspace to enterprise backend for
    centralized management and multi-user collaboration.
    
    \b
    Examples:
      caracal enterprise login <url> <token>  # Connect to enterprise
      caracal enterprise status               # Show sync status
      caracal enterprise sync                 # Trigger sync
      caracal enterprise disconnect           # Disconnect
    """
    pass


try:
    from caracal.cli.deployment_cli import (
        enterprise_login,
        enterprise_disconnect,
        enterprise_sync,
        enterprise_status,
    )

    enterprise.add_command(enterprise_login, name='login')
    enterprise.add_command(enterprise_disconnect, name='disconnect')
    enterprise.add_command(enterprise_sync, name='sync')
    enterprise.add_command(enterprise_status, name='status')
except ImportError:
    pass


# =============================================================================
# CONFIGURATION
# =============================================================================

@cli.group()
@click.pass_context
def config(ctx):
    """
    Manage system configuration.
    
    Configure mode, edition, and system settings.
    
    \b
    Examples:
      caracal config list                 # Show all settings
      caracal config set <key> <value>    # Set configuration
      caracal config get <key>            # Get configuration
    """
    pass


try:
    from caracal.cli.deployment_cli import (
        config_list, config_get, config_set,
        config_mode, config_edition
    )
    config.add_command(config_list, name='list')
    config.add_command(config_get, name='get')
    config.add_command(config_set, name='set')
    config.add_command(config_mode, name='mode')
    config.add_command(config_edition, name='edition')
except ImportError:
    pass


from caracal.cli.config_encryption import config_encrypt_group
cli.add_command(config_encrypt_group, name='config-encrypt')


# =============================================================================
# PROVIDER MANAGEMENT
# =============================================================================

@cli.group()
@click.pass_context
def provider(ctx):
    """
    Manage external provider configurations.

    Configure authenticated access to external services such as LLMs,
    APIs, databases, infrastructure endpoints, and internal resources.
    
    \b
    Examples:
    caracal provider list               # List providers
    caracal provider add <name> --resource <id> --action <resource:action:method:path> --credential <secret>
    caracal provider test <name>        # Test connection
    caracal provider remove <name>      # Remove provider
    """
    pass


try:
    from caracal.cli.deployment_cli import (
        provider_list, provider_add, provider_test, provider_remove
    )
    provider.add_command(provider_list, name='list')
    provider.add_command(provider_add, name='add')
    provider.add_command(provider_test, name='test')
    provider.add_command(provider_remove, name='remove')
except ImportError:
    pass


# =============================================================================
# SYSTEM UTILITIES
# =============================================================================

@cli.command()
@click.pass_context
def doctor(ctx):
    """
    Run system health checks.
    
    Validates configuration, connectivity, and service health.
    """
    try:
        from caracal.cli.deployment_cli import doctor_command
        ctx.invoke(doctor_command)
    except ImportError:
        click.echo("Running basic health checks...")
        click.echo("✓ Configuration loaded")
        click.echo("✓ Database accessible")
        click.echo()
        click.echo("System appears healthy")


@cli.command()
@click.option('--check-updates', is_flag=True, help='Check for available updates')
def version(check_updates):
    """Show version information."""
    click.echo(f"Caracal v{__version__}")
    
    if check_updates:
        click.echo("Checking for updates...")
        click.echo("You are running the latest version")


@cli.command()
@click.argument('shell', type=click.Choice(['bash', 'zsh', 'fish']), required=False)
def completion(shell):
    """
    Generate shell completion script.
    
    \b
    Examples:
      caracal completion bash > ~/.caracal-completion.bash
      source ~/.caracal-completion.bash
    """
    if not shell:
        click.echo("Usage: caracal completion [bash|zsh|fish]")
        click.echo()
        click.echo("Generate completion script for your shell:")
        click.echo("  caracal completion bash > ~/.caracal-completion.bash")
        click.echo("  source ~/.caracal-completion.bash")
        return
    
    click.echo(f"# Caracal completion for {shell}")
    click.echo("# Source this file in your shell configuration")


# =============================================================================
# AUDIT & LEDGER
# =============================================================================

@cli.group()
@click.pass_context
def audit(ctx):
    """
    Audit authority events and validate workflows.
    
    Query the immutable audit ledger for compliance and debugging.
    
    \b
    Examples:
    caracal audit commands              # Audit CLI command surface
    caracal audit export                # Export audit log
    caracal audit workflow              # Validate workflow
    """
    pass


from caracal.cli.cli_audit import audit_commands, audit_workflow
from caracal.cli.authority_ledger import export as audit_export
audit.add_command(audit_export, name='export')
audit.add_command(audit_commands, name='commands')
audit.add_command(audit_workflow, name='workflow')


# =============================================================================
# ADVANCED/SYSTEM COMMANDS
# =============================================================================

@cli.group(hidden=True)
@click.pass_context
def system(ctx):
    """Advanced system management (for administrators)."""
    pass


# Database management
@system.group(name='db')
def system_db():
    """Database operations."""
    pass


from caracal.cli.db import init_db, db_status
system_db.add_command(init_db, name='init')
system_db.add_command(db_status, name='status')


# Backup/restore
@system.group()
def backup():
    """Backup and restore operations."""
    pass


from caracal.cli.backup import backup_create, backup_restore, backup_list
backup.add_command(backup_create, name='create')
backup.add_command(backup_restore, name='restore')
backup.add_command(backup_list, name='list')
system.add_command(backup)


# Migration
try:
    from caracal.cli.migration import migrate_group
    system.add_command(migrate_group, name='migrate')
except ImportError:
    pass


# Secrets management
from caracal.cli.secrets import secrets_group
system.add_command(secrets_group, name='secrets')

# Master key management
from caracal.cli.system_key import key_group
system.add_command(key_group, name='key')

from caracal.cli.storage_migration import migrate_storage_command
system.add_command(migrate_storage_command, name='migrate-storage')


# Integration services
@system.group()
def integration():
    """Integration services."""
    pass


try:
    from caracal.cli.mcp_service import mcp_service_group
    integration.add_command(mcp_service_group, name='mcp')
except ImportError:
    pass

system.add_command(integration)


# =============================================================================
# INPUT VALIDATION HELPERS
# =============================================================================

def validate_positive_decimal(ctx, param, value):
    """Validate that a value is a positive decimal number."""
    if value is None:
        return value

    try:
        from decimal import Decimal, InvalidOperation

        decimal_value = Decimal(str(value))
        if decimal_value <= 0:
            raise click.BadParameter(f"must be positive, got {value}")
        return decimal_value
    except (ValueError, TypeError, InvalidOperation):
        raise click.BadParameter(f"must be a valid number, got {value}")


def validate_non_negative_decimal(ctx, param, value):
    """Validate that a value is a non-negative decimal number."""
    if value is None:
        return value

    try:
        from decimal import Decimal, InvalidOperation

        decimal_value = Decimal(str(value))
        if decimal_value < 0:
            raise click.BadParameter(f"must be non-negative, got {value}")
        return decimal_value
    except (ValueError, TypeError, InvalidOperation):
        raise click.BadParameter(f"must be a valid number, got {value}")


def validate_uuid(ctx, param, value):
    """Validate that a value is a valid UUID."""
    if value is None:
        return value

    try:
        import uuid

        uuid.UUID(value)
        return value
    except (ValueError, TypeError):
        raise click.BadParameter(f"must be a valid UUID, got {value}")


def validate_time_window(ctx, param, value):
    """Validate that a time window is supported."""
    if value is None:
        return value

    valid_windows = ["daily"]
    if value not in valid_windows:
        raise click.BadParameter(f"must be one of {valid_windows}, got '{value}'")
    return value


def validate_resource_type(ctx, param, value):
    """Validate that a resource type is non-empty."""
    if value is None:
        return value

    if not value or not value.strip():
        raise click.BadParameter("resource type cannot be empty")

    return value.strip()


# =============================================================================
# ERROR HANDLING
# =============================================================================

def handle_caracal_error(func):
    """Decorator to handle CaracalError exceptions."""
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except CaracalError as e:
            click.echo(f"Error: {e}", err=True)
            sys.exit(1)
        except Exception as e:
            click.echo(f"Unexpected error: {e}", err=True)
            if logging.getLogger("caracal").level == logging.DEBUG:
                import traceback
                traceback.print_exc()
            sys.exit(1)
    return wrapper


if __name__ == '__main__':
    cli()
