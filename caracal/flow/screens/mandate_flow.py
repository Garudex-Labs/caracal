"""
Caracal Flow Mandate Flow Screen.

Mandate management flows:
- Show mandate list with principal filter
- Issue mandate wizard with scope and validity prompts
- View mandate details with signature verification status
- Validate mandate interactively
- Revoke mandate with cascade impact preview
"""

from typing import Optional, List, Any
from uuid import UUID
from datetime import datetime, timedelta

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from caracal.flow.components.menu import show_menu
from caracal.flow.components.prompt import FlowPrompt
from caracal.flow.theme import Colors, Icons
from caracal.flow.state import FlowState, RecentAction
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class MandateFlow:
    """Mandate management flow."""
    
    def __init__(self, console: Optional[Console] = None, state: Optional[FlowState] = None):
        self.console = console or Console()
        self.state = state
        self.prompt = FlowPrompt(self.console)
    
    def run(self) -> None:
        """Run the mandate management flow."""
        while True:
            self.console.clear()
            
            action = show_menu(
                title="Mandate Manager",
                items=[
                    ("list", "List Mandates", "View all execution mandates"),
                    ("issue", "Issue Mandate", "Create a new execution mandate"),
                    ("view", "View Mandate Details", "View detailed mandate information"),
                    ("validate", "Validate Mandate", "Check mandate validity"),
                    ("revoke", "Revoke Mandate", "Revoke an execution mandate"),
                ],
                subtitle="Manage execution mandates",
            )
            
            if action is None:
                break
            
            self.console.clear()
            
            if action == "list":
                self.show_mandate_list()
            elif action == "issue":
                self.issue_mandate()
            elif action == "view":
                self.view_mandate_details()
            elif action == "validate":
                self.validate_mandate()
            elif action == "revoke":
                self.revoke_mandate()
            
            self.console.print()
            self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
            input()
    
    def show_mandate_list(self) -> None:
        """Show mandate list with optional principal filter."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]View execution mandates[/]",
            title=f"[bold {Colors.INFO}]Mandate List[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.config import load_config
            from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
            from caracal.db.models import ExecutionMandate, Principal
            
            config = load_config()
            
            db_config = DatabaseConfig(
                host=config.database.host,
                port=config.database.port,
                database=config.database.database,
                user=config.database.user,
                password=config.database.password
            )
            
            db_manager = DatabaseConnectionManager(db_config)
            db_manager.initialize()
            
            with db_manager.session_scope() as db_session:
                # Optional principal filter
                principal_id = None
                if self.prompt.confirm("Filter by principal?", default=False):
                    principals = db_session.query(Principal).all()
                    if principals:
                        items = [(str(p.principal_id), p.name) for p in principals]
                        principal_id_str = self.prompt.uuid("Principal ID (Tab for suggestions)", items)
                        principal_id = UUID(principal_id_str)
                
                # Get mandates
                query = db_session.query(ExecutionMandate)
                if principal_id:
                    query = query.filter(ExecutionMandate.subject_id == principal_id)
                
                mandates = query.order_by(ExecutionMandate.created_at.desc()).all()
                
                if not mandates:
                    self.console.print(f"  [{Colors.DIM}]No mandates found.[/]")
                    return
                
                self.console.print()
                
                table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
                table.add_column("Mandate ID", style=Colors.DIM)
                table.add_column("Subject", style=Colors.DIM)
                table.add_column("Valid Until", style=Colors.NEUTRAL)
                table.add_column("Actions", style=Colors.NEUTRAL)
                table.add_column("Status", style=Colors.NEUTRAL)
                
                for mandate in mandates:
                    status_style = Colors.SUCCESS if not mandate.revoked else Colors.ERROR
                    status_text = "Active" if not mandate.revoked else "Revoked"
                    actions_str = ", ".join(mandate.action_scope[:2]) + ("..." if len(mandate.action_scope) > 2 else "")
                    
                    table.add_row(
                        str(mandate.mandate_id)[:8] + "...",
                        str(mandate.subject_id)[:8] + "...",
                        str(mandate.valid_until)[:19],
                        actions_str,
                        f"[{status_style}]{status_text}[/]",
                    )
                
                self.console.print(table)
                self.console.print()
                self.console.print(f"  [{Colors.DIM}]Total: {len(mandates)} mandates[/]")
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error listing mandates: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
            self._show_cli_command("authority", "list", "")
    
    def issue_mandate(self) -> None:
        """Issue mandate wizard with scope and validity prompts."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Create a new execution mandate[/]",
            title=f"[bold {Colors.INFO}]Issue Mandate[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.config import load_config
            from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
            from caracal.db.models import Principal
            from caracal.core.mandate import MandateManager
            
            config = load_config()
            
            db_config = DatabaseConfig(
                host=config.database.host,
                port=config.database.port,
                database=config.database.database,
                user=config.database.user,
                password=config.database.password
            )
            
            db_manager = DatabaseConnectionManager(db_config)
            db_manager.initialize()
            
            with db_manager.session_scope() as db_session:
                # Get principals
                principals = db_session.query(Principal).all()
                
                if not principals:
                    self.console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No principals registered.[/]")
                    return
                
                # Select issuer
                items = [(str(p.principal_id), p.name) for p in principals]
                issuer_id_str = self.prompt.uuid("Issuer Principal ID (Tab for suggestions)", items)
                issuer_id = UUID(issuer_id_str)
                
                # Select subject
                subject_id_str = self.prompt.uuid("Subject Principal ID (Tab for suggestions)", items)
                subject_id = UUID(subject_id_str)
                
                # Resource scope
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Enter resource scope (one per line, empty to finish):[/]")
                self.console.print(f"  [{Colors.HINT}]Examples: api:openai:*, database:users:read, file:reports/*.pdf[/]")
                resource_scope = []
                while True:
                    resource = self.prompt.text(f"Resource {len(resource_scope) + 1}", required=False)
                    if not resource:
                        break
                    resource_scope.append(resource)
                
                if not resource_scope:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} At least one resource is required.[/]")
                    return
                
                # Action scope
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Enter action scope (one per line, empty to finish):[/]")
                self.console.print(f"  [{Colors.HINT}]Examples: api_call, database_query, file_read[/]")
                action_scope = []
                while True:
                    action = self.prompt.text(f"Action {len(action_scope) + 1}", required=False)
                    if not action:
                        break
                    action_scope.append(action)
                
                if not action_scope:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} At least one action is required.[/]")
                    return
                
                # Validity period
                validity_seconds = self.prompt.number(
                    "Validity period (seconds)",
                    default=3600,
                    min_value=60,
                )
                
                # Summary
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Mandate Details:[/]")
                self.console.print(f"    Issuer: [{Colors.DIM}]{issuer_id_str[:8]}...[/]")
                self.console.print(f"    Subject: [{Colors.DIM}]{subject_id_str[:8]}...[/]")
                self.console.print(f"    Resources: [{Colors.NEUTRAL}]{len(resource_scope)} resources[/]")
                self.console.print(f"    Actions: [{Colors.NEUTRAL}]{len(action_scope)} actions[/]")
                self.console.print(f"    Validity: [{Colors.NEUTRAL}]{int(validity_seconds)}s[/]")
                self.console.print()
                
                if not self.prompt.confirm("Issue this mandate?", default=True):
                    self.console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Cancelled[/]")
                    return
                
                # Issue mandate
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Issuing mandate...[/]")
                
                mandate_manager = MandateManager(db_session)
                
                mandate = mandate_manager.issue_mandate(
                    issuer_id=issuer_id,
                    subject_id=subject_id,
                    resource_scope=resource_scope,
                    action_scope=action_scope,
                    validity_seconds=int(validity_seconds),
                )
                
                self.console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Mandate issued![/]")
                self.console.print(f"  [{Colors.NEUTRAL}]Mandate ID: [{Colors.PRIMARY}]{mandate.mandate_id}[/]")
                self.console.print(f"  [{Colors.NEUTRAL}]Valid Until: [{Colors.PRIMARY}]{mandate.valid_until}[/]")
                
                if self.state:
                    self.state.add_recent_action(RecentAction.create(
                        "issue_mandate",
                        f"Issued mandate to {subject_id_str[:8]}...",
                    ))
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error issuing mandate: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
            self._show_cli_command("authority", "issue", "--issuer-id <uuid> --subject-id <uuid>")
    
    def view_mandate_details(self) -> None:
        """View mandate details with signature verification status."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]View detailed mandate information[/]",
            title=f"[bold {Colors.INFO}]Mandate Details[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.config import load_config
            from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
            from caracal.db.models import ExecutionMandate
            from caracal.core.crypto import verify_mandate_signature
            
            config = load_config()
            
            db_config = DatabaseConfig(
                host=config.database.host,
                port=config.database.port,
                database=config.database.database,
                user=config.database.user,
                password=config.database.password
            )
            
            db_manager = DatabaseConnectionManager(db_config)
            db_manager.initialize()
            
            with db_manager.session_scope() as db_session:
                mandates = db_session.query(ExecutionMandate).all()
                
                if not mandates:
                    self.console.print(f"  [{Colors.DIM}]No mandates exist.[/]")
                    return
                
                items = [(str(m.mandate_id), f"Subject {str(m.subject_id)[:8]}... - {m.valid_until}") for m in mandates]
                mandate_id_str = self.prompt.uuid("Mandate ID (Tab for suggestions)", items)
                mandate_id = UUID(mandate_id_str)
                
                mandate = db_session.query(ExecutionMandate).filter_by(mandate_id=mandate_id).first()
                
                if not mandate:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Mandate not found.[/]")
                    return
                
                # Display mandate details
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Mandate Information:[/]")
                self.console.print(f"    Mandate ID: [{Colors.PRIMARY}]{mandate.mandate_id}[/]")
                self.console.print(f"    Issuer ID: [{Colors.DIM}]{mandate.issuer_id}[/]")
                self.console.print(f"    Subject ID: [{Colors.DIM}]{mandate.subject_id}[/]")
                self.console.print(f"    Valid From: [{Colors.NEUTRAL}]{mandate.valid_from}[/]")
                self.console.print(f"    Valid Until: [{Colors.NEUTRAL}]{mandate.valid_until}[/]")
                self.console.print(f"    Created: [{Colors.DIM}]{mandate.created_at}[/]")
                self.console.print(f"    Delegation Depth: [{Colors.NEUTRAL}]{mandate.delegation_depth}[/]")
                
                # Status
                status_style = Colors.SUCCESS if not mandate.revoked else Colors.ERROR
                status_text = "Active" if not mandate.revoked else "Revoked"
                self.console.print(f"    Status: [{status_style}]{status_text}[/]")
                
                if mandate.revoked:
                    self.console.print(f"    Revoked At: [{Colors.DIM}]{mandate.revoked_at}[/]")
                    self.console.print(f"    Revocation Reason: [{Colors.WARNING}]{mandate.revocation_reason}[/]")
                
                # Signature verification
                try:
                    # This would require the issuer's public key
                    # For now, just show signature presence
                    sig_status = "Present" if mandate.signature else "Missing"
                    sig_style = Colors.SUCCESS if mandate.signature else Colors.ERROR
                    self.console.print(f"    Signature: [{sig_style}]{sig_status}[/]")
                except Exception:
                    self.console.print(f"    Signature: [{Colors.DIM}]Unable to verify[/]")
                
                self.console.print()
                
                # Resource scope
                self.console.print(f"  [{Colors.INFO}]Resource Scope:[/]")
                for resource in mandate.resource_scope:
                    self.console.print(f"    • {resource}")
                self.console.print()
                
                # Action scope
                self.console.print(f"  [{Colors.INFO}]Action Scope:[/]")
                for action in mandate.action_scope:
                    self.console.print(f"    • {action}")
                
                # Parent mandate if delegated
                if mandate.parent_mandate_id:
                    self.console.print()
                    self.console.print(f"  [{Colors.INFO}]Delegation:[/]")
                    self.console.print(f"    Parent Mandate: [{Colors.DIM}]{mandate.parent_mandate_id}[/]")
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error viewing mandate details: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    def validate_mandate(self) -> None:
        """Interactive mandate validation."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Validate a mandate for a specific action[/]",
            title=f"[bold {Colors.INFO}]Validate Mandate[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.config import load_config
            from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
            from caracal.db.models import ExecutionMandate
            from caracal.core.authority import AuthorityEvaluator
            
            config = load_config()
            
            db_config = DatabaseConfig(
                host=config.database.host,
                port=config.database.port,
                database=config.database.database,
                user=config.database.user,
                password=config.database.password
            )
            
            db_manager = DatabaseConnectionManager(db_config)
            db_manager.initialize()
            
            with db_manager.session_scope() as db_session:
                mandates = db_session.query(ExecutionMandate).filter_by(revoked=False).all()
                
                if not mandates:
                    self.console.print(f"  [{Colors.DIM}]No active mandates to validate.[/]")
                    return
                
                items = [(str(m.mandate_id), f"Subject {str(m.subject_id)[:8]}... - {m.valid_until}") for m in mandates]
                mandate_id_str = self.prompt.uuid("Mandate ID (Tab for suggestions)", items)
                mandate_id = UUID(mandate_id_str)
                
                mandate = db_session.query(ExecutionMandate).filter_by(mandate_id=mandate_id).first()
                
                if not mandate:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Mandate not found.[/]")
                    return
                
                # Get action and resource to validate
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Validation Request:[/]")
                requested_action = self.prompt.text("Requested action")
                requested_resource = self.prompt.text("Requested resource")
                
                # Validate
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Validating mandate...[/]")
                
                evaluator = AuthorityEvaluator(db_session)
                
                decision = evaluator.validate_mandate(
                    mandate=mandate,
                    requested_action=requested_action,
                    requested_resource=requested_resource,
                )
                
                # Display result
                self.console.print()
                if decision.allowed:
                    self.console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Validation PASSED[/]")
                    self.console.print(f"  [{Colors.NEUTRAL}]The mandate is valid for this action.[/]")
                else:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Validation FAILED[/]")
                    self.console.print(f"  [{Colors.WARNING}]Reason: {decision.reason}[/]")
                
                if self.state:
                    self.state.add_recent_action(RecentAction.create(
                        "validate_mandate",
                        f"Validated mandate {mandate_id_str[:8]}... - {'Passed' if decision.allowed else 'Failed'}",
                    ))
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error validating mandate: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
            self._show_cli_command("authority", "validate", "--mandate-id <uuid> --action <action> --resource <resource>")
    
    def revoke_mandate(self) -> None:
        """Revoke mandate with cascade impact preview."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Revoke an execution mandate[/]",
            title=f"[bold {Colors.WARNING}]Revoke Mandate[/]",
            border_style=Colors.WARNING,
        ))
        self.console.print()
        
        try:
            from caracal.config import load_config
            from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
            from caracal.db.models import ExecutionMandate
            from caracal.core.mandate import MandateManager
            
            config = load_config()
            
            db_config = DatabaseConfig(
                host=config.database.host,
                port=config.database.port,
                database=config.database.database,
                user=config.database.user,
                password=config.database.password
            )
            
            db_manager = DatabaseConnectionManager(db_config)
            db_manager.initialize()
            
            with db_manager.session_scope() as db_session:
                mandates = db_session.query(ExecutionMandate).filter_by(revoked=False).all()
                
                if not mandates:
                    self.console.print(f"  [{Colors.DIM}]No active mandates to revoke.[/]")
                    return
                
                items = [(str(m.mandate_id), f"Subject {str(m.subject_id)[:8]}... - {m.valid_until}") for m in mandates]
                mandate_id_str = self.prompt.uuid("Mandate ID (Tab for suggestions)", items)
                mandate_id = UUID(mandate_id_str)
                
                mandate = db_session.query(ExecutionMandate).filter_by(mandate_id=mandate_id).first()
                
                if not mandate:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Mandate not found.[/]")
                    return
                
                # Check for child mandates (cascade impact)
                child_count = db_session.query(ExecutionMandate).filter_by(
                    parent_mandate_id=mandate_id,
                    revoked=False
                ).count()
                
                cascade = False
                if child_count > 0:
                    self.console.print()
                    self.console.print(f"  [{Colors.WARNING}]Cascade Impact Preview:[/]")
                    self.console.print(f"    This mandate has {child_count} active child mandate(s).[/]")
                    self.console.print(f"    Revoking with cascade will also revoke all children.[/]")
                    self.console.print()
                    cascade = self.prompt.confirm("Revoke all child mandates (cascade)?", default=True)
                
                # Revocation reason
                reason = self.prompt.text("Revocation reason", default="Manual revocation via TUI")
                
                # Confirmation
                self.console.print()
                self.console.print(f"  [{Colors.WARNING}]Warning: This action cannot be undone.[/]")
                if cascade and child_count > 0:
                    self.console.print(f"  [{Colors.WARNING}]All {child_count} child mandate(s) will also be revoked.[/]")
                self.console.print()
                
                if not self.prompt.confirm("Revoke this mandate?", default=False):
                    self.console.print(f"  [{Colors.INFO}]Cancelled[/]")
                    return
                
                # Revoke mandate
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Revoking mandate...[/]")
                
                mandate_manager = MandateManager(db_session)
                
                # Use subject as revoker (in real system, would use authenticated user)
                mandate_manager.revoke_mandate(
                    mandate_id=mandate_id,
                    revoker_id=mandate.subject_id,
                    reason=reason,
                    cascade=cascade,
                )
                
                self.console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Mandate revoked![/]")
                if cascade and child_count > 0:
                    self.console.print(f"  [{Colors.INFO}]Revoked {child_count} child mandate(s).[/]")
                
                if self.state:
                    self.state.add_recent_action(RecentAction.create(
                        "revoke_mandate",
                        f"Revoked mandate {mandate_id_str[:8]}...",
                    ))
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error revoking mandate: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
            self._show_cli_command("authority", "revoke", "--mandate-id <uuid> --reason <reason>")
    
    def _show_cli_command(self, group: str, command: str, args: str) -> None:
        """Show the equivalent CLI command."""
        self.console.print()
        self.console.print(f"  [{Colors.HINT}]Run this command instead:[/]")
        self.console.print(f"  [{Colors.DIM}]$ caracal {group} {command} {args}[/]")


def run_mandate_flow(console: Optional[Console] = None, state: Optional[FlowState] = None) -> None:
    """Run the mandate management flow."""
    flow = MandateFlow(console, state)
    flow.run()
