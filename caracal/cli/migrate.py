"""
CLI commands for data migration from budget system to authority enforcement.

Provides commands to migrate data from v0.2 budget-focused system to v0.5
authority enforcement system.

Requirements: 12.1, 12.7
"""

import json
import sys
from pathlib import Path

import click

from caracal.cli.main import CLIContext, pass_context
from caracal.db.connection import get_session
from caracal.core.migration import MigrationTool
from caracal.logging_config import get_logger

logger = get_logger(__name__)


@click.group(name='migrate')
def migrate_group():
    """Migrate data from budget system to authority enforcement."""
    pass


@migrate_group.command(name='run')
@click.option(
    '--dry-run',
    is_flag=True,
    help='Perform validation without writing data',
)
@click.option(
    '--incremental',
    is_flag=True,
    help='Skip entities that already exist in target',
)
@click.option(
    '--output',
    '-o',
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    help='Save migration report to file',
)
@click.option(
    '--format',
    '-f',
    type=click.Choice(['text', 'json'], case_sensitive=False),
    default='text',
    help='Report output format',
)
@pass_context
def run_migration(
    ctx: CLIContext,
    dry_run: bool,
    incremental: bool,
    output: Path,
    format: str,
):
    """
    Run complete migration from budget system to authority enforcement.
    
    Migrates:
    - AgentIdentity -> Principal
    - BudgetPolicy -> AuthorityPolicy
    - DelegationToken -> ExecutionMandate
    - LedgerEvent -> AuthorityLedgerEvent
    
    Examples:
        # Dry run to validate migration
        caracal migrate run --dry-run
        
        # Run migration and save report
        caracal migrate run --output migration_report.txt
        
        # Incremental migration (skip existing entities)
        caracal migrate run --incremental
    """
    try:
        # Get database session
        session = get_session(ctx.config)
        
        # Create migration tool
        migration_tool = MigrationTool(
            source_session=session,
            target_session=session,
            dry_run=dry_run,
        )
        
        # Display migration info
        if dry_run:
            click.echo("Running migration in DRY RUN mode (no data will be written)")
        else:
            click.echo("Running migration...")
        
        # Show progress
        with click.progressbar(
            length=4,
            label='Migrating data',
            show_eta=True,
        ) as bar:
            # Migrate principals
            click.echo("\nMigrating principals...")
            migration_tool.migrate_principals()
            bar.update(1)
            
            # Migrate policies
            click.echo("Migrating policies...")
            migration_tool.migrate_policies()
            bar.update(1)
            
            # Migrate delegation tokens
            click.echo("Migrating delegation tokens...")
            migration_tool.migrate_delegation_tokens()
            bar.update(1)
            
            # Migrate ledger events
            click.echo("Migrating ledger events...")
            migration_tool.migrate_ledger_events()
            bar.update(1)
        
        # Validate migration
        click.echo("\nValidating migrated data...")
        validation_passed = migration_tool.validate_migration()
        
        # Commit if not dry run and validation passed
        if not dry_run:
            if validation_passed:
                session.commit()
                click.echo("\n✓ Migration completed successfully!")
            else:
                session.rollback()
                click.echo("\n✗ Migration validation failed - rolled back", err=True)
        else:
            click.echo("\n✓ Dry run completed")
        
        # Generate report
        report_text = migration_tool.generate_report(format=format)
        
        # Display report
        click.echo("\n" + report_text)
        
        # Save report to file if requested
        if output:
            output.write_text(report_text)
            click.echo(f"\nReport saved to: {output}")
        
        # Exit with error code if validation failed
        if not validation_passed:
            sys.exit(1)
        
    except Exception as e:
        logger.error(f"Migration failed: {e}", exc_info=True)
        click.echo(f"\nError: Migration failed: {e}", err=True)
        sys.exit(1)


@migrate_group.command(name='validate')
@pass_context
def validate_migration(ctx: CLIContext):
    """
    Validate migrated data for consistency.
    
    Checks:
    - All mandates reference valid principals
    - All policies reference valid principals
    - All ledger events reference valid principals
    - Referential integrity
    
    Examples:
        # Validate migration
        caracal migrate validate
    """
    try:
        # Get database session
        session = get_session(ctx.config)
        
        # Create migration tool
        migration_tool = MigrationTool(
            source_session=session,
            target_session=session,
            dry_run=True,
        )
        
        click.echo("Validating migrated data...")
        
        # Run validation
        validation_passed = migration_tool.validate_migration()
        
        # Display results
        if validation_passed:
            click.echo("\n✓ Validation passed")
        else:
            click.echo("\n✗ Validation failed", err=True)
            
            # Display errors
            if migration_tool.report.validation_errors:
                click.echo("\nValidation errors:")
                for error in migration_tool.report.validation_errors:
                    click.echo(f"  - {error}")
        
        # Exit with error code if validation failed
        if not validation_passed:
            sys.exit(1)
        
    except Exception as e:
        logger.error(f"Validation failed: {e}", exc_info=True)
        click.echo(f"\nError: Validation failed: {e}", err=True)
        sys.exit(1)


@migrate_group.command(name='rollback')
@click.option(
    '--confirm',
    is_flag=True,
    help='Confirm rollback without prompting',
)
@pass_context
def rollback_migration(ctx: CLIContext, confirm: bool):
    """
    Rollback migration by deleting migrated data.
    
    WARNING: This will delete all migrated principals, policies, mandates,
    and ledger events from the target database.
    
    Examples:
        # Rollback migration (with confirmation prompt)
        caracal migrate rollback
        
        # Rollback without prompting
        caracal migrate rollback --confirm
    """
    try:
        # Confirm rollback
        if not confirm:
            click.confirm(
                "\nWARNING: This will delete all migrated data. Continue?",
                abort=True,
            )
        
        # Get database session
        session = get_session(ctx.config)
        
        # Create migration tool
        migration_tool = MigrationTool(
            source_session=session,
            target_session=session,
            dry_run=False,
        )
        
        click.echo("Rolling back migration...")
        
        # Perform rollback
        migration_tool.rollback()
        
        click.echo("\n✓ Rollback completed successfully")
        
    except click.Abort:
        click.echo("\nRollback cancelled")
        sys.exit(0)
    except Exception as e:
        logger.error(f"Rollback failed: {e}", exc_info=True)
        click.echo(f"\nError: Rollback failed: {e}", err=True)
        sys.exit(1)


@migrate_group.command(name='report')
@click.option(
    '--format',
    '-f',
    type=click.Choice(['text', 'json'], case_sensitive=False),
    default='text',
    help='Report output format',
)
@click.option(
    '--output',
    '-o',
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    help='Save report to file',
)
@pass_context
def generate_report(ctx: CLIContext, format: str, output: Path):
    """
    Generate migration statistics report.
    
    Displays counts of migrated entities and any validation errors.
    
    Examples:
        # Generate text report
        caracal migrate report
        
        # Generate JSON report
        caracal migrate report --format json
        
        # Save report to file
        caracal migrate report --output report.txt
    """
    try:
        # Get database session
        session = get_session(ctx.config)
        
        # Create migration tool
        migration_tool = MigrationTool(
            source_session=session,
            target_session=session,
            dry_run=True,
        )
        
        # Count migrated entities
        from caracal.db.models import (
            Principal,
            AuthorityPolicy,
            ExecutionMandate,
            AuthorityLedgerEvent,
        )
        
        principals_count = session.query(Principal).count()
        policies_count = session.query(AuthorityPolicy).count()
        mandates_count = session.query(ExecutionMandate).count()
        ledger_events_count = session.query(AuthorityLedgerEvent).filter(
            AuthorityLedgerEvent.event_metadata.contains({"migrated_from": "ledger_event"})
        ).count()
        
        # Update report
        migration_tool.report.principals_migrated = principals_count
        migration_tool.report.policies_migrated = policies_count
        migration_tool.report.mandates_migrated = mandates_count
        migration_tool.report.ledger_events_migrated = ledger_events_count
        
        # Generate report
        report_text = migration_tool.generate_report(format=format)
        
        # Display report
        click.echo(report_text)
        
        # Save report to file if requested
        if output:
            output.write_text(report_text)
            click.echo(f"\nReport saved to: {output}")
        
    except Exception as e:
        logger.error(f"Report generation failed: {e}", exc_info=True)
        click.echo(f"\nError: Report generation failed: {e}", err=True)
        sys.exit(1)


@migrate_group.command(name='status')
@pass_context
def migration_status(ctx: CLIContext):
    """
    Display current migration status.
    
    Shows counts of entities in both budget and authority systems.
    
    Examples:
        # Check migration status
        caracal migrate status
    """
    try:
        # Get database session
        session = get_session(ctx.config)
        
        # Count budget system entities
        from caracal.db.models import (
            AgentIdentity,
            BudgetPolicy,
            LedgerEvent,
            Principal,
            AuthorityPolicy,
            ExecutionMandate,
            AuthorityLedgerEvent,
        )
        
        agents_count = session.query(AgentIdentity).count()
        budget_policies_count = session.query(BudgetPolicy).count()
        ledger_events_count = session.query(LedgerEvent).count()
        
        # Count authority system entities
        principals_count = session.query(Principal).count()
        authority_policies_count = session.query(AuthorityPolicy).count()
        mandates_count = session.query(ExecutionMandate).count()
        authority_events_count = session.query(AuthorityLedgerEvent).count()
        
        # Display status
        click.echo("=" * 60)
        click.echo("Migration Status")
        click.echo("=" * 60)
        click.echo()
        click.echo("Budget System (v0.2):")
        click.echo(f"  Agents:          {agents_count}")
        click.echo(f"  Budget Policies: {budget_policies_count}")
        click.echo(f"  Ledger Events:   {ledger_events_count}")
        click.echo()
        click.echo("Authority System (v0.5):")
        click.echo(f"  Principals:      {principals_count}")
        click.echo(f"  Authority Policies: {authority_policies_count}")
        click.echo(f"  Mandates:        {mandates_count}")
        click.echo(f"  Authority Events: {authority_events_count}")
        click.echo()
        
        # Calculate migration percentage
        if agents_count > 0:
            migration_pct = (principals_count / agents_count) * 100
            click.echo(f"Migration Progress: {migration_pct:.1f}%")
        else:
            click.echo("Migration Progress: N/A (no agents to migrate)")
        
        click.echo("=" * 60)
        
    except Exception as e:
        logger.error(f"Status check failed: {e}", exc_info=True)
        click.echo(f"\nError: Status check failed: {e}", err=True)
        sys.exit(1)
