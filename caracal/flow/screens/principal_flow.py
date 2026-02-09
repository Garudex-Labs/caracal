"""
Caracal Flow Principal Flow Screen.

Principal management flows (replaces agent_flow):
- Register new principal (guided form)
- List principals with authority status
- View principal authority (policies and mandates)
- Generate ECDSA P-256 key pair
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


class PrincipalFlow:
    """Principal management flow."""
    
    def __init__(self, console: Optional[Console] = None, state: Optional[FlowState] = None):
        self.console = console or Console()
        self.state = state
        self.prompt = FlowPrompt(self.console)
    
    def run(self) -> None:
        """Run the principal management flow."""
        while True:
            self.console.clear()
            
            action = show_menu(
                title="Principal Hub",
                items=[
                    ("register", "Register New Principal", "Create a new principal identity"),
                    ("list", "List Principals", "View all registered principals"),
                    ("view", "View Principal Authority", "View policies and mandates"),
                    ("keys", "Generate Keys", "Generate ECDSA P-256 key pair"),
                ],
                subtitle="Manage principal identities",
            )
            
            if action is None:
                break
            
            self.console.clear()
            
            if action == "register":
                self.create_principal()
            elif action == "list":
                self.show_principal_list()
            elif action == "view":
                self.view_principal_authority()
            elif action == "keys":
                self.generate_keys()
            
            self.console.print()
            self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
            input()
    
    def show_principal_list(self) -> None:
        """Show principal list with authority status."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]All registered principals[/]",
            title=f"[bold {Colors.INFO}]Principal List[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.config import load_config
            from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
            from caracal.db.models import Principal, AuthorityPolicy, ExecutionMandate
            
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
                principals = db_session.query(Principal).all()
                
                if not principals:
                    self.console.print(f"  [{Colors.DIM}]No principals registered yet.[/]")
                    return
                
                table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
                table.add_column("ID", style=Colors.DIM)
                table.add_column("Name", style=Colors.NEUTRAL)
                table.add_column("Type", style=Colors.NEUTRAL)
                table.add_column("Policies", style=Colors.NEUTRAL)
                table.add_column("Mandates", style=Colors.NEUTRAL)
                
                for principal in principals:
                    # Count policies
                    policy_count = db_session.query(AuthorityPolicy).filter_by(
                        principal_id=principal.principal_id,
                        active=True
                    ).count()
                    
                    # Count mandates
                    mandate_count = db_session.query(ExecutionMandate).filter_by(
                        subject_id=principal.principal_id,
                        revoked=False
                    ).count()
                    
                    table.add_row(
                        str(principal.principal_id)[:8] + "...",
                        principal.name,
                        principal.principal_type,
                        str(policy_count),
                        str(mandate_count),
                    )
                
                self.console.print(table)
                self.console.print()
                self.console.print(f"  [{Colors.DIM}]Total: {len(principals)} principals[/]")
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error listing principals: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    def create_principal(self) -> None:
        """Create principal wizard with type selection."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Create a new principal identity[/]",
            title=f"[bold {Colors.INFO}]Register Principal[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.config import load_config
            from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
            from caracal.db.models import Principal
            from datetime import datetime
            
            config = load_config()
            
            # Collect information
            name = self.prompt.text(
                "Principal name",
                validator=lambda x: (len(x) >= 2, "Name must be at least 2 characters"),
            )
            
            principal_type = self.prompt.select(
                "Principal type",
                choices=["agent", "user", "service"],
                default="agent",
            )
            
            owner = self.prompt.text(
                "Owner email",
                validator=lambda x: ("@" in x, "Please enter a valid email address"),
            )
            
            # Confirm
            self.console.print()
            self.console.print(f"  [{Colors.INFO}]Principal Details:[/]")
            self.console.print(f"    Name: [{Colors.NEUTRAL}]{name}[/]")
            self.console.print(f"    Type: [{Colors.NEUTRAL}]{principal_type}[/]")
            self.console.print(f"    Owner: [{Colors.NEUTRAL}]{owner}[/]")
            self.console.print()
            
            if not self.prompt.confirm("Create this principal?", default=True):
                self.console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Cancelled[/]")
                return
            
            # Create principal
            self.console.print()
            self.console.print(f"  [{Colors.INFO}]Creating principal...[/]")
            
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
                principal = Principal(
                    name=name,
                    principal_type=principal_type,
                    owner=owner,
                    created_at=datetime.utcnow(),
                )
                
                db_session.add(principal)
                db_session.commit()
                
                self.console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Principal registered![/]")
                self.console.print(f"  [{Colors.NEUTRAL}]Principal ID: [{Colors.PRIMARY}]{principal.principal_id}[/]")
                
                if self.state:
                    self.state.add_recent_action(RecentAction.create(
                        "register_principal",
                        f"Registered principal '{name}'",
                    ))
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error creating principal: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    def view_principal_authority(self) -> None:
        """View principal authority showing policies and mandates."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]View authority status for a principal[/]",
            title=f"[bold {Colors.INFO}]Principal Authority[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.config import load_config
            from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
            from caracal.db.models import Principal, AuthorityPolicy, ExecutionMandate
            
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
                principals = db_session.query(Principal).all()
                
                if not principals:
                    self.console.print(f"  [{Colors.DIM}]No principals registered.[/]")
                    return
                
                items = [(str(p.principal_id), p.name) for p in principals]
                principal_id_str = self.prompt.uuid("Principal ID (Tab for suggestions)", items)
                principal_id = UUID(principal_id_str)
                
                principal = db_session.query(Principal).filter_by(principal_id=principal_id).first()
                
                if not principal:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Principal not found.[/]")
                    return
                
                # Display principal info
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Principal Information:[/]")
                self.console.print(f"    Name: [{Colors.NEUTRAL}]{principal.name}[/]")
                self.console.print(f"    Type: [{Colors.NEUTRAL}]{principal.principal_type}[/]")
                self.console.print(f"    Owner: [{Colors.NEUTRAL}]{principal.owner}[/]")
                self.console.print()
                
                # Show authority policies
                policies = db_session.query(AuthorityPolicy).filter_by(principal_id=principal_id).all()
                
                self.console.print(f"  [{Colors.INFO}]Authority Policies ({len(policies)}):[/]")
                if policies:
                    for policy in policies:
                        status = "Active" if policy.active else "Inactive"
                        status_style = Colors.SUCCESS if policy.active else Colors.DIM
                        self.console.print(f"    • [{status_style}]{status}[/] - Max validity: {policy.max_validity_seconds}s")
                else:
                    self.console.print(f"    [{Colors.DIM}]No policies[/]")
                
                self.console.print()
                
                # Show execution mandates
                mandates = db_session.query(ExecutionMandate).filter_by(subject_id=principal_id).all()
                
                self.console.print(f"  [{Colors.INFO}]Execution Mandates ({len(mandates)}):[/]")
                if mandates:
                    for mandate in mandates[:5]:  # Show first 5
                        status = "Active" if not mandate.revoked else "Revoked"
                        status_style = Colors.SUCCESS if not mandate.revoked else Colors.ERROR
                        self.console.print(f"    • [{status_style}]{status}[/] - Valid until: {mandate.valid_until}")
                    if len(mandates) > 5:
                        self.console.print(f"    [{Colors.DIM}]...and {len(mandates) - 5} more[/]")
                else:
                    self.console.print(f"    [{Colors.DIM}]No mandates[/]")
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error viewing principal authority: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    def generate_keys(self) -> None:
        """Generate ECDSA P-256 key pair for principal."""
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Generate cryptographic keys for a principal[/]",
            title=f"[bold {Colors.INFO}]Generate Keys[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.config import load_config
            from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
            from caracal.db.models import Principal
            from cryptography.hazmat.primitives.asymmetric import ec
            from cryptography.hazmat.primitives import serialization
            
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
                principals = db_session.query(Principal).all()
                
                if not principals:
                    self.console.print(f"  [{Colors.DIM}]No principals registered.[/]")
                    return
                
                items = [(str(p.principal_id), p.name) for p in principals]
                principal_id_str = self.prompt.uuid("Principal ID (Tab for suggestions)", items)
                principal_id = UUID(principal_id_str)
                
                principal = db_session.query(Principal).filter_by(principal_id=principal_id).first()
                
                if not principal:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Principal not found.[/]")
                    return
                
                # Check if keys already exist
                if principal.public_key_pem:
                    self.console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Principal already has keys.[/]")
                    if not self.prompt.confirm("Regenerate keys?", default=False):
                        return
                
                # Generate ECDSA P-256 key pair
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Generating ECDSA P-256 key pair...[/]")
                
                private_key = ec.generate_private_key(ec.SECP256R1())
                public_key = private_key.public_key()
                
                # Serialize keys to PEM format
                private_pem = private_key.private_bytes(
                    encoding=serialization.Encoding.PEM,
                    format=serialization.PrivateFormat.PKCS8,
                    encryption_algorithm=serialization.NoEncryption()
                ).decode('utf-8')
                
                public_pem = public_key.public_bytes(
                    encoding=serialization.Encoding.PEM,
                    format=serialization.PublicFormat.SubjectPublicKeyInfo
                ).decode('utf-8')
                
                # Store keys
                principal.private_key_pem = private_pem
                principal.public_key_pem = public_pem
                
                db_session.commit()
                
                self.console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Keys generated and stored![/]")
                self.console.print()
                self.console.print(f"  [{Colors.WARNING}]Warning: Private key is stored in database.[/]")
                self.console.print(f"  [{Colors.HINT}]In production, use a key management service (KMS).[/]")
                
                if self.state:
                    self.state.add_recent_action(RecentAction.create(
                        "generate_keys",
                        f"Generated keys for principal {principal.name}",
                    ))
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error generating keys: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")


def run_principal_flow(console: Optional[Console] = None, state: Optional[FlowState] = None) -> None:
    """Run the principal management flow."""
    flow = PrincipalFlow(console, state)
    flow.run()
