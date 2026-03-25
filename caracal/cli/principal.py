"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for principal identity management.

Provides commands for registering, listing, and retrieving principal identities.
"""

import sys
from pathlib import Path
from typing import Optional

import click

from caracal.core.identity import PrincipalRegistry
from caracal.exceptions import (
    PrincipalNotFoundError,
    CaracalError,
    DuplicatePrincipalNameError,
)


def get_principal_registry(config) -> PrincipalRegistry:
    """
    Create PrincipalRegistry instance from configuration.
    
    Args:
        config: Configuration object
        
    Returns:
        PrincipalRegistry instance
    """
    registry_path = Path(config.storage.principal_registry).expanduser()
    backup_count = config.storage.backup_count
    return PrincipalRegistry(str(registry_path), backup_count=backup_count)


@click.command('register')
@click.option(
    "--type",
    "principal_type",
    type=click.Choice(["user", "agent", "service"]),
    default="agent",
    help="Type of principal (user, agent, service)",
)
@click.option(
    '--name',
    '-n',
    required=True,
    help='Human-readable principal name (must be unique)',
)
@click.option(
    '--owner',
    '-o',
    required=True,
    help='Owner identifier (email or username)',
)
@click.option(
    "--type",
    "principal_type",
    type=click.Choice(["user", "agent", "service"]),
    default="agent",
    help="Type of principal (user, agent, service)",
)
@click.option(
    '--metadata',
    '-m',
    multiple=True,
    help='Metadata key=value pairs (can be specified multiple times)',
)
@click.pass_context
def register(ctx, name: str, principal_type: str, owner: str, metadata: tuple):
    """
    Register a new AI principal with a unique identity.
    
    Creates a new principal with a globally unique ID and stores it in the registry.
    
    Examples:
    
        caracal principal register --name my-principal --owner user@example.com
        
        caracal principal register -n research-bot -o researcher@university.edu \
            -m department=AI -m project=LLM
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
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
        
        # Create principal registry
        registry = get_principal_registry(cli_ctx.config)
        
        # Register principal
        principal = registry.register_principal(
            name=name,
            principal_type=principal_type,
            owner=owner,
            metadata=metadata_dict,
        )
        
        # Display success message
        click.echo("✓ Principal registered successfully!")
        click.echo()
        click.echo(f"Principal ID:    {principal.principal_id}")
        click.echo(f"Name:        {principal.name}")
        click.echo(f"Type:        {getattr(principal, 'principal_type', 'agent')}")
        
        click.echo(f"Owner:       {principal.owner}")
        click.echo(f"Created:     {principal.created_at}")
        
        if principal.metadata:
            # Filter out keys for display (don't show private keys)
            display_metadata = {
                k: v for k, v in principal.metadata.items()
                if k not in ['private_key_pem', 'public_key_pem', 'delegation_tokens']
            }
            if display_metadata:
                click.echo("Metadata:")
                for key, value in display_metadata.items():
                    click.echo(f"  {key}: {value}")
        
    except DuplicatePrincipalNameError as e:
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
    "--type",
    "principal_type",
    type=click.Choice(["user", "agent", "service"]),
    default="agent",
    help="Type of principal (user, agent, service)",
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def list_principals(ctx, format: str):
    """
    List all registered principals.
    
    Displays all principals in the registry with their IDs, names, and owners.
    
    Examples:
    
        caracal principal list
        
        caracal principal list --format json
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Create principal registry
        registry = get_principal_registry(cli_ctx.config)
        
        # Get all principals
        principals = registry.list_principals()
        
        if not principals:
            click.echo("No principals registered.")
            return
        
        if format.lower() == 'json':
            # JSON output
            import json
            output = [principal.to_dict() for principal in principals]
            click.echo(json.dumps(output, indent=2))
        else:
            # Table output
            click.echo(f"Total principals: {len(principals)}")
            click.echo()
            
            # Calculate column widths
            max_id_len = max(len(principal.principal_id) for principal in principals)
            max_name_len = max(len(principal.name) for principal in principals)
            max_owner_len = max(len(principal.owner) for principal in principals)
            max_type_len = max(len(getattr(principal, "principal_type", "agent")) for principal in principals)
            
            # Ensure minimum widths for headers
            id_width = max(max_id_len, len("Principal ID"))
            name_width = max(max_name_len, len("Name"))
            owner_width = max(max_owner_len, len("Owner"))
            type_width = max(max_type_len, len("Type"))
            
            # Print header
            header = f"{'Principal ID':<{id_width}}  {'Type':<{type_width}}  {'Name':<{name_width}}  {'Owner':<{owner_width}}  Created"
            click.echo(header)
            click.echo("-" * len(header))
            
            # Print principals
            for principal in principals:
                # Format created_at to be more readable
                created = principal.created_at.replace('T', ' ').replace('Z', '')
                click.echo(
                    f"{principal.principal_id:<{id_width}}  "
                    f"{getattr(principal, 'principal_type', 'agent'):<{type_width}}  "
                    f"{principal.name:<{name_width}}  "
                    f"{principal.owner:<{owner_width}}  "
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
    '--principal-id',
    '-a',
    required=True,
    help='Principal ID to retrieve',
)
@click.option(
    "--type",
    "principal_type",
    type=click.Choice(["user", "agent", "service"]),
    default="agent",
    help="Type of principal (user, agent, service)",
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def get(ctx, principal_id: str, principal_type: str, format: str):
    """
    Get details for a specific principal.
    
    Retrieves and displays information about an principal by ID.
    
    Examples:
    
        caracal principal get --principal-id 550e8400-e29b-41d4-a716-446655440000
        
        caracal principal get -a 550e8400-e29b-41d4-a716-446655440000 --format json
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        # Create principal registry
        registry = get_principal_registry(cli_ctx.config)
        
        # Get principal
        principal = registry.get_principal(principal_id)
        
        if not principal:
            click.echo(f"Error: Principal not found: {principal_id}", err=True)
            sys.exit(1)
        
        if format.lower() == 'json':
            # JSON output
            import json
            click.echo(json.dumps(principal.to_dict(), indent=2))
        else:
            # Table output
            click.echo("Principal Details")
            click.echo("=" * 50)
            click.echo(f"Principal ID:    {principal.principal_id}")
            click.echo(f"Name:        {principal.name}")
            click.echo(f"Type:        {getattr(principal, 'principal_type', 'agent')}")
        
            click.echo(f"Owner:       {principal.owner}")
            click.echo(f"Created:     {principal.created_at}")
            
            if principal.metadata:
                click.echo()
                click.echo("Metadata:")
                for key, value in principal.metadata.items():
                    click.echo(f"  {key}: {value}")
        
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)
