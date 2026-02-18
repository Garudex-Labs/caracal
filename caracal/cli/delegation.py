"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for delegation token management.

Provides commands for generating and viewing delegation tokens.
"""

import json
import sys
from pathlib import Path

import click

from caracal.core.delegation import DelegationTokenManager
from caracal.core.identity import AgentRegistry
from caracal.exceptions import CaracalError


def get_agent_registry_with_delegation(config) -> tuple:
    """
    Create AgentRegistry and DelegationTokenManager instances from configuration.
    
    Args:
        config: Configuration object
        
    Returns:
        Tuple of (AgentRegistry, DelegationTokenManager)
    """
    registry_path = Path(config.storage.agent_registry).expanduser()
    backup_count = config.storage.backup_count
    
    # Create delegation token manager first
    delegation_manager = DelegationTokenManager(agent_registry=None)
    
    # Create agent registry with delegation manager
    registry = AgentRegistry(
        str(registry_path),
        backup_count=backup_count,
        delegation_token_manager=delegation_manager
    )
    
    # Set registry reference in delegation manager
    delegation_manager.agent_registry = registry
    
    return registry, delegation_manager


@click.command('generate')
@click.option(
    '--parent-id',
    '-p',
    required=True,
    help='Parent agent ID (issuer)',
)
@click.option(
    '--child-id',
    '-c',
    required=True,
    help='Child agent ID (subject)',
)
@click.option(
    '--authority-scope',
    '-l',
    required=True,
    type=float,
    help='Maximum authority scope allowed',
)
@click.option(
    '--currency',
    default='USD',
    help='Currency code (default: USD)',
)
@click.option(
    '--expiration',
    '-e',
    default=86400,
    type=int,
    help='Token validity duration in seconds (default: 86400 = 24 hours)',
)
@click.option(
    '--operations',
    '-o',
    multiple=True,
    help='Allowed operations (can be specified multiple times, default: api_call, mcp_tool)',
)
@click.pass_context
def generate(ctx, parent_id: str, child_id: str, authority_scope: float, 
             currency: str, expiration: int, operations: tuple):
    """
    Generate a delegation token for a child agent.
    
    Creates a JWT token signed by the parent agent that authorizes the child
    agent to operate within the specified authority scope.
    
    Examples:
    
        caracal delegation generate \\
            --parent-id 550e8400-e29b-41d4-a716-446655440000 \\
            --child-id 660e8400-e29b-41d4-a716-446655440001 \\
            --authority-scope 100.00
        
        caracal delegation generate -p parent-uuid -c child-uuid \\
            -l 50.00 --currency EUR --expiration 3600 \\
            -o api_call -o mcp_tool
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Create registry and delegation manager
        registry, delegation_manager = get_agent_registry_with_delegation(cli_ctx.config)
        
        # Parse allowed operations
        allowed_operations = list(operations) if operations else None
        
        # Generate token
        token = registry.generate_delegation_token(
            parent_agent_id=parent_id,
            child_agent_id=child_id,
            spending_limit=authority_scope,
            currency=currency,
            expiration_seconds=expiration,
            allowed_operations=allowed_operations
        )
        
        if token is None:
            click.echo("Error: Delegation token generation not available", err=True)
            sys.exit(1)
        
        # Display success message
        click.echo("✓ Delegation token generated successfully!")
        click.echo()
        click.echo(f"Parent Agent:    {parent_id}")
        click.echo(f"Child Agent:     {child_id}")
        click.echo(f"Authority Scope: {authority_scope} {currency}")
        click.echo(f"Expires In:      {expiration} seconds")
        click.echo()
        click.echo("Token:")
        click.echo(token)
        click.echo()
        click.echo("⚠ Store this token securely. It will not be displayed again.")
        
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)


@click.command('list')
@click.option(
    '--agent-id',
    '-a',
    help='Agent ID to list delegations for (shows both delegated to and from)',
)
@click.option(
    '--parent-id',
    '-p',
    help='Show only delegations from this parent agent',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def list_delegations(ctx, agent_id: str, parent_id: str, format: str):
    """
    List delegation relationships and policies.
    
    Shows parent-child agent relationships and delegated budget policies.
    Can filter by agent ID (shows delegations to/from that agent) or
    parent ID (shows all delegations from that parent).
    
    Examples:
    
        caracal delegation list
        
        caracal delegation list --agent-id 550e8400-e29b-41d4-a716-446655440000
        
        caracal delegation list --parent-id 550e8400-e29b-41d4-a716-446655440000
        
        caracal delegation list --format json
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Create registry and policy store
        from pathlib import Path
        from caracal.core.policy import PolicyStore
        
        registry_path = Path(cli_ctx.config.storage.agent_registry).expanduser()
        policy_path = Path(cli_ctx.config.storage.policy_store).expanduser()
        backup_count = cli_ctx.config.storage.backup_count
        
        registry = AgentRegistry(str(registry_path), backup_count=backup_count)
        policy_store = PolicyStore(str(policy_path), agent_registry=registry, backup_count=backup_count)
        
        # Get delegations based on filters
        delegations = []
        
        if agent_id:
            # Show delegations for specific agent (as child or parent)
            agent = registry.get_agent(agent_id)
            if not agent:
                click.echo(f"Error: Agent not found: {agent_id}", err=True)
                sys.exit(1)
            
            # Get children (delegations from this agent)
            children = registry.get_children(agent_id)
            for child in children:
                policies = policy_store.get_policies(child.agent_id)
                delegated_policies = [p for p in policies if p.delegated_from_agent_id == agent_id]
                
                for policy in delegated_policies:
                    delegations.append({
                        'parent_id': agent_id,
                        'parent_name': agent.name,
                        'child_id': child.agent_id,
                        'child_name': child.name,
                        'policy_id': policy.policy_id,
                        'limit': policy.limit_amount,
                        'currency': policy.currency,
                        'time_window': policy.time_window,
                        'created_at': policy.created_at,
                        'active': policy.active
                    })
            
            # Get parent delegations (delegations to this agent)
            if agent.parent_agent_id:
                parent = registry.get_agent(agent.parent_agent_id)
                policies = policy_store.get_policies(agent_id)
                delegated_policies = [p for p in policies if p.delegated_from_agent_id == agent.parent_agent_id]
                
                for policy in delegated_policies:
                    delegations.append({
                        'parent_id': agent.parent_agent_id,
                        'parent_name': parent.name if parent else 'Unknown',
                        'child_id': agent_id,
                        'child_name': agent.name,
                        'policy_id': policy.policy_id,
                        'limit': policy.limit_amount,
                        'currency': policy.currency,
                        'time_window': policy.time_window,
                        'created_at': policy.created_at,
                        'active': policy.active
                    })
        
        elif parent_id:
            # Show all delegations from specific parent
            parent = registry.get_agent(parent_id)
            if not parent:
                click.echo(f"Error: Parent agent not found: {parent_id}", err=True)
                sys.exit(1)
            
            children = registry.get_children(parent_id)
            for child in children:
                policies = policy_store.get_policies(child.agent_id)
                delegated_policies = [p for p in policies if p.delegated_from_agent_id == parent_id]
                
                for policy in delegated_policies:
                    delegations.append({
                        'parent_id': parent_id,
                        'parent_name': parent.name,
                        'child_id': child.agent_id,
                        'child_name': child.name,
                        'policy_id': policy.policy_id,
                        'limit': policy.limit_amount,
                        'currency': policy.currency,
                        'time_window': policy.time_window,
                        'created_at': policy.created_at,
                        'active': policy.active
                    })
        
        else:
            # Show all delegations in the system
            all_policies = policy_store.list_all_policies()
            delegated_policies = [p for p in all_policies if p.delegated_from_agent_id is not None]
            
            for policy in delegated_policies:
                parent = registry.get_agent(policy.delegated_from_agent_id)
                child = registry.get_agent(policy.agent_id)
                
                delegations.append({
                    'parent_id': policy.delegated_from_agent_id,
                    'parent_name': parent.name if parent else 'Unknown',
                    'child_id': policy.agent_id,
                    'child_name': child.name if child else 'Unknown',
                    'policy_id': policy.policy_id,
                    'limit': policy.limit_amount,
                    'currency': policy.currency,
                    'time_window': policy.time_window,
                    'created_at': policy.created_at,
                    'active': policy.active
                })
        
        if not delegations:
            click.echo("No delegations found.")
            return
        
        if format.lower() == 'json':
            # JSON output
            click.echo(json.dumps(delegations, indent=2))
        else:
            # Table output
            click.echo(f"Total delegations: {len(delegations)}")
            click.echo()
            
            # Print header
            click.echo(
                f"{'Parent Agent':<30}  {'Child Agent':<30}  {'Limit':<15}  {'Window':<10}  {'Status':<8}"
            )
            click.echo("-" * 105)
            
            # Print delegations
            for delegation in delegations:
                parent_display = f"{delegation['parent_name'][:27]}..." if len(delegation['parent_name']) > 30 else delegation['parent_name']
                child_display = f"{delegation['child_name'][:27]}..." if len(delegation['child_name']) > 30 else delegation['child_name']
                limit_display = f"{delegation['limit']} {delegation['currency']}"
                status = "Active" if delegation['active'] else "Inactive"
                
                click.echo(
                    f"{parent_display:<30}  {child_display:<30}  {limit_display:<15}  "
                    f"{delegation['time_window']:<10}  {status:<8}"
                )
        
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)


@click.command('validate')
@click.option(
    '--token',
    '-t',
    required=True,
    help='Delegation token to validate',
)
@click.pass_context
def validate(ctx, token: str):
    """
    Validate a delegation token.
    
    Verifies the token signature, expiration, and displays the decoded claims.
    
    Examples:
    
        caracal delegation validate --token eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9...
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Create registry and delegation manager
        registry, delegation_manager = get_agent_registry_with_delegation(cli_ctx.config)
        
        # Validate token
        claims = delegation_manager.validate_token(token)
        
        # Display validation result
        click.echo("✓ Token is valid!")
        click.echo()
        click.echo("Token Claims:")
        click.echo("=" * 50)
        click.echo(f"Issuer (Parent):     {claims.issuer}")
        click.echo(f"Subject (Child):     {claims.subject}")
        click.echo(f"Audience:            {claims.audience}")
        click.echo(f"Token ID:            {claims.token_id}")
        click.echo(f"Authority Scope:     {claims.spending_limit} {claims.currency}")
        click.echo(f"Issued At:           {claims.issued_at}")
        click.echo(f"Expires At:          {claims.expiration}")
        click.echo(f"Allowed Operations:  {', '.join(claims.allowed_operations)}")
        click.echo(f"Max Delegation Depth: {claims.max_delegation_depth}")
        
        if claims.budget_category:
            click.echo(f"Authority Category:  {claims.budget_category}")
        
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)


@click.command('revoke')
@click.option(
    '--policy-id',
    '-p',
    required=True,
    help='Policy ID of the delegated budget to revoke',
)
@click.option(
    '--confirm',
    is_flag=True,
    help='Confirm revocation without prompting',
)
@click.pass_context
def revoke(ctx, policy_id: str, confirm: bool):
    """
    Revoke a delegated budget policy.
    
    Deactivates the budget policy for a child agent, effectively revoking
    their delegated spending authority. The agent remains registered but
    will no longer be able to spend.
    
    Examples:
    
        caracal delegation revoke --policy-id 550e8400-e29b-41d4-a716-446655440000
        
        caracal delegation revoke -p 550e8400-e29b-41d4-a716-446655440000 --confirm
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Create policy store
        from pathlib import Path
        from caracal.core.policy import PolicyStore
        
        registry_path = Path(cli_ctx.config.storage.agent_registry).expanduser()
        policy_path = Path(cli_ctx.config.storage.policy_store).expanduser()
        backup_count = cli_ctx.config.storage.backup_count
        
        registry = AgentRegistry(str(registry_path), backup_count=backup_count)
        policy_store = PolicyStore(str(policy_path), agent_registry=registry, backup_count=backup_count)
        
        # Get the policy to verify it exists and is delegated
        policy = None
        for p in policy_store.list_all_policies():
            if p.policy_id == policy_id:
                policy = p
                break
        
        if not policy:
            click.echo(f"Error: Policy not found: {policy_id}", err=True)
            sys.exit(1)
        
        if not policy.active:
            click.echo(f"Error: Policy {policy_id} is already inactive", err=True)
            sys.exit(1)
        
        if policy.delegated_from_agent_id is None:
            click.echo(
                f"Error: Policy {policy_id} is not a delegated policy",
                err=True
            )
            sys.exit(1)
        
        # Get agent details for display
        agent = registry.get_agent(policy.agent_id)
        parent = registry.get_agent(policy.delegated_from_agent_id)
        
        # Confirm revocation
        if not confirm:
            click.echo("Delegation Details:")
            click.echo("=" * 50)
            click.echo(f"Policy ID:     {policy.policy_id}")
            click.echo(f"Child Agent:   {agent.name if agent else 'Unknown'} ({policy.agent_id})")
            click.echo(f"Parent Agent:  {parent.name if parent else 'Unknown'} ({policy.delegated_from_agent_id})")
            click.echo(f"Budget Limit:  {policy.limit_amount} {policy.currency}")
            click.echo(f"Time Window:   {policy.time_window}")
            click.echo()
            
            if not click.confirm("Are you sure you want to revoke this delegation?"):
                click.echo("Revocation cancelled.")
                return
        
        # Deactivate the policy
        policy_store._policies[policy_id].active = False
        policy_store._persist()
        
        click.echo()
        click.echo("✓ Delegation revoked successfully!")
        click.echo()
        click.echo(f"Policy ID:     {policy_id}")
        click.echo(f"Child Agent:   {agent.name if agent else 'Unknown'}")
        click.echo(f"Status:        Inactive")
        click.echo()
        click.echo("⚠ The child agent remains registered but can no longer spend.")
        
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)
