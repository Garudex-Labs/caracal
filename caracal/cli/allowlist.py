"""
CLI commands for resource allowlist management.

Provides commands for creating, listing, deleting, and testing resource allowlists.

Requirements: 7.1, 7.2
"""

import sys
from typing import Optional
from uuid import UUID

import click

from caracal.core.allowlist import AllowlistManager
from caracal.db.connection import get_db_session
from caracal.exceptions import CaracalError, ValidationError


def get_allowlist_manager(config) -> AllowlistManager:
    """
    Create AllowlistManager instance from configuration.
    
    Args:
        config: Configuration object
        
    Returns:
        AllowlistManager instance
    """
    db_session = get_db_session(config)
    cache_ttl = getattr(config, 'allowlist_cache_ttl', 60)
    return AllowlistManager(db_session, cache_ttl_seconds=cache_ttl)


@click.command('create')
@click.option(
    '--agent-id',
    '-a',
    required=True,
    help='Agent ID (UUID)',
)
@click.option(
    '--pattern',
    '-p',
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
def create(ctx, agent_id: str, pattern: str, pattern_type: str):
    """
    Create a new resource allowlist entry.
    
    Adds a pattern to the agent's allowlist. Once an agent has any allowlist entries,
    only resources matching at least one pattern will be allowed.
    
    Pattern Types:
    
        regex: Python regular expression (e.g., "^https://api\\.openai\\.com/.*$")
        glob:  Shell-style glob pattern (e.g., "https://api.anthropic.com/*")
    
    Examples:
    
        # Allow all OpenAI API endpoints
        caracal allowlist create -a 550e8400-e29b-41d4-a716-446655440000 \\
            -p "^https://api\\.openai\\.com/.*$" -t regex
        
        # Allow all Anthropic API endpoints using glob
        caracal allowlist create -a 550e8400-e29b-41d4-a716-446655440000 \\
            -p "https://api.anthropic.com/*" -t glob
        
        # Allow specific model endpoint
        caracal allowlist create -a 550e8400-e29b-41d4-a716-446655440000 \\
            -p "^https://api\\.openai\\.com/v1/chat/completions$" -t regex
    """
    try:
        config = ctx.obj['config']
        allowlist_manager = get_allowlist_manager(config)
        
        # Parse agent ID
        try:
            agent_uuid = UUID(agent_id)
        except ValueError:
            click.echo(f"Error: Invalid agent ID format: {agent_id}", err=True)
            sys.exit(1)
        
        # Create allowlist
        allowlist = allowlist_manager.create_allowlist(
            agent_id=agent_uuid,
            resource_pattern=pattern,
            pattern_type=pattern_type.lower()
        )
        
        click.echo(f"✓ Created allowlist entry:")
        click.echo(f"  Allowlist ID: {allowlist.allowlist_id}")
        click.echo(f"  Agent ID:     {allowlist.agent_id}")
        click.echo(f"  Pattern:      {allowlist.resource_pattern}")
        click.echo(f"  Type:         {allowlist.pattern_type}")
        click.echo(f"  Created:      {allowlist.created_at}")
        
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
    '--agent-id',
    '-a',
    required=True,
    help='Agent ID (UUID)',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['table', 'json'], case_sensitive=False),
    default='table',
    help='Output format (default: table)',
)
@click.pass_context
def list_allowlists(ctx, agent_id: str, format: str):
    """
    List all active allowlist entries for an agent.
    
    Shows all resource patterns that are allowed for the specified agent.
    
    Examples:
    
        # List allowlists in table format
        caracal allowlist list -a 550e8400-e29b-41d4-a716-446655440000
        
        # List allowlists in JSON format
        caracal allowlist list -a 550e8400-e29b-41d4-a716-446655440000 -f json
    """
    try:
        config = ctx.obj['config']
        allowlist_manager = get_allowlist_manager(config)
        
        # Parse agent ID
        try:
            agent_uuid = UUID(agent_id)
        except ValueError:
            click.echo(f"Error: Invalid agent ID format: {agent_id}", err=True)
            sys.exit(1)
        
        # List allowlists
        allowlists = allowlist_manager.list_allowlists(agent_uuid)
        
        if not allowlists:
            click.echo(f"No allowlists configured for agent {agent_id}")
            click.echo("(All resources are allowed by default)")
            return
        
        if format == 'json':
            import json
            data = [
                {
                    'allowlist_id': str(a.allowlist_id),
                    'agent_id': str(a.agent_id),
                    'pattern': a.resource_pattern,
                    'type': a.pattern_type,
                    'created_at': a.created_at.isoformat(),
                    'active': a.active
                }
                for a in allowlists
            ]
            click.echo(json.dumps(data, indent=2))
        else:
            # Table format
            click.echo(f"\nAllowlists for agent {agent_id}:")
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
    
    Soft-deletes the allowlist entry by marking it as inactive. The entry
    remains in the database for audit purposes but is no longer enforced.
    
    Examples:
    
        # Delete with confirmation
        caracal allowlist delete -i 123e4567-e89b-12d3-a456-426614174000
        
        # Delete without confirmation
        caracal allowlist delete -i 123e4567-e89b-12d3-a456-426614174000 -y
    """
    try:
        config = ctx.obj['config']
        allowlist_manager = get_allowlist_manager(config)
        
        # Parse allowlist ID
        try:
            allowlist_uuid = UUID(allowlist_id)
        except ValueError:
            click.echo(f"Error: Invalid allowlist ID format: {allowlist_id}", err=True)
            sys.exit(1)
        
        # Confirm deletion
        if not yes:
            if not click.confirm(f"Delete allowlist {allowlist_id}?"):
                click.echo("Cancelled.")
                return
        
        # Delete allowlist
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
    '--agent-id',
    '-a',
    required=True,
    help='Agent ID (UUID)',
)
@click.option(
    '--resource',
    '-r',
    required=True,
    help='Resource URL to test',
)
@click.pass_context
def test(ctx, agent_id: str, resource: str):
    """
    Test if a resource would be allowed for an agent.
    
    Checks the agent's allowlist patterns against the specified resource URL
    and reports whether the resource would be allowed or denied.
    
    Examples:
    
        # Test OpenAI API endpoint
        caracal allowlist test -a 550e8400-e29b-41d4-a716-446655440000 \\
            -r "https://api.openai.com/v1/chat/completions"
        
        # Test Anthropic API endpoint
        caracal allowlist test -a 550e8400-e29b-41d4-a716-446655440000 \\
            -r "https://api.anthropic.com/v1/messages"
    """
    try:
        config = ctx.obj['config']
        allowlist_manager = get_allowlist_manager(config)
        
        # Parse agent ID
        try:
            agent_uuid = UUID(agent_id)
        except ValueError:
            click.echo(f"Error: Invalid agent ID format: {agent_id}", err=True)
            sys.exit(1)
        
        # Check resource
        decision = allowlist_manager.check_resource(agent_uuid, resource)
        
        click.echo(f"\nAllowlist check for agent {agent_id}:")
        click.echo(f"  Resource: {resource}")
        click.echo(f"  Result:   {'✓ ALLOWED' if decision.allowed else '✗ DENIED'}")
        click.echo(f"  Reason:   {decision.reason}")
        
        if decision.matched_pattern:
            click.echo(f"  Pattern:  {decision.matched_pattern}")
        
        # Get cache stats
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
    
    Allowlists enable restricting agents to specific API endpoints or resources.
    Once an agent has any allowlist entries, only resources matching at least
    one pattern will be allowed.
    """
    pass


# Register commands
allowlist_group.add_command(create)
allowlist_group.add_command(list_allowlists)
allowlist_group.add_command(delete)
allowlist_group.add_command(test)
