"""
Caracal Flow Authority Policy Flow Screen.

Authority policy management flows:
- Create authority policy (with resource patterns, action patterns, validity)
- List/filter authority policies
- View policy details
- Edit policy
- Deactivate policy
"""

from typing import Optional
from uuid import UUID

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from caracal.flow.components.menu import show_menu
from caracal.flow.components.prompt import FlowPrompt
from caracal.flow.theme import Colors, Icons
from caracal.flow.state import FlowState, RecentAction
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class AuthorityPolicyFlow:
    """Authority policy management flow."""
    
    def __init__(self, console: Optional[Console] = None, state: Optional[FlowState] = None):
        self.console = console or Console()
        self.state = state
        self.prompt = FlowPrompt(self.console)
    
    def run(self) -> None:
        """Run the authority policy management flow."""
        while True:
            self.console.clear()
            
            action = show_menu(
                title="Authority Policy",
                items=[
                    ("create", "Create Policy", "Create a new authority policy"),
                    ("list", "List Policies", "View all authority policies"),
                    ("view", "View Policy Details", "View detailed policy information"),
                    ("edit", "Edit Policy", "Modify policy settings"),
                    ("deactivate", "Deactivate Policy", "Deactivate an authority policy"),
                ],
                subtitle="Manage authority policies",
            )
            
            if action is None:
                break
            
            self.console.clear()
            
            if action == "create":
                self.create_policy()
            elif action == "list":
                self.show_policy_list()
            elif action == "view":
                self.view_policy_details()
            elif action == "edit":
                self.edit_policy()
            elif action == "deactivate":
                self.deactivate_policy()
            
            self.console.print()
            self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
            input()
    
    def show_policy_list(self) -> None:
        """Display list of authority policies."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]All authority policies[/]",
            title=f"[bold {Colors.INFO}]Authority Policy List[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.config import load_config
            from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
            from caracal.db.models import AuthorityPolicy
            
            config = load_config()
            
            # Create database connection
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
                policies = db_session.query(AuthorityPolicy).all()
                
                if not policies:
                    self.console.print(f"  [{Colors.DIM}]No authority policies created yet.[/]")
                    return
                
                table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
                table.add_column("ID", style=Colors.DIM)
                table.add_column("Principal", style=Colors.DIM)
                table.add_column("Max Validity", style=Colors.NEUTRAL)
                table.add_column("Actions", style=Colors.NEUTRAL)
                table.add_column("Delegation", style=Colors.NEUTRAL)
                table.add_column("Status", style=Colors.NEUTRAL)
                
                for policy in policies:
                    status_style = Colors.SUCCESS if policy.active else Colors.DIM
                    delegation_str = f"Yes (depth {policy.max_delegation_depth})" if policy.allow_delegation else "No"
                    actions_str = ", ".join(policy.allowed_actions[:2]) + ("..." if len(policy.allowed_actions) > 2 else "")
                    
                    table.add_row(
                        str(policy.policy_id)[:8] + "...",
                        str(policy.principal_id)[:8] + "...",
                        f"{policy.max_validity_seconds}s",
                        actions_str,
                        delegation_str,
                        f"[{status_style}]{'Active' if policy.active else 'Inactive'}[/]",
                    )
                
                self.console.print(table)
                self.console.print()
                self.console.print(f"  [{Colors.DIM}]Total: {len(policies)} policies[/]")
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error listing authority policies: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
            self._show_cli_command("authority-policy", "list", "")
    
    def create_policy(self) -> None:
        """Create a new authority policy with wizard."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Create an authority policy to control mandate issuance.[/]",
            title=f"[bold {Colors.INFO}]Create Authority Policy[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.config import load_config
            from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
            from caracal.db.models import Principal, AuthorityPolicy
            from datetime import datetime
            
            config = load_config()
            
            # Create database connection
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
                    self.console.print(f"  [{Colors.HINT}]Register a principal first before creating policies.[/]")
                    return
                
                # Select principal
                items = [(str(p.principal_id), p.name) for p in principals]
                principal_id_str = self.prompt.uuid("Principal ID (Tab for suggestions)", items)
                principal_id = UUID(principal_id_str)
                
                # Max validity seconds
                max_validity = self.prompt.number(
                    "Maximum validity period (seconds)",
                    default=3600,
                    min_value=60,
                )
                
                # Resource patterns
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Enter allowed resource patterns (one per line, empty to finish):[/]")
                self.console.print(f"  [{Colors.HINT}]Examples: api:openai:*, database:users:read, file:reports/*.pdf[/]")
                resource_patterns = []
                while True:
                    pattern = self.prompt.text(f"Resource pattern {len(resource_patterns) + 1}", required=False)
                    if not pattern:
                        break
                    resource_patterns.append(pattern)
                
                if not resource_patterns:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} At least one resource pattern is required.[/]")
                    return
                
                # Action patterns
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Enter allowed actions (one per line, empty to finish):[/]")
                self.console.print(f"  [{Colors.HINT}]Examples: api_call, database_query, file_read[/]")
                actions = []
                while True:
                    action = self.prompt.text(f"Action {len(actions) + 1}", required=False)
                    if not action:
                        break
                    actions.append(action)
                
                if not actions:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} At least one action is required.[/]")
                    return
                
                # Delegation settings
                allow_delegation = self.prompt.confirm("Allow delegation?", default=False)
                max_delegation_depth = 0
                if allow_delegation:
                    max_delegation_depth = self.prompt.number(
                        "Maximum delegation depth",
                        default=2,
                        min_value=1,
                    )
                
                # Summary
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Policy Details:[/]")
                self.console.print(f"    Principal: [{Colors.DIM}]{principal_id_str[:8]}...[/]")
                self.console.print(f"    Max Validity: [{Colors.NEUTRAL}]{int(max_validity)}s[/]")
                self.console.print(f"    Resource Patterns: [{Colors.NEUTRAL}]{len(resource_patterns)} patterns[/]")
                self.console.print(f"    Actions: [{Colors.NEUTRAL}]{len(actions)} actions[/]")
                self.console.print(f"    Delegation: [{Colors.NEUTRAL}]{'Yes' if allow_delegation else 'No'}[/]")
                if allow_delegation:
                    self.console.print(f"    Max Depth: [{Colors.NEUTRAL}]{int(max_delegation_depth)}[/]")
                self.console.print()
                
                if not self.prompt.confirm("Create this policy?", default=True):
                    self.console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Cancelled[/]")
                    return
                
                # Create policy
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Creating authority policy...[/]")
                
                policy = AuthorityPolicy(
                    principal_id=principal_id,
                    max_validity_seconds=int(max_validity),
                    allowed_resource_patterns=resource_patterns,
                    allowed_actions=actions,
                    allow_delegation=allow_delegation,
                    max_delegation_depth=int(max_delegation_depth),
                    created_at=datetime.utcnow(),
                    created_by="flow_user",
                    active=True,
                )
                
                db_session.add(policy)
                db_session.commit()
                
                self.console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Authority policy created![/]")
                self.console.print(f"  [{Colors.NEUTRAL}]Policy ID: [{Colors.PRIMARY}]{policy.policy_id}[/]")
                
                if self.state:
                    self.state.add_recent_action(RecentAction.create(
                        "create_authority_policy",
                        f"Created authority policy with {max_validity}s max validity",
                    ))
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error creating authority policy: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
            self._show_cli_command("authority-policy", "create", "--principal-id <uuid> --max-validity <seconds>")
    
    def view_policy_details(self) -> None:
        """View detailed information about a policy."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]View detailed authority policy information[/]",
            title=f"[bold {Colors.INFO}]Policy Details[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.config import load_config
            from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
            from caracal.db.models import AuthorityPolicy
            
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
                policies = db_session.query(AuthorityPolicy).all()
                
                if not policies:
                    self.console.print(f"  [{Colors.DIM}]No policies exist.[/]")
                    return
                
                items = [(str(p.policy_id), f"Principal {str(p.principal_id)[:8]}... - {p.max_validity_seconds}s") for p in policies]
                policy_id_str = self.prompt.uuid("Policy ID (Tab for suggestions)", items)
                policy_id = UUID(policy_id_str)
                
                policy = db_session.query(AuthorityPolicy).filter_by(policy_id=policy_id).first()
                
                if not policy:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Policy not found.[/]")
                    return
                
                # Display policy details
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Policy Information:[/]")
                self.console.print(f"    Policy ID: [{Colors.PRIMARY}]{policy.policy_id}[/]")
                self.console.print(f"    Principal ID: [{Colors.DIM}]{policy.principal_id}[/]")
                self.console.print(f"    Max Validity: [{Colors.NEUTRAL}]{policy.max_validity_seconds}s[/]")
                self.console.print(f"    Created: [{Colors.DIM}]{policy.created_at}[/]")
                self.console.print(f"    Created By: [{Colors.DIM}]{policy.created_by}[/]")
                self.console.print(f"    Status: [{Colors.SUCCESS if policy.active else Colors.DIM}]{'Active' if policy.active else 'Inactive'}[/]")
                self.console.print()
                
                self.console.print(f"  [{Colors.INFO}]Resource Patterns:[/]")
                for pattern in policy.allowed_resource_patterns:
                    self.console.print(f"    • {pattern}")
                self.console.print()
                
                self.console.print(f"  [{Colors.INFO}]Allowed Actions:[/]")
                for action in policy.allowed_actions:
                    self.console.print(f"    • {action}")
                self.console.print()
                
                self.console.print(f"  [{Colors.INFO}]Delegation:[/]")
                self.console.print(f"    Allowed: [{Colors.NEUTRAL}]{'Yes' if policy.allow_delegation else 'No'}[/]")
                if policy.allow_delegation:
                    self.console.print(f"    Max Depth: [{Colors.NEUTRAL}]{policy.max_delegation_depth}[/]")
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error viewing policy details: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    def edit_policy(self) -> None:
        """Edit modifiable fields of a policy."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Edit authority policy settings[/]",
            title=f"[bold {Colors.INFO}]Edit Policy[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.config import load_config
            from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
            from caracal.db.models import AuthorityPolicy
            
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
                policies = db_session.query(AuthorityPolicy).all()
                
                if not policies:
                    self.console.print(f"  [{Colors.DIM}]No policies exist.[/]")
                    return
                
                items = [(str(p.policy_id), f"Principal {str(p.principal_id)[:8]}... - {p.max_validity_seconds}s") for p in policies]
                policy_id_str = self.prompt.uuid("Policy ID (Tab for suggestions)", items)
                policy_id = UUID(policy_id_str)
                
                policy = db_session.query(AuthorityPolicy).filter_by(policy_id=policy_id).first()
                
                if not policy:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Policy not found.[/]")
                    return
                
                # Show current values and allow editing
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Current Policy Settings:[/]")
                self.console.print(f"    Max Validity: {policy.max_validity_seconds}s")
                self.console.print(f"    Delegation: {'Yes' if policy.allow_delegation else 'No'}")
                if policy.allow_delegation:
                    self.console.print(f"    Max Depth: {policy.max_delegation_depth}")
                self.console.print()
                
                # Edit max validity
                if self.prompt.confirm("Update max validity?", default=False):
                    new_validity = self.prompt.number(
                        "New maximum validity (seconds)",
                        default=policy.max_validity_seconds,
                        min_value=60,
                    )
                    policy.max_validity_seconds = int(new_validity)
                
                # Edit delegation settings
                if self.prompt.confirm("Update delegation settings?", default=False):
                    policy.allow_delegation = self.prompt.confirm("Allow delegation?", default=policy.allow_delegation)
                    if policy.allow_delegation:
                        policy.max_delegation_depth = self.prompt.number(
                            "Maximum delegation depth",
                            default=policy.max_delegation_depth,
                            min_value=1,
                        )
                
                db_session.commit()
                
                self.console.print()
                self.console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Policy updated![/]")
                
                if self.state:
                    self.state.add_recent_action(RecentAction.create(
                        "edit_authority_policy",
                        f"Updated authority policy {str(policy_id)[:8]}...",
                    ))
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error editing policy: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    def deactivate_policy(self) -> None:
        """Deactivate an authority policy with confirmation."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Deactivate an authority policy[/]",
            title=f"[bold {Colors.WARNING}]Deactivate Policy[/]",
            border_style=Colors.WARNING,
        ))
        self.console.print()
        
        try:
            from caracal.config import load_config
            from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
            from caracal.db.models import AuthorityPolicy
            
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
                policies = db_session.query(AuthorityPolicy).filter_by(active=True).all()
                
                if not policies:
                    self.console.print(f"  [{Colors.DIM}]No active policies exist.[/]")
                    return
                
                items = [(str(p.policy_id), f"Principal {str(p.principal_id)[:8]}... - {p.max_validity_seconds}s") for p in policies]
                policy_id_str = self.prompt.uuid("Policy ID (Tab for suggestions)", items)
                policy_id = UUID(policy_id_str)
                
                policy = db_session.query(AuthorityPolicy).filter_by(policy_id=policy_id).first()
                
                if not policy:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Policy not found.[/]")
                    return
                
                if not policy.active:
                    self.console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Policy is already inactive.[/]")
                    return
                
                # Confirmation
                self.console.print()
                self.console.print(f"  [{Colors.WARNING}]Warning: Deactivating this policy will prevent new mandates from being issued.[/]")
                self.console.print(f"  [{Colors.DIM}]Existing mandates will remain valid until expiration.[/]")
                self.console.print()
                
                if not self.prompt.confirm("Deactivate this policy?", default=False):
                    self.console.print(f"  [{Colors.INFO}]Cancelled[/]")
                    return
                
                policy.active = False
                db_session.commit()
                
                self.console.print()
                self.console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Policy deactivated![/]")
                
                if self.state:
                    self.state.add_recent_action(RecentAction.create(
                        "deactivate_authority_policy",
                        f"Deactivated authority policy {str(policy_id)[:8]}...",
                    ))
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error deactivating policy: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    def _show_cli_command(self, group: str, command: str, args: str) -> None:
        """Show the equivalent CLI command."""
        self.console.print()
        self.console.print(f"  [{Colors.HINT}]Run this command instead:[/]")
        self.console.print(f"  [{Colors.DIM}]$ caracal {group} {command} {args}[/]")


def run_authority_policy_flow(console: Optional[Console] = None, state: Optional[FlowState] = None) -> None:
    """Run the authority policy management flow."""
    flow = AuthorityPolicyFlow(console, state)
    flow.run()
