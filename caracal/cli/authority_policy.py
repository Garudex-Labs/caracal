"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for authority policy management.

Provides commands for creating and listing authority policies.
"""

import json
import sys
from typing import Optional
from uuid import UUID

import click

from caracal.cli.provider_scopes import (
    action_scope_shell_complete,
    get_workspace_from_ctx,
    provider_name_shell_complete,
    resource_scope_shell_complete,
    validate_provider_scopes,
)
from caracal.exceptions import CaracalError
from caracal.logging_config import get_logger

logger = get_logger(__name__)


@click.command('create')
@click.option(
    '--principal-id',
    '-p',
    required=True,
    help='Principal ID this policy applies to (UUID)',
)
@click.option(
    '--max-validity-seconds',
    '-v',
    required=True,
    type=int,
    help='Maximum validity period for mandates in seconds',
)
@click.option(
    '--provider',
    multiple=True,
    shell_complete=provider_name_shell_complete,
    help='Provider name to scope this policy to (repeatable)',
)
@click.option(
    '--resource-pattern',
    '-r',
    required=True,
    multiple=True,
    shell_complete=resource_scope_shell_complete,
    help='Allowed provider resource scopes (repeatable)',
)
@click.option(
    '--action',
    '-a',
    required=True,
    multiple=True,
    shell_complete=action_scope_shell_complete,
    help='Allowed provider action scopes (repeatable)',
)
@click.option(
    '--allow-delegation',
    '-d',
    is_flag=True,
    help='Allow delegation of mandates',
)
@click.option(
    '--max-delegation-network-distance',
    '--max-delegation-network_distance',
    'max_network_distance',
    '-m',
    type=int,
    default=0,
    help='Maximum delegation network distance (default: 0)',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def create(
    ctx,
    principal_id: str,
    max_validity_seconds: int,
    provider: tuple,
    resource_pattern: tuple,
    action: tuple,
    allow_delegation: bool,
    max_network_distance: int,
    format: str,
):
    """
    Create a new authority policy for a principal.

    Defines rules for how mandates can be issued to a principal,
    including scope limits and validity period constraints.

    Examples:

        # Create a provider-scoped policy for a worker principal (for example Fiona)
        caracal policy create --principal-id <fiona-principal-id> --max-validity-seconds 3600 --provider endframe --resource-pattern "provider:endframe:resource:deployments" --action "provider:endframe:action:invoke"

        # Create a policy with delegation for an orchestrator principal (for example Jared Dunn ai)
        caracal policy create -p <jared-dunn-ai-principal-id> -v 7200 --provider endframe -r "provider:endframe:resource:deployments" -a "provider:endframe:action:invoke" --allow-delegation --max-delegation-network-distance 2

        # JSON output
        caracal policy create -p <seefood-principal-id> -v 3600 -r "provider:seefood:resource:classifications" -a "provider:seefood:action:invoke" --format json
    """
    try:
        cli_ctx = ctx.obj
        
        # Parse UUID
        try:
            principal_uuid = UUID(principal_id)
        except ValueError as e:
            click.echo(f"Error: Invalid principal ID format: {e}", err=True)
            sys.exit(1)
        
        # Validate max_validity_seconds
        if max_validity_seconds <= 0:
            click.echo(
                f"Error: Max mandate validity seconds must be positive, got {max_validity_seconds}",
                err=True,
            )
            sys.exit(1)
        
        # Validate max_network_distance
        if max_network_distance < 0:
            click.echo(f"Error: Max delegation network distance cannot be negative, got {max_network_distance}", err=True)
            sys.exit(1)
        
        workspace = get_workspace_from_ctx(ctx)

        # Convert tuples to lists
        providers = [str(p) for p in provider]
        resource_patterns = list(resource_pattern)
        actions = list(action)

        validate_provider_scopes(
            workspace=workspace,
            resource_scopes=resource_patterns,
            action_scopes=actions,
            providers=providers or None,
        )
        
        # Create database connection
        from caracal.db.connection import get_db_manager
        from caracal.db.models import AuthorityPolicy, Principal
        from uuid import uuid4
        
        db_manager = get_db_manager(cli_ctx.config)
        
        try:
            with db_manager.session_scope() as session:
                # Check if principal exists
                principal = session.query(Principal).filter(
                    Principal.principal_id == principal_uuid
                ).first()
                if not principal:
                    click.echo(
                        f"Error: Principal not found: {principal_uuid}. "
                        "Register the principal before creating a policy.",
                        err=True,
                    )
                    sys.exit(1)
                
                # Create policy
                policy = AuthorityPolicy(
                    policy_id=uuid4(),
                    principal_id=principal_uuid,
                    max_validity_seconds=max_validity_seconds,
                    allowed_resource_patterns=resource_patterns,
                    allowed_actions=actions,
                    allow_delegation=allow_delegation,
                    max_network_distance=max_network_distance,
                    created_by="cli",
                    active=True
                )
                
                session.add(policy)
                session.flush()
                
                policy_data = {
                    'policy_id': str(policy.policy_id),
                    'principal_id': str(policy.principal_id),
                    'max_validity_seconds': policy.max_validity_seconds,
                    'allowed_resource_patterns': policy.allowed_resource_patterns,
                    'allowed_actions': policy.allowed_actions,
                    'allow_delegation': policy.allow_delegation,
                    'max_network_distance': policy.max_network_distance,
                    'active': policy.active,
                    'created_at': policy.created_at.isoformat() if policy.created_at else None,
                }
        
        finally:
            db_manager.close()
        
        if format.lower() == 'json':
            click.echo(json.dumps(policy_data, indent=2))
        else:
            click.echo("✓ Authority policy created successfully!")
            click.echo()
            click.echo(f"Policy ID:              {policy_data['policy_id']}")
            click.echo(f"Principal ID:           {policy_data['principal_id']}")
            click.echo(f"Max Mandate Validity:   {policy_data['max_validity_seconds']}s")
            click.echo(f"Resource Scopes:        {', '.join(policy_data['allowed_resource_patterns'])}")
            click.echo(f"Allowed Actions:        {', '.join(policy_data['allowed_actions'])}")
            click.echo(f"Allow Delegation:       {'Yes' if policy_data['allow_delegation'] else 'No'}")
            click.echo(f"Max Network Distance:   {policy_data['max_network_distance']}")
            click.echo(f"Active:                 {'Yes' if policy_data['active'] else 'No'}")
            click.echo(f"Created:                {policy_data['created_at']}")
    
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        logger.error(f"Failed to create authority policy: {e}", exc_info=True)
        sys.exit(1)


@click.command('list')
@click.option(
    '--principal-id',
    '-p',
    default=None,
    help='Filter by principal ID (optional)',
)
@click.option(
    '--active-only',
    '-a',
    is_flag=True,
    help='Show only active policies',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def list_policies(
    ctx,
    principal_id: Optional[str],
    active_only: bool,
    format: str,
):
    """
    List authority policies.

    Lists all policies in the system, or filters by principal ID if specified.

    Examples:

        # List all policies
        caracal policy list

        # List policies for a specific principal (for example Richard Hendricks)
        caracal policy list --principal-id <richard-hendricks-principal-id>

        # List only active policies
        caracal policy list --active-only

        # JSON output
        caracal policy list --format json
    """
    try:
        cli_ctx = ctx.obj
        
        # Parse principal ID if provided
        principal_uuid = None
        if principal_id:
            try:
                principal_uuid = UUID(principal_id)
            except ValueError as e:
                click.echo(f"Error: Invalid principal ID format: {e}", err=True)
                sys.exit(1)
        
        # Create database connection
        from caracal.db.connection import get_db_manager
        from caracal.db.models import AuthorityPolicy
        
        db_manager = get_db_manager(cli_ctx.config)
        
        try:
            with db_manager.session_scope() as session:
                query = session.query(AuthorityPolicy)
                
                if principal_uuid:
                    query = query.filter(AuthorityPolicy.principal_id == principal_uuid)
                
                if active_only:
                    query = query.filter(AuthorityPolicy.active == True)
                
                policies = query.all()
                
                if not policies:
                    if principal_uuid:
                        click.echo(f"No policies found for principal: {principal_id}")
                    else:
                        click.echo("No policies found.")
                    return
                
                if format.lower() == 'json':
                    output = [
                        {
                            'policy_id': str(p.policy_id),
                            'principal_id': str(p.principal_id),
                            'max_validity_seconds': p.max_validity_seconds,
                            'allowed_resource_patterns': p.allowed_resource_patterns,
                            'allowed_actions': p.allowed_actions,
                            'allow_delegation': p.allow_delegation,
                            'max_network_distance': p.max_network_distance,
                            'active': p.active,
                            'created_at': p.created_at.isoformat()
                        }
                        for p in policies
                    ]
                    click.echo(json.dumps(output, indent=2))
                else:
                    click.echo(f"Total policies: {len(policies)}")
                    click.echo()
                    
                    click.echo(f"{ 'Policy ID':<38}  {'Principal ID':<38}  {'Max Mandate Validity':<20}  {'Active':<8}  Delegation")
                    click.echo("-" * 130)
                    
                    for p in policies:
                        max_validity_str = f"{p.max_validity_seconds}s"
                        
                        if p.allow_delegation:
                            delegation_str = f"Yes (max network distance: {p.max_network_distance})"
                        else:
                            delegation_str = "No"
                        
                        active_str = "Yes" if p.active else "No"
                        
                        click.echo(
                            f"{str(p.policy_id):<38}  "
                            f"{str(p.principal_id):<38}  "
                            f"{max_validity_str:<15}  "
                            f"{active_str:<8}  "
                            f"{delegation_str}"
                        )
        
        finally:
            db_manager.close()
    
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        logger.error(f"Failed to list authority policies: {e}", exc_info=True)
        sys.exit(1)
