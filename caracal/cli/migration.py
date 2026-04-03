"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for migration operations.

Provides commands for:
- Repository to package migration
- Edition switching
- Backup management
"""

import sys
from pathlib import Path
from typing import Optional

import click

from caracal.cli.context import pass_context, CLIContext
from caracal.deployment.migration import MigrationManager
from caracal.deployment.edition import Edition
from caracal.deployment.exceptions import MigrationError
from caracal.runtime.hardcut_preflight import (
    HardCutPreflightError,
    assert_migration_cli_allowed,
)


@click.group(name="migrate")
def migrate_group():
    """Manage migration operations."""
    pass


def _enforce_hardcut_migration_policy() -> None:
    try:
        assert_migration_cli_allowed()
    except HardCutPreflightError as exc:
        raise click.ClickException(str(exc)) from exc


@migrate_group.command(name="repo-to-package")
@click.option(
    "--repository-path",
    "-r",
    type=click.Path(exists=True, file_okay=False, dir_okay=True, path_type=Path),
    default=None,
    help="Path to repository installation (auto-detected if not provided)",
)
@click.option(
    "--no-preserve-data",
    is_flag=True,
    help="Skip data preservation during migration",
)
@click.option(
    "--no-verify",
    is_flag=True,
    help="Skip data integrity verification after migration",
)
@click.option(
    "--dry-run",
    is_flag=True,
    help="Show what would be migrated without performing the migration",
)
@pass_context
def migrate_repo_to_package(
    ctx: CLIContext,
    repository_path: Optional[Path],
    no_preserve_data: bool,
    no_verify: bool,
    dry_run: bool,
):
    """
    Migrate from repository-based installation to package-based installation.
    
    This command:
    - Creates a backup of existing configuration and data
    - Exports all workspaces
    - Preserves all settings and credentials
    - Verifies data integrity after migration
    - Provides rollback capability on failure
    
    Example:
        caracal migrate repo-to-package
        caracal migrate repo-to-package --repository-path ~/caracal
        caracal migrate repo-to-package --dry-run
    """
    _enforce_hardcut_migration_policy()

    try:
        migration_manager = MigrationManager()
        
        if dry_run:
            click.echo("DRY RUN: Migration would perform the following:")
            click.echo("  1. Create backup of current configuration")
            click.echo("  2. Detect repository installation")
            if repository_path:
                click.echo(f"     Repository path: {repository_path}")
            else:
                click.echo("     Repository path: auto-detect")
            
            if not no_preserve_data:
                click.echo("  3. Preserve all workspace data")
            
            if not no_verify:
                click.echo("  4. Verify data integrity")
            
            click.echo("\nNo changes made (dry run).")
            return
        
        click.echo("Starting repository to package migration...")
        click.echo("This may take a few moments...")
        
        result = migration_manager.migrate_repository_to_package(
            repository_path=repository_path,
            preserve_data=not no_preserve_data,
            verify_integrity=not no_verify,
        )
        
        click.echo("\n" + "=" * 60)
        click.echo("Migration completed successfully!")
        click.echo("=" * 60)
        click.echo(f"Migration ID: {result['migration_id']}")
        click.echo(f"Workspaces migrated: {result['workspaces_migrated']}")
        click.echo(f"Backup location: {result['backup_path']}")
        click.echo(f"Duration: {result['duration_ms']}ms")
        click.echo("\nYou can now use Caracal as an installed package.")
        
    except MigrationError as e:
        click.echo(f"\nError: Migration failed: {e}", err=True)
        click.echo("\nYour original configuration has been preserved.", err=True)
        click.echo("Check the logs for more details.", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"\nError: Unexpected error during migration: {e}", err=True)
        sys.exit(1)


@migrate_group.command(name="switch-edition")
@click.argument(
    "target_edition",
    type=click.Choice(["opensource", "enterprise"], case_sensitive=False),
)
@click.option(
    "--gateway-url",
    "-g",
    type=str,
    default=None,
    help="Gateway URL (required for Enterprise Edition)",
)
@click.option(
    "--gateway-token",
    "-t",
    type=str,
    default=None,
    help="Gateway JWT token (optional, for Enterprise Edition)",
)
@click.option(
    "--no-migrate-keys",
    is_flag=True,
    help="Skip API key migration",
)
@click.option(
    "--dry-run",
    is_flag=True,
    help="Show what would be migrated without performing the migration",
)
@pass_context
def migrate_switch_edition(
    ctx: CLIContext,
    target_edition: str,
    gateway_url: Optional[str],
    gateway_token: Optional[str],
    no_migrate_keys: bool,
    dry_run: bool,
):
    """
    Switch between Open Source and Enterprise editions.
    
    This command:
    - Creates a backup of existing configuration
    - Migrates API keys between local storage and gateway
    - Migrates edition-specific settings
    - Updates edition configuration
    - Verifies migration success
    
    Examples:
        # Switch to Enterprise Edition
        caracal migrate switch-edition enterprise --gateway-url https://gateway.example.com
        
        # Switch to Open Source Edition
        caracal migrate switch-edition opensource
        
        # Dry run to see what would happen
        caracal migrate switch-edition enterprise --gateway-url https://gateway.example.com --dry-run
    """
    _enforce_hardcut_migration_policy()

    try:
        migration_manager = MigrationManager()
        current_edition = migration_manager.edition_manager.get_edition()
        target_edition_enum = Edition(target_edition.lower())
        
        # Validate requirements
        if target_edition_enum == Edition.ENTERPRISE and not gateway_url:
            click.echo(
                "Error: Gateway URL is required for Enterprise Edition migration.",
                err=True
            )
            click.echo("Use --gateway-url to specify the gateway URL.", err=True)
            sys.exit(1)
        
        if current_edition == target_edition_enum:
            click.echo(f"Already running {target_edition_enum.value} edition.")
            return
        
        if dry_run:
            click.echo("DRY RUN: Migration would perform the following:")
            click.echo(f"  Current edition: {current_edition.value}")
            click.echo(f"  Target edition: {target_edition_enum.value}")
            click.echo("  1. Create backup of current configuration")
            
            if not no_migrate_keys:
                if target_edition_enum == Edition.ENTERPRISE:
                    click.echo("  2. Migrate API keys from local storage to gateway")
                    click.echo(f"     Gateway URL: {gateway_url}")
                else:
                    click.echo("  2. Prompt for API keys for local storage")
            
            click.echo("  3. Migrate edition-specific settings")
            click.echo("  4. Update edition configuration")
            click.echo("\nNo changes made (dry run).")
            return
        
        click.echo(f"Switching from {current_edition.value} to {target_edition_enum.value} edition...")
        click.echo("This may take a few moments...")
        
        result = migration_manager.migrate_edition(
            target_edition=target_edition_enum,
            gateway_url=gateway_url,
            gateway_token=gateway_token,
            migrate_api_keys=not no_migrate_keys,
        )
        
        click.echo("\n" + "=" * 60)
        click.echo("Edition switch completed successfully!")
        click.echo("=" * 60)
        click.echo(f"Migration ID: {result['migration_id']}")
        click.echo(f"From edition: {result['from_edition']}")
        click.echo(f"To edition: {result['to_edition']}")
        click.echo(f"API keys migrated: {result['api_keys_migrated']}")
        click.echo(f"Backup location: {result['backup_path']}")
        click.echo(f"Duration: {result['duration_ms']}ms")
        
        if target_edition_enum == Edition.OPENSOURCE and not no_migrate_keys:
            click.echo("\n" + "!" * 60)
            click.echo("IMPORTANT: Please configure API keys for local storage")
            click.echo("!" * 60)
            click.echo("Run 'caracal system secrets' to configure API keys.")
        
    except MigrationError as e:
        click.echo(f"\nError: Edition switch failed: {e}", err=True)
        click.echo("\nYour original configuration has been preserved.", err=True)
        click.echo("Check the logs for more details.", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"\nError: Unexpected error during edition switch: {e}", err=True)
        sys.exit(1)


@migrate_group.command(name="list-backups")
@click.option(
    "--json",
    "output_json",
    is_flag=True,
    help="Output in JSON format",
)
@pass_context
def migrate_list_backups(ctx: CLIContext, output_json: bool):
    """
    List all available migration backups.
    
    Example:
        caracal migrate list-backups
        caracal migrate list-backups --json
    """
    _enforce_hardcut_migration_policy()

    try:
        migration_manager = MigrationManager()
        backups = migration_manager.list_backups()
        
        if output_json:
            import json
            click.echo(json.dumps(backups, indent=2))
            return
        
        if not backups:
            click.echo("No backups found.")
            return
        
        click.echo(f"Found {len(backups)} backup(s):\n")
        
        for backup in backups:
            click.echo(f"Name: {backup['name']}")
            click.echo(f"  Path: {backup['path']}")
            click.echo(f"  Size: {backup['size_bytes']:,} bytes")
            click.echo(f"  Created: {backup['created_at']}")
            click.echo(f"  Checksum: {'Yes' if backup['has_checksum'] else 'No'}")
            click.echo()
        
    except Exception as e:
        click.echo(f"Error: Failed to list backups: {e}", err=True)
        sys.exit(1)


@migrate_group.command(name="restore-backup")
@click.argument(
    "backup_path",
    type=click.Path(exists=True, file_okay=True, dir_okay=False, path_type=Path),
)
@click.option(
    "--confirm",
    is_flag=True,
    help="Skip confirmation prompt",
)
@pass_context
def migrate_restore_backup(ctx: CLIContext, backup_path: Path, confirm: bool):
    """
    Restore configuration from a backup.
    
    WARNING: This will replace your current configuration with the backup.
    
    Example:
        caracal migrate restore-backup /path/to/backup.tar.gz
        caracal migrate restore-backup /path/to/backup.tar.gz --confirm
    """
    _enforce_hardcut_migration_policy()

    try:
        if not confirm:
            click.echo("WARNING: This will replace your current configuration with the backup.")
            click.echo(f"Backup: {backup_path}")
            
            if not click.confirm("Are you sure you want to continue?"):
                click.echo("Restore cancelled.")
                return
        
        migration_manager = MigrationManager()
        
        click.echo("Restoring from backup...")
        migration_manager.restore_backup(backup_path)
        
        click.echo("\n" + "=" * 60)
        click.echo("Restore completed successfully!")
        click.echo("=" * 60)
        click.echo(f"Restored from: {backup_path}")
        
    except Exception as e:
        click.echo(f"\nError: Restore failed: {e}", err=True)
        sys.exit(1)
