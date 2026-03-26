"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Backup and restore commands for Caracal Core.

Provides CLI commands for creating, restoring, and listing backups.
Implements Requirement 8.8-13 and 11.13-15 from caracal-core spec.
"""

import os
import hashlib
import subprocess
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
    backup_dir.mkdir(sources=True, exist_ok=True)
    try:
        backup_dir.chmod(0o700)
    except Exception:
        pass
    return backup_dir


def _pg_env(config) -> dict:
    env = os.environ.copy()
    if getattr(config.database, "password", None):
        env["PGPASSWORD"] = str(config.database.password)
    return env


def _run_pg_dump(config, output_file: Path) -> None:
    cmd = [
        "pg_dump",
        "-h", str(config.database.host),
        "-p", str(config.database.port),
        "-U", str(config.database.user),
        "-d", str(config.database.database),
        "-F", "c",
        "-Z", "9",
        "-f", str(output_file),
        "--no-owner",
        "--no-privileges",
    ]
    schema = getattr(config.database, "schema", "")
    if schema:
        cmd.extend(["-n", schema])

    result = subprocess.run(cmd, env=_pg_env(config), capture_output=True, text=True)
    if result.returncode != 0:
        raise CaracalError(f"pg_dump failed: {result.stderr.strip() or result.stdout.strip()}")


def _run_pg_restore(config, backup_file: Path) -> None:
    cmd = [
        "pg_restore",
        "-h", str(config.database.host),
        "-p", str(config.database.port),
        "-U", str(config.database.user),
        "-d", str(config.database.database),
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        str(backup_file),
    ]

    result = subprocess.run(cmd, env=_pg_env(config), capture_output=True, text=True)
    if result.returncode != 0:
        raise CaracalError(f"pg_restore failed: {result.stderr.strip() or result.stdout.strip()}")


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
    Create a PostgreSQL backup dump for the active Caracal workspace/schema.
    """
    try:
        config = get_config(ctx)
        backup_dir = get_backup_dir(config)
        
        # Generate backup name
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_name = name or f"caracal_backup_{timestamp}"
        archive_path = backup_dir / f"{backup_name}.dump"

        _run_pg_dump(config, archive_path)
        archive_path.chmod(0o600)
        
        # Calculate archive hash for integrity verification
        archive_hash = calculate_file_hash(archive_path)
        hash_file = archive_path.with_suffix('.dump.sha256')
        hash_file.write_text(f"{archive_hash}  {archive_path.name}\n")
        hash_file.chmod(0o600)
        
        # Get archive size
        archive_size = archive_path.stat().st_size
        size_str = _format_size(archive_size)
        
        # Enforce backup retention
        _enforce_retention(backup_dir, config.storage.backup_count)
        
        click.echo(f"✓ Backup created: {archive_path}")
        click.echo(f"  Size: {size_str}")
        click.echo("  Backend: PostgreSQL")
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
    Restore Caracal PostgreSQL data from a backup dump.

    Validates dump integrity and creates a safety dump first (unless disabled).
    """
    try:
        config = get_config(ctx)
        
        # Validate archive integrity
        hash_file = backup_file.with_suffix('.dump.sha256')
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
        
        click.echo(f"\nBackup file: {backup_file.name}")
        
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
            safety_path = backup_dir / f"{safety_name}.dump"
            _run_pg_dump(config, safety_path)
            click.echo(f"✓ Safety backup created: {safety_path}")

        _run_pg_restore(config, backup_file)
        
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
        
        # Find all backup dumps
        backups = []
        for archive_path in sorted(backup_dir.glob("*.dump"), reverse=True):
            stat = archive_path.stat()
            
            # Check for hash file
            hash_file = archive_path.with_suffix('.dump.sha256')
            has_hash = hash_file.exists()
            
            backups.append({
                "name": archive_path.stem,
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
        backup_dir.glob("caracal_backup_*.dump"),
        key=lambda p: p.stat().st_mtime,
        reverse=True
    )
    
    # Delete excess backups
    for old_backup in backups[max_count:]:
        old_backup.unlink()
        # Also delete hash file if exists
        hash_file = old_backup.with_suffix('.dump.sha256')
        if hash_file.exists():
            hash_file.unlink()
        logger.info(f"Deleted old backup: {old_backup}")
