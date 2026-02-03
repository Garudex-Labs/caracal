"""
CLI commands for policy management.

Provides commands for creating, listing, and retrieving budget policies.
"""

import sys
from decimal import Decimal
from pathlib import Path

import click

from caracal.core.identity import AgentRegistry
from caracal.core.policy import PolicyStore
from caracal.exceptions import (
    AgentNotFoundError,
    CaracalError,
    InvalidPolicyError,
)


def get_policy_store(config) -> PolicyStore:
    """
    Create PolicyStore instance from configuration.
    
    Args:
        config: Configuration object
        
    Returns:
        PolicyStore instance
    """
    policy_path = Path(config.storage.policy_store).expanduser()
    backup_count = config.storage.backup_count
    
    # Create agent registry for validation
    registry_path = Path(config.storage.agent_registry).expanduser()
    agent_registry = AgentRegistry(str(registry_path), backup_count=backup_count)
    
    return PolicyStore(
        str(policy_path),
        agent_registry=agent_registry,
        backup_count=backup_count
    )


@click.command('create')
@click.option(
    '--agent-id',
    '-a',
    required=True,
    help='Agent ID this policy applies to',
)
@click.option(
    '--limit',
    '-l',
    required=True,
    type=str,
    help='Maximum spending limit (e.g., 100.00)',
)
@click.option(
    '--time-window',
    '-w',
    type=click.Choice(['hourly', 'daily', 'weekly', 'monthly'], case_sensitive=False),
    default='daily',
    help='Time window for budget (default: daily)',
)
@click.option(
    '--window-type',
    '-t',
    type=click.Choice(['rolling', 'calendar'], case_sensitive=False),
    default='calendar',
    help='Window type: rolling (sliding) or calendar (aligned to boundaries, default: calendar)',
)
@click.option(
    '--currency',
    '-c',
    default='USD',
    help='Currency code (default: USD)',
)
@click.pass_context
def create(ctx, agent_id: str, limit: str, time_window: str, window_type: str, currency: str):
    """
    Create a new budget policy for an agent.
    
    Creates a policy that constrains agent spending within a time window.
    
    v0.3 enhancements:
    - Supports hourly, daily, weekly, monthly time windows
    - Supports rolling (sliding) and calendar (aligned) window types
    
    Examples:
    
        # Daily calendar window (default)
        caracal policy create --agent-id 550e8400-e29b-41d4-a716-446655440000 --limit 100.00
        
        # Hourly rolling window
        caracal policy create -a 550e8400-e29b-41d4-a716-446655440000 -l 50.00 -w hourly -t rolling
        
        # Weekly calendar window
        caracal policy create -a 550e8400-e29b-41d4-a716-446655440000 -l 1000.00 -w weekly -t calendar
        
        # Monthly rolling window
        caracal policy create -a 550e8400-e29b-41d4-a716-446655440000 -l 5000.00 -w monthly -t rolling
    
    Requirements: 9.1, 9.2, 9.3, 9.4
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Validate and parse limit amount
        try:
            limit_amount = Decimal(limit)
            if limit_amount <= 0:
                click.echo(
                    f"Error: Limit amount must be positive, got {limit}",
                    err=True
                )
                sys.exit(1)
        except Exception as e:
            click.echo(
                f"Error: Invalid limit amount '{limit}'. Must be a valid number.",
                err=True
            )
            sys.exit(1)
        
        # Normalize time_window and window_type to lowercase
        time_window = time_window.lower()
        window_type = window_type.lower()
        
        # Create policy store
        policy_store = get_policy_store(cli_ctx.config)
        
        # Create policy
        policy = policy_store.create_policy(
            agent_id=agent_id,
            limit_amount=limit_amount,
            time_window=time_window,
            currency=currency.upper()
        )
        
        # Display success message
        click.echo("✓ Policy created successfully!")
        click.echo()
        click.echo(f"Policy ID:    {policy.policy_id}")
        click.echo(f"Agent ID:     {policy.agent_id}")
        click.echo(f"Limit:        {policy.limit_amount} {policy.currency}")
        click.echo(f"Time Window:  {policy.time_window} ({window_type})")
        click.echo(f"Created:      {policy.created_at}")
        click.echo(f"Active:       {policy.active}")
        
    except AgentNotFoundError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except InvalidPolicyError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)


@click.command('list')
@click.option(
    '--agent-id',
    '-a',
    default=None,
    help='Filter by agent ID (optional)',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def list_policies(ctx, agent_id: str, format: str):
    """
    List budget policies.
    
    Lists all policies in the system, or filters by agent ID if specified.
    
    Examples:
    
        caracal policy list
        
        caracal policy list --agent-id 550e8400-e29b-41d4-a716-446655440000
        
        caracal policy list --format json
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Create policy store
        policy_store = get_policy_store(cli_ctx.config)
        
        # Get policies
        if agent_id:
            policies = policy_store.get_policies(agent_id)
        else:
            policies = policy_store.list_all_policies()
        
        if not policies:
            if agent_id:
                click.echo(f"No policies found for agent: {agent_id}")
            else:
                click.echo("No policies found.")
            return
        
        if format.lower() == 'json':
            # JSON output
            import json
            output = [policy.to_dict() for policy in policies]
            click.echo(json.dumps(output, indent=2))
        else:
            # Table output
            click.echo(f"Total policies: {len(policies)}")
            click.echo()
            
            # Calculate column widths
            max_policy_id_len = max(len(policy.policy_id) for policy in policies)
            max_agent_id_len = max(len(policy.agent_id) for policy in policies)
            
            # Format window display with type
            window_displays = []
            for policy in policies:
                window_type = getattr(policy, 'window_type', 'calendar')
                window_displays.append(f"{policy.time_window} ({window_type})")
            
            max_limit_len = max(len(f"{policy.limit_amount} {policy.currency}") for policy in policies)
            max_window_len = max(len(wd) for wd in window_displays)
            
            # Ensure minimum widths for headers
            policy_id_width = max(max_policy_id_len, len("Policy ID"))
            agent_id_width = max(max_agent_id_len, len("Agent ID"))
            limit_width = max(max_limit_len, len("Limit"))
            window_width = max(max_window_len, len("Time Window"))
            
            # Print header
            header = (
                f"{'Policy ID':<{policy_id_width}}  "
                f"{'Agent ID':<{agent_id_width}}  "
                f"{'Limit':<{limit_width}}  "
                f"{'Time Window':<{window_width}}  "
                f"{'Active':<6}  "
                f"Created"
            )
            click.echo(header)
            click.echo("-" * len(header))
            
            # Print policies
            for i, policy in enumerate(policies):
                # Format created_at to be more readable
                created = policy.created_at.replace('T', ' ').replace('Z', '')
                limit_str = f"{policy.limit_amount} {policy.currency}"
                active_str = "Yes" if policy.active else "No"
                window_display = window_displays[i]
                
                click.echo(
                    f"{policy.policy_id:<{policy_id_width}}  "
                    f"{policy.agent_id:<{agent_id_width}}  "
                    f"{limit_str:<{limit_width}}  "
                    f"{window_display:<{window_width}}  "
                    f"{active_str:<6}  "
                    f"{created}"
                )
        
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)


@click.command('get')
@click.option(
    '--agent-id',
    '-a',
    required=True,
    help='Agent ID to retrieve policies for',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def get(ctx, agent_id: str, format: str):
    """
    Get policies for a specific agent.
    
    Retrieves and displays all active policies for an agent.
    
    Examples:
    
        caracal policy get --agent-id 550e8400-e29b-41d4-a716-446655440000
        
        caracal policy get -a 550e8400-e29b-41d4-a716-446655440000 --format json
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Create policy store
        policy_store = get_policy_store(cli_ctx.config)
        
        # Get policies for agent
        policies = policy_store.get_policies(agent_id)
        
        if not policies:
            click.echo(f"No active policies found for agent: {agent_id}")
            return
        
        if format.lower() == 'json':
            # JSON output
            import json
            output = [policy.to_dict() for policy in policies]
            click.echo(json.dumps(output, indent=2))
        else:
            # Table output
            click.echo(f"Policies for Agent: {agent_id}")
            click.echo("=" * 70)
            click.echo()
            
            for i, policy in enumerate(policies, 1):
                if i > 1:
                    click.echo()
                    click.echo("-" * 70)
                    click.echo()
                
                window_type = getattr(policy, 'window_type', 'calendar')
                
                click.echo(f"Policy #{i}")
                click.echo(f"  Policy ID:    {policy.policy_id}")
                click.echo(f"  Limit:        {policy.limit_amount} {policy.currency}")
                click.echo(f"  Time Window:  {policy.time_window} ({window_type})")
                click.echo(f"  Active:       {'Yes' if policy.active else 'No'}")
                click.echo(f"  Created:      {policy.created_at}")
        
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)


@click.command('history')
@click.option(
    '--policy-id',
    '-p',
    required=True,
    help='Policy ID to retrieve history for',
)
@click.option(
    '--agent-id',
    '-a',
    default=None,
    help='Filter by agent ID (optional)',
)
@click.option(
    '--change-type',
    '-t',
    type=click.Choice(['created', 'modified', 'deactivated'], case_sensitive=False),
    default=None,
    help='Filter by change type (optional)',
)
@click.option(
    '--start-time',
    '-s',
    default=None,
    help='Filter by start time (ISO 8601 format, optional)',
)
@click.option(
    '--end-time',
    '-e',
    default=None,
    help='Filter by end time (ISO 8601 format, optional)',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def history(ctx, policy_id: str, agent_id: str, change_type: str, start_time: str, end_time: str, format: str):
    """
    View policy change history.
    
    Displays complete audit trail of all changes to a policy.
    
    Examples:
    
        caracal policy history --policy-id 550e8400-e29b-41d4-a716-446655440000
        
        caracal policy history -p 550e8400-e29b-41d4-a716-446655440000 --change-type modified
        
        caracal policy history -p 550e8400-e29b-41d4-a716-446655440000 --format json
    
    Requirements: 6.6, 6.7
    """
    try:
        from uuid import UUID
        from datetime import datetime
        from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
        from caracal.core.policy_versions import PolicyVersionManager
        
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Parse policy_id as UUID
        try:
            policy_uuid = UUID(policy_id)
        except ValueError:
            click.echo(f"Error: Invalid policy ID format: {policy_id}", err=True)
            sys.exit(1)
        
        # Create database connection manager
        db_config = DatabaseConfig(
            host=cli_ctx.config.database.host,
            port=cli_ctx.config.database.port,
            database=cli_ctx.config.database.database,
            user=cli_ctx.config.database.user,
            password=cli_ctx.config.database.password
        )
        db_manager = DatabaseConnectionManager(db_config)
        db_manager.initialize()
        
        # Get database session
        with db_manager.session_scope() as db_session:
            # Create version manager
            version_manager = PolicyVersionManager(db_session)
            
            # Get policy history
            versions = version_manager.get_policy_history(policy_uuid)
        
        if not versions:
            click.echo(f"No history found for policy: {policy_id}")
            return
        
        # Apply filters
        if agent_id:
            try:
                agent_uuid = UUID(agent_id)
                versions = [v for v in versions if v.agent_id == agent_uuid]
            except ValueError:
                click.echo(f"Error: Invalid agent ID format: {agent_id}", err=True)
                sys.exit(1)
        
        if change_type:
            versions = [v for v in versions if v.change_type == change_type.lower()]
        
        if start_time:
            try:
                start_dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
                versions = [v for v in versions if v.changed_at >= start_dt]
            except ValueError:
                click.echo(f"Error: Invalid start time format: {start_time}", err=True)
                sys.exit(1)
        
        if end_time:
            try:
                end_dt = datetime.fromisoformat(end_time.replace('Z', '+00:00'))
                versions = [v for v in versions if v.changed_at <= end_dt]
            except ValueError:
                click.echo(f"Error: Invalid end time format: {end_time}", err=True)
                sys.exit(1)
        
        if not versions:
            click.echo("No versions match the specified filters.")
            return
        
        if format.lower() == 'json':
            # JSON output
            import json
            output = [
                {
                    'version_id': str(v.version_id),
                    'policy_id': str(v.policy_id),
                    'version_number': v.version_number,
                    'agent_id': str(v.agent_id),
                    'limit_amount': str(v.limit_amount),
                    'time_window': v.time_window,
                    'window_type': v.window_type,
                    'currency': v.currency,
                    'active': v.active,
                    'change_type': v.change_type,
                    'changed_by': v.changed_by,
                    'changed_at': v.changed_at.isoformat(),
                    'change_reason': v.change_reason
                }
                for v in versions
            ]
            click.echo(json.dumps(output, indent=2))
        else:
            # Table output
            click.echo(f"Policy History: {policy_id}")
            click.echo(f"Total versions: {len(versions)}")
            click.echo()
            
            for i, version in enumerate(versions, 1):
                if i > 1:
                    click.echo()
                    click.echo("-" * 70)
                    click.echo()
                
                click.echo(f"Version {version.version_number}")
                click.echo(f"  Version ID:    {version.version_id}")
                click.echo(f"  Change Type:   {version.change_type}")
                click.echo(f"  Changed By:    {version.changed_by}")
                click.echo(f"  Changed At:    {version.changed_at}")
                click.echo(f"  Reason:        {version.change_reason}")
                click.echo(f"  Limit:         {version.limit_amount} {version.currency}")
                click.echo(f"  Time Window:   {version.time_window} ({version.window_type})")
                click.echo(f"  Active:        {'Yes' if version.active else 'No'}")
        
        # Close connection manager
        db_manager.close()
        
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        import traceback
        traceback.print_exc()
        sys.exit(1)


@click.command('version-at')
@click.option(
    '--policy-id',
    '-p',
    required=True,
    help='Policy ID to query',
)
@click.option(
    '--timestamp',
    '-t',
    required=True,
    help='Timestamp to query (ISO 8601 format)',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def version_at(ctx, policy_id: str, timestamp: str, format: str):
    """
    Get policy version at a specific time.
    
    Retrieves the policy version that was active at the specified timestamp.
    
    Examples:
    
        caracal policy version-at --policy-id 550e8400-e29b-41d4-a716-446655440000 --timestamp 2024-01-15T10:30:00Z
        
        caracal policy version-at -p 550e8400-e29b-41d4-a716-446655440000 -t 2024-01-15T10:30:00Z --format json
    
    Requirements: 6.6
    """
    try:
        from uuid import UUID
        from datetime import datetime
        from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
        from caracal.core.policy_versions import PolicyVersionManager
        
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Parse policy_id as UUID
        try:
            policy_uuid = UUID(policy_id)
        except ValueError:
            click.echo(f"Error: Invalid policy ID format: {policy_id}", err=True)
            sys.exit(1)
        
        # Parse timestamp
        try:
            dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
        except ValueError:
            click.echo(f"Error: Invalid timestamp format: {timestamp}", err=True)
            sys.exit(1)
        
        # Create database connection manager
        db_config = DatabaseConfig(
            host=cli_ctx.config.database.host,
            port=cli_ctx.config.database.port,
            database=cli_ctx.config.database.database,
            user=cli_ctx.config.database.user,
            password=cli_ctx.config.database.password
        )
        db_manager = DatabaseConnectionManager(db_config)
        db_manager.initialize()
        
        # Get database session
        with db_manager.session_scope() as db_session:
            # Create version manager
            version_manager = PolicyVersionManager(db_session)
            
            # Get policy version at time
            version = version_manager.get_policy_at_time(policy_uuid, dt)
        
        if version is None:
            click.echo(f"No policy version found for policy {policy_id} at time {timestamp}")
            return
        
        if format.lower() == 'json':
            # JSON output
            import json
            output = {
                'version_id': str(version.version_id),
                'policy_id': str(version.policy_id),
                'version_number': version.version_number,
                'agent_id': str(version.agent_id),
                'limit_amount': str(version.limit_amount),
                'time_window': version.time_window,
                'window_type': version.window_type,
                'currency': version.currency,
                'active': version.active,
                'change_type': version.change_type,
                'changed_by': version.changed_by,
                'changed_at': version.changed_at.isoformat(),
                'change_reason': version.change_reason
            }
            click.echo(json.dumps(output, indent=2))
        else:
            # Table output
            click.echo(f"Policy Version at {timestamp}")
            click.echo("=" * 70)
            click.echo()
            click.echo(f"Policy ID:     {version.policy_id}")
            click.echo(f"Version:       {version.version_number}")
            click.echo(f"Version ID:    {version.version_id}")
            click.echo(f"Agent ID:      {version.agent_id}")
            click.echo(f"Limit:         {version.limit_amount} {version.currency}")
            click.echo(f"Time Window:   {version.time_window} ({version.window_type})")
            click.echo(f"Active:        {'Yes' if version.active else 'No'}")
            click.echo(f"Change Type:   {version.change_type}")
            click.echo(f"Changed By:    {version.changed_by}")
            click.echo(f"Changed At:    {version.changed_at}")
            click.echo(f"Reason:        {version.change_reason}")
        
        # Close connection manager
        db_manager.close()
        
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        import traceback
        traceback.print_exc()
        sys.exit(1)


@click.command('compare-versions')
@click.option(
    '--version1',
    '-v1',
    required=True,
    help='First version ID to compare',
)
@click.option(
    '--version2',
    '-v2',
    required=True,
    help='Second version ID to compare',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def compare_versions(ctx, version1: str, version2: str, format: str):
    """
    Compare two policy versions.
    
    Shows differences between two policy versions.
    
    Examples:
    
        caracal policy compare-versions --version1 550e8400-e29b-41d4-a716-446655440000 --version2 660e8400-e29b-41d4-a716-446655440001
        
        caracal policy compare-versions -v1 550e8400-e29b-41d4-a716-446655440000 -v2 660e8400-e29b-41d4-a716-446655440001 --format json
    
    Requirements: 6.6
    """
    try:
        from uuid import UUID
        from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
        from caracal.core.policy_versions import PolicyVersionManager
        
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Parse version IDs as UUIDs
        try:
            version1_uuid = UUID(version1)
            version2_uuid = UUID(version2)
        except ValueError as e:
            click.echo(f"Error: Invalid version ID format: {e}", err=True)
            sys.exit(1)
        
        # Create database connection manager
        db_config = DatabaseConfig(
            host=cli_ctx.config.database.host,
            port=cli_ctx.config.database.port,
            database=cli_ctx.config.database.database,
            user=cli_ctx.config.database.user,
            password=cli_ctx.config.database.password
        )
        db_manager = DatabaseConnectionManager(db_config)
        db_manager.initialize()
        
        # Get database session
        with db_manager.session_scope() as db_session:
            # Create version manager
            version_manager = PolicyVersionManager(db_session)
            
            # Compare versions
            diff = version_manager.compare_versions(version1_uuid, version2_uuid)
        
        if format.lower() == 'json':
            # JSON output
            import json
            output = {
                'version1': {
                    'version_id': str(diff.version1.version_id),
                    'version_number': diff.version1.version_number,
                    'changed_at': diff.version1.changed_at.isoformat()
                },
                'version2': {
                    'version_id': str(diff.version2.version_id),
                    'version_number': diff.version2.version_number,
                    'changed_at': diff.version2.changed_at.isoformat()
                },
                'changed_fields': {
                    field: {
                        'old_value': str(old_val),
                        'new_value': str(new_val)
                    }
                    for field, (old_val, new_val) in diff.changed_fields.items()
                }
            }
            click.echo(json.dumps(output, indent=2))
        else:
            # Table output
            click.echo("Policy Version Comparison")
            click.echo("=" * 70)
            click.echo()
            click.echo(f"Version 1: {diff.version1.version_id} (v{diff.version1.version_number})")
            click.echo(f"  Changed At: {diff.version1.changed_at}")
            click.echo()
            click.echo(f"Version 2: {diff.version2.version_id} (v{diff.version2.version_number})")
            click.echo(f"  Changed At: {diff.version2.changed_at}")
            click.echo()
            
            if not diff.changed_fields:
                click.echo("No differences found between versions.")
            else:
                click.echo(f"Changed Fields ({len(diff.changed_fields)}):")
                click.echo("-" * 70)
                
                for field, (old_val, new_val) in diff.changed_fields.items():
                    click.echo()
                    click.echo(f"  {field}:")
                    click.echo(f"    Old: {old_val}")
                    click.echo(f"    New: {new_val}")
        
        # Close connection manager
        db_manager.close()
        
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        import traceback
        traceback.print_exc()
        sys.exit(1)
