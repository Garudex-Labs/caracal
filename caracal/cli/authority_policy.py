"""
CLI commands for authority policy management.

Provides commands for creating and listing authority policies.

Requirements: 11.5, 11.6, 11.10
"""

import json
import sys
from typing import Optional
from uuid import UUID

import click

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
    '--resource-pattern',
    '-r',
    required=True,
    multiple=True,
    help='Allowed resource patterns (can be specified multiple times)',
)
@click.option(
    '--action',
    '-a',
    required=True,
    multiple=True,
    help='Allowed actions (can be specified multiple times)',
)
@click.option(
    '--allow-delegation',
    '-d',
    is_flag=True,
    help='Allow delegation of mandates',
)
@click.option(
    '--max-delegation-depth',
    '-m',
    type=int,
    default=0,
    help='Maximum delegation depth (default: 0)',
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
    resource_pattern: tuple,
    action: tuple,
    allow_delegation: bool,
    max_delegation_depth: int,
    format: str,
):
    """
    Create a new authority policy for a principal.
    
    Defines rules for how mandates can be issued to a principal,
    including scope limits and validity period constraints.
    
    Examples:
    
        # Create a basic policy
        caracal policy create \\
            --principal-id 550e8400-e29b-41d4-a716-446655440000 \\
            --max-validity-seconds 3600 \\
            --resource-pattern "api:openai:*" \\
            --action "api_call"
        
        # Create a policy with delegation
        caracal policy create \\
            -p 550e8400-e29b-41d4-a716-446655440000 \\
            -v 7200 \\
            -r "api:*" -r "database:*:read" \\
            -a "api_call" -a "database_query" \\
            --allow-delegation \\
            --max-delegation-depth 2
        
        # JSON output
        caracal policy create -p <principal-id> -v 3600 -r "api:*" -a "api_call" --format json
    
    Requirements: 11.5, 11.10
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Parse UUID
        try:
            principal_uuid = UUID(principal_id)
        except ValueError as e:
            click.echo(f"Error: Invalid principal ID format: {e}", err=True)
            sys.exit(1)
        
        # Validate max_validity_seconds
        if max_validity_seconds <= 0:
            click.echo(f"Error: Max validity seconds must be positive, got {max_validity_seconds}", err=True)
            sys.exit(1)
        
        # Validate max_delegation_depth
        if max_delegation_depth < 0:
            click.echo(f"Error: Max delegation depth cannot be negative, got {max_delegation_depth}", err=True)
            sys.exit(1)
        
        # Convert tuples to lists
        resource_patterns = list(resource_pattern)
        actions = list(action)
        
        # Create database connection
        from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
        from caracal.db.models import AuthorityPolicy, Principal
        from uuid import uuid4
        
        db_config = DatabaseConfig(
            host=cli_ctx.config.database.host,
            port=cli_ctx.config.database.port,
            database=cli_ctx.config.database.database,
            user=cli_ctx.config.database.user,
            password=cli_ctx.config.database.password
        )
        db_manager = DatabaseConnectionManager(db_config)
        db_manager.initialize()
        
        try:
            session = db_manager.get_session()
            
            # Check if principal exists
            principal = session.query(Principal).filter(
                Principal.principal_id == principal_uuid
            ).first()
            
            if not principal:
                click.echo(f"Error: Principal not found: {principal_id}", err=True)
                sys.exit(1)
            
            # Create policy
            policy = AuthorityPolicy(
                policy_id=uuid4(),
                principal_id=principal_uuid,
                max_validity_seconds=max_validity_seconds,
                allowed_resource_patterns=resource_patterns,
                allowed_actions=actions,
                allow_delegation=allow_delegation,
                max_delegation_depth=max_delegation_depth,
                created_by="cli",
                active=True
            )
            
            session.add(policy)
            session.commit()
            
            if format.lower() == 'json':
                # JSON output
                output = {
                    'policy_id': str(policy.policy_id),
                    'principal_id': str(policy.principal_id),
                    'max_validity_seconds': policy.max_validity_seconds,
                    'allowed_resource_patterns': policy.allowed_resource_patterns,
                    'allowed_actions': policy.allowed_actions,
                    'allow_delegation': policy.allow_delegation,
                    'max_delegation_depth': policy.max_delegation_depth,
                    'active': policy.active,
                    'created_at': policy.created_at.isoformat()
                }
                click.echo(json.dumps(output, indent=2))
            else:
                # Table output
                click.echo("✓ Authority policy created successfully!")
                click.echo()
                click.echo(f"Policy ID:              {policy.policy_id}")
                click.echo(f"Principal ID:           {policy.principal_id}")
                click.echo(f"Max Validity:           {policy.max_validity_seconds} seconds")
                click.echo(f"Resource Patterns:      {', '.join(policy.allowed_resource_patterns)}")
                click.echo(f"Allowed Actions:        {', '.join(policy.allowed_actions)}")
                click.echo(f"Allow Delegation:       {'Yes' if policy.allow_delegation else 'No'}")
                click.echo(f"Max Delegation Depth:   {policy.max_delegation_depth}")
                click.echo(f"Active:                 {'Yes' if policy.active else 'No'}")
                click.echo(f"Created:                {policy.created_at}")
        
        finally:
            # Close database connection
            db_manager.close()
    
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
        
        # List policies for a specific principal
        caracal policy list --principal-id 550e8400-e29b-41d4-a716-446655440000
        
        # List only active policies
        caracal policy list --active-only
        
        # JSON output
        caracal policy list --format json
    
    Requirements: 11.6, 11.10
    """
    try:
        # Get CLI context
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
        from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
        from caracal.db.models import AuthorityPolicy
        
        db_config = DatabaseConfig(
            host=cli_ctx.config.database.host,
            port=cli_ctx.config.database.port,
            database=cli_ctx.config.database.database,
            user=cli_ctx.config.database.user,
            password=cli_ctx.config.database.password
        )
        db_manager = DatabaseConnectionManager(db_config)
        db_manager.initialize()
        
        try:
            # Query policies
            query = db_manager.get_session().query(AuthorityPolicy)
            
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
                # JSON output
                output = [
                    {
                        'policy_id': str(p.policy_id),
                        'principal_id': str(p.principal_id),
                        'max_validity_seconds': p.max_validity_seconds,
                        'allowed_resource_patterns': p.allowed_resource_patterns,
                        'allowed_actions': p.allowed_actions,
                        'allow_delegation': p.allow_delegation,
                        'max_delegation_depth': p.max_delegation_depth,
                        'active': p.active,
                        'created_at': p.created_at.isoformat()
                    }
                    for p in policies
                ]
                click.echo(json.dumps(output, indent=2))
            else:
                # Table output
                click.echo(f"Total policies: {len(policies)}")
                click.echo()
                
                # Print header
                click.echo(f"{'Policy ID':<38}  {'Principal ID':<38}  {'Max Validity':<15}  {'Active':<8}  Delegation")
                click.echo("-" * 130)
                
                # Print policies
                for p in policies:
                    # Format max validity
                    max_validity_str = f"{p.max_validity_seconds}s"
                    
                    # Format delegation
                    if p.allow_delegation:
                        delegation_str = f"Yes (depth: {p.max_delegation_depth})"
                    else:
                        delegation_str = "No"
                    
                    # Format active status
                    active_str = "Yes" if p.active else "No"
                    
                    click.echo(
                        f"{str(p.policy_id):<38}  "
                        f"{str(p.principal_id):<38}  "
                        f"{max_validity_str:<15}  "
                        f"{active_str:<8}  "
                        f"{delegation_str}"
                    )
        
        finally:
            # Close database connection
            db_manager.close()
    
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        logger.error(f"Failed to list authority policies: {e}", exc_info=True)
        sys.exit(1)
