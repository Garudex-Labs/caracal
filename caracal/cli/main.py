"""
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
    
    Provides mandate management, policy enforcement, and authority ledger for AI agents.
    """
    ctx.verbose = verbose
    ctx.config_path = str(config) if config else None
    
    # Load configuration
    try:
        ctx.config = load_config(ctx.config_path)
    except InvalidConfigurationError as e:
        click.echo(f"Error: Invalid configuration: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Error: Failed to load configuration: {e}", err=True)
        sys.exit(1)
    
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


# Command groups (to be implemented in separate modules)
@cli.group()
def agent():
    """Manage AI agent identities."""
    pass


# Import and register agent commands
from caracal.cli.agent import get, list_agents, register
agent.add_command(register)
agent.add_command(list_agents, name='list')
agent.add_command(get)


@cli.group()
def policy():
    """Manage authority policies."""
    pass


# Import and register authority policy commands (v0.5)
from caracal.cli.authority_policy import create, list_policies
policy.add_command(create)
policy.add_command(list_policies, name='list')


@cli.group()
def ledger():
    """Query and manage the ledger."""
    pass


# Import and register ledger commands
from caracal.cli.ledger import (
    query, 
    summary, 
    delegation_chain,
    list_partitions,
    create_partitions,
    archive_partitions,
    refresh_views
)
ledger.add_command(query)
ledger.add_command(summary)
ledger.add_command(delegation_chain)
ledger.add_command(list_partitions, name='list-partitions')
ledger.add_command(create_partitions, name='create-partitions')
ledger.add_command(archive_partitions, name='archive-partitions')
ledger.add_command(refresh_views, name='refresh-views')


@cli.group()
def backup():
    """Backup and restore operations."""
    pass


# Import and register backup commands
from caracal.cli.backup import backup_create, backup_restore, backup_list
backup.add_command(backup_create, name='create')
backup.add_command(backup_restore, name='restore')
backup.add_command(backup_list, name='list')


@cli.group()
def delegation():
    """Manage delegation tokens and relationships."""
    pass


# Import and register delegation commands
from caracal.cli.delegation import generate, list_delegations, validate, revoke
delegation.add_command(generate)
delegation.add_command(list_delegations, name='list')
delegation.add_command(validate)
delegation.add_command(revoke)


@cli.group(name='mcp-service')
def mcp_service():
    """Manage MCP Adapter Service."""
    pass


# Import and register MCP service commands
from caracal.cli.mcp_service import mcp_service_group
cli.add_command(mcp_service_group)




@cli.group(name='db')
def db():
    """Database management commands."""
    pass


# Import and register database commands (lazy import to avoid circular dependency)
def _register_db_commands():
    from caracal.cli.db import init_db, db_status
    db.add_command(init_db)
    # db.add_command(migrate)  # Removed: Migration tool deprecated
    db.add_command(db_status, name='status')

_register_db_commands()


# Import and register Merkle commands (v0.3)
try:
    from caracal.cli.merkle import merkle
    cli.add_command(merkle)
except ImportError:
    # Merkle commands not available if cryptography not installed
    pass


# Import and register Allowlist commands (v0.3)
try:
    from caracal.cli.allowlist import allowlist_group
    cli.add_command(allowlist_group)
except ImportError:
    # Allowlist commands not available
    pass


# Import and register Snapshot commands (v0.3)
try:
    from caracal.cli.snapshot import snapshot_group
    cli.add_command(snapshot_group)
except ImportError:
    # Snapshot commands not available
    pass


# Import and register Key Management commands (v0.3)
try:
    from caracal.cli.key_management import keys_group
    cli.add_command(keys_group)
except ImportError as e:
    # Key management commands not available
    import logging
    logging.getLogger(__name__).debug(f"Key management commands not available: {e}")
except Exception as e:
    # Log any other errors
    import logging
    logging.getLogger(__name__).warning(f"Failed to register key management commands: {e}")


# Import and register Configuration Encryption commands (v0.3)
try:
    from caracal.cli.config_encryption import config_encrypt_group
    cli.add_command(config_encrypt_group)
except ImportError as e:
    # Config encryption commands not available
    import logging
    logging.getLogger(__name__).debug(f"Config encryption commands not available: {e}")
except Exception as e:
    # Log any other errors
    import logging
    logging.getLogger(__name__).warning(f"Failed to register config encryption commands: {e}")


# Import and register Authority commands (v0.5)
@cli.group()
def authority():
    """Manage execution mandates and authority enforcement."""
    pass


try:
    from caracal.cli.authority import issue, validate, revoke, list_mandates, delegate
    authority.add_command(issue)
    authority.add_command(validate)
    authority.add_command(revoke)
    authority.add_command(list_mandates, name='list')
    authority.add_command(delegate)
except ImportError as e:
    # Authority commands not available
    import logging
    logging.getLogger(__name__).debug(f"Authority commands not available: {e}")
except Exception as e:
    # Log any other errors
    import logging
    logging.getLogger(__name__).warning(f"Failed to register authority commands: {e}")


# Authority policy commands are now registered in the main policy group above


# Import and register Authority Ledger commands (v0.5)
# Note: These extend the existing ledger group
try:
    from caracal.cli.authority_ledger import query as ledger_query_authority, export as ledger_export_authority
    # Add authority ledger commands to existing ledger group
    ledger.add_command(ledger_query_authority, name='query-authority')
    ledger.add_command(ledger_export_authority, name='export-authority')
except ImportError as e:
    # Authority ledger commands not available
    import logging
    logging.getLogger(__name__).debug(f"Authority ledger commands not available: {e}")
except Exception as e:
    # Log any other errors
    import logging
    logging.getLogger(__name__).warning(f"Failed to register authority ledger commands: {e}")


# Import and register Audit commands (v0.5)
@cli.group()
def audit():
    """Export audit reports."""
    pass


try:
    from caracal.cli.authority_ledger import export as audit_export
    audit.add_command(audit_export, name='export')
except ImportError as e:
    # Audit commands not available
    import logging
    logging.getLogger(__name__).debug(f"Audit commands not available: {e}")
except Exception as e:
    # Log any other errors
    import logging
    logging.getLogger(__name__).warning(f"Failed to register audit commands: {e}")




@cli.command()
@click.option(
    '--workspace',
    '-w',
    type=click.Path(path_type=Path),
    default=None,
    help='Workspace directory (default: ~/.caracal/)',
)
@pass_context
def init(ctx: CLIContext, workspace: Optional[Path]):
    """
    Initialize Caracal Core directory structure and configuration.
    
    Creates workspace directory with default configuration and data files.
    """
    try:
        import os
        import shutil
        from caracal.flow.workspace import get_workspace, set_workspace, WorkspaceManager
        
        if workspace:
            ws = set_workspace(workspace)
        else:
            ws = get_workspace()
        
        caracal_dir = ws.root
        
        # Create directory structure
        ws.ensure_dirs()
        
        click.echo(f"Created directory: {caracal_dir}")
        
        # Create default config.yaml if it doesn't exist
        config_path = ws.config_path
        if not config_path.exists():
            default_config_content = f"""# Caracal Core Configuration

storage:
  agent_registry: {ws.agents_path}
  policy_store: {ws.policies_path}
  ledger: {ws.ledger_path}
  backup_dir: {ws.backups_dir}
  backup_count: 3

defaults:
  currency: USD
  time_window: daily


logging:
  level: INFO
  file: {ws.log_path}
  format: "%(asctime)s - %(name)s - %(levelname)s - %(message)s"

database:
  type: postgres  # or "sqlite"
  # For PostgreSQL:
  host: localhost
  port: 5432
  database: caracal
  user: caracal
  password: ""
  # For SQLite:
  # type: sqlite
  # file_path: {ws.db_path}

performance:
  policy_eval_timeout_ms: 100
  ledger_write_timeout_ms: 10
  file_lock_timeout_s: 5
  max_retries: 3
"""
            config_path.write_text(default_config_content)
            click.echo(f"Created configuration: {config_path}")
        else:
            click.echo(f"Configuration already exists: {config_path}")
        
        # Create empty agents.json if it doesn't exist
        agents_path = ws.agents_path
        if not agents_path.exists():
            agents_path.write_text("[]")
            click.echo(f"Created agent registry: {agents_path}")
        
        # Create empty policies.json if it doesn't exist
        policies_path = ws.policies_path
        if not policies_path.exists():
            policies_path.write_text("[]")
            click.echo(f"Created policy store: {policies_path}")
        
        # Create empty ledger.jsonl if it doesn't exist
        ledger_path = ws.ledger_path
        if not ledger_path.exists():
            ledger_path.write_text("")
            click.echo(f"Created ledger: {ledger_path}")
        
        # Register workspace
        WorkspaceManager.register_workspace(caracal_dir.name, caracal_dir)
        
        click.echo("\n✓ Caracal Core initialized successfully!")
        click.echo(f"\nWorkspace directory: {caracal_dir}")
        click.echo("\nNext steps:")
        click.echo("  1. Register an agent: caracal agent register --name my-agent --owner user@example.com")
        click.echo("  2. Create a policy: caracal policy create --agent-id <uuid> --limit 100.00")
        click.echo("  3. Query the ledger: caracal ledger query")
        
    except Exception as e:
        click.echo(f"Error: Failed to initialize Caracal Core: {e}", err=True)
        sys.exit(1)


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
