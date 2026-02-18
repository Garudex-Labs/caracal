"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal Flow Authority Ledger Flow Screen.

Authority ledger exploration:
- Show recent authority events
- Interactive filter builder
- View event details with full metadata
- Export events as JSON or CSV
"""

from typing import Optional, Dict, Any, List
from uuid import UUID
import json
import csv
from datetime import datetime
from pathlib import Path

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from caracal.flow.components.menu import show_menu
from caracal.flow.components.prompt import FlowPrompt
from caracal.flow.theme import Colors, Icons
from caracal.flow.state import FlowState, RecentAction
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class AuthorityLedgerFlow:
    """Authority ledger exploration flow."""
    
    def __init__(self, console: Optional[Console] = None, state: Optional[FlowState] = None):
        self.console = console or Console()
        self.state = state
        self.prompt = FlowPrompt(self.console)
    
    def run(self) -> None:
        """Run the authority ledger exploration flow."""
        while True:
            self.console.clear()
            
            action = show_menu(
                title="Authority Ledger",
                items=[
                    ("recent", "Show Recent Events", "View latest authority events"),
                    ("filter", "Filter Events", "Build custom event filters"),
                    ("view", "View Event Details", "View full event metadata"),
                    ("export", "Export Events", "Export events as JSON or CSV"),
                ],
                subtitle="Explore authority decisions and audit trail",
            )
            
            if action is None:
                break
            
            self.console.clear()
            
            if action == "recent":
                self.show_recent_events()
            elif action == "filter":
                self.filter_events()
            elif action == "view":
                self.view_event_details()
            elif action == "export":
                self.export_events()
            
            self.console.print()
            self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
            input()
    
    def show_recent_events(self) -> None:
        """Show recent authority events."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]View latest authority ledger events[/]",
            title=f"[bold {Colors.INFO}]Recent Authority Events[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.db.connection import get_db_manager
            from caracal.db.models import AuthorityLedgerEvent
            
            db_manager = get_db_manager()
            
            with db_manager.session_scope() as db_session:
                # Get recent events (last 50)
                events = db_session.query(AuthorityLedgerEvent).order_by(
                    AuthorityLedgerEvent.event_id.desc()
                ).limit(50).all()
                
                if not events:
                    self.console.print(f"  [{Colors.DIM}]No authority events recorded yet.[/]")
                    return
                
                # Display events table
                table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
                table.add_column("Event ID", style=Colors.DIM)
                table.add_column("Type", style=Colors.NEUTRAL)
                table.add_column("Principal", style=Colors.DIM)
                table.add_column("Decision", style=Colors.NEUTRAL)
                table.add_column("Timestamp", style=Colors.DIM)
                
                for event in events:
                    decision_style = Colors.SUCCESS if event.decision == "allowed" else Colors.ERROR
                    decision_text = event.decision or "-"
                    
                    table.add_row(
                        str(event.event_id),
                        event.event_type,
                        str(event.principal_id)[:8] + "...",
                        f"[{decision_style}]{decision_text}[/]",
                        str(event.timestamp)[:19],
                    )
                
                self.console.print(table)
                self.console.print()
                self.console.print(f"  [{Colors.DIM}]Showing {len(events)} most recent events[/]")
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error showing recent events: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
            self._show_cli_command("authority-ledger", "query", "--limit 50")
    
    def filter_events(self) -> None:
        """Interactive filter builder for events."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Build custom filters to query authority events[/]",
            title=f"[bold {Colors.INFO}]Filter Events[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.db.connection import get_db_manager
            from caracal.db.models import AuthorityLedgerEvent, Principal
            
            db_manager = get_db_manager()
            
            with db_manager.session_scope() as db_session:
                # Build filters interactively
                self.console.print(f"  [{Colors.INFO}]Optional Filters (press Enter to skip):[/]")
                self.console.print()
                
                # Principal filter
                principal_id = None
                if self.prompt.confirm("Filter by principal?", default=False):
                    principals = db_session.query(Principal).all()
                    if principals:
                        items = [(str(p.principal_id), p.name) for p in principals]
                        principal_id_str = self.prompt.uuid("Principal ID (Tab for suggestions)", items)
                        principal_id = UUID(principal_id_str)
                
                # Event type filter
                event_type = None
                if self.prompt.confirm("Filter by event type?", default=False):
                    event_type = self.prompt.select(
                        "Event type",
                        choices=["issued", "validated", "denied", "revoked"],
                    )
                
                # Decision filter
                decision = None
                if self.prompt.confirm("Filter by decision?", default=False):
                    decision = self.prompt.select(
                        "Decision",
                        choices=["allowed", "denied"],
                    )
                
                # Time range filter
                start_time = None
                end_time = None
                if self.prompt.confirm("Filter by time range?", default=False):
                    start_str = self.prompt.text("Start time (YYYY-MM-DD HH:MM:SS)", required=False)
                    if start_str:
                        start_time = datetime.strptime(start_str, "%Y-%m-%d %H:%M:%S")
                    
                    end_str = self.prompt.text("End time (YYYY-MM-DD HH:MM:SS)", required=False)
                    if end_str:
                        end_time = datetime.strptime(end_str, "%Y-%m-%d %H:%M:%S")
                
                # Build query
                query = db_session.query(AuthorityLedgerEvent)
                
                if principal_id:
                    query = query.filter(AuthorityLedgerEvent.principal_id == principal_id)
                if event_type:
                    query = query.filter(AuthorityLedgerEvent.event_type == event_type)
                if decision:
                    query = query.filter(AuthorityLedgerEvent.decision == decision)
                if start_time:
                    query = query.filter(AuthorityLedgerEvent.timestamp >= start_time)
                if end_time:
                    query = query.filter(AuthorityLedgerEvent.timestamp <= end_time)
                
                events = query.order_by(AuthorityLedgerEvent.event_id.desc()).limit(100).all()
                
                self.console.print()
                
                if not events:
                    self.console.print(f"  [{Colors.DIM}]No events found matching filters.[/]")
                    return
                
                # Display results
                table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
                table.add_column("Event ID", style=Colors.DIM)
                table.add_column("Type", style=Colors.NEUTRAL)
                table.add_column("Principal", style=Colors.DIM)
                table.add_column("Decision", style=Colors.NEUTRAL)
                table.add_column("Action", style=Colors.NEUTRAL)
                table.add_column("Timestamp", style=Colors.DIM)
                
                for event in events:
                    decision_style = Colors.SUCCESS if event.decision == "allowed" else Colors.ERROR
                    decision_text = event.decision or "-"
                    action_text = event.requested_action or "-"
                    
                    table.add_row(
                        str(event.event_id),
                        event.event_type,
                        str(event.principal_id)[:8] + "...",
                        f"[{decision_style}]{decision_text}[/]",
                        action_text[:20],
                        str(event.timestamp)[:19],
                    )
                
                self.console.print(table)
                self.console.print()
                self.console.print(f"  [{Colors.DIM}]Total: {len(events)} events (max 100 shown)[/]")
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error filtering events: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    def view_event_details(self) -> None:
        """View full event details with metadata."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]View detailed information about an authority event[/]",
            title=f"[bold {Colors.INFO}]Event Details[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.db.connection import get_db_manager
            from caracal.db.models import AuthorityLedgerEvent
            
            db_manager = get_db_manager()
            
            with db_manager.session_scope() as db_session:
                # Get event ID
                event_id = self.prompt.number("Event ID", min_value=1)
                
                event = db_session.query(AuthorityLedgerEvent).filter_by(event_id=int(event_id)).first()
                
                if not event:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Event not found.[/]")
                    return
                
                # Display event details
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Event Information:[/]")
                self.console.print(f"    Event ID: [{Colors.PRIMARY}]{event.event_id}[/]")
                self.console.print(f"    Event Type: [{Colors.NEUTRAL}]{event.event_type}[/]")
                self.console.print(f"    Timestamp: [{Colors.DIM}]{event.timestamp}[/]")
                self.console.print(f"    Principal ID: [{Colors.DIM}]{event.principal_id}[/]")
                
                if event.mandate_id:
                    self.console.print(f"    Mandate ID: [{Colors.DIM}]{event.mandate_id}[/]")
                
                if event.decision:
                    decision_style = Colors.SUCCESS if event.decision == "allowed" else Colors.ERROR
                    self.console.print(f"    Decision: [{decision_style}]{event.decision}[/]")
                
                if event.denial_reason:
                    self.console.print(f"    Denial Reason: [{Colors.WARNING}]{event.denial_reason}[/]")
                
                if event.requested_action:
                    self.console.print(f"    Requested Action: [{Colors.NEUTRAL}]{event.requested_action}[/]")
                
                if event.requested_resource:
                    self.console.print(f"    Requested Resource: [{Colors.NEUTRAL}]{event.requested_resource}[/]")
                
                if event.correlation_id:
                    self.console.print(f"    Correlation ID: [{Colors.DIM}]{event.correlation_id}[/]")
                
                # Display metadata if present
                if event.event_metadata:
                    self.console.print()
                    self.console.print(f"  [{Colors.INFO}]Event Metadata:[/]")
                    metadata_str = json.dumps(event.event_metadata, indent=2)
                    for line in metadata_str.split('\n'):
                        self.console.print(f"    {line}")
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error viewing event details: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    def export_events(self) -> None:
        """Export events as JSON or CSV."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Export authority events to file[/]",
            title=f"[bold {Colors.INFO}]Export Events[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.db.connection import get_db_manager
            from caracal.db.models import AuthorityLedgerEvent
            
            db_manager = get_db_manager()
            
            with db_manager.session_scope() as db_session:
                # Select export format
                export_format = self.prompt.select(
                    "Export format",
                    choices=["json", "csv"],
                    default="json",
                )
                
                # Optional filters
                limit = None
                if self.prompt.confirm("Limit number of events?", default=True):
                    limit = self.prompt.number("Maximum events to export", default=1000, min_value=1)
                
                # Get events
                query = db_session.query(AuthorityLedgerEvent).order_by(
                    AuthorityLedgerEvent.event_id.desc()
                )
                
                if limit:
                    query = query.limit(int(limit))
                
                events = query.all()
                
                if not events:
                    self.console.print(f"  [{Colors.DIM}]No events to export.[/]")
                    return
                
                # Generate filename
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                filename = f"authority_events_{timestamp}.{export_format}"
                output_path = Path.home() / filename
                
                # Export
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Exporting {len(events)} events...[/]")
                
                if export_format == "json":
                    self._export_json(events, output_path)
                else:
                    self._export_csv(events, output_path)
                
                self.console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Events exported![/]")
                self.console.print(f"  [{Colors.NEUTRAL}]File: [{Colors.PRIMARY}]{output_path}[/]")
                
                if self.state:
                    self.state.add_recent_action(RecentAction.create(
                        "export_authority_events",
                        f"Exported {len(events)} events to {export_format}",
                    ))
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error exporting events: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    def _export_json(self, events: List[Any], output_path: Path) -> None:
        """Export events as JSON."""
        data = []
        for event in events:
            data.append({
                "event_id": event.event_id,
                "event_type": event.event_type,
                "timestamp": str(event.timestamp),
                "principal_id": str(event.principal_id),
                "mandate_id": str(event.mandate_id) if event.mandate_id else None,
                "decision": event.decision,
                "denial_reason": event.denial_reason,
                "requested_action": event.requested_action,
                "requested_resource": event.requested_resource,
                "correlation_id": event.correlation_id,
                "event_metadata": event.event_metadata,
            })
        
        with open(output_path, 'w') as f:
            json.dump(data, f, indent=2)
    
    def _export_csv(self, events: List[Any], output_path: Path) -> None:
        """Export events as CSV."""
        with open(output_path, 'w', newline='') as f:
            writer = csv.writer(f)
            
            # Header
            writer.writerow([
                "event_id", "event_type", "timestamp", "principal_id", "mandate_id",
                "decision", "denial_reason", "requested_action", "requested_resource",
                "correlation_id"
            ])
            
            # Data
            for event in events:
                writer.writerow([
                    event.event_id,
                    event.event_type,
                    str(event.timestamp),
                    str(event.principal_id),
                    str(event.mandate_id) if event.mandate_id else "",
                    event.decision or "",
                    event.denial_reason or "",
                    event.requested_action or "",
                    event.requested_resource or "",
                    event.correlation_id or "",
                ])
    
    def _show_cli_command(self, group: str, command: str, args: str) -> None:
        """Show the equivalent CLI command."""
        self.console.print()
        self.console.print(f"  [{Colors.HINT}]Run this command instead:[/]")
        self.console.print(f"  [{Colors.DIM}]$ caracal {group} {command} {args}[/]")


def run_authority_ledger_flow(console: Optional[Console] = None, state: Optional[FlowState] = None) -> None:
    """Run the authority ledger exploration flow."""
    flow = AuthorityLedgerFlow(console, state)
    flow.run()
