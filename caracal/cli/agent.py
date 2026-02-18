"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for agent identity management.

Provides commands for registering, listing, and retrieving agent identities.
"""

import sys
from pathlib import Path
from typing import Optional

import click

from caracal.core.identity import AgentRegistry
from caracal.exceptions import (
    AgentNotFoundError,
    CaracalError,
    DuplicateAgentNameError,
)


def get_agent_registry(config) -> AgentRegistry:
    """
    Create AgentRegistry instance from configuration.
    
    Args:
        config: Configuration object
        
    Returns:
        AgentRegistry instance
    """
    registry_path = Path(config.storage.agent_registry).expanduser()
    backup_count = config.storage.backup_count
    return AgentRegistry(str(registry_path), backup_count=backup_count)


@click.command('register')
@click.option(
    '--name',
    '-n',
    required=True,
    help='Human-readable agent name (must be unique)',
)
@click.option(
    '--owner',
    '-o',
    required=True,
    help='Owner identifier (email or username)',
)
@click.option(
    '--parent-id',
    '-p',
    default=None,
    help='Parent agent ID for hierarchical relationships',
)
@click.option(
    '--delegated-budget',
    '-b',
    type=float,
    default=None,
    help='Delegated budget amount from parent (requires --parent-id)',
)
@click.option(
    '--currency',
    '-c',
    default='USD',
    help='Currency code for delegated budget (default: USD)',
)
@click.option(
    '--time-window',
    '-w',
    default='daily',
    help='Time window for delegated budget (default: daily)',
)
@click.option(
    '--metadata',
    '-m',
    multiple=True,
    help='Metadata key=value pairs (can be specified multiple times)',
)
@click.pass_context
def register(ctx, name: str, owner: str, parent_id: str, delegated_budget: float, 
             currency: str, time_window: str, metadata: tuple):
    """
    Register a new AI agent with a unique identity.
    
    Creates a new agent with a globally unique ID and stores it in the registry.
    Optionally creates a child agent with a parent relationship and delegated budget.
    
    Examples:
    
        caracal agent register --name my-agent --owner user@example.com
        
        caracal agent register -n research-bot -o researcher@university.edu \\
            -m department=AI -m project=LLM
        
        caracal agent register -n child-agent -o user@example.com \\
            --parent-id 550e8400-e29b-41d4-a716-446655440000 \\
            --delegated-budget 50.00
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Validate delegated budget requires parent ID
        if delegated_budget is not None and parent_id is None:
            click.echo(
                "Error: --delegated-budget requires --parent-id to be specified",
                err=True
            )
            sys.exit(1)
        
        # Parse metadata
        metadata_dict = {}
        for item in metadata:
            if '=' not in item:
                click.echo(
                    f"Error: Invalid metadata format '{item}'. "
                    f"Expected key=value",
                    err=True
                )
                sys.exit(1)
            key, value = item.split('=', 1)
            metadata_dict[key.strip()] = value.strip()
        
        # Create agent registry
        registry = get_agent_registry(cli_ctx.config)
        
        # Register agent with optional parent
        agent = registry.register_agent(
            name=name,
            owner=owner,
            metadata=metadata_dict,
            parent_agent_id=parent_id
        )
        
        # Display success message
        click.echo("✓ Agent registered successfully!")
        click.echo()
        click.echo(f"Agent ID:    {agent.agent_id}")
        click.echo(f"Name:        {agent.name}")
        click.echo(f"Owner:       {agent.owner}")
        click.echo(f"Created:     {agent.created_at}")
        
        if agent.parent_agent_id:
            click.echo(f"Parent ID:   {agent.parent_agent_id}")
        
        if agent.metadata:
            # Filter out keys for display (don't show private keys)
            display_metadata = {
                k: v for k, v in agent.metadata.items()
                if k not in ['private_key_pem', 'public_key_pem', 'delegation_tokens']
            }
            if display_metadata:
                click.echo("Metadata:")
                for key, value in display_metadata.items():
                    click.echo(f"  {key}: {value}")
        
        # Create delegated budget policy if requested
        if delegated_budget is not None:
            from pathlib import Path
            from decimal import Decimal
            from caracal.core.policy import PolicyStore
            
            # Create policy store
            policy_path = Path(cli_ctx.config.storage.policy_store).expanduser()
            backup_count = cli_ctx.config.storage.backup_count
            policy_store = PolicyStore(
                str(policy_path),
                agent_registry=registry,
                backup_count=backup_count
            )
            
            # Create delegated policy
            policy = policy_store.create_policy(
                agent_id=agent.agent_id,
                limit_amount=Decimal(str(delegated_budget)),
                time_window=time_window,
                currency=currency,
                delegated_from_agent_id=parent_id
            )
            
            click.echo()
            click.echo("✓ Delegated budget policy created!")
            click.echo(f"Policy ID:   {policy.policy_id}")
            click.echo(f"Limit:       {delegated_budget} {currency}")
            click.echo(f"Time Window: {time_window}")
            click.echo(f"Delegated From: {parent_id}")
        
    except DuplicateAgentNameError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)


@click.command('list')
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def list_agents(ctx, format: str):
    """
    List all registered agents.
    
    Displays all agents in the registry with their IDs, names, and owners.
    
    Examples:
    
        caracal agent list
        
        caracal agent list --format json
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Create agent registry
        registry = get_agent_registry(cli_ctx.config)
        
        # Get all agents
        agents = registry.list_agents()
        
        if not agents:
            click.echo("No agents registered.")
            return
        
        if format.lower() == 'json':
            # JSON output
            import json
            output = [agent.to_dict() for agent in agents]
            click.echo(json.dumps(output, indent=2))
        else:
            # Table output
            click.echo(f"Total agents: {len(agents)}")
            click.echo()
            
            # Calculate column widths
            max_id_len = max(len(agent.agent_id) for agent in agents)
            max_name_len = max(len(agent.name) for agent in agents)
            max_owner_len = max(len(agent.owner) for agent in agents)
            
            # Ensure minimum widths for headers
            id_width = max(max_id_len, len("Agent ID"))
            name_width = max(max_name_len, len("Name"))
            owner_width = max(max_owner_len, len("Owner"))
            
            # Print header
            header = f"{'Agent ID':<{id_width}}  {'Name':<{name_width}}  {'Owner':<{owner_width}}  Created"
            click.echo(header)
            click.echo("-" * len(header))
            
            # Print agents
            for agent in agents:
                # Format created_at to be more readable
                created = agent.created_at.replace('T', ' ').replace('Z', '')
                click.echo(
                    f"{agent.agent_id:<{id_width}}  "
                    f"{agent.name:<{name_width}}  "
                    f"{agent.owner:<{owner_width}}  "
                    f"{created}"
                )
        
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)


@click.command('get')
@click.option(
    '--agent-id',
    '-a',
    required=True,
    help='Agent ID to retrieve',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def get(ctx, agent_id: str, format: str):
    """
    Get details for a specific agent.
    
    Retrieves and displays information about an agent by ID.
    
    Examples:
    
        caracal agent get --agent-id 550e8400-e29b-41d4-a716-446655440000
        
        caracal agent get -a 550e8400-e29b-41d4-a716-446655440000 --format json
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Create agent registry
        registry = get_agent_registry(cli_ctx.config)
        
        # Get agent
        agent = registry.get_agent(agent_id)
        
        if not agent:
            click.echo(f"Error: Agent not found: {agent_id}", err=True)
            sys.exit(1)
        
        if format.lower() == 'json':
            # JSON output
            import json
            click.echo(json.dumps(agent.to_dict(), indent=2))
        else:
            # Table output
            click.echo("Agent Details")
            click.echo("=" * 50)
            click.echo(f"Agent ID:    {agent.agent_id}")
            click.echo(f"Name:        {agent.name}")
            click.echo(f"Owner:       {agent.owner}")
            click.echo(f"Created:     {agent.created_at}")
            
            if agent.metadata:
                click.echo()
                click.echo("Metadata:")
                for key, value in agent.metadata.items():
                    click.echo(f"  {key}: {value}")
        
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)
