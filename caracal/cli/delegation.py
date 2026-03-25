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
from caracal.core.identity import PrincipalRegistry
from caracal.exceptions import CaracalError


def get_principal_registry_with_delegation(config) -> tuple:
    """
    Create PrincipalRegistry and DelegationTokenManager instances from configuration.
    
    Args:
        config: Configuration object
        
    Returns:
        Tuple of (PrincipalRegistry, DelegationTokenManager)
    """
    registry_path = Path(config.storage.principal_registry).expanduser()
    backup_count = config.storage.backup_count
    
    # Create delegation token manager first
    delegation_manager = DelegationTokenManager(principal_registry=None)
    
    # Create agent registry with delegation manager
    registry = PrincipalRegistry(
        str(registry_path),
        backup_count=backup_count,
        delegation_token_manager=delegation_manager
    )
    
    # Set registry reference in delegation manager
    delegation_manager.principal_registry = registry
    
    return registry, delegation_manager


@click.command('generate')
@click.option(
    '--parent-id',
    '-p',
    required=True,
    help='Source agent ID (issuer)',
)
@click.option(
    '--child-id',
    '-c',
    required=True,
    help='Target agent ID (subject)',
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
    Generate a delegation token for a target agent.
    
    Creates a JWT token signed by the source agent that authorizes the target
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
        registry, delegation_manager = get_principal_registry_with_delegation(cli_ctx.config)
        
        # Parse allowed operations
        allowed_operations = list(operations) if operations else None
        
        # Generate token
        token = registry.generate_delegation_token(
            source_agent_id=parent_id,
            target_agent_id=child_id,
            expiration_seconds=expiration,
            allowed_operations=allowed_operations
        )
        
        if token is None:
            click.echo("Error: Delegation token generation not available", err=True)
            sys.exit(1)
        
        # Display success message
        click.echo("✓ Delegation token generated successfully!")
        click.echo()
        click.echo(f"Source Agent:    {parent_id}")
        click.echo(f"Target Agent:    {child_id}")
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
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def list_delegations(ctx, agent_id: str, format: str):
    """
    List delegation relationships from the delegation graph.
    
    Shows delegation edges between mandates with principal types,
    delegation types, and context tags.
    
    Examples:
    
        caracal delegation list
        
        caracal delegation list --agent-id 550e8400-e29b-41d4-a716-446655440000
        
        caracal delegation list --format json
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        from caracal.db.connection import get_db_manager
        from caracal.db.models import DelegationEdgeModel
        
        db_manager = get_db_manager(cli_ctx.config)
        
        try:
            session = db_manager.get_session()
            
            # Query delegation edges
            query = session.query(DelegationEdgeModel).filter(
                DelegationEdgeModel.revoked == False
            )
            
            if agent_id:
                # Filter edges involving this agent (as source or target principal)
                from caracal.db.models import ExecutionMandate
                # Get mandates for this agent
                mandates = session.query(ExecutionMandate.mandate_id).filter(
                    ExecutionMandate.subject_id == agent_id
                ).all()
                mandate_ids = [m.mandate_id for m in mandates]
                
                if mandate_ids:
                    query = query.filter(
                        (DelegationEdgeModel.source_mandate_id.in_(mandate_ids)) |
                        (DelegationEdgeModel.target_mandate_id.in_(mandate_ids))
                    )
                else:
                    click.echo(f"No mandates found for agent: {agent_id}")
                    return
            
            edges = query.all()
            
            if not edges:
                click.echo("No delegation edges found.")
                return
            
            delegations = []
            for edge in edges:
                delegations.append({
                    'edge_id': str(edge.edge_id),
                    'source_mandate_id': str(edge.source_mandate_id),
                    'target_mandate_id': str(edge.target_mandate_id),
                    'source_principal_type': edge.source_principal_type,
                    'target_principal_type': edge.target_principal_type,
                    'delegation_type': edge.delegation_type,
                    'context_tags': edge.context_tags,
                    'granted_at': edge.granted_at.isoformat() if edge.granted_at else None,
                    'expires_at': edge.expires_at.isoformat() if edge.expires_at else None,
                })
        
            if not delegations:
                click.echo("No delegation edges found.")
                return
            
            if format.lower() == 'json':
                # JSON output
                click.echo(json.dumps(delegations, indent=2))
            else:
                # Table output
                click.echo(f"Total delegation edges: {len(delegations)}")
                click.echo()
                
                # Print header
                type_icons = {'user': '👤', 'agent': '🤖', 'service': '⚙️'}
                click.echo(
                    f"{'Edge ID':<38}  {'Source Type':<12}  {'Target Type':<12}  {'Deleg. Type':<14}  Tags"
                )
                click.echo("-" * 110)
                
                # Print delegations
                for d in delegations:
                    src_icon = type_icons.get(d['source_principal_type'], '?')
                    tgt_icon = type_icons.get(d['target_principal_type'], '?')
                    tags = ', '.join(d['context_tags']) if d.get('context_tags') else ''
                    
                    click.echo(
                        f"{d['edge_id']:<38}  "
                        f"{src_icon} {d['source_principal_type']:<9}  "
                        f"{tgt_icon} {d['target_principal_type']:<9}  "
                        f"{d['delegation_type']:<14}  "
                        f"{tags}"
                    )
        
        finally:
            db_manager.close()
    
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
        registry, delegation_manager = get_principal_registry_with_delegation(cli_ctx.config)
        
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
        click.echo(f"Issued At:           {claims.issued_at}")
        click.echo(f"Expires At:          {claims.expiration}")
        click.echo(f"Allowed Operations:  {', '.join(claims.allowed_operations)}")
        click.echo(f"Max Delegation Depth: {claims.max_delegation_depth}")
        
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
    help='Policy ID of the delegation to revoke',
)
@click.option(
    '--confirm',
    is_flag=True,
    help='Confirm revocation without prompting',
)
@click.pass_context
def revoke(ctx, policy_id: str, confirm: bool):
    """
    Revoke a delegation policy.
    
    Deactivates the delegation policy for a target agent, effectively revoking
    their designated authority.
    
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
        
        registry_path = Path(cli_ctx.config.storage.principal_registry).expanduser()
        policy_path = Path(cli_ctx.config.storage.policy_store).expanduser()
        backup_count = cli_ctx.config.storage.backup_count
        
        registry = PrincipalRegistry(str(registry_path), backup_count=backup_count)
        policy_store = PolicyStore(str(policy_path), principal_registry=registry, backup_count=backup_count)
        
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
            click.echo(f"Target Agent:  {agent.name if agent else 'Unknown'} ({policy.agent_id})")
            click.echo(f"Source Agent:  {parent.name if parent else 'Unknown'} ({policy.delegated_from_agent_id})")
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
        click.echo(f"Target Agent:  {agent.name if agent else 'Unknown'}")
        click.echo(f"Status:        Inactive")
        click.echo()
        click.echo("⚠ The target agent remains registered but can no longer spend.")
        
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)
