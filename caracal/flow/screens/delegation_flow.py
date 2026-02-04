"""
Caracal Flow Delegation Screen.

Delegation management flows:
- Generate delegation token
- List delegations
- Validate token
- Revoke delegation
"""

from typing import Optional, List
import json
from pathlib import Path
from decimal import Decimal

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text


from caracal.flow.screens.main_menu import show_submenu # Correct import
from caracal.flow.components.prompt import FlowPrompt
from caracal.flow.theme import Colors, Icons
from caracal.logging_config import get_logger

logger = get_logger(__name__)


def run_delegation_flow(console: Optional[Console] = None) -> None:
    """Run the delegation management flow."""
    console = console or Console()
    
    while True:
        console.clear()
        
        action = show_submenu("delegation", console)
        
        if action is None:
            break
        
        console.clear()
        
        if action == "generate":
            _generate_token(console)
        elif action == "list":
            _list_delegations(console)
        elif action == "validate":
            _validate_token(console)
        elif action == "revoke":
            _revoke_delegation(console)
            
        console.print()
        console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
        input()


def _get_managers():
    """Helper to get registry, policy_store, and delegation_manager."""
    from caracal.cli.delegation import get_agent_registry_with_delegation
    from caracal.core.policy import PolicyStore
    from caracal.config import load_config
    
    config = load_config()
    registry, delegation_manager = get_agent_registry_with_delegation(config)
    
    policy_path = Path(config.storage.policy_store).expanduser()
    policy_store = PolicyStore(
        str(policy_path), 
        agent_registry=registry, 
        backup_count=config.storage.backup_count
    )
    
    return registry, policy_store, delegation_manager


def _generate_token(console: Console) -> None:
    """Generate delegation token."""
    prompt = FlowPrompt(console)
    
    console.print(Panel(
        f"[{Colors.NEUTRAL}]Create a new delegation token[/]",
        title=f"[bold {Colors.INFO}]Generate Token[/]",
        border_style=Colors.PRIMARY,
    ))
    console.print()
    
    try:
        registry, _, delegation_manager = _get_managers()
        
        # Get agents for selection
        agents = registry.list_agents()
        if not agents:
            console.print(f"  [{Colors.DIM}]No agents registered. Please register agents first.[/]")
            return
            
        agent_items = [(a.agent_id, a.name) for a in agents]
        
        # Select Parent
        console.print(f"  [{Colors.INFO}]Select Parent Agent (Issuer):[/]")
        parent_id = prompt.uuid("Parent Agent ID", agent_items)
        
        # Select Child
        # Exclude parent from child options if possible, or just let user select
        child_items = [(id, name) for id, name in agent_items if id != parent_id]
        if not child_items:
             console.print(f"  [{Colors.DIM}]No other agents available to be the child.[/]")
             return

        console.print(f"  [{Colors.INFO}]Select Child Agent (Subject):[/]")
        child_id = prompt.uuid("Child Agent ID", child_items)
        
        # Spending Limit
        limit = prompt.number("Spending Limit", min_value=0.0)
        currency = prompt.text("Currency", default="USD")
        
        # Expiration
        expiration = prompt.number("Expiration (seconds)", default=86400, min_value=60)
        
        # Operations
        ops_str = prompt.text("Allowed Operations (comma separated)", default="api_call, mcp_tool")
        operations = [op.strip() for op in ops_str.split(",") if op.strip()]
        
        if not prompt.confirm("Generate token?", default=True):
             return
             
        token = registry.generate_delegation_token(
            parent_agent_id=parent_id,
            child_agent_id=child_id,
            spending_limit=float(limit),
            currency=currency,
            expiration_seconds=int(expiration),
            allowed_operations=operations
        )
        
        if token:
            console.print()
            console.print(Panel(
                Text(token, style=Colors.SUCCESS),
                title="[bold]Delegation Token[/]",
                subtitle="Store securely! Won't be shown again.",
                border_style=Colors.SUCCESS
            ))
        else:
            console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Failed to generate token.[/]")
            
    except Exception as e:
        # Check if error is due to missing keys
        if "no private key" in str(e).lower():
            if prompt.confirm(f"Parent agent needs a signing key. Generate one now?", default=True):
                try:
                    # Generate keys
                    private_key, public_key = delegation_manager.generate_key_pair()
                    
                    # Update agent metadata
                    agent = registry.get_agent(parent_id)
                    if not agent.metadata:
                        agent.metadata = {}
                    
                    agent.metadata["private_key_pem"] = private_key.decode('utf-8')
                    agent.metadata["public_key_pem"] = public_key.decode('utf-8')
                    
                    # Persist changes
                    registry._persist() # Using internal method as we're fixing data
                    
                    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Signing keys generated![/]")
                    
                    # Retry token generation
                    token = registry.generate_delegation_token(
                        parent_agent_id=parent_id,
                        child_agent_id=child_id,
                        spending_limit=float(limit),
                        currency=currency,
                        expiration_seconds=int(expiration),
                        allowed_operations=operations
                    )
                    
                    if token:
                        console.print()
                        console.print(Panel(
                            Text(token, style=Colors.SUCCESS),
                            title="[bold]Delegation Token[/]",
                            subtitle="Store securely! Won't be shown again.",
                            border_style=Colors.SUCCESS
                        ))
                        return
                        
                except Exception as key_err:
                    logger.error(f"Failed to recover missing keys: {key_err}")
                    console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Failed to generate keys: {key_err}[/]")
                    return

        logger.error(f"Error generating token: {e}")
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")


def _list_delegations(console: Console) -> None:
    """List delegations."""
    console.print(Panel(
        f"[{Colors.NEUTRAL}]View current delegations[/]",
        title=f"[bold {Colors.INFO}]List Delegations[/]",
        border_style=Colors.PRIMARY,
    ))
    console.print()
    
    try:
        registry, policy_store, _ = _get_managers()
        
        delegations = []
        all_policies = policy_store.list_all_policies()
        
        for policy in all_policies:
            if policy.delegated_from_agent_id:
                parent = registry.get_agent(policy.delegated_from_agent_id)
                child = registry.get_agent(policy.agent_id)
                
                delegations.append({
                    "parent": parent.name if parent else policy.delegated_from_agent_id[:8],
                    "child": child.name if child else policy.agent_id[:8],
                    "limit": f"{policy.limit_amount} {policy.currency}",
                    "active": policy.active,
                    "policy_id": policy.policy_id
                })
        
        if not delegations:
             console.print(f"  [{Colors.DIM}]No delegations found.[/]")
             return
             
        table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
        table.add_column("Parent Agent", style=Colors.NEUTRAL)
        table.add_column("Child Agent", style=Colors.NEUTRAL)
        table.add_column("Limit", style=Colors.SUCCESS)
        table.add_column("Status", style=Colors.DIM)
        
        for d in delegations:
            status_style = Colors.SUCCESS if d["active"] else Colors.DIM
            status_text = "Active" if d["active"] else "Inactive"
            table.add_row(
                d["parent"],
                d["child"],
                d["limit"],
                f"[{status_style}]{status_text}[/]"
            )
            
        console.print(table)
        
    except Exception as e:
        logger.error(f"Error listing delegations: {e}")
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")


def _validate_token(console: Console) -> None:
    """Validate delegation token."""
    prompt = FlowPrompt(console)
    
    console.print(Panel(
        f"[{Colors.NEUTRAL}]Check validty of a token[/]",
        title=f"[bold {Colors.INFO}]Validate Token[/]",
        border_style=Colors.PRIMARY,
    ))
    console.print()
    
    try:
        token = prompt.text("Delegation Token", required=True)
        
        _, _, delegation_manager = _get_managers()
        
        claims = delegation_manager.validate_token(token)
        
        console.print()
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Token is valid![/]")
        console.print()
        
        table = Table(show_header=False, box=None)
        table.add_column("Field", style=f"bold {Colors.INFO}")
        table.add_column("Value", style=Colors.NEUTRAL)
        
        table.add_row("Issuer (Parent)", str(claims.issuer))
        table.add_row("Subject (Child)", str(claims.subject))
        table.add_row("Limit", f"{claims.spending_limit} {claims.currency}")
        table.add_row("Expires", str(claims.expiration))
        table.add_row("Operations", ", ".join(claims.allowed_operations))
        
        console.print(table)
        
    except Exception as e:
        logger.error(f"Error validating token: {e}")
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Invalid Token: {e}[/]")


def _revoke_delegation(console: Console) -> None:
    """Revoke a delegation."""
    prompt = FlowPrompt(console)
    
    console.print(Panel(
        f"[{Colors.NEUTRAL}]Revoke a delegated budget[/]",
        title=f"[bold {Colors.INFO}]Revoke Delegation[/]",
        border_style=Colors.PRIMARY,
    ))
    console.print()
    
    try:
        registry, policy_store, _ = _get_managers()
        
        # Find active delegations
        active_delegations = []
        all_policies = policy_store.list_all_policies()
        
        for p in all_policies:
            if p.delegated_from_agent_id and p.active:
                child = registry.get_agent(p.agent_id)
                child_name = child.name if child else p.agent_id[:8]
                display = f"Policy {p.policy_id[:8]}... (Child: {child_name})"
                active_delegations.append((p.policy_id, display))
        
        if not active_delegations:
            console.print(f"  [{Colors.DIM}]No active delegations to revoke.[/]")
            return
            
        policy_id = prompt.select(
            "Select Delegation to Revoke", 
            choices=[d[0] for d in active_delegations]
        )
        
        # Confirm
        if not prompt.confirm(f"Are you sure you want to revoke delegation {policy_id}?", default=False):
            return
            
        # Revoke
        # We need to manually update since PolicyStore doesn't expose strict 'revoke' API easily externally 
        # but manual update is what CLI does too.
        policy = policy_store._policies.get(policy_id)
        if policy:
            policy.active = False
            policy_store._persist()
            console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Delegation revoked successfully![/]")
        else:
            console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Policy not found.[/]")
            
    except Exception as e:
        logger.error(f"Error revoking delegation: {e}")
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
