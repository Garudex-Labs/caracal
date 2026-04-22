"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for ledger management.

Provides commands for querying and summarizing ledger events.
"""

import json
import sys
from datetime import datetime
from dataclasses import dataclass
from decimal import Decimal
from uuid import UUID
from typing import Optional

import click

from caracal.db.connection import get_db_manager
from caracal.db.models import LedgerEvent
from caracal.exceptions import CaracalError


@dataclass
class _LedgerEventView:
    event_id: int
    principal_id: str
    resource_type: str
    quantity: str
    timestamp: str

    def to_dict(self) -> dict:
        return {
            "event_id": self.event_id,
            "principal_id": self.principal_id,
            "resource_type": self.resource_type,
            "quantity": self.quantity,
            "timestamp": self.timestamp,
        }


class _PostgresLedgerQuery:
    """Compatibility query facade backed by ledger_events (metering ledger)."""

    def __init__(self, config):
        self._config = config

    @staticmethod
    def _as_uuid(value: Optional[str]) -> Optional[UUID]:
        if not value:
            return None
        try:
            return UUID(value)
        except ValueError:
            return None

    def get_events(
        self,
        principal_id: Optional[str] = None,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
        resource_type: Optional[str] = None,
    ) -> list[_LedgerEventView]:
        principal_uuid = self._as_uuid(principal_id)
        db_manager = get_db_manager(self._config)
        try:
            with db_manager.session_scope() as session:
                query = session.query(LedgerEvent)
                if principal_uuid:
                    query = query.filter(LedgerEvent.principal_id == principal_uuid)
                if start_time:
                    query = query.filter(LedgerEvent.timestamp >= start_time)
                if end_time:
                    query = query.filter(LedgerEvent.timestamp <= end_time)
                if resource_type:
                    query = query.filter(LedgerEvent.resource_type.ilike(f"%{resource_type}%"))

                rows = query.order_by(LedgerEvent.event_id.desc()).all()
                return [
                    _LedgerEventView(
                        event_id=row.event_id,
                        principal_id=str(row.principal_id),
                        resource_type=row.resource_type,
                        quantity=str(row.quantity),
                        timestamp=row.timestamp.isoformat(),
                    )
                    for row in rows
                ]
        finally:
            db_manager.close()

    def sum_usage(
        self,
        principal_id: str,
        start_time: Optional[datetime],
        end_time: Optional[datetime],
    ) -> Decimal:
        events = self.get_events(principal_id=principal_id, start_time=start_time, end_time=end_time)
        return sum((Decimal(e.quantity) for e in events), Decimal("0"))

    def aggregate_by_principal(self, start_time: datetime, end_time: datetime) -> dict[str, Decimal]:
        events = self.get_events(start_time=start_time, end_time=end_time)
        totals: dict[str, Decimal] = {}
        for event in events:
            totals[event.principal_id] = totals.get(event.principal_id, Decimal("0")) + Decimal(event.quantity)
        return totals

    def sum_usage_with_children(self, principal_id: str, start_time: datetime, end_time: datetime, principal_registry=None) -> dict[str, Decimal]:
        # Delegation-aware recursive rollup has moved to PostgreSQL graph queries.
        # This compatibility method currently returns direct usage for the requested principal.
        return {principal_id: self.sum_usage(principal_id, start_time, end_time)}

    def get_usage_breakdown(self, principal_id: str, start_time: datetime, end_time: datetime, principal_registry=None) -> dict:
        own_usage = self.sum_usage(principal_id, start_time, end_time)
        return {
            "principal_id": principal_id,
            "principal_name": principal_id,
            "usage": str(own_usage),
            "children": [],
            "total_with_children": str(own_usage),
        }


def get_ledger_query(config) -> _PostgresLedgerQuery:
    """
    Create PostgreSQL-backed ledger query instance from configuration.
    
    Args:
        config: Configuration object
        
    Returns:
        _PostgresLedgerQuery instance
    """
    return _PostgresLedgerQuery(config)


def get_principal_registry(config):
    """
    Backward-compatibility placeholder. directed queries are PostgreSQL-backed.
    
    Args:
        config: Configuration object
        
    Returns:
        Principal registry instance
    """
    return None


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
    '--principal-id',
    '-a',
    default=None,
    help='Filter by principal ID (optional)',
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
    principal_id: Optional[str],
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
        
        # Query events for a specific principal
        caracal ledger query --principal-id 550e8400-e29b-41d4-a716-446655440000
        
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
        cli_ctx = ctx.obj
        
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
        
        ledger_query = get_ledger_query(cli_ctx.config)
        
        events = ledger_query.get_events(
            principal_id=principal_id,
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
            max_principal_id_len = max(len(event.principal_id) for event in events)
            max_resource_len = max(len(event.resource_type) for event in events)
            max_quantity_len = max(len(event.quantity) for event in events)
            
            # Ensure minimum widths for headers
            event_id_width = max(max_event_id_len, len("Event ID"))
            principal_id_width = max(max_principal_id_len, len("Principal ID"))
            resource_width = max(max_resource_len, len("Resource Type"))
            quantity_width = max(max_quantity_len, len("Quantity"))
            
            # Print header
            header = (
                f"{'Event ID':<{event_id_width}}  "
                f"{'Principal ID':<{principal_id_width}}  "
                f"{'Resource Type':<{resource_width}}  "
                f"{'Quantity':<{quantity_width}}  "
                f"Timestamp"
            )
            click.echo(header)
            click.echo("-" * len(header))
            
            # Print events
            for event in events:
                # Format timestamp to be more readable
                timestamp = event.timestamp.replace('T', ' ').replace('Z', '')
                
                click.echo(
                    f"{str(event.event_id):<{event_id_width}}  "
                    f"{event.principal_id:<{principal_id_width}}  "
                    f"{event.resource_type:<{resource_width}}  "
                    f"{event.quantity:<{quantity_width}}  "
                    f"{timestamp}"
                )
    
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)


@click.command('summary')
@click.option(
    '--principal-id',
    '-a',
    default=None,
    help='Filter by principal ID (optional)',
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
    help='Include usage from delegated child principals in the total (graph aggregation)',
)
@click.option(
    '--breakdown',
    is_flag=True,
    help='Show directed breakdown of usage by principal and delegated children',
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
    principal_id: Optional[str],
    start: Optional[str],
    end: Optional[str],
    aggregate_children: bool,
    breakdown: bool,
    format: str,
):
    """
    Summarize usage with aggregation by principal.
    
    Calculates total usage for each principal in the specified time window.
    If principal-id is specified, shows detailed breakdown for that principal only.
    
    With --aggregate-children, includes usage from all delegated child principals in the total.
    With --breakdown, shows directed view with indentation for source-target relationships.
    
    Examples:
    
        # Summary of all principals
        caracal ledger summary
        
        # Summary for a specific principal
        caracal ledger summary --principal-id 550e8400-e29b-41d4-a716-446655440000
        
        # Summary with delegated child principal usage included
        caracal ledger summary --principal-id 550e8400-e29b-41d4-a716-446655440000 \\
            --aggregate-children --start 2024-01-01 --end 2024-01-31
        
        # directed breakdown view
        caracal ledger summary --principal-id 550e8400-e29b-41d4-a716-446655440000 \\
            --breakdown --start 2024-01-01 --end 2024-01-31
        
        # Summary for a date range
        caracal ledger summary --start 2024-01-01 --end 2024-01-31
        
        # JSON output
        caracal ledger summary --format json
    """
    try:
        cli_ctx = ctx.obj
        
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
        
        ledger_query = get_ledger_query(cli_ctx.config)
        
        principal_registry = None
        if aggregate_children or breakdown:
            principal_registry = get_principal_registry(cli_ctx.config)
        
        if principal_id:
            # Single principal summary with optional directed features
            if not start_time or not end_time:
                click.echo(
                    "Error: --start and --end are required when using --principal-id",
                    err=True
                )
                sys.exit(1)
            
            # Handle directed breakdown view
            if breakdown:
                breakdown_data = ledger_query.get_usage_breakdown(
                    principal_id=principal_id,
                    start_time=start_time,
                    end_time=end_time,
                    principal_registry=principal_registry
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
                    # Table output with directed indentation
                    click.echo(f"directed Usage Breakdown")
                    click.echo("=" * 70)
                    click.echo()
                    click.echo(f"Time Period: {start_time} to {end_time}")
                    click.echo()
                    
                    def print_breakdown(data, indent=0):
                        """Recursively print breakdown with indentation"""
                        indent_str = "  " * indent
                        principal_name = data.get("principal_name", data["principal_id"])
                        
                        # Print principal line
                        if indent == 0:
                            click.echo(f"{indent_str}Principal: {principal_name} ({data['principal_id']})")
                        else:
                            click.echo(f"{indent_str}└─ {principal_name} ({data['principal_id']})")
                        
                        click.echo(f"{indent_str}   Own Usage: {data['usage']} USD")
                        
                        # Print delegated children recursively
                        if data.get("children"):
                            for child in data["children"]:
                                print_breakdown(child, indent + 1)
                        
                        # Print total at root level
                        if indent == 0:
                            click.echo()
                            click.echo(f"{indent_str}Total (with children): {data['total_with_children']} USD")
                    
                    print_breakdown(breakdown_data)
                
                return
            
            # Handle aggregate children (sum with delegated children)
            if aggregate_children:
                usage_with_children = ledger_query.sum_usage_with_children(
                    principal_id=principal_id,
                    start_time=start_time,
                    end_time=end_time,
                    principal_registry=principal_registry
                )
                
                # Calculate totals
                own_usage = usage_with_children.get(principal_id, Decimal('0'))
                total_usage = sum(usage_with_children.values())
                children_usage = total_usage - own_usage
                
                if format.lower() == 'json':
                    # JSON output
                    output = {
                        "principal_id": principal_id,
                        "start_time": start_time.isoformat() if start_time else None,
                        "end_time": end_time.isoformat() if end_time else None,
                        "own_usage": str(own_usage),
                        "children_usage": str(children_usage),
                        "total_usage": str(total_usage),
                        "unit": "requests",
                        "breakdown_by_principal": {
                            aid: str(amount)
                            for aid, amount in usage_with_children.items()
                        }
                    }
                    click.echo(json.dumps(output, indent=2))
                else:
                    # Table output
                    click.echo(f"Usage Summary for Principal: {principal_id} (with children)")
                    click.echo("=" * 70)
                    click.echo()
                    click.echo(f"Time Period: {start_time} to {end_time}")
                    click.echo(f"Own Usage: {own_usage}")
                    click.echo(f"Children Usage: {children_usage}")
                    click.echo(f"Total Usage: {total_usage}")
                    click.echo()
                    
                    if len(usage_with_children) > 1:
                        click.echo("Breakdown by Principal:")
                        click.echo("-" * 70)
                        
                        # Calculate column width
                        max_principal_id_len = max(len(aid) for aid in usage_with_children.keys())
                        principal_id_width = max(max_principal_id_len, len("Principal ID"))
                        
                        # Print header
                        click.echo(f"{'Principal ID':<{principal_id_width}}  Usage")
                        click.echo("-" * 70)
                        
                        # Print breakdown sorted by usage (descending)
                        for aid, usage in sorted(
                            usage_with_children.items(),
                            key=lambda x: x[1],
                            reverse=True
                        ):
                            marker = " (self)" if aid == principal_id else ""
                            click.echo(f"{aid:<{principal_id_width}}  {usage}{marker}")
                
                return
            
            # Standard single principal summary (no directed features)
            # Calculate total usage
            total_usage = ledger_query.sum_usage(
                principal_id=principal_id,
                start_time=start_time,
                end_time=end_time,
            )
            
            # Get events for breakdown by resource type
            events = ledger_query.get_events(
                principal_id=principal_id,
                start_time=start_time,
                end_time=end_time,
            )
            
            # Aggregate by resource type
            resource_breakdown = {}
            for event in events:
                try:
                    qty = Decimal(event.quantity)
                    if event.resource_type in resource_breakdown:
                        resource_breakdown[event.resource_type] += qty
                    else:
                        resource_breakdown[event.resource_type] = qty
                except Exception:
                    continue
            
            if format.lower() == 'json':
                # JSON output
                output = {
                    "principal_id": principal_id,
                    "start_time": start_time.isoformat() if start_time else None,
                    "end_time": end_time.isoformat() if end_time else None,
                    "total_usage": str(total_usage),
                    "unit": "requests",
                    "breakdown_by_resource": {
                        resource: str(qty)
                        for resource, qty in resource_breakdown.items()
                    }
                }
                click.echo(json.dumps(output, indent=2))
            else:
                # Table output
                click.echo(f"Usage Summary for Principal: {principal_id}")
                click.echo("=" * 70)
                click.echo()
                click.echo(f"Time Period: {start_time} to {end_time}")
                click.echo(f"Total Usage: {total_usage}")
                click.echo()
                
                if resource_breakdown:
                    click.echo("Breakdown by Resource Type:")
                    click.echo("-" * 70)
                    
                    # Calculate column widths
                    max_resource_len = max(len(r) for r in resource_breakdown.keys())
                    resource_width = max(max_resource_len, len("Resource Type"))
                    
                    # Print header
                    click.echo(f"{'Resource Type':<{resource_width}}  Quantity")
                    click.echo("-" * 70)
                    
                    # Print breakdown sorted by quantity (descending)
                    for resource, cost in sorted(
                        resource_breakdown.items(),
                        key=lambda x: x[1],
                        reverse=True
                    ):
                        click.echo(f"{resource:<{resource_width}}  {cost}")
                else:
                    click.echo("No usage recorded in this time period.")
        
        else:
            # Multi-principal aggregation
            if not start_time or not end_time:
                click.echo(
                    "Error: --start and --end are required for multi-principal summary",
                    err=True
                )
                sys.exit(1)
            
            # Aggregate by principal
            aggregation = ledger_query.aggregate_by_principal(
                start_time=start_time,
                end_time=end_time,
            )
            
            if not aggregation:
                click.echo("No usage recorded in the specified time period.")
                return
            
            if format.lower() == 'json':
                # JSON output
                output = {
                    "start_time": start_time.isoformat() if start_time else None,
                    "end_time": end_time.isoformat() if end_time else None,
                    "unit": "requests",
                    "principals": {
                        principal_id: str(usage)
                        for principal_id, usage in aggregation.items()
                    }
                }
                click.echo(json.dumps(output, indent=2))
            else:
                # Table output
                click.echo("Usage Summary by Principal")
                click.echo("=" * 70)
                click.echo()
                click.echo(f"Time Period: {start_time} to {end_time}")
                click.echo(f"Total Principals: {len(aggregation)}")
                click.echo()
                
                # Calculate total usage across all principals
                total_usage = sum(aggregation.values())
                click.echo(f"Total Usage: {total_usage}")
                click.echo()
                
                # Calculate column widths
                max_principal_id_len = max(len(principal_id) for principal_id in aggregation.keys())
                principal_id_width = max(max_principal_id_len, len("Principal ID"))
                
                # Print header
                click.echo(f"{'Principal ID':<{principal_id_width}}  Usage")
                click.echo("-" * 70)
                
                # Print principals sorted by usage (descending)
                for principal_id, usage in sorted(
                    aggregation.items(),
                    key=lambda x: x[1],
                    reverse=True
                ):
                    click.echo(f"{principal_id:<{principal_id_width}}  {usage}")
    
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)



@click.command('delegation-path')
@click.option(
    '--principal-id',
    '-a',
    required=True,
    help='Principal ID to query delegation graph for',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def delegation_path(
    ctx,
    principal_id: str,
    format: str,
):
    """
    Query the delegation graph for a principal.
    
    Shows all delegation edges (inbound and outbound) for the mandates
    belonging to the specified principal.
    
    Examples:
    
        # Show delegation graph for a principal
        caracal ledger delegation-path --principal-id 550e8400-e29b-41d4-a716-446655440000
        
        # JSON output
        caracal ledger delegation-path -a 550e8400-e29b-41d4-a716-446655440000 --format json
    """
    try:
        cli_ctx = ctx.obj
        
        from caracal.db.connection import get_db_manager
        from caracal.db.models import DelegationEdgeModel, ExecutionMandate
        
        db_manager = get_db_manager(cli_ctx.config)
        session = db_manager.get_session()
        
        try:
            # Get mandates for this principal
            mandates = session.query(ExecutionMandate).filter(
                ExecutionMandate.subject_id == principal_id
            ).all()
            
            if not mandates:
                click.echo(f"No mandates found for principal: {principal_id}")
                return
            
            mandate_ids = [m.mandate_id for m in mandates]
            
            # Get inbound edges (delegations TO this principal)
            inbound_edges = session.query(DelegationEdgeModel).filter(
                DelegationEdgeModel.target_mandate_id.in_(mandate_ids),
                DelegationEdgeModel.revoked == False,
            ).all()
            
            # Get outbound edges (delegations FROM this principal)
            outbound_edges = session.query(DelegationEdgeModel).filter(
                DelegationEdgeModel.source_mandate_id.in_(mandate_ids),
                DelegationEdgeModel.revoked == False,
            ).all()
            
            if format.lower() == 'json':
                output = {
                    "principal_id": principal_id,
                    "mandate_count": len(mandates),
                    "inbound_edges": [
                        {
                            "edge_id": str(e.edge_id),
                            "source_mandate_id": str(e.source_mandate_id),
                            "source_principal_kind": e.source_principal_kind,
                            "delegation_type": e.delegation_type,
                            "context_tags": e.context_tags,
                        }
                        for e in inbound_edges
                    ],
                    "outbound_edges": [
                        {
                            "edge_id": str(e.edge_id),
                            "target_mandate_id": str(e.target_mandate_id),
                            "target_principal_kind": e.target_principal_kind,
                            "delegation_type": e.delegation_type,
                            "context_tags": e.context_tags,
                        }
                        for e in outbound_edges
                    ],
                }
                click.echo(json.dumps(output, indent=2))
            else:
                type_icons = {
                    'human': '👤',
                    'orchestrator': '🎛️',
                    'worker': '🤖',
                    'service': '⚙️',
                }
                click.echo(f"Delegation Graph for Principal: {principal_id}")
                click.echo("=" * 70)
                click.echo()
                click.echo(f"Mandates: {len(mandates)}")
                click.echo()
                
                if inbound_edges:
                    click.echo(f"Inbound Edges ({len(inbound_edges)} authority sources):")
                    click.echo("-" * 70)
                    for edge in inbound_edges:
                        icon = type_icons.get(edge.source_principal_kind, '?')
                        tags = ', '.join(edge.context_tags) if edge.context_tags else ''
                        click.echo(
                            f"  {icon} {edge.source_principal_kind} "
                            f"({str(edge.source_mandate_id)[:8]}...) "
                            f"\u2192 [{edge.delegation_type}] "
                            f"{tags}"
                        )
                    click.echo()
                else:
                    click.echo("No inbound edges (root authority)")
                    click.echo()
                
                if outbound_edges:
                    click.echo(f"Outbound Edges ({len(outbound_edges)} delegated targets):")
                    click.echo("-" * 70)
                    for edge in outbound_edges:
                        icon = type_icons.get(edge.target_principal_kind, '?')
                        tags = ', '.join(edge.context_tags) if edge.context_tags else ''
                        click.echo(
                            f"  \u2192 {icon} {edge.target_principal_kind} "
                            f"({str(edge.target_mandate_id)[:8]}...) "
                            f"[{edge.delegation_type}] "
                            f"{tags}"
                        )
                else:
                    click.echo("No outbound edges (leaf node)")
        
        finally:
            db_manager.close()
    
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
        from caracal.db.connection import get_db_manager
        from caracal.db.partition_manager import PartitionManager
        
        # Get database session
        session = get_db_manager(ctx.obj.config).get_session()
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
        from caracal.db.connection import get_db_manager
        from caracal.db.partition_manager import PartitionManager
        
        # Get database session
        session = get_db_manager(ctx.obj.config).get_session()
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
        from caracal.db.connection import get_db_manager
        from caracal.db.partition_manager import PartitionManager
        
        # Get database session
        session = get_db_manager(ctx.obj.config).get_session()
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
    
    Refreshes the usage_by_agent_mv and usage_by_time_window_mv
    materialized views. These views provide fast lookups for usage
    aggregations and are used by the policy evaluator.
    
    By default, uses CONCURRENTLY to avoid blocking reads during refresh.
    
    Examples:
    
        # Refresh views concurrently (recommended)
        caracal ledger refresh-views
        
        # Refresh views without concurrent mode (faster but blocks reads)
        caracal ledger refresh-views --no-concurrent
    """
    try:
        from caracal.db.connection import get_db_manager
        from caracal.db.materialized_views import MaterializedViewManager
        
        # Get database session
        session = get_db_manager(ctx.obj.config).get_session()
        manager = MaterializedViewManager(session)
        
        click.echo("Refreshing materialized views...")
        
        # Refresh all views
        manager.refresh_all(concurrent=concurrent)
        
        # Get refresh times
        usage_by_agent_time = manager.get_view_refresh_time('usage_by_agent_mv')
        usage_by_time_window_time = manager.get_view_refresh_time('usage_by_time_window_mv')
        
        click.echo("\nSuccessfully refreshed all materialized views:")
        click.echo(f"  - usage_by_agent_mv (refreshed at: {usage_by_agent_time})")
        click.echo(f"  - usage_by_time_window_mv (refreshed at: {usage_by_time_window_time})")
        
        session.close()
    
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
