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
        caracal ledger query --resource openai.gpt-5.2.input_tokens
        
        # Combine filters
        caracal ledger query -a 550e8400-e29b-41d4-a716-446655440000 \\
            -s 2024-01-01 -e 2024-01-31 -r openai.gpt-5.2.input_tokens
        
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
    '--aggregate-children',
    is_flag=True,
    help='Include spending from child agents in the total (hierarchical aggregation)',
)
@click.option(
    '--breakdown',
    is_flag=True,
    help='Show hierarchical breakdown of spending by agent and children',
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
    aggregate_children: bool,
    breakdown: bool,
    format: str,
):
    """
    Summarize spending with aggregation by agent.
    
    Calculates total spending for each agent in the specified time window.
    If agent-id is specified, shows detailed breakdown for that agent only.
    
    With --aggregate-children, includes spending from all child agents in the total.
    With --breakdown, shows hierarchical view with indentation for parent-child relationships.
    
    Examples:
    
        # Summary of all agents
        caracal ledger summary
        
        # Summary for a specific agent
        caracal ledger summary --agent-id 550e8400-e29b-41d4-a716-446655440000
        
        # Summary with child agent spending included
        caracal ledger summary --agent-id 550e8400-e29b-41d4-a716-446655440000 \\
            --aggregate-children --start 2024-01-01 --end 2024-01-31
        
        # Hierarchical breakdown view
        caracal ledger summary --agent-id 550e8400-e29b-41d4-a716-446655440000 \\
            --breakdown --start 2024-01-01 --end 2024-01-31
        
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
        
        # Get agent registry if needed for hierarchical features
        agent_registry = None
        if aggregate_children or breakdown:
            agent_registry = get_agent_registry(cli_ctx.config)
        
        if agent_id:
            # Single agent summary with optional hierarchical features
            if not start_time or not end_time:
                click.echo(
                    "Error: --start and --end are required when using --agent-id",
                    err=True
                )
                sys.exit(1)
            
            # Handle hierarchical breakdown view
            if breakdown:
                breakdown_data = ledger_query.get_spending_breakdown(
                    agent_id=agent_id,
                    start_time=start_time,
                    end_time=end_time,
                    agent_registry=agent_registry
                )
                
                if format.lower() == 'json':
                    # JSON output - convert Decimal to string
                    def convert_decimals(obj):
                        if isinstance(obj, dict):
                            return {k: convert_decimals(v) for k, v in obj.items()}
                        elif isinstance(obj, list):
                            return [convert_decimals(item) for item in obj]
                        elif isinstance(obj, Decimal):
                            return str(obj)
                        return obj
                    
                    output = convert_decimals(breakdown_data)
                    click.echo(json.dumps(output, indent=2))
                else:
                    # Table output with hierarchical indentation
                    click.echo(f"Hierarchical Spending Breakdown")
                    click.echo("=" * 70)
                    click.echo()
                    click.echo(f"Time Period: {start_time} to {end_time}")
                    click.echo()
                    
                    def print_breakdown(data, indent=0):
                        """Recursively print breakdown with indentation"""
                        indent_str = "  " * indent
                        agent_name = data.get("agent_name", data["agent_id"])
                        
                        # Print agent line
                        if indent == 0:
                            click.echo(f"{indent_str}Agent: {agent_name} ({data['agent_id']})")
                        else:
                            click.echo(f"{indent_str}└─ {agent_name} ({data['agent_id']})")
                        
                        click.echo(f"{indent_str}   Own Spending: {data['spending']} USD")
                        
                        # Print children recursively
                        if data.get("children"):
                            for child in data["children"]:
                                print_breakdown(child, indent + 1)
                        
                        # Print total at root level
                        if indent == 0:
                            click.echo()
                            click.echo(f"{indent_str}Total (with children): {data['total_with_children']} USD")
                    
                    print_breakdown(breakdown_data)
                
                return
            
            # Handle aggregate children (sum with children)
            if aggregate_children:
                spending_with_children = ledger_query.sum_spending_with_children(
                    agent_id=agent_id,
                    start_time=start_time,
                    end_time=end_time,
                    agent_registry=agent_registry
                )
                
                # Calculate totals
                own_spending = spending_with_children.get(agent_id, Decimal('0'))
                total_spending = sum(spending_with_children.values())
                children_spending = total_spending - own_spending
                
                if format.lower() == 'json':
                    # JSON output
                    output = {
                        "agent_id": agent_id,
                        "start_time": start_time.isoformat() if start_time else None,
                        "end_time": end_time.isoformat() if end_time else None,
                        "own_spending": str(own_spending),
                        "children_spending": str(children_spending),
                        "total_spending": str(total_spending),
                        "currency": "USD",
                        "breakdown_by_agent": {
                            aid: str(cost)
                            for aid, cost in spending_with_children.items()
                        }
                    }
                    click.echo(json.dumps(output, indent=2))
                else:
                    # Table output
                    click.echo(f"Spending Summary for Agent: {agent_id} (with children)")
                    click.echo("=" * 70)
                    click.echo()
                    click.echo(f"Time Period: {start_time} to {end_time}")
                    click.echo(f"Own Spending: {own_spending} USD")
                    click.echo(f"Children Spending: {children_spending} USD")
                    click.echo(f"Total Spending: {total_spending} USD")
                    click.echo()
                    
                    if len(spending_with_children) > 1:
                        click.echo("Breakdown by Agent:")
                        click.echo("-" * 70)
                        
                        # Calculate column width
                        max_agent_id_len = max(len(aid) for aid in spending_with_children.keys())
                        agent_id_width = max(max_agent_id_len, len("Agent ID"))
                        
                        # Print header
                        click.echo(f"{'Agent ID':<{agent_id_width}}  Spending (USD)")
                        click.echo("-" * 70)
                        
                        # Print breakdown sorted by spending (descending)
                        for aid, spending in sorted(
                            spending_with_children.items(),
                            key=lambda x: x[1],
                            reverse=True
                        ):
                            marker = " (self)" if aid == agent_id else ""
                            click.echo(f"{aid:<{agent_id_width}}  {spending}{marker}")
                
                return
            
            # Standard single agent summary (no hierarchical features)
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



@click.command('delegation-chain')
@click.option(
    '--agent-id',
    '-a',
    required=True,
    help='Agent ID to query delegation chain for',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def delegation_chain(
    ctx,
    agent_id: str,
    format: str,
):
    """
    Query the delegation chain for an agent.
    
    Shows the parent-child hierarchy for an agent, including all ancestors
    (parent, grandparent, etc.) and all descendants (children, grandchildren, etc.).
    
    Examples:
    
        # Show delegation chain for an agent
        caracal ledger delegation-chain --agent-id 550e8400-e29b-41d4-a716-446655440000
        
        # JSON output
        caracal ledger delegation-chain -a 550e8400-e29b-41d4-a716-446655440000 --format json
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Get agent registry
        agent_registry = get_agent_registry(cli_ctx.config)
        
        # Get the agent
        agent = agent_registry.get_agent(agent_id)
        if not agent:
            click.echo(f"Error: Agent with ID '{agent_id}' not found", err=True)
            sys.exit(1)
        
        # Build ancestor chain (parent, grandparent, etc.)
        ancestors = []
        current_agent = agent
        while current_agent.parent_agent_id:
            parent = agent_registry.get_agent(current_agent.parent_agent_id)
            if not parent:
                break
            ancestors.append({
                "agent_id": parent.agent_id,
                "name": parent.name,
                "owner": parent.owner
            })
            current_agent = parent
        
        # Reverse to show from root to current
        ancestors.reverse()
        
        # Get descendants (children, grandchildren, etc.)
        descendants = agent_registry.get_descendants(agent_id)
        descendants_data = [
            {
                "agent_id": desc.agent_id,
                "name": desc.name,
                "owner": desc.owner,
                "parent_agent_id": desc.parent_agent_id
            }
            for desc in descendants
        ]
        
        # Get direct children for tree view
        children = agent_registry.get_children(agent_id)
        
        if format.lower() == 'json':
            # JSON output
            output = {
                "agent": {
                    "agent_id": agent.agent_id,
                    "name": agent.name,
                    "owner": agent.owner,
                    "parent_agent_id": agent.parent_agent_id
                },
                "ancestors": ancestors,
                "descendants": descendants_data,
                "direct_children_count": len(children),
                "total_descendants_count": len(descendants)
            }
            click.echo(json.dumps(output, indent=2))
        else:
            # Table output
            click.echo(f"Delegation Chain for Agent: {agent.name}")
            click.echo("=" * 70)
            click.echo()
            click.echo(f"Agent ID: {agent.agent_id}")
            click.echo(f"Owner: {agent.owner}")
            click.echo()
            
            # Show ancestors (path from root to current)
            if ancestors:
                click.echo("Ancestors (from root):")
                click.echo("-" * 70)
                for i, ancestor in enumerate(ancestors):
                    indent = "  " * i
                    click.echo(f"{indent}└─ {ancestor['name']} ({ancestor['agent_id']})")
                # Show current agent with proper indentation
                indent = "  " * len(ancestors)
                click.echo(f"{indent}└─ {agent.name} ({agent.agent_id}) ← YOU ARE HERE")
                click.echo()
            else:
                click.echo("No parent agents (this is a root agent)")
                click.echo()
            
            # Show descendants
            if descendants:
                click.echo(f"Descendants: {len(descendants)} total")
                click.echo("-" * 70)
                
                # Build tree structure recursively
                def print_tree(parent_id, indent=0):
                    """Print agent tree recursively"""
                    children = agent_registry.get_children(parent_id)
                    for child in children:
                        indent_str = "  " * indent
                        click.echo(f"{indent_str}└─ {child.name} ({child.agent_id})")
                        # Recursively print children
                        print_tree(child.agent_id, indent + 1)
                
                print_tree(agent_id)
                click.echo()
                click.echo(f"Direct children: {len(children)}")
            else:
                click.echo("No child agents")
    
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)



@click.command('list-partitions')
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def list_partitions(ctx, format: str):
    """
    List all ledger_events table partitions.
    
    Shows all existing partitions with their date ranges, sizes, and row counts.
    
    Examples:
    
        # List all partitions
        caracal ledger list-partitions
        
        # JSON output
        caracal ledger list-partitions --format json
    """
    try:
        from caracal.db.connection import get_session
        from caracal.db.partition_manager import PartitionManager
        
        # Get database session
        session = get_session()
        manager = PartitionManager(session)
        
        # List partitions
        partitions = manager.list_partitions()
        
        if not partitions:
            click.echo("No partitions found. The ledger_events table may not be partitioned.")
            return
        
        if format.lower() == 'json':
            # JSON output
            output = {
                "total_partitions": len(partitions),
                "partitions": [
                    {
                        "name": name,
                        "start_date": start_date.isoformat(),
                        "end_date": end_date.isoformat(),
                        "size_bytes": manager.get_partition_size(name),
                        "row_count": manager.get_partition_row_count(name)
                    }
                    for name, start_date, end_date in partitions
                ]
            }
            click.echo(json.dumps(output, indent=2))
        else:
            # Table output
            click.echo(f"Ledger Events Partitions")
            click.echo("=" * 100)
            click.echo()
            click.echo(f"Total Partitions: {len(partitions)}")
            click.echo()
            
            # Print header
            click.echo(f"{'Partition Name':<40}  {'Start Date':<12}  {'End Date':<12}  {'Rows':>10}  {'Size':>10}")
            click.echo("-" * 100)
            
            # Print partitions
            for name, start_date, end_date in partitions:
                row_count = manager.get_partition_row_count(name) or 0
                size_bytes = manager.get_partition_size(name) or 0
                
                # Format size in human-readable format
                if size_bytes < 1024:
                    size_str = f"{size_bytes}B"
                elif size_bytes < 1024 * 1024:
                    size_str = f"{size_bytes / 1024:.1f}KB"
                elif size_bytes < 1024 * 1024 * 1024:
                    size_str = f"{size_bytes / (1024 * 1024):.1f}MB"
                else:
                    size_str = f"{size_bytes / (1024 * 1024 * 1024):.1f}GB"
                
                click.echo(
                    f"{name:<40}  "
                    f"{start_date.date()!s:<12}  "
                    f"{end_date.date()!s:<12}  "
                    f"{row_count:>10}  "
                    f"{size_str:>10}"
                )
        
        session.close()
    
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@click.command('create-partitions')
@click.option(
    '--months-ahead',
    '-m',
    type=int,
    default=3,
    help='Number of months ahead to create partitions for (default: 3)',
)
@click.pass_context
def create_partitions(ctx, months_ahead: int):
    """
    Create partitions for upcoming months.
    
    Creates partitions for the current month and specified number of months ahead.
    This command should be run periodically (e.g., monthly) to ensure partitions
    exist for future data.
    
    Examples:
    
        # Create partitions for next 3 months
        caracal ledger create-partitions
        
        # Create partitions for next 6 months
        caracal ledger create-partitions --months-ahead 6
    """
    try:
        from caracal.db.connection import get_session
        from caracal.db.partition_manager import PartitionManager
        
        # Get database session
        session = get_session()
        manager = PartitionManager(session)
        
        click.echo(f"Creating partitions for next {months_ahead} months...")
        
        # Create partitions
        created_partitions = manager.create_upcoming_partitions(months_ahead=months_ahead)
        
        if created_partitions:
            click.echo(f"\nSuccessfully created {len(created_partitions)} partitions:")
            for partition_name in created_partitions:
                click.echo(f"  - {partition_name}")
        else:
            click.echo("\nNo new partitions created (all partitions already exist)")
        
        session.close()
    
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@click.command('archive-partitions')
@click.option(
    '--months-to-keep',
    '-m',
    type=int,
    default=12,
    help='Number of months of data to keep online (default: 12)',
)
@click.option(
    '--dry-run',
    is_flag=True,
    help='Show which partitions would be archived without actually archiving them',
)
@click.pass_context
def archive_partitions(ctx, months_to_keep: int, dry_run: bool):
    """
    Archive old partitions to cold storage.
    
    Detaches partitions older than the specified number of months from the
    ledger_events table. Detached partitions become standalone tables that
    can be backed up and dropped independently.
    
    IMPORTANT: This command only detaches partitions. You must:
    1. Back up the detached partitions to cold storage
    2. Manually drop the detached tables after backup is confirmed
    
    Examples:
    
        # Dry run to see which partitions would be archived
        caracal ledger archive-partitions --dry-run
        
        # Archive partitions older than 12 months
        caracal ledger archive-partitions
        
        # Archive partitions older than 6 months
        caracal ledger archive-partitions --months-to-keep 6
    """
    try:
        from caracal.db.connection import get_session
        from caracal.db.partition_manager import PartitionManager
        
        # Get database session
        session = get_session()
        manager = PartitionManager(session)
        
        if dry_run:
            click.echo(f"DRY RUN: Checking for partitions older than {months_to_keep} months...")
        else:
            click.echo(f"Archiving partitions older than {months_to_keep} months...")
            click.echo("\nWARNING: This will detach old partitions from the ledger_events table.")
            click.echo("Make sure to back up detached partitions before dropping them!")
            
            if not click.confirm("\nDo you want to continue?"):
                click.echo("Aborted.")
                return
        
        # Archive old partitions
        archived_partitions = manager.archive_old_partitions(
            months_to_keep=months_to_keep,
            dry_run=dry_run
        )
        
        if archived_partitions:
            if dry_run:
                click.echo(f"\nWould archive {len(archived_partitions)} partitions:")
            else:
                click.echo(f"\nSuccessfully archived {len(archived_partitions)} partitions:")
            
            for partition_name in archived_partitions:
                click.echo(f"  - {partition_name}")
            
            if not dry_run:
                click.echo("\nNext steps:")
                click.echo("1. Back up the detached partitions to cold storage")
                click.echo("2. Verify backups are complete and accessible")
                click.echo("3. Drop the detached tables manually:")
                for partition_name in archived_partitions:
                    click.echo(f"   DROP TABLE {partition_name};")
        else:
            click.echo("\nNo partitions to archive (all partitions are within retention period)")
        
        session.close()
    
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@click.command('refresh-views')
@click.option(
    '--concurrent/--no-concurrent',
    default=True,
    help='Use concurrent refresh to avoid blocking reads (default: concurrent)',
)
@click.pass_context
def refresh_views(ctx, concurrent: bool):
    """
    Refresh materialized views for ledger query optimization.
    
    Refreshes the spending_by_agent_mv and spending_by_time_window_mv
    materialized views. These views provide fast lookups for spending
    aggregations and are used by the policy evaluator.
    
    By default, uses CONCURRENTLY to avoid blocking reads during refresh.
    
    Examples:
    
        # Refresh views concurrently (recommended)
        caracal ledger refresh-views
        
        # Refresh views without concurrent mode (faster but blocks reads)
        caracal ledger refresh-views --no-concurrent
    """
    try:
        from caracal.db.connection import get_session
        from caracal.db.materialized_views import MaterializedViewManager
        
        # Get database session
        session = get_session()
        manager = MaterializedViewManager(session)
        
        click.echo("Refreshing materialized views...")
        
        # Refresh all views
        manager.refresh_all(concurrent=concurrent)
        
        # Get refresh times
        spending_by_agent_time = manager.get_view_refresh_time('spending_by_agent_mv')
        spending_by_time_window_time = manager.get_view_refresh_time('spending_by_time_window_mv')
        
        click.echo("\nSuccessfully refreshed all materialized views:")
        click.echo(f"  - spending_by_agent_mv (refreshed at: {spending_by_agent_time})")
        click.echo(f"  - spending_by_time_window_mv (refreshed at: {spending_by_time_window_time})")
        
        session.close()
    
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
