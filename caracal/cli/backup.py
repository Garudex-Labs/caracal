"""
Backup and restore commands for Caracal Core.

Provides CLI commands for creating, restoring, and listing backups.
Implements Requirement 8.8-13 and 11.13-15 from caracal-core spec.
"""

import os
import shutil
import tarfile
import hashlib
from datetime import datetime
from pathlib import Path
from typing import Optional

import click

from caracal.exceptions import CaracalError, FileReadError, FileWriteError
from caracal.logging_config import get_logger

logger = get_logger(__name__)


def get_config(ctx):
    """Get configuration from CLI context."""
    from caracal.cli.main import CLIContext
    cli_ctx = ctx.find_object(CLIContext)
    if not cli_ctx or not cli_ctx.config:
        raise CaracalError("Configuration not loaded. Run 'caracal init' first.")
    return cli_ctx.config


def get_backup_dir(config) -> Path:
    """Get backup directory from config, creating if needed."""
    backup_dir = Path(config.storage.backup_dir).expanduser()
    backup_dir.mkdir(parents=True, exist_ok=True)
    return backup_dir


def get_data_files(config) -> dict:
    """Get paths to all data files that should be backed up."""
    return {
        "agents.json": Path(config.storage.agent_registry).expanduser(),
        "policies.json": Path(config.storage.policy_store).expanduser(),
        "ledger.jsonl": Path(config.storage.ledger).expanduser(),
        "pricebook.csv": Path(config.storage.pricebook).expanduser(),
        "config.yaml": Path("~/.caracal/config.yaml").expanduser(),
    }


def calculate_file_hash(file_path: Path) -> str:
    """Calculate SHA256 hash of a file."""
    sha256 = hashlib.sha256()
    with open(file_path, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            sha256.update(chunk)
    return sha256.hexdigest()


@click.command('create')
@click.option(
    '--name',
    '-n',
    type=str,
    default=None,
    help='Custom name for the backup (default: auto-generated timestamp)',
)
@click.pass_context
def backup_create(ctx, name: Optional[str]):
    """
    Create a timestamped backup archive of all Caracal data.
    
    Creates a .tar.gz archive containing agents.json, policies.json,
    ledger.jsonl, pricebook.csv, and config.yaml.
    """
    try:
        config = get_config(ctx)
        backup_dir = get_backup_dir(config)
        
        # Generate backup name
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_name = name or f"caracal_backup_{timestamp}"
        archive_path = backup_dir / f"{backup_name}.tar.gz"
        
        # Get data files
        data_files = get_data_files(config)
        
        # Check which files exist
        existing_files = {}
        for name_key, path in data_files.items():
            if path.exists():
                existing_files[name_key] = path
            else:
                logger.warning(f"Data file not found, skipping: {path}")
        
        if not existing_files:
            click.echo("Error: No data files found to backup.", err=True)
            raise SystemExit(1)
        
        # Create archive
        with tarfile.open(archive_path, "w:gz") as tar:
            for name_key, path in existing_files.items():
                tar.add(path, arcname=name_key)
                logger.info(f"Added to backup: {name_key}")
        
        # Calculate archive hash for integrity verification
        archive_hash = calculate_file_hash(archive_path)
        hash_file = archive_path.with_suffix('.tar.gz.sha256')
        hash_file.write_text(f"{archive_hash}  {archive_path.name}\n")
        
        # Get archive size
        archive_size = archive_path.stat().st_size
        size_str = _format_size(archive_size)
        
        # Enforce backup retention
        _enforce_retention(backup_dir, config.storage.backup_count)
        
        click.echo(f"✓ Backup created: {archive_path}")
        click.echo(f"  Size: {size_str}")
        click.echo(f"  Files: {len(existing_files)}")
        click.echo(f"  Hash: {archive_hash[:16]}...")
        
        logger.info(f"Backup created successfully: {archive_path}")
        
    except CaracalError:
        raise
    except Exception as e:
        logger.error(f"Failed to create backup: {e}", exc_info=True)
        click.echo(f"Error: Failed to create backup: {e}", err=True)
        raise SystemExit(1)


@click.command('restore')
@click.argument('backup_file', type=click.Path(exists=True, path_type=Path))
@click.option(
    '--force',
    '-f',
    is_flag=True,
    help='Skip confirmation prompt',
)
@click.option(
    '--no-safety-backup',
    is_flag=True,
    help='Skip creating safety backup of current data',
)
@click.pass_context
def backup_restore(ctx, backup_file: Path, force: bool, no_safety_backup: bool):
    """
    Restore Caracal data from a backup archive.
    
    Before restoring, validates archive integrity and creates a safety
    backup of current data (unless --no-safety-backup is specified).
    """
    try:
        config = get_config(ctx)
        
        # Validate archive integrity
        hash_file = backup_file.with_suffix('.tar.gz.sha256')
        if hash_file.exists():
            expected_hash = hash_file.read_text().split()[0]
            actual_hash = calculate_file_hash(backup_file)
            if expected_hash != actual_hash:
                click.echo("Error: Backup archive integrity check failed!", err=True)
                click.echo(f"  Expected: {expected_hash[:16]}...", err=True)
                click.echo(f"  Actual:   {actual_hash[:16]}...", err=True)
                raise SystemExit(1)
            click.echo("✓ Archive integrity verified")
        else:
            click.echo("⚠ No hash file found, skipping integrity check")
        
        # List archive contents
        with tarfile.open(backup_file, "r:gz") as tar:
            members = tar.getnames()
        
        click.echo(f"\nBackup contains {len(members)} files:")
        for member in members:
            click.echo(f"  - {member}")
        
        # Confirm restore
        if not force:
            click.echo("\n⚠ WARNING: This will overwrite existing data!")
            if not click.confirm("Do you want to continue?"):
                click.echo("Restore cancelled.")
                return
        
        # Create safety backup of current data
        if not no_safety_backup:
            click.echo("\nCreating safety backup of current data...")
            safety_timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            safety_name = f"safety_backup_{safety_timestamp}"
            backup_dir = get_backup_dir(config)
            safety_path = backup_dir / f"{safety_name}.tar.gz"
            
            data_files = get_data_files(config)
            existing_files = {k: v for k, v in data_files.items() if v.exists()}
            
            if existing_files:
                with tarfile.open(safety_path, "w:gz") as tar:
                    for name_key, path in existing_files.items():
                        tar.add(path, arcname=name_key)
                click.echo(f"✓ Safety backup created: {safety_path}")
        
        # Extract backup
        data_files = get_data_files(config)
        caracal_dir = Path("~/.caracal").expanduser()
        
        with tarfile.open(backup_file, "r:gz") as tar:
            for member in tar.getmembers():
                if member.name in data_files:
                    target_path = data_files[member.name]
                    # Extract to a temp file first
                    tar.extract(member, path=caracal_dir.parent / ".caracal_restore_tmp")
                    tmp_path = caracal_dir.parent / ".caracal_restore_tmp" / member.name
                    # Move to final location
                    shutil.move(str(tmp_path), str(target_path))
                    click.echo(f"  Restored: {member.name}")
        
        # Cleanup temp dir
        tmp_dir = caracal_dir.parent / ".caracal_restore_tmp"
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir)
        
        click.echo("\n✓ Restore completed successfully!")
        logger.info(f"Restored from backup: {backup_file}")
        
    except CaracalError:
        raise
    except Exception as e:
        logger.error(f"Failed to restore backup: {e}", exc_info=True)
        click.echo(f"Error: Failed to restore backup: {e}", err=True)
        raise SystemExit(1)


@click.command('list')
@click.option(
    '--json',
    'output_json',
    is_flag=True,
    help='Output in JSON format',
)
@click.pass_context
def backup_list(ctx, output_json: bool):
    """
    List available backup archives with timestamps and sizes.
    """
    try:
        config = get_config(ctx)
        backup_dir = get_backup_dir(config)
        
        # Find all backup archives
        backups = []
        for archive_path in sorted(backup_dir.glob("*.tar.gz"), reverse=True):
            stat = archive_path.stat()
            
            # Check for hash file
            hash_file = archive_path.with_suffix('.tar.gz.sha256')
            has_hash = hash_file.exists()
            
            backups.append({
                "name": archive_path.stem.replace('.tar', ''),
                "path": str(archive_path),
                "size": stat.st_size,
                "size_human": _format_size(stat.st_size),
                "created": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                "verified": has_hash,
            })
        
        if output_json:
            import json
            click.echo(json.dumps(backups, indent=2))
            return
        
        if not backups:
            click.echo("No backups found.")
            click.echo(f"Backup directory: {backup_dir}")
            return
        
        click.echo(f"Available backups ({len(backups)}):\n")
        click.echo(f"{'Name':<40} {'Size':<10} {'Created':<20} {'Verified'}")
        click.echo("-" * 80)
        
        for backup in backups:
            verified = "✓" if backup["verified"] else "-"
            created = backup["created"][:19].replace("T", " ")
            click.echo(f"{backup['name']:<40} {backup['size_human']:<10} {created:<20} {verified}")
        
        click.echo(f"\nBackup directory: {backup_dir}")
        
    except CaracalError:
        raise
    except Exception as e:
        logger.error(f"Failed to list backups: {e}", exc_info=True)
        click.echo(f"Error: Failed to list backups: {e}", err=True)
        raise SystemExit(1)


def _format_size(size_bytes: int) -> str:
    """Format size in human-readable format."""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} TB"


def _enforce_retention(backup_dir: Path, max_count: int):
    """Delete old backups to maintain retention count."""
    # Get all backup archives sorted by modification time
    backups = sorted(
        backup_dir.glob("caracal_backup_*.tar.gz"),
        key=lambda p: p.stat().st_mtime,
        reverse=True
    )
    
    # Delete excess backups
    for old_backup in backups[max_count:]:
        old_backup.unlink()
        # Also delete hash file if exists
        hash_file = old_backup.with_suffix('.tar.gz.sha256')
        if hash_file.exists():
            hash_file.unlink()
        logger.info(f"Deleted old backup: {old_backup}")
