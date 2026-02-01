"""
CLI commands for ledger management.

Provides commands for querying and summarizing ledger events.
"""

import json
import sys
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Optional

import click

from caracal.core.ledger import LedgerQuery
from caracal.exceptions import CaracalError, LedgerReadError


def get_ledger_query(config) -> LedgerQuery:
    """
    Create LedgerQuery instance from configuration.
    
    Args:
        config: Configuration object
        
    Returns:
        LedgerQuery instance
    """
    ledger_path = Path(config.storage.ledger).expanduser()
    return LedgerQuery(str(ledger_path))


def get_agent_registry(config):
    """
    Create AgentRegistry instance from configuration.
    
    Args:
        config: Configuration object
        
    Returns:
        AgentRegistry instance
    """
    from caracal.core.identity import AgentRegistry
    registry_path = Path(config.storage.agent_registry).expanduser()
    return AgentRegistry(str(registry_path))


def parse_datetime(date_str: str) -> datetime:
    """
    Parse datetime string in various formats.
    
    Supports:
    - ISO 8601: 2024-01-15T10:30:00Z
    - Date only: 2024-01-15 (assumes 00:00:00)
    - Date and time: 2024-01-15 10:30:00
    
    Args:
        date_str: Date/time string to parse
        
    Returns:
        datetime object
        
    Raises:
        ValueError: If date string cannot be parsed
    """
    # Try ISO 8601 format first
    for fmt in [
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
    ]:
        try:
            return datetime.strptime(date_str, fmt)
        except ValueError:
            continue
    
    raise ValueError(
        f"Invalid date format: {date_str}. "
        f"Expected formats: YYYY-MM-DD, YYYY-MM-DD HH:MM:SS, or ISO 8601"
    )


@click.command('query')
@click.option(
    '--agent-id',
    '-a',
    default=None,
    help='Filter by agent ID (optional)',
)
@click.option(
    '--start',
    '-s',
    default=None,
    help='Start time (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)',
)
@click.option(
    '--end',
    '-e',
    default=None,
    help='End time (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)',
)
@click.option(
    '--resource',
    '-r',
    default=None,
    help='Filter by resource type (optional)',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def query(
    ctx,
    agent_id: Optional[str],
    start: Optional[str],
    end: Optional[str],
    resource: Optional[str],
    format: str,
):
    """
    Query ledger events with optional filters.
    
    Returns all events matching the specified filters. All filters are optional
    and can be combined.
    
    Examples:
    
        # Query all events
        caracal ledger query
        
        # Query events for a specific agent
        caracal ledger query --agent-id 550e8400-e29b-41d4-a716-446655440000
        
        # Query events in a date range
        caracal ledger query --start 2024-01-01 --end 2024-01-31
        
        # Query events for a specific resource type
        caracal ledger query --resource openai.gpt4.input_tokens
        
        # Combine filters
        caracal ledger query -a 550e8400-e29b-41d4-a716-446655440000 \\
            -s 2024-01-01 -e 2024-01-31 -r openai.gpt4.input_tokens
        
        # JSON output
        caracal ledger query --format json
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Parse date/time filters
        start_time = None
        end_time = None
        
        if start:
            try:
                start_time = parse_datetime(start)
            except ValueError as e:
                click.echo(f"Error: Invalid start time: {e}", err=True)
                sys.exit(1)
        
        if end:
            try:
                end_time = parse_datetime(end)
            except ValueError as e:
                click.echo(f"Error: Invalid end time: {e}", err=True)
                sys.exit(1)
        
        # Validate time range
        if start_time and end_time and start_time > end_time:
            click.echo(
                "Error: Start time must be before or equal to end time",
                err=True
            )
            sys.exit(1)
        
        # Create ledger query
        ledger_query = get_ledger_query(cli_ctx.config)
        
        # Query events
        events = ledger_query.get_events(
            agent_id=agent_id,
            start_time=start_time,
            end_time=end_time,
            resource_type=resource,
        )
        
        if not events:
            click.echo("No events found matching the specified filters.")
            return
        
        if format.lower() == 'json':
            # JSON output
            output = [event.to_dict() for event in events]
            click.echo(json.dumps(output, indent=2))
        else:
            # Table output
            click.echo(f"Total events: {len(events)}")
            click.echo()
            
            # Calculate column widths
            max_event_id_len = max(len(str(event.event_id)) for event in events)
            max_agent_id_len = max(len(event.agent_id) for event in events)
            max_resource_len = max(len(event.resource_type) for event in events)
            max_quantity_len = max(len(event.quantity) for event in events)
            max_cost_len = max(len(f"{event.cost} {event.currency}") for event in events)
            
            # Ensure minimum widths for headers
            event_id_width = max(max_event_id_len, len("Event ID"))
            agent_id_width = max(max_agent_id_len, len("Agent ID"))
            resource_width = max(max_resource_len, len("Resource Type"))
            quantity_width = max(max_quantity_len, len("Quantity"))
            cost_width = max(max_cost_len, len("Cost"))
            
            # Print header
            header = (
                f"{'Event ID':<{event_id_width}}  "
                f"{'Agent ID':<{agent_id_width}}  "
                f"{'Resource Type':<{resource_width}}  "
                f"{'Quantity':<{quantity_width}}  "
                f"{'Cost':<{cost_width}}  "
                f"Timestamp"
            )
            click.echo(header)
            click.echo("-" * len(header))
            
            # Print events
            for event in events:
                # Format timestamp to be more readable
                timestamp = event.timestamp.replace('T', ' ').replace('Z', '')
                cost_str = f"{event.cost} {event.currency}"
                
                click.echo(
                    f"{str(event.event_id):<{event_id_width}}  "
                    f"{event.agent_id:<{agent_id_width}}  "
                    f"{event.resource_type:<{resource_width}}  "
                    f"{event.quantity:<{quantity_width}}  "
                    f"{cost_str:<{cost_width}}  "
                    f"{timestamp}"
                )
    
    except LedgerReadError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)


@click.command('summary')
@click.option(
    '--agent-id',
    '-a',
    default=None,
    help='Filter by agent ID (optional)',
)
@click.option(
    '--start',
    '-s',
    default=None,
    help='Start time (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)',
)
@click.option(
    '--end',
    '-e',
    default=None,
    help='End time (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def summary(
    ctx,
    agent_id: Optional[str],
    start: Optional[str],
    end: Optional[str],
    format: str,
):
    """
    Summarize spending with aggregation by agent.
    
    Calculates total spending for each agent in the specified time window.
    If agent-id is specified, shows detailed breakdown for that agent only.
    
    Examples:
    
        # Summary of all agents
        caracal ledger summary
        
        # Summary for a specific agent
        caracal ledger summary --agent-id 550e8400-e29b-41d4-a716-446655440000
        
        # Summary for a date range
        caracal ledger summary --start 2024-01-01 --end 2024-01-31
        
        # JSON output
        caracal ledger summary --format json
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Parse date/time filters
        start_time = None
        end_time = None
        
        if start:
            try:
                start_time = parse_datetime(start)
            except ValueError as e:
                click.echo(f"Error: Invalid start time: {e}", err=True)
                sys.exit(1)
        
        if end:
            try:
                end_time = parse_datetime(end)
            except ValueError as e:
                click.echo(f"Error: Invalid end time: {e}", err=True)
                sys.exit(1)
        
        # Validate time range
        if start_time and end_time and start_time > end_time:
            click.echo(
                "Error: Start time must be before or equal to end time",
                err=True
            )
            sys.exit(1)
        
        # Create ledger query
        ledger_query = get_ledger_query(cli_ctx.config)
        
        if agent_id:
            # Single agent summary with detailed breakdown
            if not start_time or not end_time:
                click.echo(
                    "Error: --start and --end are required when using --agent-id",
                    err=True
                )
                sys.exit(1)
            
            # Calculate total spending
            total_spending = ledger_query.sum_spending(
                agent_id=agent_id,
                start_time=start_time,
                end_time=end_time,
            )
            
            # Get events for breakdown by resource type
            events = ledger_query.get_events(
                agent_id=agent_id,
                start_time=start_time,
                end_time=end_time,
            )
            
            # Aggregate by resource type
            resource_breakdown = {}
            for event in events:
                try:
                    cost = Decimal(event.cost)
                    if event.resource_type in resource_breakdown:
                        resource_breakdown[event.resource_type] += cost
                    else:
                        resource_breakdown[event.resource_type] = cost
                except Exception:
                    continue
            
            if format.lower() == 'json':
                # JSON output
                output = {
                    "agent_id": agent_id,
                    "start_time": start_time.isoformat() if start_time else None,
                    "end_time": end_time.isoformat() if end_time else None,
                    "total_spending": str(total_spending),
                    "currency": "USD",
                    "breakdown_by_resource": {
                        resource: str(cost)
                        for resource, cost in resource_breakdown.items()
                    }
                }
                click.echo(json.dumps(output, indent=2))
            else:
                # Table output
                click.echo(f"Spending Summary for Agent: {agent_id}")
                click.echo("=" * 70)
                click.echo()
                click.echo(f"Time Period: {start_time} to {end_time}")
                click.echo(f"Total Spending: {total_spending} USD")
                click.echo()
                
                if resource_breakdown:
                    click.echo("Breakdown by Resource Type:")
                    click.echo("-" * 70)
                    
                    # Calculate column widths
                    max_resource_len = max(len(r) for r in resource_breakdown.keys())
                    resource_width = max(max_resource_len, len("Resource Type"))
                    
                    # Print header
                    click.echo(f"{'Resource Type':<{resource_width}}  Cost (USD)")
                    click.echo("-" * 70)
                    
                    # Print breakdown sorted by cost (descending)
                    for resource, cost in sorted(
                        resource_breakdown.items(),
                        key=lambda x: x[1],
                        reverse=True
                    ):
                        click.echo(f"{resource:<{resource_width}}  {cost}")
                else:
                    click.echo("No spending recorded in this time period.")
        
        else:
            # Multi-agent aggregation
            if not start_time or not end_time:
                click.echo(
                    "Error: --start and --end are required for multi-agent summary",
                    err=True
                )
                sys.exit(1)
            
            # Aggregate by agent
            aggregation = ledger_query.aggregate_by_agent(
                start_time=start_time,
                end_time=end_time,
            )
            
            if not aggregation:
                click.echo("No spending recorded in the specified time period.")
                return
            
            if format.lower() == 'json':
                # JSON output
                output = {
                    "start_time": start_time.isoformat() if start_time else None,
                    "end_time": end_time.isoformat() if end_time else None,
                    "currency": "USD",
                    "agents": {
                        agent_id: str(spending)
                        for agent_id, spending in aggregation.items()
                    }
                }
                click.echo(json.dumps(output, indent=2))
            else:
                # Table output
                click.echo("Spending Summary by Agent")
                click.echo("=" * 70)
                click.echo()
                click.echo(f"Time Period: {start_time} to {end_time}")
                click.echo(f"Total Agents: {len(aggregation)}")
                click.echo()
                
                # Calculate total spending across all agents
                total_spending = sum(aggregation.values())
                click.echo(f"Total Spending: {total_spending} USD")
                click.echo()
                
                # Calculate column widths
                max_agent_id_len = max(len(agent_id) for agent_id in aggregation.keys())
                agent_id_width = max(max_agent_id_len, len("Agent ID"))
                
                # Print header
                click.echo(f"{'Agent ID':<{agent_id_width}}  Spending (USD)")
                click.echo("-" * 70)
                
                # Print agents sorted by spending (descending)
                for agent_id, spending in sorted(
                    aggregation.items(),
                    key=lambda x: x[1],
                    reverse=True
                ):
                    click.echo(f"{agent_id:<{agent_id_width}}  {spending}")
    
    except LedgerReadError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)
