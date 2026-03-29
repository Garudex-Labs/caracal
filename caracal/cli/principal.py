"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for principal identity management.

Provides commands for registering, listing, and retrieving principal identities.
"""

import json
import sys
from datetime import datetime
from typing import Optional
from uuid import UUID

import click

from caracal.core.principal_keys import generate_and_store_principal_keypair
from caracal.db.connection import get_db_manager
from caracal.db.models import Principal
from caracal.exceptions import (
    CaracalError,
    DuplicatePrincipalNameError,
)


def _format_created(value) -> str:
    """Normalize created timestamps for human-readable output."""
    if isinstance(value, datetime):
        return value.replace(microsecond=0).isoformat(sep=" ")
    if isinstance(value, str):
        return value.replace("T", " ").replace("Z", "")
    return ""


def _principal_to_dict(principal) -> dict:
    """Convert DB or legacy principal object to a consistent dict payload."""
    if hasattr(principal, "to_dict"):
        data = principal.to_dict()
        data.setdefault("principal_type", getattr(principal, "principal_type", "agent"))
        data.setdefault("metadata", getattr(principal, "metadata", {}) or {})
        return data

    return {
        "principal_id": str(principal.principal_id),
        "name": principal.name,
        "principal_type": getattr(principal, "principal_type", "agent"),
        "owner": principal.owner,
        "created_at": principal.created_at,
        "metadata": getattr(principal, "principal_metadata", {}) or {},
    }


def _load_principals_from_db(config, principal_type: str = "all") -> list[dict]:
    """Load principals from PostgreSQL (primary source for Flow + CLI consistency)."""
    db_manager = get_db_manager(config)
    try:
        with db_manager.session_scope() as db_session:
            query = db_session.query(Principal)
            if principal_type != "all":
                query = query.filter_by(principal_type=principal_type)
            rows = query.order_by(Principal.created_at.asc()).all()
            return [_principal_to_dict(row) for row in rows]
    finally:
        db_manager.close()


def _get_principal_from_db(config, principal_id: str) -> Optional[dict]:
    """Get one principal from PostgreSQL by UUID string."""
    db_manager = get_db_manager(config)
    try:
        with db_manager.session_scope() as db_session:
            try:
                parsed_id = UUID(principal_id)
            except ValueError:
                return None
            row = db_session.query(Principal).filter_by(principal_id=parsed_id).first()
            return _principal_to_dict(row) if row else None
    finally:
        db_manager.close()


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
    '--email',
    '-e',
    required=True,
    help='Principal email address',
)
@click.option(
    '--metadata',
    '-m',
    multiple=True,
    help='Metadata key=value pairs (can be specified multiple times)',
)
@click.pass_context
def register(ctx, name: str, principal_type: str, email: str, metadata: tuple):
    """
    Register a new AI principal with a unique identity.
    
    Creates a new principal with a globally unique ID and stores it in the registry.
    
    Examples:
    
        caracal principal register --name my-principal --email user@example.com
        
        caracal principal register -n research-bot -e researcher@university.edu \
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
        
        principal = None
        db_manager = get_db_manager(cli_ctx.config)
        try:
            with db_manager.session_scope() as db_session:
                existing = db_session.query(Principal).filter_by(name=name).first()
                if existing:
                    raise DuplicatePrincipalNameError(f"Principal with name '{name}' already exists")

                principal_row = Principal(
                    name=name,
                    principal_type=principal_type,
                    owner=email,
                    created_at=datetime.utcnow(),
                    principal_metadata=metadata_dict or None,
                )
                db_session.add(principal_row)
                db_session.flush()

                keypair = generate_and_store_principal_keypair(principal_row.principal_id)
                principal_row.public_key_pem = keypair.public_key_pem

                merged_metadata = dict(principal_row.principal_metadata or {})
                merged_metadata.update(keypair.storage.metadata)
                principal_row.principal_metadata = merged_metadata

                principal = {
                    "principal_id": str(principal_row.principal_id),
                    "name": principal_row.name,
                    "principal_type": principal_row.principal_type,
                    "owner": principal_row.owner,
                    "created_at": principal_row.created_at.isoformat(),
                    "metadata": principal_row.principal_metadata or {},
                    "private_key_ref": keypair.storage.reference,
                }
        finally:
            db_manager.close()
        
        # Display success message
        click.echo("✓ Principal registered successfully!")
        click.echo()
        click.echo(f"Principal ID:    {principal['principal_id']}")
        click.echo(f"Name:        {principal['name']}")
        click.echo(f"Type:        {principal.get('principal_type', 'agent')}")

        click.echo(f"Email:       {principal['owner']}")
        click.echo(f"Created:     {_format_created(principal.get('created_at'))}")
        click.echo(f"Private key: {principal.get('private_key_ref', '')}")

        if principal.get('metadata'):
            # Filter out keys for display (don't show private keys)
            display_metadata = {
                k: v for k, v in principal['metadata'].items()
                if k not in [
                    'private_key_pem',
                    'public_key_pem',
                    'delegation_tokens',
                    'aws_kms_ciphertext_b64',
                    'private_key_ref',
                    'key_backend',
                    'aws_kms_key_id',
                    'aws_kms_region',
                    'key_updated_at',
                ]
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
    type=click.Choice(["all", "user", "agent", "service"]),
    default="all",
    help="Filter by principal type (default: all)",
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def list_principals(ctx, principal_type: str, format: str):
    """
    List all registered principals.
    
    Displays all principals in the registry with their IDs, names, and emails.
    
    Examples:
    
        caracal principal list
        
        caracal principal list --format json
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        
        principals = _load_principals_from_db(cli_ctx.config, principal_type=principal_type)
        
        if not principals:
            click.echo("No principals registered.")
            return
        
        if format.lower() == 'json':
            click.echo(json.dumps(principals, indent=2, default=str))
        else:
            # Table output
            click.echo(f"Total principals: {len(principals)}")
            click.echo()
            
            # Calculate column widths
            max_id_len = max(len(str(principal["principal_id"])) for principal in principals)
            max_name_len = max(len(str(principal["name"])) for principal in principals)
            max_email_len = max(len(str(principal["owner"])) for principal in principals)
            max_type_len = max(len(str(principal.get("principal_type", "agent"))) for principal in principals)
            
            # Ensure minimum widths for headers
            id_width = max(max_id_len, len("Principal ID"))
            name_width = max(max_name_len, len("Name"))
            email_width = max(max_email_len, len("Email"))
            type_width = max(max_type_len, len("Type"))
            
            # Print header
            header = f"{'Principal ID':<{id_width}}  {'Type':<{type_width}}  {'Name':<{name_width}}  {'Email':<{email_width}}  Created"
            click.echo(header)
            click.echo("-" * len(header))
            
            # Print principals
            for principal in principals:
                # Format created_at to be more readable
                created = _format_created(principal.get("created_at"))
                click.echo(
                    f"{str(principal['principal_id']):<{id_width}}  "
                    f"{str(principal.get('principal_type', 'agent')):<{type_width}}  "
                    f"{str(principal['name']):<{name_width}}  "
                    f"{str(principal['owner']):<{email_width}}  "
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
        
        principal = _get_principal_from_db(cli_ctx.config, principal_id)
        
        if not principal:
            click.echo(f"Error: Principal not found: {principal_id}", err=True)
            sys.exit(1)
        
        if format.lower() == 'json':
            click.echo(json.dumps(principal, indent=2, default=str))
        else:
            # Table output
            click.echo("Principal Details")
            click.echo("=" * 50)
            click.echo(f"Principal ID:    {principal['principal_id']}")
            click.echo(f"Name:        {principal['name']}")
            click.echo(f"Type:        {principal.get('principal_type', 'agent')}")

            click.echo(f"Email:       {principal['owner']}")
            click.echo(f"Created:     {_format_created(principal.get('created_at'))}")

            if principal.get('metadata'):
                click.echo()
                click.echo("Metadata:")
                for key, value in principal['metadata'].items():
                    click.echo(f"  {key}: {value}")
        
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)
