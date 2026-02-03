"""
CLI commands for snapshot management.

Provides commands for creating, listing, and restoring ledger snapshots.

Requirements: 12.5
"""

import sys
from datetime import datetime
from pathlib import Path
from uuid import UUID

import click
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from caracal.db.connection import get_database_url
from caracal.db.models import Base
from caracal.logging_config import get_logger
from caracal.merkle.snapshot import SnapshotManager
from caracal.merkle.recovery import RecoveryManager

logger = get_logger(__name__)


@click.group(name='snapshot')
def snapshot_group():
    """
    Manage ledger snapshots.
    
    Commands for creating, listing, and restoring snapshots for fast recovery.
    """
    pass


@snapshot_group.command(name='create')
@click.pass_obj
def create_snapshot(ctx):
    """
    Create a ledger snapshot.
    
    Creates a point-in-time snapshot of the ledger including:
    - Aggregated spending per agent
    - Current Merkle root
    - Total event count
    
    Example:
        caracal snapshot create
    """
    try:
        click.echo("Creating ledger snapshot...")
        
        # Create database session
        engine = create_engine(get_database_url(ctx.config))
        Session = sessionmaker(bind=engine)
        session = Session()
        
        try:
            # Create snapshot manager
            snapshot_manager = SnapshotManager(db_session=session)
            
            # Create snapshot
            start_time = datetime.utcnow()
            snapshot = snapshot_manager.create_snapshot()
            end_time = datetime.utcnow()
            
            duration = (end_time - start_time).total_seconds()
            
            click.echo(f"✓ Snapshot created successfully")
            click.echo(f"  Snapshot ID: {snapshot.snapshot_id}")
            click.echo(f"  Timestamp: {snapshot.snapshot_timestamp}")
            click.echo(f"  Total events: {snapshot.total_events}")
            click.echo(f"  Merkle root: {snapshot.merkle_root[:16]}...")
            click.echo(f"  Duration: {duration:.2f}s")
            
        finally:
            session.close()
            
    except Exception as e:
        logger.error(f"Failed to create snapshot: {e}", exc_info=True)
        click.echo(f"✗ Error: {e}", err=True)
        sys.exit(1)


@snapshot_group.command(name='list')
@click.option(
    '--limit',
    '-n',
    type=int,
    default=10,
    help='Maximum number of snapshots to list (default: 10)',
)
@click.pass_obj
def list_snapshots(ctx, limit: int):
    """
    List recent snapshots.
    
    Shows the most recent snapshots with their metadata.
    
    Example:
        caracal snapshot list
        caracal snapshot list --limit 20
    """
    try:
        # Create database session
        engine = create_engine(get_database_url(ctx.config))
        Session = sessionmaker(bind=engine)
        session = Session()
        
        try:
            # Create snapshot manager
            snapshot_manager = SnapshotManager(db_session=session)
            
            # List snapshots
            snapshots = snapshot_manager.list_snapshots(limit=limit)
            
            if not snapshots:
                click.echo("No snapshots found")
                return
            
            click.echo(f"Recent snapshots (showing {len(snapshots)}):\n")
            
            # Print header
            click.echo(f"{'Snapshot ID':<38} {'Timestamp':<20} {'Events':<10} {'Merkle Root':<20}")
            click.echo("-" * 90)
            
            # Print snapshots
            for snapshot in snapshots:
                timestamp_str = snapshot.snapshot_timestamp.strftime("%Y-%m-%d %H:%M:%S")
                merkle_root_short = snapshot.merkle_root[:16] + "..." if snapshot.merkle_root else "N/A"
                
                click.echo(
                    f"{str(snapshot.snapshot_id):<38} "
                    f"{timestamp_str:<20} "
                    f"{snapshot.total_events:<10} "
                    f"{merkle_root_short:<20}"
                )
            
        finally:
            session.close()
            
    except Exception as e:
        logger.error(f"Failed to list snapshots: {e}", exc_info=True)
        click.echo(f"✗ Error: {e}", err=True)
        sys.exit(1)


@snapshot_group.command(name='restore')
@click.option(
    '--snapshot-id',
    '-s',
    type=str,
    default=None,
    help='Snapshot ID to restore from (default: latest snapshot)',
)
@click.option(
    '--dry-run',
    is_flag=True,
    help='Show what would be restored without actually restoring',
)
@click.pass_obj
def restore_snapshot(ctx, snapshot_id: str, dry_run: bool):
    """
    Restore from a snapshot.
    
    Loads a snapshot and replays events after the snapshot timestamp.
    Rebuilds Redis cache from replayed events.
    
    Example:
        caracal snapshot restore
        caracal snapshot restore --snapshot-id <uuid>
        caracal snapshot restore --dry-run
    """
    try:
        if dry_run:
            click.echo("DRY RUN: No changes will be made\n")
        
        # Create database session
        engine = create_engine(get_database_url(ctx.config))
        Session = sessionmaker(bind=engine)
        session = Session()
        
        try:
            # Create snapshot manager
            snapshot_manager = SnapshotManager(db_session=session)
            
            # Create recovery manager
            recovery_manager = RecoveryManager(
                db_session=session,
                snapshot_manager=snapshot_manager,
            )
            
            if snapshot_id:
                click.echo(f"Restoring from snapshot: {snapshot_id}")
                snapshot_uuid = UUID(snapshot_id)
                
                if dry_run:
                    # Load snapshot to show what would be restored
                    snapshot_data = snapshot_manager.load_snapshot(snapshot_uuid)
                    click.echo(f"  Snapshot timestamp: {snapshot_data.snapshot_timestamp}")
                    click.echo(f"  Total events: {snapshot_data.total_events}")
                    click.echo(f"  Agents: {len(snapshot_data.agent_spending)}")
                    click.echo(f"  Merkle root: {snapshot_data.merkle_root[:16]}...")
                    click.echo("\nNo changes made (dry run)")
                    return
                
                # Perform recovery
                result = recovery_manager.recover_from_snapshot(snapshot_uuid)
            else:
                click.echo("Restoring from latest snapshot...")
                
                if dry_run:
                    # Get latest snapshot to show what would be restored
                    latest = snapshot_manager.get_latest_snapshot()
                    if latest is None:
                        click.echo("✗ No snapshots available")
                        return
                    
                    click.echo(f"  Snapshot ID: {latest.snapshot_id}")
                    click.echo(f"  Snapshot timestamp: {latest.snapshot_timestamp}")
                    click.echo(f"  Total events: {latest.total_events}")
                    click.echo(f"  Merkle root: {latest.merkle_root[:16]}...")
                    click.echo("\nNo changes made (dry run)")
                    return
                
                # Perform recovery
                result = recovery_manager.recover_from_latest_snapshot()
            
            click.echo(f"✓ Recovery completed successfully")
            click.echo(f"  Snapshot ID: {result.snapshot_id}")
            click.echo(f"  Snapshot timestamp: {result.snapshot_timestamp}")
            click.echo(f"  Agents restored: {result.agents_restored}")
            click.echo(f"  Replay from: {result.replay_from_timestamp}")
            
        finally:
            session.close()
            
    except ValueError as e:
        click.echo(f"✗ Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        logger.error(f"Failed to restore snapshot: {e}", exc_info=True)
        click.echo(f"✗ Error: {e}", err=True)
        sys.exit(1)


@snapshot_group.command(name='status')
@click.pass_obj
def snapshot_status(ctx):
    """
    Show snapshot recovery status.
    
    Displays information about the latest snapshot and recovery readiness.
    
    Example:
        caracal snapshot status
    """
    try:
        # Create database session
        engine = create_engine(get_database_url(ctx.config))
        Session = sessionmaker(bind=engine)
        session = Session()
        
        try:
            # Create snapshot manager
            snapshot_manager = SnapshotManager(db_session=session)
            
            # Create recovery manager
            recovery_manager = RecoveryManager(
                db_session=session,
                snapshot_manager=snapshot_manager,
            )
            
            # Get recovery status
            status = recovery_manager.get_recovery_status()
            
            if "error" in status:
                click.echo(f"✗ Error getting status: {status['error']}", err=True)
                return
            
            if not status.get("snapshot_available"):
                click.echo("No snapshots available")
                click.echo("Run 'caracal snapshot create' to create a snapshot")
                return
            
            click.echo("Snapshot Recovery Status:\n")
            click.echo(f"  Latest snapshot ID: {status['latest_snapshot_id']}")
            click.echo(f"  Snapshot timestamp: {status['snapshot_timestamp']}")
            click.echo(f"  Events in snapshot: {status['snapshot_events']}")
            click.echo(f"  Events after snapshot: {status['events_after_snapshot']}")
            click.echo(f"  Total events: {status['total_events']}")
            
            # Calculate recovery time estimate (rough estimate)
            events_to_replay = status['events_after_snapshot']
            if events_to_replay > 0:
                # Assume ~1000 events per second replay rate
                estimated_seconds = events_to_replay / 1000
                click.echo(f"\n  Estimated recovery time: ~{estimated_seconds:.1f}s")
            else:
                click.echo(f"\n  Recovery would be instant (no events to replay)")
            
        finally:
            session.close()
            
    except Exception as e:
        logger.error(f"Failed to get snapshot status: {e}", exc_info=True)
        click.echo(f"✗ Error: {e}", err=True)
        sys.exit(1)


@snapshot_group.command(name='cleanup')
@click.option(
    '--retention-days',
    '-r',
    type=int,
    default=90,
    help='Number of days to retain snapshots (default: 90)',
)
@click.option(
    '--dry-run',
    is_flag=True,
    help='Show what would be deleted without actually deleting',
)
@click.pass_obj
def cleanup_snapshots(ctx, retention_days: int, dry_run: bool):
    """
    Clean up old snapshots.
    
    Deletes snapshots older than the retention period.
    
    Example:
        caracal snapshot cleanup
        caracal snapshot cleanup --retention-days 30
        caracal snapshot cleanup --dry-run
    """
    try:
        if dry_run:
            click.echo("DRY RUN: No snapshots will be deleted\n")
        
        click.echo(f"Cleaning up snapshots older than {retention_days} days...")
        
        # Create database session
        engine = create_engine(get_database_url(ctx.config))
        Session = sessionmaker(bind=engine)
        session = Session()
        
        try:
            # Create snapshot manager
            snapshot_manager = SnapshotManager(db_session=session)
            
            if dry_run:
                # Query old snapshots without deleting
                from datetime import timedelta
                cutoff_date = datetime.utcnow() - timedelta(days=retention_days)
                
                from sqlalchemy import select
                from caracal.db.models import LedgerSnapshot
                
                result = session.execute(
                    select(LedgerSnapshot)
                    .where(LedgerSnapshot.created_at < cutoff_date)
                )
                
                old_snapshots = result.scalars().all()
                
                if not old_snapshots:
                    click.echo("No snapshots to delete")
                    return
                
                click.echo(f"Would delete {len(old_snapshots)} snapshots:\n")
                for snapshot in old_snapshots:
                    click.echo(f"  - {snapshot.snapshot_id} ({snapshot.created_at})")
                
                click.echo("\nNo changes made (dry run)")
                return
            
            # Cleanup old snapshots
            deleted_count = snapshot_manager.cleanup_old_snapshots(retention_days)
            
            if deleted_count > 0:
                click.echo(f"✓ Deleted {deleted_count} old snapshots")
            else:
                click.echo("No snapshots to delete")
            
        finally:
            session.close()
            
    except Exception as e:
        logger.error(f"Failed to cleanup snapshots: {e}", exc_info=True)
        click.echo(f"✗ Error: {e}", err=True)
        sys.exit(1)
