"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for authority ledger management.

Provides commands for querying authority ledger events and exporting audit reports.
"""

import csv
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional
from uuid import UUID

import click

from caracal.exceptions import CaracalError
from caracal.logging_config import get_logger

logger = get_logger(__name__)


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
    '-p',
    default=None,
    help='Filter by principal ID (optional)',
)
@click.option(
    '--mandate-id',
    '-m',
    default=None,
    help='Filter by mandate ID (optional)',
)
@click.option(
    '--event-type',
    '-t',
    type=click.Choice(['issued', 'validated', 'denied', 'revoked'], case_sensitive=False),
    default=None,
    help='Filter by event type (optional)',
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
def query(
    ctx,
    principal_id: Optional[str],
    mandate_id: Optional[str],
    event_type: Optional[str],
    start: Optional[str],
    end: Optional[str],
    format: str,
):
    """
    Query authority ledger events with optional filters.
    
    Returns all events matching the specified filters. All filters are optional
    and can be combined.
    
    Examples:
    
        # Query all events
        caracal ledger query
        
        # Query events for a specific principal
        caracal ledger query --principal-id 550e8400-e29b-41d4-a716-446655440000
        
        # Query events for a specific mandate
        caracal ledger query --mandate-id 660e8400-e29b-41d4-a716-446655440001
        
        # Query events by type
        caracal ledger query --event-type validated
        
        # Query events in a date range
        caracal ledger query --start 2024-01-01 --end 2024-01-31
        
        # Combine filters
        caracal ledger query -p <principal-id> -t denied -s 2024-01-01 -e 2024-01-31
        
        # JSON output
        caracal ledger query --format json
        """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Parse UUIDs if provided
        principal_uuid = None
        mandate_uuid = None
        
        if principal_id:
            try:
                principal_uuid = UUID(principal_id)
            except ValueError as e:
                click.echo(f"Error: Invalid principal ID format: {e}", err=True)
                sys.exit(1)
        
        if mandate_id:
            try:
                mandate_uuid = UUID(mandate_id)
            except ValueError as e:
                click.echo(f"Error: Invalid mandate ID format: {e}", err=True)
                sys.exit(1)
        
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
        
        # Create database connection
        from caracal.db.connection import get_db_manager
        from caracal.core.authority_ledger import AuthorityLedgerQuery
        
        db_manager = get_db_manager()
        
        try:
            # Create ledger query
            ledger_query = AuthorityLedgerQuery(db_manager.get_session())
            
            # Query events
            events = ledger_query.get_events(
                principal_id=principal_uuid,
                mandate_id=mandate_uuid,
                event_type=event_type.lower() if event_type else None,
                start_time=start_time,
                end_time=end_time
            )
            
            if not events:
                click.echo("No events found matching the specified filters.")
                return
            
            if format.lower() == 'json':
                # JSON output
                output = [
                    {
                        'event_id': e.event_id,
                        'event_type': e.event_type,
                        'timestamp': e.timestamp.isoformat(),
                        'principal_id': str(e.principal_id),
                        'mandate_id': str(e.mandate_id) if e.mandate_id else None,
                        'decision': e.decision,
                        'denial_reason': e.denial_reason,
                        'requested_action': e.requested_action,
                        'requested_resource': e.requested_resource
                    }
                    for e in events
                ]
                click.echo(json.dumps(output, indent=2))
            else:
                # Table output
                click.echo(f"Total events: {len(events)}")
                click.echo()
                
                # Print header
                click.echo(f"{'Event ID':<10}  {'Type':<10}  {'Timestamp':<20}  {'Principal ID':<38}  {'Decision':<10}")
                click.echo("-" * 110)
                
                # Print events
                for e in events:
                    # Format timestamp
                    timestamp_str = e.timestamp.strftime("%Y-%m-%d %H:%M:%S")
                    
                    # Format decision
                    decision_str = e.decision if e.decision else "-"
                    
                    click.echo(
                        f"{e.event_id:<10}  "
                        f"{e.event_type:<10}  "
                        f"{timestamp_str:<20}  "
                        f"{str(e.principal_id):<38}  "
                        f"{decision_str:<10}"
                    )
        
        finally:
            # Close database connection
            db_manager.close()
    
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        logger.error(f"Failed to query authority ledger: {e}", exc_info=True)
        sys.exit(1)


@click.command('export')
@click.option(
    '--start',
    '-s',
    required=True,
    help='Start time (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)',
)
@click.option(
    '--end',
    '-e',
    required=True,
    help='End time (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)',
)
@click.option(
    '--principal-id',
    '-p',
    default=None,
    help='Filter by principal ID (optional)',
)
@click.option(
    '--output',
    '-o',
    required=True,
    type=click.Path(dir_okay=False, writable=True, path_type=Path),
    help='Output file path',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['csv', 'json'], case_sensitive=False),
    default='csv',
    help='Output format (default: csv)',
)
@click.pass_context
def export(
    ctx,
    start: str,
    end: str,
    principal_id: Optional[str],
    output: Path,
    format: str,
):
    """
    Export audit report for a time range.
    
    Generates an audit report containing all authority ledger events
    in the specified time range.
    
    Examples:
    
        # Export CSV report
        caracal audit export \\
            --start 2024-01-01 \\
            --end 2024-01-31 \\
            --output audit_report.csv
        
        # Export JSON report for a specific principal
        caracal audit export \\
            -s 2024-01-01 -e 2024-01-31 \\
            -p 550e8400-e29b-41d4-a716-446655440000 \\
            -o audit_report.json \\
            --format json
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Parse principal ID if provided
        principal_uuid = None
        if principal_id:
            try:
                principal_uuid = UUID(principal_id)
            except ValueError as e:
                click.echo(f"Error: Invalid principal ID format: {e}", err=True)
                sys.exit(1)
        
        # Parse date/time filters
        try:
            start_time = parse_datetime(start)
            end_time = parse_datetime(end)
        except ValueError as e:
            click.echo(f"Error: {e}", err=True)
            sys.exit(1)
        
        # Validate time range
        if start_time > end_time:
            click.echo(
                "Error: Start time must be before or equal to end time",
                err=True
            )
            sys.exit(1)
        
        # Create database connection
        from caracal.db.connection import get_db_manager
        from caracal.core.authority_ledger import AuthorityLedgerQuery
        
        db_manager = get_db_manager()
        
        try:
            # Create ledger query
            ledger_query = AuthorityLedgerQuery(db_manager.get_session())
            
            # Query events
            events = ledger_query.get_events(
                principal_id=principal_uuid,
                start_time=start_time,
                end_time=end_time
            )
            
            if not events:
                click.echo("No events found in the specified time range.")
                return
            
            # Export to file
            if format.lower() == 'csv':
                # CSV export
                with open(output, 'w', newline='') as csvfile:
                    fieldnames = [
                        'event_id', 'event_type', 'timestamp', 'principal_id',
                        'mandate_id', 'decision', 'denial_reason',
                        'requested_action', 'requested_resource'
                    ]
                    writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
                    
                    writer.writeheader()
                    for e in events:
                        writer.writerow({
                            'event_id': e.event_id,
                            'event_type': e.event_type,
                            'timestamp': e.timestamp.isoformat(),
                            'principal_id': str(e.principal_id),
                            'mandate_id': str(e.mandate_id) if e.mandate_id else '',
                            'decision': e.decision if e.decision else '',
                            'denial_reason': e.denial_reason if e.denial_reason else '',
                            'requested_action': e.requested_action if e.requested_action else '',
                            'requested_resource': e.requested_resource if e.requested_resource else ''
                        })
            else:
                # JSON export
                output_data = {
                    'report_generated': datetime.utcnow().isoformat(),
                    'time_range': {
                        'start': start_time.isoformat(),
                        'end': end_time.isoformat()
                    },
                    'principal_id': str(principal_uuid) if principal_uuid else None,
                    'total_events': len(events),
                    'events': [
                        {
                            'event_id': e.event_id,
                            'event_type': e.event_type,
                            'timestamp': e.timestamp.isoformat(),
                            'principal_id': str(e.principal_id),
                            'mandate_id': str(e.mandate_id) if e.mandate_id else None,
                            'decision': e.decision,
                            'denial_reason': e.denial_reason,
                            'requested_action': e.requested_action,
                            'requested_resource': e.requested_resource
                        }
                        for e in events
                    ]
                }
                
                with open(output, 'w') as jsonfile:
                    json.dump(output_data, jsonfile, indent=2)
            
            click.echo(f"✓ Audit report exported successfully!")
            click.echo()
            click.echo(f"File:         {output}")
            click.echo(f"Format:       {format.upper()}")
            click.echo(f"Events:       {len(events)}")
            click.echo(f"Time Range:   {start_time} to {end_time}")
        
        finally:
            # Close database connection
            db_manager.close()
    
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        logger.error(f"Failed to export audit report: {e}", exc_info=True)
        sys.exit(1)
