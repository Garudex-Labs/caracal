"""
CLI entry point for Caracal Core.

Provides command-line interface for administrative operations including
agent management, policy management, ledger queries, and pricebook management.
"""

import logging
import sys
from pathlib import Path
from typing import Optional

import click

from caracal.config.settings import get_default_config_path, load_config
from caracal.exceptions import CaracalError, InvalidConfigurationError
from caracal.logging_config import setup_logging


# Global context object to share configuration across commands
class CLIContext:
    """Context object for CLI commands."""
    
    def __init__(self):
        self.config = None
        self.config_path = None
        self.verbose = False


pass_context = click.make_pass_decorator(CLIContext, ensure=True)


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
@click.version_option(version='0.1.1', prog_name='caracal')
@pass_context
def cli(ctx: CLIContext, config: Optional[Path], log_level: str, verbose: bool):
    """
    Caracal Core - Economic control plane for AI agents.
    
    Provides budget enforcement, metering, and ledger management for AI agents.
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
        setup_logging(
            level=effective_log_level,
            log_file=log_file,
            log_format=ctx.config.logging.format,
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
    """Manage budget policies."""
    pass


# Import and register policy commands
from caracal.cli.policy import create, get, list_policies
policy.add_command(create)
policy.add_command(list_policies, name='list')
policy.add_command(get)


@cli.group()
def ledger():
    """Query and manage the ledger."""
    pass


# Import and register ledger commands
from caracal.cli.ledger import query, summary, delegation_chain
ledger.add_command(query)
ledger.add_command(summary)
ledger.add_command(delegation_chain)


@cli.group()
def pricebook():
    """Manage resource prices."""
    pass


# Import and register pricebook commands
from caracal.cli.pricebook import get_price, import_prices, list_prices, set_price
pricebook.add_command(list_prices, name='list')
pricebook.add_command(get_price, name='get')
pricebook.add_command(set_price, name='set')
pricebook.add_command(import_prices, name='import')


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
    """Manage delegation tokens."""
    pass


# Import and register delegation commands
from caracal.cli.delegation import generate, list_tokens, validate
delegation.add_command(generate)
delegation.add_command(list_tokens, name='list')
delegation.add_command(validate)


@cli.group(name='mcp-service')
def mcp_service():
    """Manage MCP Adapter Service."""
    pass


# Import and register MCP service commands
from caracal.cli.mcp_service import mcp_service_group
cli.add_command(mcp_service_group)


@cli.command()
@pass_context
def init(ctx: CLIContext):
    """
    Initialize Caracal Core directory structure and configuration.
    
    Creates ~/.caracal/ directory with default configuration and data files.
    """
    try:
        import os
        import shutil
        
        caracal_dir = Path.home() / ".caracal"
        
        # Create directory structure
        caracal_dir.mkdir(parents=True, exist_ok=True)
        (caracal_dir / "backups").mkdir(exist_ok=True)
        
        click.echo(f"Created directory: {caracal_dir}")
        
        # Create default config.yaml if it doesn't exist
        config_path = caracal_dir / "config.yaml"
        if not config_path.exists():
            default_config_content = """# Caracal Core Configuration

storage:
  agent_registry: ~/.caracal/agents.json
  policy_store: ~/.caracal/policies.json
  ledger: ~/.caracal/ledger.jsonl
  pricebook: ~/.caracal/pricebook.csv
  backup_dir: ~/.caracal/backups
  backup_count: 3

defaults:
  currency: USD
  time_window: daily
  default_budget: 100.00

logging:
  level: INFO
  file: ~/.caracal/caracal.log
  format: "%(asctime)s - %(name)s - %(levelname)s - %(message)s"

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
        agents_path = caracal_dir / "agents.json"
        if not agents_path.exists():
            agents_path.write_text("[]")
            click.echo(f"Created agent registry: {agents_path}")
        
        # Create empty policies.json if it doesn't exist
        policies_path = caracal_dir / "policies.json"
        if not policies_path.exists():
            policies_path.write_text("[]")
            click.echo(f"Created policy store: {policies_path}")
        
        # Create empty ledger.jsonl if it doesn't exist
        ledger_path = caracal_dir / "ledger.jsonl"
        if not ledger_path.exists():
            ledger_path.write_text("")
            click.echo(f"Created ledger: {ledger_path}")
        
        # Create sample pricebook.csv if it doesn't exist
        pricebook_path = caracal_dir / "pricebook.csv"
        if not pricebook_path.exists():
            sample_pricebook = """resource_type,price_per_unit,currency,updated_at
openai.gpt4.input_tokens,0.000030,USD,2024-01-15T10:00:00Z
openai.gpt4.output_tokens,0.000060,USD,2024-01-15T10:00:00Z
openai.gpt35.input_tokens,0.000001,USD,2024-01-15T10:00:00Z
openai.gpt35.output_tokens,0.000002,USD,2024-01-15T10:00:00Z
anthropic.claude3.input_tokens,0.000015,USD,2024-01-15T10:00:00Z
anthropic.claude3.output_tokens,0.000075,USD,2024-01-15T10:00:00Z
"""
            pricebook_path.write_text(sample_pricebook)
            click.echo(f"Created sample pricebook: {pricebook_path}")
        
        click.echo("\n✓ Caracal Core initialized successfully!")
        click.echo(f"\nConfiguration directory: {caracal_dir}")
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
