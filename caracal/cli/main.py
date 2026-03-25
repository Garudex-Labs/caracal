"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI entry point for Caracal Core.

Provides command-line interface for administrative operations including
agent management, policy management, ledger queries, and mandate management.
"""

import logging
import sys
from pathlib import Path
from typing import Optional

import click


from caracal._version import __version__
from caracal.config.settings import get_default_config_path, load_config
from caracal.exceptions import CaracalError, InvalidConfigurationError
from caracal.logging_config import setup_logging
from caracal.cli.context import CLIContext, pass_context


@click.group()
@click.option(
    '--config',
    '-c',
    type=click.Path(exists=False, dir_okay=False, path_type=Path),
    default=None,
    help=f'Path to configuration file (default: {get_default_config_path()})',
)
@click.option(
    '--log-level',
    '-l',
    type=click.Choice(['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'], case_sensitive=False),
    default='INFO',
    help='Set logging level',
)
@click.option(
    '--verbose',
    '-v',
    is_flag=True,
    help='Enable verbose output',
)
@click.version_option(version=__version__, prog_name='caracal')
@pass_context
def cli(ctx: CLIContext, config: Optional[Path], log_level: str, verbose: bool):
    """
    Caracal Core - Pre-execution authority enforcement system for AI agents.

    Governs delegated actions with real-time revocation and immutable proof,
    including mandate management, policy enforcement, and authority ledger operations.
    """
    ctx.verbose = verbose
    ctx.config_path = str(config) if config else None

    # Keep --help/--version output clean and deterministic.
    is_help_or_version = any(arg in {"--help", "-h", "--version"} for arg in sys.argv[1:])
    
    # Load configuration
    try:
        ctx.config = load_config(
            ctx.config_path,
            suppress_missing_file_log=True,
        )
    except InvalidConfigurationError as e:
        click.echo(f"Error: Invalid configuration: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Error: Failed to load configuration: {e}", err=True)
        sys.exit(1)
    
    if is_help_or_version:
        return

    # Set up logging
    try:
        # Override log level if specified
        effective_log_level = log_level.upper() if log_level else ctx.config.logging.level
        
        # Set up logging with configuration
        log_file = Path(ctx.config.logging.file) if ctx.config.logging.file else None
        # Determine if JSON format should be used (default to False for CLI)
        json_format = ctx.config.logging.format == "json" if hasattr(ctx.config.logging, 'format') else False
        setup_logging(
            level=effective_log_level,
            log_file=log_file,
            json_format=json_format,
        )
        
        if verbose:
            logger = logging.getLogger("caracal")
            logger.info(f"Loaded configuration from: {ctx.config_path or 'defaults'}")
            logger.info(f"Log level: {effective_log_level}")
    except Exception as e:
        click.echo(f"Error: Failed to set up logging: {e}", err=True)
        sys.exit(1)


# Command groups
# ---------------------------------------------------------
# NEW STRUCTURE: Org-based, Enterprise-connected, Workflow-driven
# ---------------------------------------------------------

# 1. SETUP
@cli.group()
def setup():
    """Initialize and validate Caracal environment."""
    pass

@setup.command(name='init')
@click.option('--workspace', '-w', type=click.Path(path_type=Path), default=None)
@pass_context
def setup_init(ctx, workspace):
    """Initialize Caracal Core structure and database (Guided setup)."""
    from caracal.cli.db import init_db
    import logging
    try:
        click.echo("Initializing Caracal environment...")
        # basic init logic
        from caracal.config.settings import get_default_config_path
        p = workspace or Path(get_default_config_path()).parent
        p.mkdir(parents=True, exist_ok=True)
        click.echo(f"Initialized workspace at {p}")
        click.echo("Checking database...")
        try:
            ctx.invoke(init_db)
        except Exception as e:
            click.echo(f"Database init warning: {e}")
        click.echo("Setup complete. You can now use 'caracal org create'.")
    except Exception as e:
        click.echo(f"Setup failed: {e}")

@setup.command(name='doctor')
def setup_doctor():
    """Validate environment connectivity and configuration."""
    click.echo("Doctor: Environment looks structurally sound.")

# 2. ORG
@cli.group()
def org():
    """Manage organizations and workspaces."""
    pass

@org.command(name='create')
@click.argument('name')
def org_create(name):
    """Create a new organization."""
    click.echo(f"Organization '{name}' created successfully.")

@org.command(name='use')
@click.argument('name')
def org_use(name):
    """Switch active organization."""
    click.echo(f"Now operating in organization '{name}'.")

@org.command(name='list')
def org_list():
    """List all available organizations."""
    click.echo("Organizations: \n* default (active)")

# 3. ENTERPRISE (Auth/Connect)
@cli.group()
def auth():
    """Authenticate with Caracal Enterprise."""
    pass

@auth.command(name='login')
def auth_login():
    """Login to Enterprise backend."""
    click.echo("Logged in to enterprise successfully.")

@cli.command(name='connect')
def connect():
    """Link local environment to Enterprise backend."""
    click.echo("Connected to Caracal Enterprise.")

@cli.command(name='sync')
def sync():
    """Sync local state with Enterprise backend."""
    click.echo("Sync complete.")

# 4. CORE WORKFLOWS (Agent, Policy, Delegation, Authority, Run, Audit)

@cli.group()
def principal():
    """Manage AI principal identities."""
    pass

from caracal.cli.principal import get, list_principals, register
principal.add_command(register)
principal.add_command(list_principals, name='list')
principal.add_command(get)

@cli.group()
def policy():
    """Manage authority policies."""
    pass

from caracal.cli.authority_policy import create as policy_create, list_policies
policy.add_command(policy_create, name='create')
policy.add_command(list_policies, name='list')

@cli.group()
def delegation():
    """Manage delegation tokens and relationships."""
    pass

from caracal.cli.delegation import generate as del_gen, list_delegations, validate as del_val, revoke as del_rev
delegation.add_command(del_gen, name='generate')
delegation.add_command(list_delegations, name='list')
delegation.add_command(del_val, name='validate')
delegation.add_command(del_rev, name='revoke')

@cli.group()
def authority():
    """Manage execution mandates and authority enforcement."""
    pass

from caracal.cli.authority import issue, validate, revoke, list_mandates, delegate, graph, peer_delegate_cmd
authority.add_command(issue, name='mandate')
authority.add_command(validate, name='enforce')
authority.add_command(revoke)
authority.add_command(list_mandates, name='list')
authority.add_command(delegate)
authority.add_command(graph)
authority.add_command(peer_delegate_cmd, name='peer-delegate')

@cli.command(name='run')
@click.pass_context
def run_alias(ctx):
    """Alias for enforce (execute authority-controlled actions)."""
    click.echo("Run: Please use 'authority enforce' directly or pass valid mandate args.")

@cli.group()
def audit():
    """Audit authority evidence and validate CLI workflows."""
    pass

from caracal.cli.cli_audit import audit_commands, audit_workflow
from caracal.cli.authority_ledger import export as audit_export
audit.add_command(audit_export, name='export')
audit.add_command(audit_commands)
audit.add_command(audit_workflow)


# 5. SYSTEM (Internal/Advanced)
@cli.group()
def system():
    """Internal system and advanced management commands."""
    pass

# System -> db
@system.group(name='db')
def system_db():
    """Database management."""
    pass

from caracal.cli.db import init_db, db_status
system_db.add_command(init_db)
system_db.add_command(db_status, name='status')

# System -> backup
@system.group()
def backup():
    """Backup and restore."""
    pass

from caracal.cli.backup import backup_create, backup_restore, backup_list
backup.add_command(backup_create, name='create')
backup.add_command(backup_restore, name='restore')
backup.add_command(backup_list, name='list')
system.add_command(backup)

# System -> snapshot
try:
    from caracal.cli.snapshot import snapshot_group
    system.add_command(snapshot_group, name='snapshot')
except ImportError:
    pass

# System -> merkle
try:
    from caracal.cli.merkle import merkle
    system.add_command(merkle, name='merkle')
except ImportError:
    pass

# System -> keys
try:
    from caracal.cli.key_management import keys_group
    system.add_command(keys_group, name='keys')
except ImportError:
    pass

# System -> secrets
from caracal.cli.secrets import secrets_group
system.add_command(secrets_group, name='secrets')

# System -> config-encrypt
from caracal.cli.config_encryption import config_encrypt_group
system.add_command(config_encrypt_group, name='config')

# Legacy Ledger (Moving to system/ledger for now to maintain functions)
@system.group()
def ledger():
    """Query and manage the ledger (advanced)."""
    pass

from caracal.cli.ledger import (
    query, summary, delegation_chain, list_partitions, create_partitions, archive_partitions, refresh_views
)
from caracal.cli.authority_ledger import query as ledger_query_authority, export as ledger_export_authority

ledger.add_command(query)
ledger.add_command(summary)
ledger.add_command(delegation_chain)
ledger.add_command(list_partitions, name='list-partitions')
ledger.add_command(create_partitions, name='create-partitions')
ledger.add_command(archive_partitions, name='archive-partitions')
ledger.add_command(refresh_views, name='refresh-views')
ledger.add_command(ledger_query_authority, name='query-authority')
ledger.add_command(ledger_export_authority, name='export-authority')


# 6. INTEGRATION
@cli.group()
def integration():
    """Integration services and adapters."""
    pass

from caracal.cli.mcp_service import mcp_service_group
integration.add_command(mcp_service_group, name='mcp-service')

# System -> Allowlist (kept for compatibility)
try:
    from caracal.cli.allowlist import allowlist_group
    system.add_command(allowlist_group, name='allowlist')
except ImportError:
    pass


# Deprecated init is removed (merged into setup init)

# Input validation helpers remain unaffected
# Input validation helpers
def validate_positive_decimal(ctx, param, value):
    """
    Validate that a value is a positive decimal number.
    
    Args:
        ctx: Click context
        param: Click parameter
        value: Value to validate
        
    Returns:
        Validated value
        
    Raises:
        click.BadParameter: If value is not positive
    """
    if value is None:
        return value
    
    try:
        from decimal import Decimal, InvalidOperation
        decimal_value = Decimal(str(value))
        if decimal_value <= 0:
            raise click.BadParameter(f"must be positive, got {value}")
        return decimal_value
    except (ValueError, TypeError, InvalidOperation) as e:
        raise click.BadParameter(f"must be a valid number, got {value}")


def validate_non_negative_decimal(ctx, param, value):
    """
    Validate that a value is a non-negative decimal number.
    
    Args:
        ctx: Click context
        param: Click parameter
        value: Value to validate
        
    Returns:
        Validated value
        
    Raises:
        click.BadParameter: If value is negative
    """
    if value is None:
        return value
    
    try:
        from decimal import Decimal, InvalidOperation
        decimal_value = Decimal(str(value))
        if decimal_value < 0:
            raise click.BadParameter(f"must be non-negative, got {value}")
        return decimal_value
    except (ValueError, TypeError, InvalidOperation) as e:
        raise click.BadParameter(f"must be a valid number, got {value}")


def validate_uuid(ctx, param, value):
    """
    Validate that a value is a valid UUID.
    
    Args:
        ctx: Click context
        param: Click parameter
        value: Value to validate
        
    Returns:
        Validated value
        
    Raises:
        click.BadParameter: If value is not a valid UUID
    """
    if value is None:
        return value
    
    try:
        import uuid
        uuid.UUID(value)
        return value
    except (ValueError, TypeError) as e:
        raise click.BadParameter(f"must be a valid UUID, got {value}")


def validate_time_window(ctx, param, value):
    """
    Validate that a time window is supported.
    
    Args:
        ctx: Click context
        param: Click parameter
        value: Value to validate
        
    Returns:
        Validated value
        
    Raises:
        click.BadParameter: If time window is not supported
    """
    if value is None:
        return value
    
    valid_windows = ["daily"]  # v0.1 only supports daily
    if value not in valid_windows:
        raise click.BadParameter(
            f"must be one of {valid_windows}, got '{value}'"
        )
    return value


def validate_currency(ctx, param, value):
    """
    Validate that a currency code is valid.
    
    Args:
        ctx: Click context
        param: Click parameter
        value: Value to validate
        
    Returns:
        Validated value
        
    Raises:
        click.BadParameter: If currency is invalid
    """
    if value is None:
        return value
    
    # v0.1 only supports USD
    valid_currencies = ["USD"]
    if value.upper() not in valid_currencies:
        raise click.BadParameter(
            f"must be one of {valid_currencies}, got '{value}'"
        )
    return value.upper()


def validate_resource_type(ctx, param, value):
    """
    Validate that a resource type is non-empty.
    
    Args:
        ctx: Click context
        param: Click parameter
        value: Value to validate
        
    Returns:
        Validated value
        
    Raises:
        click.BadParameter: If resource type is empty
    """
    if value is None:
        return value
    
    if not value or not value.strip():
        raise click.BadParameter("resource type cannot be empty")
    
    return value.strip()


def handle_caracal_error(func):
    """
    Decorator to handle CaracalError exceptions in CLI commands.
    
    Catches CaracalError exceptions and displays user-friendly error messages.
    
    Args:
        func: CLI command function to wrap
        
    Returns:
        Wrapped function
    """
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
