"""
Caracal Flow Agent Flow Screen.

Agent management flows:
- Register new agent (guided form)
- List agents (searchable table)
- View agent details
- Create child agent with delegation
"""

from typing import Any, Optional

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from caracal.flow.components.menu import Menu, MenuItem, show_menu
from caracal.flow.components.prompt import FlowPrompt
from caracal.flow.theme import Colors, Icons
from caracal.flow.state import FlowState, RecentAction


def run_agent_flow(console: Optional[Console] = None, state: Optional[FlowState] = None) -> None:
    """Run the agent management flow."""
    console = console or Console()
    
    while True:
        console.clear()
        
        action = show_menu(
            title="Agent Management",
            items=[
                ("register", "Register New Agent", "Create a new agent identity"),
                ("list", "List Agents", "View all registered agents"),
                ("get", "Get Agent Details", "View details for a specific agent"),
                ("child", "Create Child Agent", "Register a child with delegation"),
                ("assign", "Assign Parent Agent", "Assign existing agent to a parent"),
            ],
            subtitle="Manage AI agent identities",
        )
        
        if action is None:
            break
        
        console.clear()
        
        if action == "register":
            _register_agent(console, state)
        elif action == "list":
            _list_agents(console)
        elif action == "get":
            _get_agent(console)
        elif action == "child":
            _create_child_agent(console, state)
        elif action == "assign":
            _assign_parent(console, state)
        
        # Pause before returning to menu
        console.print()
        console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
        input()


def _register_agent(console: Console, state: Optional[FlowState] = None) -> None:
    """Register a new agent through guided prompts."""
    prompt = FlowPrompt(console)
    
    console.print(Panel(
        f"[{Colors.NEUTRAL}]Create a new AI agent identity. Each agent gets a unique ID and can have budget policies.[/]",
        title=f"[bold {Colors.INFO}]Register New Agent[/]",
        border_style=Colors.PRIMARY,
    ))
    console.print()
    
    # Collect information
    name = prompt.text(
        "Agent name",
        validator=lambda x: (len(x) >= 2, "Name must be at least 2 characters"),
    )
    
    owner = prompt.text(
        "Owner email",
        validator=lambda x: ("@" in x, "Please enter a valid email address"),
    )
    
    # Optional metadata
    add_metadata = prompt.confirm("Add optional metadata?", default=False)
    metadata = {}
    if add_metadata:
        console.print(f"  [{Colors.DIM}]Enter key=value pairs, empty line to finish:[/]")
        while True:
            pair = prompt.text("Metadata (key=value)", required=False)
            if not pair:
                break
            if "=" in pair:
                key, value = pair.split("=", 1)
                metadata[key.strip()] = value.strip()
    
    # Confirm
    console.print()
    console.print(f"  [{Colors.INFO}]Agent Details:[/]")
    console.print(f"    Name: [{Colors.NEUTRAL}]{name}[/]")
    console.print(f"    Owner: [{Colors.NEUTRAL}]{owner}[/]")
    if metadata:
        console.print(f"    Metadata: [{Colors.DIM}]{metadata}[/]")
    console.print()
    
    if not prompt.confirm("Create this agent?", default=True):
        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Cancelled[/]")
        return
    
    # Execute command
    console.print()
    console.print(f"  [{Colors.INFO}]Creating agent...[/]")
    
    try:
        from caracal.cli.delegation import get_agent_registry_with_delegation
        from caracal.config import load_config
        
        config = load_config()
        registry, _ = get_agent_registry_with_delegation(config)
        
        agent = registry.register_agent(name=name, owner=owner, metadata=metadata if metadata else None)
        
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Agent registered successfully![/]")
        console.print()
        console.print(f"  [{Colors.NEUTRAL}]Agent ID: [{Colors.PRIMARY}]{agent.agent_id}[/]")
        
        # Record action
        if state:
            state.add_recent_action(RecentAction.create(
                "register_agent",
                f"Registered agent '{name}' ({agent.agent_id[:8]}...)",
            ))
        
    except ImportError:
        # Fallback: show CLI command
        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Unable to register directly.[/]")
        console.print()
        _show_cli_command(console, "agent", "register", 
                         f"--name {name} --owner {owner}")
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")


def _list_agents(console: Console) -> None:
    """List all registered agents."""
    console.print(Panel(
        f"[{Colors.NEUTRAL}]All registered AI agents[/]",
        title=f"[bold {Colors.INFO}]Agent List[/]",
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
            console.print(f"  [{Colors.DIM}]No agents registered yet.[/]")
            console.print(f"  [{Colors.HINT}]Use 'Register New Agent' to create one.[/]")
            return
        
        table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
        table.add_column("ID", style=Colors.DIM)
        table.add_column("Name", style=Colors.NEUTRAL)
        table.add_column("Owner", style=Colors.NEUTRAL)
        table.add_column("Parent", style=Colors.DIM)
        
        for agent in agents:
            table.add_row(
                agent.agent_id[:8] + "...",
                agent.name,
                agent.owner,
                agent.parent_agent_id[:8] + "..." if agent.parent_agent_id else "-",
            )
        
        console.print(table)
        console.print()
        console.print(f"  [{Colors.DIM}]Total: {len(agents)} agents[/]")
        
    except ImportError:
        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Unable to fetch agents.[/]")
        _show_cli_command(console, "agent", "list", "")
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")


def _get_agent(console: Console) -> None:
    """Get details for a specific agent."""
    prompt = FlowPrompt(console)
    
    console.print(Panel(
        f"[{Colors.NEUTRAL}]View detailed information about an agent[/]",
        title=f"[bold {Colors.INFO}]Agent Details[/]",
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
            console.print(f"  [{Colors.DIM}]No agents registered yet.[/]")
            return
        
        # Build completion list
        items = [(a.agent_id, a.name) for a in agents]
        
        agent_id = prompt.uuid("Enter agent ID (Tab for suggestions)", items)
        
        agent = registry.get_agent(agent_id)
        if not agent:
            console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Agent not found[/]")
            return
        
        # Display details
        console.print()
        console.print(f"  [{Colors.INFO}]Agent Details:[/]")
        console.print(f"    ID: [{Colors.PRIMARY}]{agent.agent_id}[/]")
        console.print(f"    Name: [{Colors.NEUTRAL}]{agent.name}[/]")
        console.print(f"    Owner: [{Colors.NEUTRAL}]{agent.owner}[/]")
        console.print(f"    Parent: [{Colors.DIM}]{agent.parent_agent_id or 'None'}[/]")
        console.print(f"    Created: [{Colors.DIM}]{agent.created_at}[/]")
        
        if agent.metadata:
            console.print(f"    Metadata:")
            for key, value in agent.metadata.items():
                console.print(f"      {key}: [{Colors.NEUTRAL}]{value}[/]")
        
    except ImportError:
        agent_id = prompt.text("Enter agent ID")
        _show_cli_command(console, "agent", "get", f"--agent-id {agent_id}")
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")


def _create_child_agent(console: Console, state: Optional[FlowState] = None) -> None:
    """Create a child agent with delegation."""
    prompt = FlowPrompt(console)
    
    console.print(Panel(
        f"[{Colors.NEUTRAL}]Create a child agent with delegated budget from a parent[/]",
        title=f"[bold {Colors.INFO}]Create Child Agent[/]",
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
            console.print(f"  [{Colors.DIM}]No agents exist to be a parent.[/]")
            console.print(f"  [{Colors.HINT}]Register a parent agent first.[/]")
            return
        
        # Select parent
        items = [(a.agent_id, a.name) for a in agents]
        parent_id = prompt.uuid("Parent agent ID (Tab for suggestions)", items)
        
        # Child details
        name = prompt.text("Child agent name")
        owner = prompt.text("Owner email")
        
        # Delegation
        budget = prompt.number("Delegated budget (USD)", default=50.0, min_value=0.01)
        
        console.print()
        console.print(f"  [{Colors.INFO}]Child Agent Details:[/]")
        console.print(f"    Parent: [{Colors.DIM}]{parent_id[:8]}...[/]")
        console.print(f"    Name: [{Colors.NEUTRAL}]{name}[/]")
        console.print(f"    Owner: [{Colors.NEUTRAL}]{owner}[/]")
        console.print(f"    Delegated Budget: [{Colors.SUCCESS}]${budget:.2f}[/]")
        console.print()
        
        if not prompt.confirm("Create this child agent?", default=True):
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Cancelled[/]")
            return
        
        # Execute
        console.print()
        console.print(f"  [{Colors.INFO}]Creating child agent...[/]")
        
        agent = registry.register_agent(
            name=name, 
            owner=owner, 
            parent_agent_id=parent_id,
        )
        
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Child agent created![/]")
        console.print(f"  [{Colors.NEUTRAL}]Agent ID: [{Colors.PRIMARY}]{agent.agent_id}[/]")
        
    except ImportError:
        _show_cli_command(console, "agent", "register",
                         "--name <name> --owner <email> --parent-id <uuid> --delegated-budget <amount>")
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")


def _assign_parent(console: Console, state: Optional[FlowState] = None) -> None:
    """Assign a parent to an existing agent."""
    prompt = FlowPrompt(console)
    
    console.print(Panel(
        f"[{Colors.NEUTRAL}]Assign an existing agent to a parent agent[/]",
        title=f"[bold {Colors.INFO}]Assign Parent[/]",
        border_style=Colors.PRIMARY,
    ))
    console.print()
    
    try:
        from caracal.cli.agent import get_agent_registry
        from caracal.config import load_config
        
        config = load_config()
        registry = get_agent_registry(config)
        agents = registry.list_agents()
        
        if len(agents) < 2:
            console.print(f"  [{Colors.DIM}]Need at least 2 agents to create a relationship.[/]")
            return
            
        # Select Child
        items = [(a.agent_id, a.name) for a in agents]
        child_id = prompt.uuid("Select Child Agent (Tab for suggestions)", items)
        
        # Select Parent (exclude child)
        parent_items = [(a.agent_id, a.name) for a in agents if a.agent_id != child_id]
        if not parent_items:
             console.print(f"  [{Colors.WARNING}]No valid parents available.[/]")
             return
             
        parent_id = prompt.uuid("Select Parent Agent", parent_items)
        
        console.print()
        if not prompt.confirm("Assign relationship?", default=True):
             return
             
        # Execute
        try:
            registry.update_agent(child_id, parent_agent_id=parent_id)
            console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Relationship assigned![/]")
        except ValueError as e:
            console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Invalid assignment: {e}[/]")
            
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")


def _show_cli_command(console: Console, group: str, command: str, args: str) -> None:
    """Show the equivalent CLI command."""
    console.print()
    console.print(f"  [{Colors.HINT}]Run this command instead:[/]")
    console.print(f"  [{Colors.DIM}]$ caracal {group} {command} {args}[/]")
