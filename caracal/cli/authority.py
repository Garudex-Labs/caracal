"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for authority enforcement management.

Provides commands for issuing, validating, revoking, and listing execution mandates.
"""

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
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
from caracal.mcp.tool_registry_contract import resolve_issue_scopes_from_tool_ids

logger = get_logger(__name__)


def _get_cli_config(cli_ctx):
    """Extract the loaded config object from Click context for runtime and tests."""
    if cli_ctx is None:
        raise ValueError("CLI context is missing")

    if hasattr(cli_ctx, "config"):
        return cli_ctx.config

    if isinstance(cli_ctx, dict):
        return cli_ctx.get("config")

    getter = getattr(cli_ctx, "get", None)
    if callable(getter):
        return getter("config")

    raise ValueError("CLI context does not provide a configuration object")


def get_mandate_manager(config):
    """
    Create MandateManager instance from configuration.
    
    Args:
        config: Configuration object
        
    Returns:
        MandateManager instance with database session
    """
    from caracal.db.connection import get_db_manager
    from caracal.core.mandate import MandateManager
    from caracal.core.authority_ledger import AuthorityLedgerWriter
    from caracal.core.delegation_graph import DelegationGraph
    
    db_manager = get_db_manager(config)
    
    # Get session
    session = db_manager.get_session()
    
    # Create ledger writer
    ledger_writer = AuthorityLedgerWriter(session)
    
    # Create delegation graph
    delegation_graph = DelegationGraph(session)
    
    # Create mandate manager
    return MandateManager(session, ledger_writer, delegation_graph=delegation_graph), db_manager


def get_authority_evaluator(config):
    """
    Create AuthorityEvaluator instance from configuration.
    
    Args:
        config: Configuration object
        
    Returns:
        AuthorityEvaluator instance with database session
    """
    from caracal.db.connection import get_db_manager
    from caracal.core.authority import AuthorityEvaluator
    from caracal.core.authority_ledger import AuthorityLedgerWriter
    from caracal.core.delegation_graph import DelegationGraph
    
    db_manager = get_db_manager(config)
    
    # Get session
    session = db_manager.get_session()
    
    # Create ledger writer
    ledger_writer = AuthorityLedgerWriter(session)
    
    # Create delegation graph
    delegation_graph = DelegationGraph(session)
    
    # Create authority evaluator
    return AuthorityEvaluator(session, ledger_writer, delegation_graph=delegation_graph), db_manager


@click.command('issue')
@click.option(
    '--issuer-id',
    '-i',
    required=True,
    help='Issuer principal ID (UUID)',
)
@click.option(
    '--subject-id',
    '-s',
    required=True,
    help='Subject principal ID (UUID)',
)
@click.option(
    '--provider',
    multiple=True,
    shell_complete=provider_name_shell_complete,
    help='Provider name filter for selected tools (repeatable)',
)
@click.option(
    '--tool-id',
    '-t',
    required=True,
    multiple=True,
    help='Registered tool ID to include in the issued mandate (repeatable)',
)
@click.option(
    '--validity-seconds',
    '-v',
    required=True,
    type=int,
    help='Validity period in seconds',
)
@click.option(
    '--delegation-network-distance',
    '--delegation-network_distance',
    'network_distance',
    '-d',
    type=int,
    default=None,
    help='Delegation network distance for this mandate (default: policy maximum)',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def issue(
    ctx,
    issuer_id: str,
    subject_id: str,
    provider: tuple,
    tool_id: tuple,
    validity_seconds: int,
    network_distance: Optional[int],
    format: str,
):
    """
    Issue a new execution mandate.
    
    Creates a cryptographically signed mandate that grants specific execution
    rights to a subject principal for a limited time.
    
    Examples:
    
        # Issue a provider-scoped mandate
        caracal authority mandate \\
            --issuer-id 550e8400-e29b-41d4-a716-446655440000 \\
            --subject-id 660e8400-e29b-41d4-a716-446655440001 \\
            --provider openai-main \\
                        --tool-id provider:openai-main:resource:chat.completions \
            --validity-seconds 3600
        
                # Issue a mandate from multiple registered tools
        caracal authority mandate \\
            -i 550e8400-e29b-41d4-a716-446655440000 \\
            -s 660e8400-e29b-41d4-a716-446655440001 \\
                        -t "provider:openai-main:resource:chat.completions" \
            -v 7200
        
        # JSON output
        caracal authority mandate -i <issuer> -s <subject> \\
                    -t "provider:<provider>:resource:<resource>" -v 3600 --format json
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        config = _get_cli_config(cli_ctx)
        
        # Parse UUIDs
        try:
            issuer_uuid = UUID(issuer_id)
            subject_uuid = UUID(subject_id)
        except ValueError as e:
            click.echo(f"Error: Invalid UUID format: {e}", err=True)
            sys.exit(1)
        
        # Validate validity_seconds
        if validity_seconds <= 0:
            click.echo(f"Error: Validity seconds must be positive, got {validity_seconds}", err=True)
            sys.exit(1)

        if network_distance is not None and network_distance < 0:
            click.echo(f"Error: Delegation network distance cannot be negative, got {network_distance}", err=True)
            sys.exit(1)
        
        workspace = get_workspace_from_ctx(ctx)

        # Convert tuples to lists
        providers = [str(p).strip() for p in provider if str(p).strip()]
        selected_tool_ids = [str(value).strip() for value in tool_id if str(value).strip()]
        if not selected_tool_ids:
            click.echo("Error: At least one --tool-id is required", err=True)
            sys.exit(1)
        
        # Create mandate manager
        mandate_manager, db_manager = get_mandate_manager(config)
        
        try:
            tool_contract = resolve_issue_scopes_from_tool_ids(
                db_session=mandate_manager.db_session,
                tool_ids=selected_tool_ids,
                providers=providers or None,
            )

            resource_scope_list = list(tool_contract["resource_scope"])
            action_scope_list = list(tool_contract["action_scope"])
            providers_for_validation = list(tool_contract["providers"])

            validate_provider_scopes(
                workspace=workspace,
                resource_scopes=resource_scope_list,
                action_scopes=action_scope_list,
                providers=providers_for_validation,
            )

            # Issue mandate
            mandate = mandate_manager.issue_mandate(
                issuer_id=issuer_uuid,
                subject_id=subject_uuid,
                resource_scope=resource_scope_list,
                action_scope=action_scope_list,
                validity_seconds=validity_seconds,
                network_distance=network_distance,
            )
            
            # Commit transaction
            mandate_manager.db_session.commit()
            
            if format.lower() == 'json':
                # JSON output
                output = {
                    'mandate_id': str(mandate.mandate_id),
                    'issuer_id': str(mandate.issuer_id),
                    'subject_id': str(mandate.subject_id),
                    'valid_from': mandate.valid_from.isoformat(),
                    'valid_until': mandate.valid_until.isoformat(),
                    'resource_scope': mandate.resource_scope,
                    'action_scope': mandate.action_scope,
                    'signature': mandate.signature,
                    'created_at': mandate.created_at.isoformat(),
                    'revoked': mandate.revoked,
                    'delegation_type': mandate.delegation_type,
                    'network_distance': mandate.network_distance,
                }
                click.echo(json.dumps(output, indent=2))
            else:
                # Table output
                click.echo("✓ Mandate issued successfully!")
                click.echo()
                click.echo(f"Mandate ID:       {mandate.mandate_id}")
                click.echo(f"Issuer ID:        {mandate.issuer_id}")
                click.echo(f"Subject ID:       {mandate.subject_id}")
                click.echo(f"Valid From:       {mandate.valid_from}")
                click.echo(f"Valid Until:      {mandate.valid_until}")
                click.echo(f"Tool IDs:         {', '.join(tool_contract['tool_ids'])}")
                click.echo(f"Resource Scope:   {', '.join(mandate.resource_scope)}")
                click.echo(f"Action Scope:     {', '.join(mandate.action_scope)}")
                click.echo(f"Delegation Type:  {mandate.delegation_type}")
                click.echo(f"Delegation Network Distance: {mandate.network_distance}")
                click.echo(f"Created:          {mandate.created_at}")
        
        finally:
            # Close database connection
            db_manager.close()
    
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        logger.error(f"Failed to issue mandate: {e}", exc_info=True)
        sys.exit(1)


@click.command('validate')
@click.option(
    '--mandate-id',
    '-m',
    required=True,
    help='Mandate ID to validate (UUID)',
)
@click.option(
    '--provider',
    shell_complete=provider_name_shell_complete,
    help='Provider name used for scope autocompletion/filtering',
)
@click.option(
    '--action',
    '-a',
    required=True,
    shell_complete=action_scope_shell_complete,
    help='Requested provider action scope',
)
@click.option(
    '--resource',
    '-r',
    required=True,
    shell_complete=resource_scope_shell_complete,
    help='Requested provider resource scope',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def validate(
    ctx,
    mandate_id: str,
    provider: Optional[str],
    action: str,
    resource: str,
    format: str,
):
    """
    Validate an execution mandate for a specific action.
    
    Checks if the mandate is valid and authorizes the requested action
    on the requested resource.
    
    Examples:
    
        # Validate a mandate
        caracal authority enforce \\
            --mandate-id 550e8400-e29b-41d4-a716-446655440000 \\
            --provider openai-main \\
            --action "provider:openai-main:action:invoke" \\
            --resource "provider:openai-main:resource:chat.completions"
        
        # Short form
        caracal authority enforce -m <mandate-id> \\
          -a "provider:<provider>:action:<action>" \\
          -r "provider:<provider>:resource:<resource>"
        
        # JSON output
        caracal authority enforce -m <mandate-id> \\
          -a "provider:<provider>:action:<action>" \\
          -r "provider:<provider>:resource:<resource>" --format json
    
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        config = _get_cli_config(cli_ctx)
        
        # Parse UUID
        try:
            mandate_uuid = UUID(mandate_id)
        except ValueError as e:
            click.echo(f"Error: Invalid mandate ID format: {e}", err=True)
            sys.exit(1)

        workspace = get_workspace_from_ctx(ctx)
        validate_provider_scopes(
            workspace=workspace,
            resource_scopes=[resource],
            action_scopes=[action],
            providers=[provider] if provider else None,
        )
        
        # Create authority evaluator
        evaluator, db_manager = get_authority_evaluator(config)
        
        try:
            # Get mandate from database
            from caracal.db.models import ExecutionMandate
            mandate = db_manager.get_session().query(ExecutionMandate).filter(
                ExecutionMandate.mandate_id == mandate_uuid
            ).first()
            
            if not mandate:
                click.echo(f"Error: Mandate not found: {mandate_id}", err=True)
                sys.exit(1)
            
            # Validate mandate
            decision = evaluator.validate_mandate(
                mandate=mandate,
                requested_action=action,
                requested_resource=resource
            )
            decision_label = 'allowed' if decision.allowed else 'denied'
            
            # Commit transaction (to record ledger event)
            evaluator.db_session.commit()
            
            if format.lower() == 'json':
                # JSON output
                output = {
                    'mandate_id': str(mandate.mandate_id),
                    'decision': decision_label,
                    'allowed': decision.allowed,
                    'reason': decision.reason,
                    'requested_action': action,
                    'requested_resource': resource,
                    'timestamp': datetime.utcnow().isoformat()
                }
                click.echo(json.dumps(output, indent=2))
            else:
                # Table output
                if decision.allowed:
                    click.echo("✓ Mandate validation: ALLOWED")
                else:
                    click.echo("✗ Mandate validation: DENIED")
                
                click.echo()
                click.echo(f"Mandate ID:  {mandate.mandate_id}")
                click.echo(f"Decision:    {decision_label.upper()}")
                click.echo(f"Action:      {action}")
                click.echo(f"Resource:    {resource}")
                
                if decision.reason:
                    click.echo(f"Reason:      {decision.reason}")
        
        finally:
            # Close database connection
            db_manager.close()
    
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        logger.error(f"Failed to validate mandate: {e}", exc_info=True)
        sys.exit(1)


@click.command('revoke')
@click.option(
    '--mandate-id',
    '-m',
    required=True,
    help='Mandate ID to revoke (UUID)',
)
@click.option(
    '--revoker-id',
    '-r',
    required=True,
    help='Revoker principal ID (UUID)',
)
@click.option(
    '--reason',
    '-e',
    required=True,
    help='Revocation reason',
)
@click.option(
    '--cascade',
    '-c',
    is_flag=True,
    help='Revoke all downstream delegated mandates recursively',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def revoke(
    ctx,
    mandate_id: str,
    revoker_id: str,
    reason: str,
    cascade: bool,
    format: str,
):
    """
    Revoke an execution mandate.
    
    Marks the mandate as revoked, preventing further use. Optionally
    revokes all downstream delegated mandates in the delegation graph.
    
    Examples:
    
        # Revoke a mandate
        caracal authority revoke \\
            --mandate-id 550e8400-e29b-41d4-a716-446655440000 \\
            --revoker-id 660e8400-e29b-41d4-a716-446655440001 \\
            --reason "Security incident"
        
        # Revoke with cascade
        caracal authority revoke \\
            -m 550e8400-e29b-41d4-a716-446655440000 \\
            -r 660e8400-e29b-41d4-a716-446655440001 \\
            -e "Policy violation" \\
            --cascade
        
        # JSON output
        caracal authority revoke -m <mandate-id> -r <revoker-id> -e "Reason" --format json
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        config = _get_cli_config(cli_ctx)
        
        # Parse UUIDs
        try:
            mandate_uuid = UUID(mandate_id)
            revoker_uuid = UUID(revoker_id)
        except ValueError as e:
            click.echo(f"Error: Invalid UUID format: {e}", err=True)
            sys.exit(1)
        
        # Create mandate manager
        mandate_manager, db_manager = get_mandate_manager(config)
        
        try:
            # Revoke mandate
            mandate_manager.revoke_mandate(
                mandate_id=mandate_uuid,
                revoker_id=revoker_uuid,
                reason=reason,
                cascade=cascade
            )
            
            # Commit transaction
            mandate_manager.db_session.commit()
            
            if format.lower() == 'json':
                # JSON output
                output = {
                    'mandate_id': str(mandate_uuid),
                    'revoked': True,
                    'reason': reason,
                    'cascade': cascade,
                    'timestamp': datetime.utcnow().isoformat()
                }
                click.echo(json.dumps(output, indent=2))
            else:
                # Table output
                click.echo("✓ Mandate revoked successfully!")
                click.echo()
                click.echo(f"Mandate ID:  {mandate_uuid}")
                click.echo(f"Reason:      {reason}")
                click.echo(f"Cascade:     {'Yes' if cascade else 'No'}")
                
                if cascade:
                    click.echo()
                    click.echo("Note: All delegation edges from this mandate have been revoked.")
        
        finally:
            # Close database connection
            db_manager.close()
    
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        logger.error(f"Failed to revoke mandate: {e}", exc_info=True)
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
    help='Show only active (non-revoked, non-expired) mandates',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def list_mandates(
    ctx,
    principal_id: Optional[str],
    active_only: bool,
    format: str,
):
    """
    List execution mandates.
    
    Lists all mandates in the system, or filters by principal ID if specified.
    
    Examples:
    
        # List all mandates
        caracal authority list
        
        # List mandates for a specific principal
        caracal authority list --principal-id 550e8400-e29b-41d4-a716-446655440000
        
        # List only active mandates
        caracal authority list --active-only
        
        # JSON output
        caracal authority list --format json
    
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        config = _get_cli_config(cli_ctx)
        
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
        from caracal.db.models import ExecutionMandate
        
        db_manager = get_db_manager(config)
        
        try:
            # Query mandates
            query = db_manager.get_session().query(ExecutionMandate)
            
            if principal_uuid:
                query = query.filter(
                    (ExecutionMandate.issuer_id == principal_uuid) |
                    (ExecutionMandate.subject_id == principal_uuid)
                )
            
            if active_only:
                current_time = datetime.utcnow()
                query = query.filter(
                    ExecutionMandate.revoked == False,
                    ExecutionMandate.valid_until > current_time
                )
            
            mandates = query.all()
            
            if not mandates:
                if principal_uuid:
                    click.echo(f"No mandates found for principal: {principal_id}")
                else:
                    click.echo("No mandates found.")
                return
            
            if format.lower() == 'json':
                # JSON output
                output = [
                    {
                        'mandate_id': str(m.mandate_id),
                        'issuer_id': str(m.issuer_id),
                        'subject_id': str(m.subject_id),
                        'valid_from': m.valid_from.isoformat(),
                        'valid_until': m.valid_until.isoformat(),
                        'resource_scope': m.resource_scope,
                        'action_scope': m.action_scope,
                        'revoked': m.revoked,
                        'delegation_type': m.delegation_type,
                        'network_distance': m.network_distance,
                        'created_at': m.created_at.isoformat()
                    }
                    for m in mandates
                ]
                click.echo(json.dumps(output, indent=2))
            else:
                # Table output
                click.echo(f"Total mandates: {len(mandates)}")
                click.echo()
                
                # Print header
                click.echo(f"{'Mandate ID':<38}  {'Subject ID':<38}  {'Valid Until':<20}  {'Status':<10}  Type  Network Distance")
                click.echo("-" * 140)
                
                # Print mandates
                for m in mandates:
                    # Determine status
                    if m.revoked:
                        status = "Revoked"
                    elif m.valid_until < datetime.utcnow():
                        status = "Expired"
                    else:
                        status = "Active"
                    
                    # Format valid_until
                    valid_until_str = m.valid_until.strftime("%Y-%m-%d %H:%M:%S")
                    
                    click.echo(
                        f"{str(m.mandate_id):<38}  "
                        f"{str(m.subject_id):<38}  "
                        f"{valid_until_str:<20}  "
                        f"{status:<10}  "
                        f"{m.delegation_type:<4}  "
                        f"{(m.network_distance if m.network_distance is not None else 0)}"
                    )
        
        finally:
            # Close database connection
            db_manager.close()
    
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        logger.error(f"Failed to list mandates: {e}", exc_info=True)
        sys.exit(1)



@click.command('delegate')
@click.option(
    '--source-mandate-id',
    '-p',
    required=True,
    help='Source mandate ID to delegate from (UUID)',
)
@click.option(
    '--target-subject-id',
    '-s',
    required=True,
    help='Target subject principal ID (UUID)',
)
@click.option(
    '--provider',
    multiple=True,
    shell_complete=provider_name_shell_complete,
    help='Provider name used for scope autocompletion and filtering (repeatable)',
)
@click.option(
    '--resource-scope',
    '-r',
    required=True,
    multiple=True,
    shell_complete=resource_scope_shell_complete,
    help='Provider resource scopes (must be subset of source)',
)
@click.option(
    '--action-scope',
    '-a',
    required=True,
    multiple=True,
    shell_complete=action_scope_shell_complete,
    help='Provider action scopes (must be subset of source)',
)
@click.option(
    '--validity-seconds',
    '-v',
    required=True,
    type=int,
    help='Validity period in seconds (must be within source validity)',
)
@click.option(
    '--context-tags',
    '-t',
    multiple=True,
    help='Context tags for delegation edge (can be specified multiple times)',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def delegate(
    ctx,
    source_mandate_id: str,
    target_subject_id: str,
    provider: tuple,
    resource_scope: tuple,
    action_scope: tuple,
    validity_seconds: int,
    context_tags: tuple,
    format: str,
):
    """
    Delegate authority from a source mandate to a target principal.
    
    Creates a new mandate derived from a source mandate with constrained
    scope and validity, then creates a delegation edge in the graph.
    
    Respects delegation direction rules:
      ✅ human → orchestrator/worker/service, orchestrator → worker/service, peer delegation (human↔human, worker↔worker)
      ❌ service → any, worker → human
    
    Examples:
    
        # Delegate from human mandate to worker
        caracal authority delegate \\
            --source-mandate-id <source-id> \\
            --target-subject-id <worker-id> \\
            --provider openai-main \\
            --resource-scope "provider:openai-main:resource:chat.completions" \\
            --action-scope "provider:openai-main:action:invoke" \\
            --validity-seconds 1800
        
        # Delegate with context tags
        caracal authority delegate \\
            -p <source-id> -s <target-id> \\
            -r "provider:<provider>:resource:<resource>" \\
            -a "provider:<provider>:action:<action>" -v 3600 \\
            -t "production" -t "read-only"
    
    """
    try:
        # Get CLI context
        cli_ctx = ctx.obj
        config = _get_cli_config(cli_ctx)
        
        # Parse UUIDs
        try:
            source_uuid = UUID(source_mandate_id)
            target_uuid = UUID(target_subject_id)
        except ValueError as e:
            click.echo(f"Error: Invalid UUID format: {e}", err=True)
            sys.exit(1)
        
        # Validate validity_seconds
        if validity_seconds <= 0:
            click.echo(f"Error: Validity seconds must be positive, got {validity_seconds}", err=True)
            sys.exit(1)
        
        workspace = get_workspace_from_ctx(ctx)

        # Convert tuples to lists
        providers = [str(p) for p in provider]
        resource_scope_list = list(resource_scope)
        action_scope_list = list(action_scope)
        context_tags_list = list(context_tags) if context_tags else None

        validate_provider_scopes(
            workspace=workspace,
            resource_scopes=resource_scope_list,
            action_scopes=action_scope_list,
            providers=providers or None,
        )
        
        # Create mandate manager
        mandate_manager, db_manager = get_mandate_manager(config)
        
        try:
            # Delegate mandate
            target_mandate = mandate_manager.delegate_mandate(
                source_mandate_id=source_uuid,
                target_subject_id=target_uuid,
                resource_scope=resource_scope_list,
                action_scope=action_scope_list,
                validity_seconds=validity_seconds,
                context_tags=context_tags_list,
            )
            
            # Commit transaction
            mandate_manager.db_session.commit()
            
            if format.lower() == 'json':
                # JSON output
                output = {
                    'mandate_id': str(target_mandate.mandate_id),
                    'source_mandate_id': source_mandate_id,
                    'issuer_id': str(target_mandate.issuer_id),
                    'subject_id': str(target_mandate.subject_id),
                    'valid_from': target_mandate.valid_from.isoformat(),
                    'valid_until': target_mandate.valid_until.isoformat(),
                    'resource_scope': target_mandate.resource_scope,
                    'action_scope': target_mandate.action_scope,
                    'delegation_type': target_mandate.delegation_type,
                    'network_distance': target_mandate.network_distance,
                    'context_tags': target_mandate.context_tags,
                    'created_at': target_mandate.created_at.isoformat()
                }
                click.echo(json.dumps(output, indent=2))
            else:
                # Table output
                click.echo("✓ Mandate delegated successfully!")
                click.echo()
                click.echo(f"Delegated Mandate ID:  {target_mandate.mandate_id}")
                click.echo(f"Source Mandate ID:     {source_mandate_id}")
                click.echo(f"Subject ID:            {target_mandate.subject_id}")
                click.echo(f"Valid From:            {target_mandate.valid_from}")
                click.echo(f"Valid Until:           {target_mandate.valid_until}")
                click.echo(f"Resource Scope:        {', '.join(target_mandate.resource_scope)}")
                click.echo(f"Action Scope:          {', '.join(target_mandate.action_scope)}")
                click.echo(f"Delegation Type:       {target_mandate.delegation_type}")
                click.echo(f"Delegation Network Distance:      {target_mandate.network_distance}")
                if target_mandate.context_tags:
                    click.echo(f"Context Tags:          {', '.join(target_mandate.context_tags)}")
        
        finally:
            # Close database connection
            db_manager.close()
    
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        logger.error(f"Failed to delegate mandate: {e}", exc_info=True)
        sys.exit(1)


@click.command('graph')
@click.option(
    '--root-mandate-id',
    '-m',
    default=None,
    help='Root mandate ID to show subgraph from (optional, shows full graph if not specified)',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def graph(ctx, root_mandate_id: Optional[str], format: str):
    """
    Show the delegation graph topology.
    
    Displays all delegation edges between mandates with principal types
    and delegation types (directed/peer).
    
    Examples:
    
        # Show full delegation graph
        caracal authority graph
        
        # Show subgraph from a specific mandate
        caracal authority graph --root-mandate-id <mandate-id>
        
        # JSON output
        caracal authority graph --format json
    """
    try:
        cli_ctx = ctx.obj
        config = _get_cli_config(cli_ctx)
        
        # Parse root mandate ID if provided
        root_uuid = None
        if root_mandate_id:
            try:
                root_uuid = UUID(root_mandate_id)
            except ValueError as e:
                click.echo(f"Error: Invalid mandate ID format: {e}", err=True)
                sys.exit(1)
        
        from caracal.db.connection import get_db_manager
        from caracal.core.delegation_graph import DelegationGraph
        
        db_manager = get_db_manager(config)
        
        try:
            session = db_manager.get_session()
            graph = DelegationGraph(session)
            topology = graph.get_topology(root_mandate_id=root_uuid)
            details = graph.get_path_details(root_uuid) if root_uuid else None
            
            if format.lower() == 'json':
                output = {
                    'nodes': topology.nodes,
                    'edges': topology.edges,
                    'stats': topology.stats,
                }
                if details:
                    output['graph_details'] = details
                click.echo(json.dumps(output, indent=2))
            else:
                # Table output
                type_icons = {
                    'human': '👤',
                    'orchestrator': '🏛️',
                    'worker': '🤖',
                    'service': '⚙️',
                }
                click.echo(f"Delegation Graph ({topology.stats['total_nodes']} nodes, {topology.stats['total_edges']} edges)")
                click.echo()
                
                if topology.edges:
                    click.echo(f"{'Edge ID':<38}  {'Source':<18}  {'Target':<18}  {'Type':<14}  Tags")
                    click.echo("-" * 110)
                    
                    for edge in topology.edges:
                        src_icon = type_icons.get(edge['source_principal_type'], '?')
                        tgt_icon = type_icons.get(edge['target_principal_type'], '?')
                        tags = ', '.join(edge.get('context_tags', []))
                        click.echo(
                            f"{edge['edge_id']:<38}  "
                            f"{src_icon} {edge['source_principal_type']:<14}  "
                            f"{tgt_icon} {edge['target_principal_type']:<14}  "
                            f"{edge['delegation_type']:<14}  "
                            f"{tags}"
                        )
                else:
                    click.echo("No delegation edges found.")
                
                click.echo()
                click.echo("Stats:")
                for ptype, count in topology.stats.get('nodes_by_type', {}).items():
                    icon = type_icons.get(ptype, '?')
                    click.echo(f"  {icon} {ptype}: {count} nodes")

                if details:
                    stats = details.get('stats', {})
                    click.echo()
                    click.echo(
                        "Graph Details: "
                        f"max_network_distance={stats.get('max_network_distance', 0)}, "
                        f"branches={stats.get('branch_nodes', 0)}, "
                        f"leaves={stats.get('leaf_nodes', 0)}, "
                        f"valid={'yes' if stats.get('is_valid') else 'no'}"
                    )

                    rows = details.get('path', [])
                    if rows:
                        click.echo()
                        click.echo(
                            f"{'Network Distance':<5}  {'Mandate ID':<38}  {'Type':<8}  {'targetren':<8}  {'Paths':<5}  {'DelNetwork Distance':<8}  {'Status'}"
                        )
                        click.echo("-" * 110)

                        for row in rows:
                            status = "active"
                            if not row.get('active'):
                                status = "revoked"
                            elif row.get('expired'):
                                status = "expired"

                            click.echo(
                                f"{row.get('network_distance', 0):<5}  "
                                f"{row.get('mandate_id', ''):<38}  "
                                f"{row.get('principal_kind', 'unknown'):<8}  "
                                f"{row.get('target_count', 0):<8}  "
                                f"{row.get('path_count', 0):<5}  "
                                f"{row.get('network_distance', 0):<8}  "
                                f"{status}"
                            )
        
        finally:
            db_manager.close()
    
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        logger.error(f"Failed to show delegation graph: {e}", exc_info=True)
        sys.exit(1)


@click.command('attach-source')
@click.option(
    '--source-mandate-id',
    '-s',
    required=True,
    help='Additional source mandate ID (UUID)',
)
@click.option(
    '--target-mandate-id',
    '-t',
    required=True,
    help='Existing target mandate ID (UUID)',
)
@click.option(
    '--context-tags',
    multiple=True,
    help='Context tags for the graph edge',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def attach_source(
    ctx,
    source_mandate_id: str,
    target_mandate_id: str,
    context_tags: tuple,
    format: str,
):
    """Attach an additional authority source to an existing mandate."""
    try:
        cli_ctx = ctx.obj
        config = _get_cli_config(cli_ctx)
        source_uuid = UUID(source_mandate_id)
        target_uuid = UUID(target_mandate_id)
        context_tags_list = list(context_tags) if context_tags else None

        mandate_manager, db_manager = get_mandate_manager(config)
        try:
            target_mandate = mandate_manager.attach_delegation_source(
                source_mandate_id=source_uuid,
                target_mandate_id=target_uuid,
                context_tags=context_tags_list,
            )
            mandate_manager.db_session.commit()

            payload = {
                'mandate_id': str(target_mandate.mandate_id),
                'source_mandate_id': source_mandate_id,
                'resource_scope': target_mandate.resource_scope,
                'action_scope': target_mandate.action_scope,
                'valid_until': target_mandate.valid_until.isoformat(),
            }
            if format.lower() == 'json':
                click.echo(json.dumps(payload, indent=2))
            else:
                click.echo("✓ Authority source attached successfully!")
                click.echo()
                click.echo(f"Target Mandate ID:     {target_mandate.mandate_id}")
                click.echo(f"Additional Source ID:  {source_mandate_id}")
                if target_mandate.context_tags:
                    click.echo(f"Target Context Tags:   {', '.join(target_mandate.context_tags)}")
        finally:
            db_manager.close()

    except ValueError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        logger.error(f"Failed to attach authority source: {e}", exc_info=True)
        sys.exit(1)


@click.command('peer-delegate')
@click.option(
    '--source-mandate-id',
    '-p',
    required=True,
    help='Source mandate ID (UUID)',
)
@click.option(
    '--target-subject-id',
    '-s',
    required=True,
    help='Peer target principal ID (UUID)',
)
@click.option(
    '--provider',
    multiple=True,
    shell_complete=provider_name_shell_complete,
    help='Provider name used for scope autocompletion and filtering (repeatable)',
)
@click.option(
    '--resource-scope',
    '-r',
    required=True,
    multiple=True,
    shell_complete=resource_scope_shell_complete,
    help='Resource scope patterns (must be subset of source)',
)
@click.option(
    '--action-scope',
    '-a',
    required=True,
    multiple=True,
    shell_complete=action_scope_shell_complete,
    help='Action scope (must be subset of source)',
)
@click.option(
    '--validity-seconds',
    '-v',
    required=True,
    type=int,
    help='Validity period in seconds',
)
@click.option(
    '--context-tags',
    '-t',
    multiple=True,
    help='Context tags for delegation edge',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def peer_delegate_cmd(
    ctx,
    source_mandate_id: str,
    target_subject_id: str,
    provider: tuple,
    resource_scope: tuple,
    action_scope: tuple,
    validity_seconds: int,
    context_tags: tuple,
    format: str,
):
    """
    Create a peer delegation between same-type principals.
    
    Peer delegation allows authority sharing between principals of
    the same type (human↔human, worker↔worker).
    
    Examples:
    
        # Peer delegate between two workers
        caracal authority peer-delegate \\
            --source-mandate-id <source-id> \\
            --target-subject-id <target-id> \\
            --provider model-provider \\
            --resource-scope "provider:model-provider:resource:inference" \\
            --action-scope "provider:model-provider:action:invoke" \\
            --validity-seconds 3600
    """
    try:
        cli_ctx = ctx.obj
        config = _get_cli_config(cli_ctx)
        
        try:
            source_uuid = UUID(source_mandate_id)
            target_uuid = UUID(target_subject_id)
        except ValueError as e:
            click.echo(f"Error: Invalid UUID format: {e}", err=True)
            sys.exit(1)
        
        if validity_seconds <= 0:
            click.echo(f"Error: Validity seconds must be positive", err=True)
            sys.exit(1)
        
        workspace = get_workspace_from_ctx(ctx)
        providers = [str(p) for p in provider]
        resource_scope_list = list(resource_scope)
        action_scope_list = list(action_scope)
        context_tags_list = list(context_tags) if context_tags else None
        validate_provider_scopes(
            workspace=workspace,
            resource_scopes=resource_scope_list,
            action_scopes=action_scope_list,
            providers=providers or None,
        )
        
        mandate_manager, db_manager = get_mandate_manager(config)
        
        try:
            peer_mandate = mandate_manager.peer_delegate(
                source_mandate_id=source_uuid,
                target_subject_id=target_uuid,
                resource_scope=resource_scope_list,
                action_scope=action_scope_list,
                validity_seconds=validity_seconds,
                context_tags=context_tags_list,
            )
            
            mandate_manager.db_session.commit()
            
            if format.lower() == 'json':
                output = {
                    'mandate_id': str(peer_mandate.mandate_id),
                    'source_mandate_id': source_mandate_id,
                    'subject_id': str(peer_mandate.subject_id),
                    'delegation_type': peer_mandate.delegation_type,
                    'context_tags': peer_mandate.context_tags,
                    'created_at': peer_mandate.created_at.isoformat()
                }
                click.echo(json.dumps(output, indent=2))
            else:
                click.echo("✓ Peer delegation created successfully!")
                click.echo()
                click.echo(f"Peer Mandate ID:   {peer_mandate.mandate_id}")
                click.echo(f"Source Mandate:    {source_mandate_id}")
                click.echo(f"Target Subject:    {peer_mandate.subject_id}")
                click.echo(f"Delegation Type:   {peer_mandate.delegation_type}")
                if peer_mandate.context_tags:
                    click.echo(f"Context Tags:      {', '.join(peer_mandate.context_tags)}")
        
        finally:
            db_manager.close()
    
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        logger.error(f"Failed to create peer delegation: {e}", exc_info=True)
        sys.exit(1)
