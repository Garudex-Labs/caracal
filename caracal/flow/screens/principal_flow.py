"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal Flow Principal Flow Screen.

Principal management flows:
- Register new principal (guided form) — ECDSA P-256 keypair generated automatically
- List principals with authority status
- View principal authority (policies and mandates)
- Rotate Key — replace the keypair and choose mandate disposition

Key storage:
    Hard-cut    : private keys are custody-managed by vault backend.
    Runtime     : principal metadata stores only opaque vault references.
"""

from datetime import datetime
from typing import Optional
from uuid import UUID

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from sqlalchemy import or_

from caracal.db.connection import get_db_manager
from caracal.db.models import AuthorityLedgerEvent, AuthorityPolicy, ExecutionMandate, Principal
from caracal.core.identity import PrincipalRegistry
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
                    ("rotate", "Rotate Key", "Generate a new keypair; manage existing mandates"),
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
            elif action == "rotate":
                self.rotate_key()
            
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
            db_manager = get_db_manager()
            
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
                        principal.principal_kind,
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
        """Create principal wizard with type selection.
        
        Automatically generates and stores an ECDSA P-256 keypair immediately
        after the principal is committed to the database.
        """
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Create a new principal identity[/]",
            title=f"[bold {Colors.INFO}]Register Principal[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            # Collect information
            principal_kind = self.prompt.select(
                "Principal kind",
                choices=["human", "orchestrator", "worker", "service"],
            )

            name = self.prompt.text(
                "Principal name",
                validator=lambda x: (len(x) >= 2, "Name must be at least 2 characters"),
            )
            
            owner = self.prompt.text(
                "Owner email",
                validator=lambda x: ("@" in x, "Please enter a valid email address"),
            )
            
            # Confirm
            self.console.print()
            self.console.print(f"  [{Colors.INFO}]Principal Details:[/]")
            self.console.print(f"    Name: [{Colors.NEUTRAL}]{name}[/]")
            self.console.print(f"    Kind: [{Colors.NEUTRAL}]{principal_kind}[/]")
            self.console.print(f"    Owner: [{Colors.NEUTRAL}]{owner}[/]")
            self.console.print(f"    Keys: [{Colors.DIM}]ECDSA P-256 keypair (generated automatically)[/]")
            self.console.print()
            
            if not self.prompt.confirm("Create this principal?", default=True):
                self.console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Cancelled[/]")
                return
            
            # Create principal and generate keypair atomically
            self.console.print()
            self.console.print(f"  [{Colors.INFO}]Creating principal...[/]")
            
            db_manager = get_db_manager()
            
            with db_manager.session_scope() as db_session:
                registry = PrincipalRegistry(db_session)
                identity = registry.register_principal(
                    name=name,
                    principal_kind=principal_kind,
                    owner=owner,
                    metadata=None,
                    generate_keys=True,
                )
                key_ref = (identity.metadata or {}).get("vault_key_ref", "")
                
                self.console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Principal registered![/]")
                self.console.print(f"  [{Colors.NEUTRAL}]Principal ID : [{Colors.PRIMARY}]{identity.principal_id}[/]")
                self.console.print(
                    f"  [{Colors.NEUTRAL}]Vault key reference : [{Colors.DIM}]{key_ref}[/]"
                )
                self.console.print()
                
                if self.state:
                    self.state.add_recent_action(RecentAction.create(
                        "register_principal",
                        f"Registered principal '{name}' with ECDSA P-256 keypair",
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
            db_manager = get_db_manager()
            
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
                self.console.print(f"    Kind: [{Colors.NEUTRAL}]{principal.principal_kind}[/]")
                self.console.print(f"    Owner: [{Colors.NEUTRAL}]{principal.owner}[/]")
                self.console.print()
                
                # Show authority policies
                policies = db_session.query(AuthorityPolicy).filter_by(principal_id=principal_id).all()
                
                self.console.print(f"  [{Colors.INFO}]Authority Policies ({len(policies)}):[/]")
                if policies:
                    for policy in policies:
                        status = "Active" if policy.active else "Inactive"
                        status_style = Colors.SUCCESS if policy.active else Colors.DIM
                        self.console.print(f"    • [{status_style}]{status}[/] - Max mandate validity: {policy.max_validity_seconds}s")
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
    
    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _write_audit_log(
        self,
        db_session,
        event_type: str,
        principal_id,
        details: str,
        mandate_id=None,
    ) -> None:
        """Append an :class:`~caracal.db.models.AuthorityLedgerEvent` audit row.
        
        Args:
            db_session: Active SQLAlchemy session.
            event_type: Short identifier, e.g. ``"key_generated"``.
            principal_id: UUID of the affected principal.
            details: Human-readable description of the event.
            mandate_id: Optional UUID of a related mandate.
        """
        entry = AuthorityLedgerEvent(
            event_type=event_type,
            timestamp=datetime.utcnow(),
            principal_id=principal_id,
            mandate_id=mandate_id,
            decision=None,
            event_metadata={
                "details": details,
                "operator": "tui",
                "ts": datetime.utcnow().isoformat(),
            },
        )
        db_session.add(entry)
        db_session.flush()
        
        logger.info(
            "Audit log [%s] principal=%s — %s",
            event_type,
            principal_id,
            details,
        )

    def _revoke_mandates_for_principal(
        self,
        principal_id,
        db_session,
        reason: str,
    ) -> int:
        """Revoke all active mandates where the principal is the issuer or subject.
        
        Args:
            principal_id: UUID of the principal whose mandates should be revoked.
            db_session: Active SQLAlchemy session.
            reason: Short revocation reason stored on each mandate.
        
        Returns:
            Number of mandates revoked.
        """
        now = datetime.utcnow()
        mandates = (
            db_session.query(ExecutionMandate)
            .filter(
                ExecutionMandate.revoked.is_(False),
                or_(
                    ExecutionMandate.subject_id == principal_id,
                    ExecutionMandate.issuer_id == principal_id,
                ),
            )
            .all()
        )
        
        for mandate in mandates:
            mandate.revoked = True
            mandate.revoked_at = now
            mandate.revocation_reason = reason
            self._write_audit_log(
                db_session,
                event_type="mandate_revoked_by_rotation",
                principal_id=principal_id,
                mandate_id=mandate.mandate_id,
                details=(
                    f"Mandate {mandate.mandate_id} revoked due to key rotation "
                    f"(reason: {reason})"
                ),
            )
        
        db_session.flush()
        return len(mandates)

    # ------------------------------------------------------------------
    # Rotate Key action
    # ------------------------------------------------------------------

    def rotate_key(self) -> None:
        """Rotate the ECDSA P-256 keypair for a principal.
        
        Workflow:
        1. Operator selects a principal.
        2. Confirmation prompt.
        3. New keypair is generated; old private key file is backed up.
        4. Operator chooses mandate disposition:
           a. Revoke all active mandates immediately.
           b. Leave mandates valid until expiry (recommended).
        5. Audit log entries are written for every action.
        """
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Rotate the ECDSA P-256 keypair for a principal[/]",
            title=f"[bold {Colors.INFO}]Rotate Key[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            db_manager = get_db_manager()
            
            with db_manager.session_scope() as db_session:
                principals = db_session.query(Principal).all()
                
                if not principals:
                    self.console.print(f"  [{Colors.DIM}]No principals registered.[/]")
                    return
                
                items = [(str(p.principal_id), p.name) for p in principals]
                principal_id_str = self.prompt.uuid(
                    "Principal ID (Tab for suggestions)", items
                )
                principal_id = UUID(principal_id_str)
                
                principal = (
                    db_session.query(Principal)
                    .filter_by(principal_id=principal_id)
                    .first()
                )
                
                if not principal:
                    self.console.print(
                        f"  [{Colors.ERROR}]{Icons.ERROR} Principal not found.[/]"
                    )
                    return
                
                # Require an existing keypair
                if not principal.public_key_pem:
                    self.console.print(
                        f"  [{Colors.ERROR}]{Icons.ERROR} Principal '{principal.name}' has no "
                        f"existing keypair. Register the principal first.[/]"
                    )
                    return
                
                # ---------- confirmation ----------
                self.console.print()
                self.console.print(
                    f"  [{Colors.WARNING}]{Icons.WARNING}  You are about to rotate the keypair "
                    f"for '[bold]{principal.name}[/bold]'.[/]"
                )
                self.console.print(
                    f"  [{Colors.DIM}]All mandates signed with the old key will become "
                    f"unverifiable unless you keep them active until expiry.[/]"
                )
                self.console.print()
                
                if not self.prompt.confirm(
                    f"Rotate keypair for '{principal.name}'?", default=False
                ):
                    self.console.print(
                        f"  [{Colors.WARNING}]{Icons.WARNING} Rotation cancelled.[/]"
                    )
                    return
                
                # ---------- generate new keypair ----------
                self.console.print()
                self.console.print(f"  [{Colors.INFO}]Generating ECDSA P-256 keypair...[/]")
                registry = PrincipalRegistry(db_session)
                identity = registry.rotate_signing_keys(
                    principal_id=str(principal.principal_id),
                    reason="Flow key rotation",
                )
                principal = db_session.query(Principal).filter_by(principal_id=principal.principal_id).first()
                rotated_metadata = dict(identity.metadata or {})
                new_key_ref = (
                    rotated_metadata.get("vault_key_ref")
                    or "managed-by-vault"
                )
                
                # Audit: rotation event
                self._write_audit_log(
                    db_session,
                    event_type="key_rotated",
                    principal_id=principal.principal_id,
                    details=(
                        f"Keypair rotated for principal '{principal.name}'; "
                        f"new key reference {new_key_ref}"
                    ),
                )
                
                # ---------- mandate disposition ----------
                self.console.print()
                self.console.print(
                    f"  [{Colors.INFO}]What should happen to existing active mandates signed "
                    f"with the old key?[/]"
                )
                self.console.print(
                    f"  [{Colors.NEUTRAL}]  [1] Revoke all immediately — mandates become invalid "
                    f"right now.[/]"
                )
                self.console.print(
                    f"  [{Colors.SUCCESS}]  [2] Leave until expiry (recommended) — mandates "
                    f"remain valid until their individual expiry; "
                    f"new key used for all future mandates.[/]"
                )
                self.console.print()
                
                choice = self.prompt.text(
                    "Choice",
                    default="2",
                    validator=lambda x: (
                        x in ("1", "2"),
                        "Enter 1 or 2",
                    ),
                )
                
                if choice == "1":
                    # --- option 1: revoke all active mandates ---
                    active_count = (
                        db_session.query(ExecutionMandate)
                        .filter(
                            ExecutionMandate.revoked.is_(False),
                            or_(
                                ExecutionMandate.subject_id == principal_id,
                                ExecutionMandate.issuer_id == principal_id,
                            ),
                        )
                        .count()
                    )
                    
                    if active_count == 0:
                        self.console.print(
                            f"  [{Colors.DIM}]No active mandates to revoke.[/]"
                        )
                    else:
                        self.console.print()
                        self.console.print(
                            f"  [{Colors.WARNING}]{Icons.WARNING}  This will immediately revoke "
                            f"[bold]{active_count}[/bold] active mandate(s). "
                            f"This cannot be undone.[/]"
                        )
                        
                        if not self.prompt.confirm(
                            f"Revoke {active_count} mandate(s)?", default=False
                        ):
                            self.console.print(
                                f"  [{Colors.WARNING}]Revocation skipped. "
                                f"Mandates remain active.[/]"
                            )
                        else:
                            revoked = self._revoke_mandates_for_principal(
                                principal_id=principal.principal_id,
                                db_session=db_session,
                                reason="key_rotation",
                            )
                            self.console.print(
                                f"  [{Colors.SUCCESS}]{Icons.SUCCESS} "
                                f"Revoked {revoked} mandate(s).[/]"
                            )
                else:
                    # --- option 2: leave mandates until expiry ---
                    active_count = (
                        db_session.query(ExecutionMandate)
                        .filter(
                            ExecutionMandate.revoked.is_(False),
                            or_(
                                ExecutionMandate.subject_id == principal_id,
                                ExecutionMandate.issuer_id == principal_id,
                            ),
                        )
                        .count()
                    )
                    
                    self.console.print(
                        f"  [{Colors.SUCCESS}]{Icons.SUCCESS} "
                        f"{active_count} active mandate(s) will remain valid until expiry.[/]"
                    )
                    self.console.print(
                        f"  [{Colors.HINT}]All future mandates will use the new key.[/]"
                    )
                    
                    self._write_audit_log(
                        db_session,
                        event_type="key_rotated_mandates_preserved",
                        principal_id=principal.principal_id,
                        details=(
                            f"{active_count} mandate(s) preserved until expiry after "
                            f"key rotation for '{principal.name}'"
                        ),
                    )
                
                db_session.commit()
                
                self.console.print()
                self.console.print(
                    f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Key rotation complete.[/]"
                )
                self.console.print(
                    f"  [{Colors.NEUTRAL}]New private key ({_path_scope_label()}) : [{Colors.DIM}]{new_key_path}[/]"
                )
                
                if self.state:
                    self.state.add_recent_action(RecentAction.create(
                        "rotate_key",
                        f"Rotated keypair for principal '{principal.name}'",
                    ))
            
            db_manager.close()
            
        except Exception as e:
            logger.error(f"Error rotating key: {e}")
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")


def run_principal_flow(console: Optional[Console] = None, state: Optional[FlowState] = None) -> None:
    """Run the principal management flow."""
    flow = PrincipalFlow(console, state)
    flow.run()
