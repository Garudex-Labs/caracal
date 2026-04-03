"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for delegation token management.

Provides commands for generating and viewing delegation tokens.
"""

import json
import sys
from dataclasses import dataclass
from uuid import UUID

import click

from caracal.core.delegation import DelegationTokenManager
from caracal.core.principal_keys import (
    generate_and_store_principal_keypair,
    principal_has_key_custody,
    resolve_principal_private_key,
)
from caracal.db.connection import get_db_manager
from caracal.db.models import AuthorityPolicy, Principal
from caracal.exceptions import CaracalError, PrincipalNotFoundError


@dataclass
class _PrincipalView:
    """Minimal principal view required by DelegationTokenManager."""

    principal_id: str
    metadata: dict
    public_key: str | None = None


class _DBPrincipalRegistryAdapter:
    """Principal lookup/metadata adapter backed by PostgreSQL."""

    def __init__(self, config):
        self._config = config

    def get_principal(self, principal_id: str):
        try:
            principal_uuid = UUID(principal_id)
        except ValueError:
            return None

        db_manager = get_db_manager(self._config)
        try:
            with db_manager.session_scope() as session:
                row = session.query(Principal).filter_by(principal_id=principal_uuid).first()
                if not row:
                    return None
                return _PrincipalView(
                    principal_id=str(row.principal_id),
                    metadata=row.principal_metadata or {},
                    public_key=row.public_key_pem,
                )
        finally:
            db_manager.close()

    def ensure_signing_keys(self, principal_id: str, delegation_manager: DelegationTokenManager) -> None:
        """Ensure principal has ES256 signing keys stored in custody tables."""
        try:
            principal_uuid = UUID(principal_id)
        except ValueError as exc:
            raise PrincipalNotFoundError(f"Invalid principal ID: {principal_id}") from exc

        db_manager = get_db_manager(self._config)
        try:
            with db_manager.session_scope() as session:
                row = session.query(Principal).filter_by(principal_id=principal_uuid).first()
                if not row:
                    raise PrincipalNotFoundError(f"Principal not found: {principal_id}")

                metadata = dict(row.principal_metadata or {})
                if row.public_key_pem and principal_has_key_custody(row.principal_id, session):
                    return

                generated = generate_and_store_principal_keypair(
                    row.principal_id,
                    db_session=session,
                )
                row.public_key_pem = generated.public_key_pem
                metadata.update(generated.storage.metadata)
                row.principal_metadata = metadata
        finally:
            db_manager.close()

    def resolve_private_key(self, principal_id: str) -> str:
        """Resolve signing key material from custody records."""
        try:
            principal_uuid = UUID(principal_id)
        except ValueError as exc:
            raise PrincipalNotFoundError(f"Invalid principal ID: {principal_id}") from exc

        db_manager = get_db_manager(self._config)
        try:
            with db_manager.session_scope() as session:
                row = session.query(Principal).filter_by(principal_id=principal_uuid).first()
                if not row:
                    raise PrincipalNotFoundError(f"Principal not found: {principal_id}")
                return resolve_principal_private_key(
                    principal_uuid,
                    db_session=session,
                    principal_metadata=row.principal_metadata,
                )
        finally:
            db_manager.close()

    def assert_exists(self, principal_id: str) -> None:
        if self.get_principal(principal_id) is None:
            raise PrincipalNotFoundError(f"Principal not found: {principal_id}")


def _get_delegation_manager(config) -> tuple[_DBPrincipalRegistryAdapter, DelegationTokenManager]:
    registry = _DBPrincipalRegistryAdapter(config)
    return registry, DelegationTokenManager(principal_registry=registry)


def _get_cli_config(ctx_obj):
    """Resolve CLI config from Click context object.

    Supports both object-style contexts with a ``config`` attribute and
    dict-style contexts used in tests (``{"config": ...}``).
    """
    if ctx_obj is None:
        return None
    if isinstance(ctx_obj, dict):
        return ctx_obj.get("config")
    return getattr(ctx_obj, "config", None)


@click.command('generate')
@click.option(
    '--source-id',
    '-p',
    required=True,
    help='Source principal ID (issuer)',
)
@click.option(
    '--target-id',
    '-c',
    required=True,
    help='Target principal ID (subject)',
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
@click.option(
    '--delegation-type',
    default='directed',
    type=click.Choice(['directed', 'peer']),
    help='Type of delegation: directed or peer (default: directed)',
)
@click.option(
    '--source-type',
    default='agent',
    type=click.Choice(['user', 'agent', 'service']),
    help='Type of the source principal (default: agent)',
)
@click.option(
    '--target-type',
    default='agent',
    type=click.Choice(['user', 'agent', 'service']),
    help='Type of the target principal (default: agent)',
)
@click.option(
    '--context-tags',
    '-t',
    multiple=True,
    help='Context tags for the delegation token',
)
@click.option(
    '--source-mandate-id',
    multiple=True,
    help='Canonical source mandate lineage ID (can be specified multiple times)',
)
@click.pass_context
def generate(ctx, source_id: str, target_id: str,
             expiration: int, operations: tuple,
             delegation_type: str, source_type: str, target_type: str, context_tags: tuple,
             source_mandate_id: tuple):
    """
    Generate a delegation token for a target principal.
    
    Creates a JWT token signed by the source principal that authorizes the target
    principal to operate within the specified authority scope.
    
    Examples:
    
        caracal delegation generate \
            --source-id 550e8400-e29b-41d4-a716-446655440000 \
            --target-id 660e8400-e29b-41d4-a716-446655440001 \
            --source-mandate-id 770e8400-e29b-41d4-a716-446655440002
        
        caracal delegation generate -p source-uuid -c target-uuid \
            --expiration 3600 \
            --delegation-type directed --source-type user --target-type agent \
            -o api_call -o mcp_tool
    """
    try:
        # Get CLI context
        config = _get_cli_config(ctx.obj)
        
        # Build PostgreSQL-backed principal adapter + delegation manager
        registry, delegation_manager = _get_delegation_manager(config)
        registry.assert_exists(source_id)
        registry.assert_exists(target_id)
        registry.ensure_signing_keys(source_id, delegation_manager)
        
        # Parse allowed operations
        allowed_operations = list(operations) if operations else None
        
        # Parse context tags
        tags_list = list(context_tags) if context_tags else None

        authority_sources = None
        if source_mandate_id:
            authority_sources = []
            for mandate_id in source_mandate_id:
                try:
                    authority_sources.append(str(UUID(mandate_id)))
                except ValueError:
                    click.echo(f"Error: Invalid source mandate ID format: {mandate_id}", err=True)
                    sys.exit(1)
        
        # Generate token
        token = delegation_manager.generate_token(
            source_principal_id=UUID(source_id),
            target_principal_id=UUID(target_id),
            expiration_seconds=expiration,
            allowed_operations=allowed_operations,
            delegation_type=delegation_type,
            source_principal_type=source_type,
            target_principal_type=target_type,
            context_tags=tags_list,
            authority_sources=authority_sources,
        )
        
        # Display success message
        click.echo("✓ Delegation token generated successfully!")
        click.echo()
        click.echo(f"Source Principal: {source_id}")
        click.echo(f"Target Principal: {target_id}")
        click.echo(f"Delegation Type:  {delegation_type}")
        click.echo(f"Expires In:      {expiration} seconds")
        if authority_sources:
            click.echo(f"Source Mandates: {', '.join(authority_sources)}")
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
    '--principal-id',
    '-p',
    help='Principal ID to list delegations for (shows both delegated to and from)',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def list_delegations(ctx, principal_id: str, format: str):
    """
    List delegation relationships from the delegation graph.
    
    Shows delegation edges between mandates with principal types,
    delegation types, and context tags.
    
    Examples:
    
        caracal delegation list
        
        caracal delegation list --principal-id 550e8400-e29b-41d4-a716-446655440000
        
        caracal delegation list --format json
    """
    try:
        # Get CLI context
        config = _get_cli_config(ctx.obj)

        from caracal.db.models import DelegationEdgeModel
        
        db_manager = get_db_manager(config)
        
        try:
            session = db_manager.get_session()
            
            # Query delegation edges
            query = session.query(DelegationEdgeModel).filter(
                DelegationEdgeModel.revoked == False
            )
            
            if principal_id:
                # Filter edges involving this principal (as source or target principal)
                from caracal.db.models import ExecutionMandate
                # Get mandates for this principal
                mandates = session.query(ExecutionMandate.mandate_id).filter(
                    ExecutionMandate.subject_id == principal_id
                ).all()
                mandate_ids = [m.mandate_id for m in mandates]
                
                if mandate_ids:
                    query = query.filter(
                        (DelegationEdgeModel.source_mandate_id.in_(mandate_ids)) |
                        (DelegationEdgeModel.target_mandate_id.in_(mandate_ids))
                    )
                else:
                    click.echo(f"No mandates found for principal: {principal_id}")
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
        config = _get_cli_config(ctx.obj)
        
        # Create PostgreSQL-backed delegation manager
        _, delegation_manager = _get_delegation_manager(config)
        
        # Validate token
        claims = delegation_manager.validate_token(token)
        
        # Display validation result
        click.echo("✓ Token is valid!")
        click.echo()
        click.echo("Token Claims:")
        click.echo("=" * 50)
        click.echo(f"Source Principal:    {claims.issuer}")
        click.echo(f"Target Principal:    {claims.subject}")
        click.echo(f"Audience:            {claims.audience}")
        click.echo(f"Token ID:            {claims.token_id}")
        click.echo(f"Issued At:           {claims.issued_at}")
        click.echo(f"Expires At:          {claims.expiration}")
        click.echo(f"Allowed Operations:  {', '.join(claims.allowed_operations)}")
        click.echo(f"Delegation Type:     {claims.delegation_type}")
        if getattr(claims, "authority_sources", None):
            click.echo(f"Source Mandates:     {', '.join(claims.authority_sources)}")
        
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
    
    Deactivates the delegation policy for a target principal, effectively revoking
    their designated authority.
    
    Examples:
    
        caracal delegation revoke --policy-id 550e8400-e29b-41d4-a716-446655440000
        
        caracal delegation revoke -p 550e8400-e29b-41d4-a716-446655440000 --confirm
    """
    try:
        # Get CLI context
        config = _get_cli_config(ctx.obj)

        try:
            policy_uuid = UUID(policy_id)
        except ValueError:
            click.echo(f"Error: Invalid policy ID format: {policy_id}", err=True)
            sys.exit(1)
        
        db_manager = get_db_manager(config)
        try:
            with db_manager.session_scope() as session:
                policy = session.query(AuthorityPolicy).filter_by(policy_id=policy_uuid).first()
                if not policy:
                    click.echo(f"Error: Policy not found: {policy_id}", err=True)
                    sys.exit(1)

                if not policy.active:
                    click.echo(f"Error: Policy {policy_id} is already inactive", err=True)
                    sys.exit(1)

                principal = session.query(Principal).filter_by(principal_id=policy.principal_id).first()

                # Confirm revocation
                if not confirm:
                    click.echo("Delegation Policy Details:")
                    click.echo("=" * 50)
                    click.echo(f"Policy ID:     {policy_id}")
                    click.echo(f"Principal:     {principal.name if principal else 'Unknown'} ({policy.principal_id})")
                    click.echo(f"Allow Deleg.:  {'Yes' if policy.allow_delegation else 'No'}")
                    click.echo(f"Status:        {'Active' if policy.active else 'Inactive'}")
                    click.echo()

                    if not click.confirm("Are you sure you want to revoke this delegation policy?"):
                        click.echo("Revocation cancelled.")
                        return

                policy.active = False

                click.echo()
                click.echo("✓ Delegation policy revoked successfully!")
                click.echo()
                click.echo(f"Policy ID:     {policy_id}")
                click.echo(f"Principal:     {principal.name if principal else 'Unknown'}")
                click.echo("Status:        Inactive")
        finally:
            db_manager.close()

    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)
