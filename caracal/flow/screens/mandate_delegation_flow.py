"""
Caracal Flow Mandate Delegation Screen.

Mandate delegation management flows:
- Show delegation chain with ASCII tree visualization
- Delegate mandate with scope subset validation
- View delegated mandates for principal
- Revoke delegation with cascade option
"""

from typing import Optional, List, Dict, Any
from uuid import UUID

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.tree import Tree

from caracal.flow.components.menu import show_menu
from caracal.flow.components.prompt import FlowPrompt
from caracal.flow.theme import Colors, Icons
from caracal.flow.state import FlowState, RecentAction
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class MandateDelegationFlow:
    """Mandate delegation management flow."""
    
    def __init__(self, console: Optional[Console] = None, state: Optional[FlowState] = None):
        self.console = console or Console()
        self.state = state
        self.prompt = FlowPrompt(self.console)
    
    def run(self) -> None:
        """Run the mandate delegation management flow."""
        while True:
            self.console.clear()
            
            action = show_menu(
                title="Mandate Delegation",
                items=[
                    ("chain", "Show Delegation Chain", "Visualize mandate delegation hierarchy"),
                    ("delegate", "Delegate Mandate", "Create a delegated mandate"),
                    ("list", "View Delegated Mandates", "List mandates for a principal"),
                    ("revoke", "Revoke Delegation", "Revoke a delegated mandate"),
                ],
                subtitle="Manage mandate delegation",
            )
            
            if action is None:
                break
            
            self.console.clear()
            
            if action == "chain":
                self.show_delegation_chain()
            elif action == "delegate":
                self.delegate_mandate()
            elif action == "list":
                self.view_delegated_mandates()
            elif action == "revoke":
                self.revoke_delegation()
            
            self.console.print()
            self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
            input()
    
    def show_delegation_chain(self) -> None:
        """Show delegation chain with ASCII tree visualization."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Visualize mandate delegation hierarchy[/]",
            title=f"[bold {Colors.INFO}]Delegation Chain[/]",
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
                # Get all mandates
                mandates = db_session.query(ExecutionMandate).all()
                
                if not mandates:
                    self.console.print(f"  [{Colors.DIM}]No mandates exist.[/]")
                    return
                
                # Select a mandate to show its chain
                items = [(str(m.mandate_id), f"Subject {str(m.subject_id)[:8]}... - Depth {m.delegation_depth}") for m in mandates]
                mandate_id_str = self.prompt.uuid("Mandate ID (Tab for suggestions)", items)
                mandate_id = UUID(mandate_id_str)
                
                mandate = db_session.query(ExecutionMandate).filter_by(mandate_id=mandate_id).first()
                
                if not mandate:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Mandate not found.[/]")
                    return
                
                # Build delegation chain tree
                tree = self._build_delegation_tree(mandate, db_session)
                
                self.console.print()
                self.console.print(tree)
                self.console.print()
                
                # Show chain summary
                chain_length = mandate.delegation_depth + 1
                self.console.print(f"  [{Colors.INFO}]Chain Length: {chain_length}[/]")
                self.console.print(f"  [{Colors.INFO}]Delegation Depth: {mandate.delegation_depth}[/]")
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error showing delegation chain: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    def _build_delegation_tree(self, mandate: Any, db_session: Any) -> Tree:
        """Build a tree visualization of the delegation chain."""
        from caracal.db.models import ExecutionMandate, Principal
        
        # Find root mandate
        current = mandate
        chain = [current]
        
        while current.parent_mandate_id:
            parent = db_session.query(ExecutionMandate).filter_by(mandate_id=current.parent_mandate_id).first()
            if not parent:
                break
            chain.insert(0, parent)
            current = parent
        
        # Build tree from root
        root_mandate = chain[0]
        root_principal = db_session.query(Principal).filter_by(principal_id=root_mandate.subject_id).first()
        root_name = root_principal.name if root_principal else str(root_mandate.subject_id)[:8]
        
        status_icon = Icons.SUCCESS if not root_mandate.revoked else Icons.ERROR
        status_color = Colors.SUCCESS if not root_mandate.revoked else Colors.ERROR
        
        tree = Tree(
            f"[{status_color}]{status_icon}[/] {root_name} (Root)",
            guide_style=Colors.DIM
        )
        
        # Add children recursively
        if len(chain) > 1:
            self._add_children_to_tree(tree, chain[1:], db_session)
        
        return tree
    
    def _add_children_to_tree(self, parent_node: Tree, chain: List[Any], db_session: Any) -> None:
        """Recursively add children to the tree."""
        from caracal.db.models import Principal
        
        if not chain:
            return
        
        mandate = chain[0]
        principal = db_session.query(Principal).filter_by(principal_id=mandate.subject_id).first()
        name = principal.name if principal else str(mandate.subject_id)[:8]
        
        status_icon = Icons.SUCCESS if not mandate.revoked else Icons.ERROR
        status_color = Colors.SUCCESS if not mandate.revoked else Colors.ERROR
        
        child_node = parent_node.add(
            f"[{status_color}]{status_icon}[/] {name} (Depth {mandate.delegation_depth})"
        )
        
        if len(chain) > 1:
            self._add_children_to_tree(child_node, chain[1:], db_session)
    
    def delegate_mandate(self) -> None:
        """Delegate mandate with scope subset validation."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Create a delegated mandate from a parent mandate[/]",
            title=f"[bold {Colors.INFO}]Delegate Mandate[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.config import load_config
            from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
            from caracal.db.models import ExecutionMandate, Principal
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
                # Get valid parent mandates
                mandates = db_session.query(ExecutionMandate).filter_by(revoked=False).all()
                
                if not mandates:
                    self.console.print(f"  [{Colors.DIM}]No valid mandates available for delegation.[/]")
                    return
                
                # Select parent mandate
                items = [(str(m.mandate_id), f"Subject {str(m.subject_id)[:8]}... - Depth {m.delegation_depth}") for m in mandates]
                parent_mandate_id_str = self.prompt.uuid("Parent Mandate ID (Tab for suggestions)", items)
                parent_mandate_id = UUID(parent_mandate_id_str)
                
                parent_mandate = db_session.query(ExecutionMandate).filter_by(mandate_id=parent_mandate_id).first()
                
                if not parent_mandate:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Parent mandate not found.[/]")
                    return
                
                # Show parent mandate scope
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Parent Mandate Scope:[/]")
                self.console.print(f"    Resources: {', '.join(parent_mandate.resource_scope[:3])}{'...' if len(parent_mandate.resource_scope) > 3 else ''}")
                self.console.print(f"    Actions: {', '.join(parent_mandate.action_scope[:3])}{'...' if len(parent_mandate.action_scope) > 3 else ''}")
                self.console.print()
                
                # Select child principal
                principals = db_session.query(Principal).all()
                principal_items = [(str(p.principal_id), p.name) for p in principals]
                child_subject_id_str = self.prompt.uuid("Child Principal ID (Tab for suggestions)", principal_items)
                child_subject_id = UUID(child_subject_id_str)
                
                # Child resource scope (must be subset)
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Enter child resource scope (subset of parent):[/]")
                self.console.print(f"  [{Colors.HINT}]Parent resources: {', '.join(parent_mandate.resource_scope)}[/]")
                child_resources = []
                while True:
                    resource = self.prompt.text(f"Resource {len(child_resources) + 1}", required=False)
                    if not resource:
                        break
                    if resource not in parent_mandate.resource_scope:
                        self.console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Resource not in parent scope. Try again.[/]")
                        continue
                    child_resources.append(resource)
                
                if not child_resources:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} At least one resource is required.[/]")
                    return
                
                # Child action scope (must be subset)
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Enter child action scope (subset of parent):[/]")
                self.console.print(f"  [{Colors.HINT}]Parent actions: {', '.join(parent_mandate.action_scope)}[/]")
                child_actions = []
                while True:
                    action = self.prompt.text(f"Action {len(child_actions) + 1}", required=False)
                    if not action:
                        break
                    if action not in parent_mandate.action_scope:
                        self.console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Action not in parent scope. Try again.[/]")
                        continue
                    child_actions.append(action)
                
                if not child_actions:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} At least one action is required.[/]")
                    return
                
                # Validity period (must be within parent)
                from datetime import datetime, timedelta
                
                parent_remaining = (parent_mandate.valid_until - datetime.utcnow()).total_seconds()
                max_validity = int(parent_remaining) if parent_remaining > 0 else 0
                
                if max_validity <= 0:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Parent mandate has expired.[/]")
                    return
                
                validity_seconds = self.prompt.number(
                    f"Validity period (seconds, max {max_validity})",
                    default=min(3600, max_validity),
                    min_value=60,
                    max_value=max_validity,
                )
                
                # Summary
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Delegation Summary:[/]")
                self.console.print(f"    Parent Mandate: [{Colors.DIM}]{parent_mandate_id_str[:8]}...[/]")
                self.console.print(f"    Child Principal: [{Colors.DIM}]{child_subject_id_str[:8]}...[/]")
                self.console.print(f"    Resources: [{Colors.NEUTRAL}]{len(child_resources)} resources[/]")
                self.console.print(f"    Actions: [{Colors.NEUTRAL}]{len(child_actions)} actions[/]")
                self.console.print(f"    Validity: [{Colors.NEUTRAL}]{int(validity_seconds)}s[/]")
                self.console.print()
                
                if not self.prompt.confirm("Create delegated mandate?", default=True):
                    self.console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Cancelled[/]")
                    return
                
                # Create delegated mandate
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Creating delegated mandate...[/]")
                
                mandate_manager = MandateManager(db_session)
                
                delegated_mandate = mandate_manager.delegate_mandate(
                    parent_mandate_id=parent_mandate_id,
                    child_subject_id=child_subject_id,
                    resource_scope=child_resources,
                    action_scope=child_actions,
                    validity_seconds=int(validity_seconds),
                )
                
                self.console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Delegated mandate created![/]")
                self.console.print(f"  [{Colors.NEUTRAL}]Mandate ID: [{Colors.PRIMARY}]{delegated_mandate.mandate_id}[/]")
                self.console.print(f"  [{Colors.NEUTRAL}]Delegation Depth: [{Colors.PRIMARY}]{delegated_mandate.delegation_depth}[/]")
                
                if self.state:
                    self.state.add_recent_action(RecentAction.create(
                        "delegate_mandate",
                        f"Delegated mandate to {child_subject_id_str[:8]}...",
                    ))
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error delegating mandate: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    def view_delegated_mandates(self) -> None:
        """View delegated mandates for a principal."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]View mandates delegated to a principal[/]",
            title=f"[bold {Colors.INFO}]Delegated Mandates[/]",
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
                # Select principal
                principals = db_session.query(Principal).all()
                
                if not principals:
                    self.console.print(f"  [{Colors.DIM}]No principals registered.[/]")
                    return
                
                items = [(str(p.principal_id), p.name) for p in principals]
                principal_id_str = self.prompt.uuid("Principal ID (Tab for suggestions)", items)
                principal_id = UUID(principal_id_str)
                
                # Get delegated mandates (where parent_mandate_id is not null)
                mandates = db_session.query(ExecutionMandate).filter(
                    ExecutionMandate.subject_id == principal_id,
                    ExecutionMandate.parent_mandate_id.isnot(None)
                ).all()
                
                if not mandates:
                    self.console.print(f"  [{Colors.DIM}]No delegated mandates for this principal.[/]")
                    return
                
                self.console.print()
                
                table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
                table.add_column("Mandate ID", style=Colors.DIM)
                table.add_column("Parent ID", style=Colors.DIM)
                table.add_column("Depth", style=Colors.NEUTRAL)
                table.add_column("Valid Until", style=Colors.NEUTRAL)
                table.add_column("Status", style=Colors.NEUTRAL)
                
                for mandate in mandates:
                    status_style = Colors.SUCCESS if not mandate.revoked else Colors.ERROR
                    status_text = "Active" if not mandate.revoked else "Revoked"
                    
                    table.add_row(
                        str(mandate.mandate_id)[:8] + "...",
                        str(mandate.parent_mandate_id)[:8] + "...",
                        str(mandate.delegation_depth),
                        str(mandate.valid_until),
                        f"[{status_style}]{status_text}[/]",
                    )
                
                self.console.print(table)
                self.console.print()
                self.console.print(f"  [{Colors.DIM}]Total: {len(mandates)} delegated mandates[/]")
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error viewing delegated mandates: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    def revoke_delegation(self) -> None:
        """Revoke delegation with cascade option."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Revoke a delegated mandate[/]",
            title=f"[bold {Colors.WARNING}]Revoke Delegation[/]",
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
                # Get active delegated mandates
                mandates = db_session.query(ExecutionMandate).filter(
                    ExecutionMandate.revoked == False,
                    ExecutionMandate.parent_mandate_id.isnot(None)
                ).all()
                
                if not mandates:
                    self.console.print(f"  [{Colors.DIM}]No active delegated mandates to revoke.[/]")
                    return
                
                items = [(str(m.mandate_id), f"Subject {str(m.subject_id)[:8]}... - Depth {m.delegation_depth}") for m in mandates]
                mandate_id_str = self.prompt.uuid("Mandate ID (Tab for suggestions)", items)
                mandate_id = UUID(mandate_id_str)
                
                mandate = db_session.query(ExecutionMandate).filter_by(mandate_id=mandate_id).first()
                
                if not mandate:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Mandate not found.[/]")
                    return
                
                # Check for child mandates
                child_count = db_session.query(ExecutionMandate).filter_by(
                    parent_mandate_id=mandate_id,
                    revoked=False
                ).count()
                
                cascade = False
                if child_count > 0:
                    self.console.print()
                    self.console.print(f"  [{Colors.WARNING}]This mandate has {child_count} active child mandate(s).[/]")
                    cascade = self.prompt.confirm("Revoke all child mandates (cascade)?", default=True)
                
                # Revocation reason
                reason = self.prompt.text("Revocation reason", default="Manual revocation via TUI")
                
                # Confirmation
                self.console.print()
                self.console.print(f"  [{Colors.WARNING}]Warning: This action cannot be undone.[/]")
                if cascade:
                    self.console.print(f"  [{Colors.WARNING}]All child mandates will also be revoked.[/]")
                self.console.print()
                
                if not self.prompt.confirm("Revoke this mandate?", default=False):
                    self.console.print(f"  [{Colors.INFO}]Cancelled[/]")
                    return
                
                # Revoke mandate
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Revoking mandate...[/]")
                
                mandate_manager = MandateManager(db_session)
                
                # For now, use the subject as revoker (in real system, would use authenticated user)
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
                        "revoke_delegation",
                        f"Revoked mandate {mandate_id_str[:8]}...",
                    ))
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error revoking delegation: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")


def run_mandate_delegation_flow(console: Optional[Console] = None, state: Optional[FlowState] = None) -> None:
    """Run the mandate delegation management flow."""
    flow = MandateDelegationFlow(console, state)
    flow.run()
