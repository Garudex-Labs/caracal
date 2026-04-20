"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for resource allowlist management.
"""

import sys
from uuid import UUID

import click

from caracal.core.allowlist import AllowlistManager
from caracal.db.connection import get_db_manager
from caracal.exceptions import CaracalError, ValidationError


def get_allowlist_manager(config) -> AllowlistManager:
    db_manager = get_db_manager(config)
    db_session = db_manager.get_session()
    cache_ttl = getattr(config, 'allowlist_cache_ttl', 60)
    return AllowlistManager(db_session, cache_ttl_seconds=cache_ttl)


@click.command('create')
@click.option(
    '--principal-id',
    '-p',
    required=True,
    help='Principal ID (UUID)',
)
@click.option(
    '--pattern',
    required=True,
    help='Resource pattern (regex or glob)',
)
@click.option(
    '--type',
    '-t',
    'pattern_type',
    type=click.Choice(['regex', 'glob'], case_sensitive=False),
    required=True,
    help='Pattern type (regex or glob)',
)
@click.pass_context
def create(ctx, principal_id: str, pattern: str, pattern_type: str):
    """
    Create a new resource allowlist entry.

    Adds a pattern to the principal's allowlist.  Once a principal has any
    allowlist entries, only resources matching at least one pattern are allowed.

    \b
    Pattern Types:
        regex  Python regular expression
        glob   Shell-style glob pattern

    \b
    Examples:
        caracal allowlist create -p <UUID> --pattern "^https://api\\.openai\\.com/.*$" -t regex
        caracal allowlist create -p <UUID> --pattern "https://api.anthropic.com/*" -t glob
    """
    try:
        config = ctx.obj['config']
        allowlist_manager = get_allowlist_manager(config)

        try:
            parsed_id = UUID(principal_id)
        except ValueError:
            click.echo(f"Error: Invalid principal ID format: {principal_id}", err=True)
            sys.exit(1)

        allowlist = allowlist_manager.create_allowlist(
            principal_id=parsed_id,
            resource_pattern=pattern,
            pattern_type=pattern_type.lower()
        )

        click.echo(f"✓ Created allowlist entry:")
        click.echo(f"  Allowlist ID:  {allowlist.allowlist_id}")
        click.echo(f"  Principal ID:  {allowlist.principal_id}")
        click.echo(f"  Pattern:       {allowlist.resource_pattern}")
        click.echo(f"  Type:          {allowlist.pattern_type}")
        click.echo(f"  Created:       {allowlist.created_at}")

    except ValidationError as e:
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
    '--principal-id',
    '-p',
    required=True,
    help='Principal ID (UUID)',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def list_allowlists(ctx, principal_id: str, format: str):
    """
    List all active allowlist entries for a principal.

    \b
    Examples:
        caracal allowlist list -p <UUID>
        caracal allowlist list -p <UUID> -f json
    """
    try:
        config = ctx.obj['config']
        allowlist_manager = get_allowlist_manager(config)

        try:
            parsed_id = UUID(principal_id)
        except ValueError:
            click.echo(f"Error: Invalid principal ID format: {principal_id}", err=True)
            sys.exit(1)

        allowlists = allowlist_manager.list_allowlists(parsed_id)

        if not allowlists:
            click.echo(f"No allowlists configured for principal {principal_id}")
            click.echo("(All resources are allowed by default)")
            return

        if format == 'json':
            import json
            data = [
                {
                    'allowlist_id': str(a.allowlist_id),
                    'principal_id': str(a.principal_id),
                    'pattern': a.resource_pattern,
                    'type': a.pattern_type,
                    'created_at': a.created_at.isoformat(),
                    'active': a.active
                }
                for a in allowlists
            ]
            click.echo(json.dumps(data, indent=2))
        else:
            click.echo(f"\nAllowlists for principal {principal_id}:")
            click.echo(f"{'ID':<38} {'Type':<8} {'Pattern':<60}")
            click.echo("-" * 110)

            for allowlist in allowlists:
                pattern_display = allowlist.resource_pattern
                if len(pattern_display) > 57:
                    pattern_display = pattern_display[:54] + "..."

                click.echo(
                    f"{str(allowlist.allowlist_id):<38} "
                    f"{allowlist.pattern_type:<8} "
                    f"{pattern_display:<60}"
                )

            click.echo(f"\nTotal: {len(allowlists)} allowlist(s)")

    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)


@click.command('delete')
@click.option(
    '--allowlist-id',
    '-i',
    required=True,
    help='Allowlist ID (UUID) to delete',
)
@click.option(
    '--yes',
    '-y',
    is_flag=True,
    help='Skip confirmation prompt',
)
@click.pass_context
def delete(ctx, allowlist_id: str, yes: bool):
    """
    Delete (deactivate) an allowlist entry.

    Soft-deletes the allowlist entry by marking it as inactive.  The entry
    remains in the database for audit purposes but is no longer enforced.

    \b
    Examples:
        caracal allowlist delete -i <UUID>
        caracal allowlist delete -i <UUID> -y
    """
    try:
        config = ctx.obj['config']
        allowlist_manager = get_allowlist_manager(config)

        try:
            allowlist_uuid = UUID(allowlist_id)
        except ValueError:
            click.echo(f"Error: Invalid allowlist ID format: {allowlist_id}", err=True)
            sys.exit(1)

        if not yes:
            if not click.confirm(f"Delete allowlist {allowlist_id}?"):
                click.echo("Cancelled.")
                return

        allowlist_manager.deactivate_allowlist(allowlist_uuid)

        click.echo(f"✓ Deleted allowlist {allowlist_id}")

    except ValueError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)


@click.command('test')
@click.option(
    '--principal-id',
    '-p',
    required=True,
    help='Principal ID (UUID)',
)
@click.option(
    '--resource',
    '-r',
    required=True,
    help='Resource URL to test',
)
@click.pass_context
def test(ctx, principal_id: str, resource: str):
    """
    Test if a resource would be allowed for a principal.

    Checks the principal's allowlist patterns against the specified resource URL
    and reports whether the resource would be allowed or denied.

    \b
    Examples:
        caracal allowlist test -p <UUID> -r "https://api.openai.com/v1/chat/completions"
    """
    try:
        config = ctx.obj['config']
        allowlist_manager = get_allowlist_manager(config)

        try:
            parsed_id = UUID(principal_id)
        except ValueError:
            click.echo(f"Error: Invalid principal ID format: {principal_id}", err=True)
            sys.exit(1)

        decision = allowlist_manager.check_resource(parsed_id, resource)

        click.echo(f"\nAllowlist check for principal {principal_id}:")
        click.echo(f"  Resource: {resource}")
        click.echo(f"  Result:   {'✓ ALLOWED' if decision.allowed else '✗ DENIED'}")
        click.echo(f"  Reason:   {decision.reason}")

        if decision.matched_pattern:
            click.echo(f"  Pattern:  {decision.matched_pattern}")

        cache_stats = allowlist_manager.get_cache_stats()
        click.echo(f"\nCache statistics:")
        click.echo(f"  Hit rate:      {cache_stats['hit_rate']:.1%}")
        click.echo(f"  Cache size:    {cache_stats['cache_size']}")
        click.echo(f"  Cache hits:    {cache_stats['cache_hits']}")
        click.echo(f"  Cache misses:  {cache_stats['cache_misses']}")

    except CaracalError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Unexpected error: {e}", err=True)
        sys.exit(1)


@click.group('allowlist')
def allowlist_group():
    """
    Manage resource allowlists for fine-grained access control.

    Allowlists restrict principals to specific API endpoints or resources.
    Once a principal has any allowlist entries, only resources matching at
    least one pattern are allowed.
    """
    pass


allowlist_group.add_command(create)
allowlist_group.add_command(list_allowlists)
allowlist_group.add_command(delete)
allowlist_group.add_command(test)
