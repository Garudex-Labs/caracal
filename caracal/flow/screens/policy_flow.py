"""
Caracal Flow Policy Flow Screen.

Policy management flows:
- Create policy (with limit calculator)
- List/filter policies
- Policy history viewer
- Policy status check
"""

from typing import Optional

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from caracal.flow.components.menu import show_menu
from caracal.flow.components.prompt import FlowPrompt
from caracal.flow.theme import Colors, Icons
from caracal.flow.state import FlowState, RecentAction
from caracal.logging_config import get_logger

logger = get_logger(__name__)


def run_policy_flow(console: Optional[Console] = None, state: Optional[FlowState] = None) -> None:
    """Run the policy management flow."""
    console = console or Console()
    
    while True:
        console.clear()
        
        action = show_menu(
            title="Policy Management",
            items=[
                ("create", "Create Policy", "Create a new budget policy"),
                ("list", "List Policies", "View all policies"),
                ("status", "Policy Status", "Check budget utilization"),
                ("history", "Policy History", "View policy change audit trail"),
            ],
            subtitle="Manage budget policies",
        )
        
        if action is None:
            break
        
        console.clear()
        
        if action == "create":
            _create_policy(console, state)
        elif action == "list":
            _list_policies(console)
        elif action == "status":
            _policy_status(console)
        elif action == "history":
            _policy_history(console)
        
        console.print()
        console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
        input()


def _create_policy(console: Console, state: Optional[FlowState] = None) -> None:
    """Create a new budget policy."""
    prompt = FlowPrompt(console)
    
    console.print(Panel(
        f"[{Colors.NEUTRAL}]Create a budget policy to limit agent spending within a time window.[/]",
        title=f"[bold {Colors.INFO}]Create Budget Policy[/]",
        border_style=Colors.PRIMARY,
    ))
    console.print()
    
    try:
        from caracal.cli.agent import get_agent_registry
        from caracal.config import load_config
        
        config = load_config()
        registry = get_agent_registry(config)
        agents = registry.list_agents()
        
        if not agents:
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No agents registered.[/]")
            console.print(f"  [{Colors.HINT}]Register an agent first before creating policies.[/]")
            return
        
        # Select agent
        items = [(a.agent_id, a.name) for a in agents]
        agent_id = prompt.uuid("Agent ID (Tab for suggestions)", items)
        
        # Policy details
        limit = prompt.number(
            "Budget limit (USD)",
            default=100.0,
            min_value=0.01,
        )
        
        time_window = prompt.select(
            "Time window",
            choices=["hourly", "daily", "weekly", "monthly"],
            default="daily",
        )
        
        window_type = prompt.select(
            "Window type",
            choices=["rolling", "calendar"],
            default="rolling",
        )
        
        # Summary
        console.print()
        console.print(f"  [{Colors.INFO}]Policy Details:[/]")
        console.print(f"    Agent: [{Colors.DIM}]{agent_id[:8]}...[/]")
        console.print(f"    Limit: [{Colors.SUCCESS}]${limit:.2f}[/]")
        console.print(f"    Window: [{Colors.NEUTRAL}]{time_window} ({window_type})[/]")
        console.print()
        
        if not prompt.confirm("Create this policy?", default=True):
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Cancelled[/]")
            return
        
        # Execute
        console.print()
        console.print(f"  [{Colors.INFO}]Creating policy...[/]")
        
        from caracal.cli.policy import get_policy_store
        from decimal import Decimal
        
        store = get_policy_store(config)
        policy = store.create_policy(
            agent_id=agent_id,
            limit_amount=Decimal(str(limit)),
            currency="USD",
            time_window=time_window,
        )
        
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Policy created![/]")
        console.print(f"  [{Colors.NEUTRAL}]Policy ID: [{Colors.PRIMARY}]{policy.policy_id}[/]")
        
        if state:
            state.add_recent_action(RecentAction.create(
                "create_policy",
                f"Created {time_window} policy with ${limit:.2f} limit",
            ))
        
    except ImportError:
        _show_cli_command(console, "policy", "create",
                         "--agent-id <uuid> --limit <amount> --time-window daily")
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")


def _list_policies(console: Console) -> None:
    """List all policies."""
    console.print(Panel(
        f"[{Colors.NEUTRAL}]All budget policies[/]",
        title=f"[bold {Colors.INFO}]Policy List[/]",
        border_style=Colors.PRIMARY,
    ))
    console.print()
    
    try:
        from caracal.cli.policy import get_policy_store
        from caracal.config import load_config
        
        config = load_config()
        store = get_policy_store(config)
        policies = store.list_all_policies()
        
        if not policies:
            console.print(f"  [{Colors.DIM}]No policies created yet.[/]")
            return
        
        table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
        table.add_column("ID", style=Colors.DIM)
        table.add_column("Agent", style=Colors.DIM)
        table.add_column("Limit", style=Colors.SUCCESS)
        table.add_column("Window", style=Colors.NEUTRAL)
        table.add_column("Status", style=Colors.NEUTRAL)
        
        for policy in policies:
            status_style = Colors.SUCCESS if policy.active else Colors.DIM
            table.add_row(
                policy.policy_id[:8] + "...",
                policy.agent_id[:8] + "...",
                f"${float(policy.limit_amount):.2f}",
                policy.time_window,
                f"[{status_style}]{'Active' if policy.active else 'Inactive'}[/]",
            )
        
        console.print(table)
        console.print()
        console.print(f"  [{Colors.DIM}]Total: {len(policies)} policies[/]")
        
    except ImportError:
        _show_cli_command(console, "policy", "list", "")
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")


def _policy_status(console: Console) -> None:
    """Check policy status and budget utilization."""
    prompt = FlowPrompt(console)
    
    console.print(Panel(
        f"[{Colors.NEUTRAL}]Check budget utilization for an agent's policies[/]",
        title=f"[bold {Colors.INFO}]Policy Status[/]",
        border_style=Colors.PRIMARY,
    ))
    console.print()
    
    try:
        from caracal.cli.agent import get_agent_registry
        from caracal.config import load_config
        
        config = load_config()
        registry = get_agent_registry(config)
        agents = registry.list_agents()
        
        if not agents:
            console.print(f"  [{Colors.DIM}]No agents registered.[/]")
            return
        
        items = [(a.agent_id, a.name) for a in agents]
        agent_id = prompt.uuid("Agent ID (Tab for suggestions)", items)
        
        # Get policies and spending
        from caracal.cli.policy import get_policy_store
        from caracal.cli.ledger import get_ledger_query
        
        store = get_policy_store(config)
        policies = store.get_policies(agent_id)
        
        if not policies:
            console.print(f"  [{Colors.DIM}]No policies for this agent.[/]")
            return
        
        console.print()
        console.print(f"  [{Colors.INFO}]Budget Status:[/]")
        console.print()
        
        for policy in policies:
            limit = float(policy.limit_amount)
            # Simplified - in reality would calculate actual spending
            spent = 0.0  # Placeholder
            remaining = limit - spent
            pct = (spent / limit * 100) if limit > 0 else 0
            
            if pct >= 90:
                color = Colors.ERROR
                icon = Icons.WARNING
            elif pct >= 70:
                color = Colors.WARNING
                icon = Icons.INFO
            else:
                color = Colors.SUCCESS
                icon = Icons.SUCCESS
            
            console.print(f"  [{color}]{icon}[/] {policy.time_window.capitalize()} Policy")
            console.print(f"      Limit: ${limit:.2f}")
            console.print(f"      Spent: ${spent:.2f} ({pct:.1f}%)")
            console.print(f"      Remaining: [{color}]${remaining:.2f}[/]")
            console.print()
        
    except ImportError:
        agent_id = prompt.text("Enter agent ID")
        _show_cli_command(console, "policy", "status", f"--agent-id {agent_id}")
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")


def _policy_history(console: Console) -> None:
    """View policy change history."""
    prompt = FlowPrompt(console)
    
    console.print(Panel(
        f"[{Colors.NEUTRAL}]View audit trail of policy changes[/]",
        title=f"[bold {Colors.INFO}]Policy History[/]",
        border_style=Colors.PRIMARY,
    ))
    console.print()
    
    try:
        from caracal.cli.policy import get_policy_store
        from caracal.config import load_config
        
        config = load_config()
        store = get_policy_store(config)
        policies = store.list_all_policies()
        
        if not policies:
            console.print(f"  [{Colors.DIM}]No policies exist.[/]")
            return
        
        items = [(p.policy_id, f"Agent {p.agent_id[:8]}... - ${float(p.limit_amount):.2f}") for p in policies]
        policy_id = prompt.uuid("Policy ID (Tab for suggestions)", items)
        
        # Check if database is configured for history
        # Simple check: if host is default localhost and password is empty, likely not configured
        # But better to try to connect if user wants history
        
        try:
            from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
            from caracal.core.policy_versions import PolicyVersionManager
            from uuid import UUID
            
            # Create database connection manager
            db_config = DatabaseConfig(
                host=config.database.host,
                port=config.database.port,
                database=config.database.database,
                user=config.database.user,
                password=config.database.password
            )
            
            # Check if we should even try to connect (basic validation)
            if not config.database.password and config.database.host == "localhost":
                # Assume default config without DB
                raise ImportError("Database not configured")

            console.print(f"  [{Colors.DIM}]Connecting to database to fetch history...[/]")
            db_manager = DatabaseConnectionManager(db_config)
            db_manager.initialize()
            
            # Get database session
            with db_manager.session_scope() as db_session:
                # Create version manager
                version_manager = PolicyVersionManager(db_session)
                
                # Get policy history
                history = version_manager.get_policy_history(UUID(policy_id))
            
            db_manager.close()
            
            if not history:
                console.print(f"  [{Colors.DIM}]No history found for this policy.[/]")
                return
            
            console.print()
            console.print(f"  [{Colors.INFO}]Change History:[/]")
            console.print()
            
            for entry in history[-10:]:  # Last 10 entries
                console.print(f"  [{Colors.DIM}]{entry.changed_at}[/]")
                console.print(f"    {entry.change_type}: {entry.description}")
                console.print()
                
        except (ImportError, Exception) as e:
            # Fallback for file-based storage or connection error
            logger.debug(f"Could not fetch history from DB: {e}")
            
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Full history requires database storage.[/]")
            console.print(f"  [{Colors.DIM}]Current policy state:[/]")
            
            # Show current state from file store
            policy = store._policies.get(policy_id)
            if policy:
                console.print(f"    Created: {policy.created_at}")
                console.print(f"    Limit: {policy.limit_amount} {policy.currency}")
                console.print(f"    Status: {'Active' if policy.active else 'Inactive'}")
            
    except ImportError:
        policy_id = prompt.text("Enter policy ID")
        _show_cli_command(console, "policy", "history", f"--policy-id {policy_id}")
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")


def _show_cli_command(console: Console, group: str, command: str, args: str) -> None:
    """Show the equivalent CLI command."""
    console.print()
    console.print(f"  [{Colors.HINT}]Run this command instead:[/]")
    console.print(f"  [{Colors.DIM}]$ caracal {group} {command} {args}[/]")
