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
from caracal.logging_config import get_logger

logger = get_logger(__name__)


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








@click.command('status')
@click.option(
    '--agent-id',
    '-a',
    required=True,
    help='Agent ID to check policy status for',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def status(ctx, agent_id: str, format: str):
    """
    Show policy status for an agent.
    
    Displays all active policies for an agent and shows which policy is closest to its limit.
    Useful for multi-policy scenarios to understand budget utilization.
    
    Examples:
    
        caracal policy status --agent-id 550e8400-e29b-41d4-a716-446655440000
        
        caracal policy status -a 550e8400-e29b-41d4-a716-446655440000 --format json
    
    Requirements: 19.6
    """
    try:
        from caracal.core.policy import PolicyEvaluator
        from caracal.core.ledger import LedgerQuery
        from datetime import datetime
        
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Create policy store
        policy_store = get_policy_store(cli_ctx.config)
        
        # Get policies for agent
        policies = policy_store.get_policies(agent_id)
        
        if not policies:
            click.echo(f"No active policies found for agent: {agent_id}")
            return
        
        # Create ledger query
        ledger_path = Path(cli_ctx.config.storage.ledger_store).expanduser()
        ledger_query = LedgerQuery(str(ledger_path))
        
        # Create policy evaluator
        evaluator = PolicyEvaluator(policy_store, ledger_query)
        
        # Evaluate each policy
        current_time = datetime.utcnow()
        policy_statuses = []
        
        for policy in policies:
            try:
                decision = evaluator.evaluate_single_policy(
                    policy=policy,
                    agent_id=agent_id,
                    estimated_cost=None,
                    current_time=current_time
                )
                
                # Calculate utilization percentage
                utilization_pct = (
                    (decision.current_spending + decision.reserved_budget) / decision.limit_amount * 100
                    if decision.limit_amount > 0 else 0
                )
                
                policy_statuses.append({
                    'policy_id': policy.policy_id,
                    'time_window': decision.time_window,
                    'window_type': decision.window_type,
                    'limit': decision.limit_amount,
                    'spent': decision.current_spending,
                    'reserved': decision.reserved_budget,
                    'available': decision.available_budget,
                    'utilization_pct': utilization_pct,
                    'currency': policy.currency,
                    'status': 'OK' if decision.allowed else 'EXCEEDED'
                })
            except Exception as e:
                logger.error(f"Failed to evaluate policy {policy.policy_id}: {e}")
                policy_statuses.append({
                    'policy_id': policy.policy_id,
                    'time_window': policy.time_window,
                    'window_type': getattr(policy, 'window_type', 'calendar'),
                    'limit': policy.get_limit_decimal(),
                    'spent': Decimal('0'),
                    'reserved': Decimal('0'),
                    'available': Decimal('0'),
                    'utilization_pct': 0,
                    'currency': policy.currency,
                    'status': 'ERROR'
                })
        
        # Find policy closest to limit
        closest_policy = max(policy_statuses, key=lambda p: p['utilization_pct'])
        
        if format.lower() == 'json':
            # JSON output
            import json
            output = {
                'agent_id': agent_id,
                'total_policies': len(policy_statuses),
                'policies': [
                    {
                        'policy_id': p['policy_id'],
                        'time_window': p['time_window'],
                        'window_type': p['window_type'],
                        'limit': str(p['limit']),
                        'spent': str(p['spent']),
                        'reserved': str(p['reserved']),
                        'available': str(p['available']),
                        'utilization_percent': float(p['utilization_pct']),
                        'currency': p['currency'],
                        'status': p['status']
                    }
                    for p in policy_statuses
                ],
                'closest_to_limit': {
                    'policy_id': closest_policy['policy_id'],
                    'utilization_percent': float(closest_policy['utilization_pct'])
                }
            }
            click.echo(json.dumps(output, indent=2))
        else:
            # Table output
            click.echo(f"Policy Status for Agent: {agent_id}")
            click.echo(f"Total Policies: {len(policy_statuses)}")
            click.echo("=" * 100)
            click.echo()
            
            for i, status_info in enumerate(policy_statuses, 1):
                if i > 1:
                    click.echo()
                    click.echo("-" * 100)
                    click.echo()
                
                # Mark closest to limit
                closest_marker = " ⚠️  CLOSEST TO LIMIT" if status_info == closest_policy else ""
                
                click.echo(f"Policy #{i}{closest_marker}")
                click.echo(f"  Policy ID:     {status_info['policy_id']}")
                click.echo(f"  Time Window:   {status_info['time_window']} ({status_info['window_type']})")
                click.echo(f"  Status:        {status_info['status']}")
                click.echo(f"  Limit:         {status_info['limit']} {status_info['currency']}")
                click.echo(f"  Spent:         {status_info['spent']} {status_info['currency']}")
                click.echo(f"  Reserved:      {status_info['reserved']} {status_info['currency']}")
                click.echo(f"  Available:     {status_info['available']} {status_info['currency']}")
                click.echo(f"  Utilization:   {status_info['utilization_pct']:.2f}%")
                
                # Show visual progress bar
                bar_width = 40
                filled = int(bar_width * status_info['utilization_pct'] / 100)
                bar = '█' * filled + '░' * (bar_width - filled)
                click.echo(f"  Progress:      [{bar}]")
        
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        import traceback
        traceback.print_exc()
        sys.exit(1)
