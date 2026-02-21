"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for Merkle tree operations.

Provides commands for:
- Generating signing keys
- Verifying ledger integrity
- Exporting Merkle roots
"""

import os
import sys
from pathlib import Path

import click

from caracal.logging_config import get_logger
from caracal.merkle import KeyManager, generate_merkle_signing_key

logger = get_logger(__name__)


@click.group()
def merkle():
    """Merkle tree operations for ledger integrity."""
    pass


@merkle.command("generate-key")
@click.option(
    "--private-key",
    "-k",
    required=True,
    help="Path to store private key (e.g., /etc/caracal/keys/merkle-signing-key.pem)",
)
@click.option(
    "--public-key",
    "-p",
    required=True,
    help="Path to store public key (e.g., /etc/caracal/keys/merkle-signing-key.pub)",
)
@click.option(
    "--passphrase",
    "-P",
    help="Passphrase to encrypt private key (optional, can also use MERKLE_KEY_PASSPHRASE env var)",
)
@click.option(
    "--audit-log",
    "-a",
    help="Path to audit log file for key operations (optional)",
)
def generate_key(private_key, public_key, passphrase, audit_log):
    """
    Generate new ECDSA P-256 key pair for Merkle signing.
    
    This command generates a new cryptographic key pair for signing Merkle roots.
    The private key can be encrypted with a passphrase for additional security.
    
    Examples:
    
        # Generate key without passphrase
        caracal merkle generate-key -k /etc/caracal/keys/private.pem -p /etc/caracal/keys/public.pem
        
        # Generate key with passphrase
        caracal merkle generate-key -k /etc/caracal/keys/private.pem -p /etc/caracal/keys/public.pem -P "secure_passphrase"
        
        # Generate key with passphrase from environment variable
        export MERKLE_KEY_PASSPHRASE="secure_passphrase"
        caracal merkle generate-key -k /etc/caracal/keys/private.pem -p /etc/caracal/keys/public.pem
    """
    try:
        # Get passphrase from environment if not provided
        if not passphrase:
            passphrase = os.environ.get('MERKLE_KEY_PASSPHRASE')
        
        # Expand paths
        private_key_path = Path(private_key).expanduser()
        public_key_path = Path(public_key).expanduser()
        
        # Check if keys already exist
        if private_key_path.exists():
            click.echo(f"Error: Private key already exists: {private_key_path}", err=True)
            click.echo("Remove the existing key or use a different path.", err=True)
            sys.exit(1)
        
        if public_key_path.exists():
            click.echo(f"Error: Public key already exists: {public_key_path}", err=True)
            click.echo("Remove the existing key or use a different path.", err=True)
            sys.exit(1)
        
        # Generate key pair
        click.echo(f"Generating ECDSA P-256 key pair...")
        click.echo(f"  Private key: {private_key_path}")
        click.echo(f"  Public key: {public_key_path}")
        
        if passphrase:
            click.echo(f"  Encryption: Enabled")
        else:
            click.echo(f"  Encryption: Disabled (WARNING: Private key will be stored unencrypted)")
        
        generate_merkle_signing_key(
            str(private_key_path),
            str(public_key_path),
            passphrase=passphrase,
            audit_log_path=audit_log,
        )
        
        click.echo()
        click.echo("✓ Key pair generated successfully!")
        click.echo()
        click.echo("IMPORTANT:")
        click.echo("  1. Store the private key securely with restricted permissions (600)")
        click.echo("  2. Backup the private key to a secure location")
        click.echo("  3. Never share the private key")
        click.echo("  4. Update your Caracal configuration to use this key:")
        click.echo()
        click.echo("     merkle:")
        click.echo(f"       private_key_path: {private_key_path}")
        click.echo("       signing_backend: software")
        
        if passphrase:
            click.echo()
            click.echo("  5. Set the MERKLE_KEY_PASSPHRASE environment variable:")
            click.echo("     export MERKLE_KEY_PASSPHRASE='your_passphrase'")
        
    except Exception as e:
        click.echo(f"Error generating key pair: {e}", err=True)
        logger.error(f"Failed to generate key pair: {e}", exc_info=True)
        sys.exit(1)


@merkle.command("verify-key")
@click.option(
    "--private-key",
    "-k",
    required=True,
    help="Path to private key to verify",
)
@click.option(
    "--passphrase",
    "-P",
    help="Passphrase if key is encrypted (optional, can also use MERKLE_KEY_PASSPHRASE env var)",
)
def verify_key(private_key, passphrase):
    """
    Verify that a private key is valid and can be loaded.
    
    This command checks if a private key file is valid, properly formatted,
    and uses the correct algorithm (ECDSA P-256).
    
    Examples:
    
        # Verify unencrypted key
        caracal merkle verify-key -k /etc/caracal/keys/private.pem
        
        # Verify encrypted key with passphrase
        caracal merkle verify-key -k /etc/caracal/keys/private.pem -P "secure_passphrase"
    """
    try:
        # Get passphrase from environment if not provided
        if not passphrase:
            passphrase = os.environ.get('MERKLE_KEY_PASSPHRASE')
        
        # Expand path
        private_key_path = Path(private_key).expanduser()
        
        if not private_key_path.exists():
            click.echo(f"Error: Private key not found: {private_key_path}", err=True)
            sys.exit(1)
        
        click.echo(f"Verifying private key: {private_key_path}")
        
        # Verify key
        key_manager = KeyManager()
        is_valid = key_manager.verify_key(str(private_key_path), passphrase=passphrase)
        
        if is_valid:
            click.echo("✓ Key is valid and can be loaded successfully")
            click.echo("  Algorithm: ECDSA P-256")
            sys.exit(0)
        else:
            click.echo("✗ Key verification failed", err=True)
            click.echo("  The key may be corrupted, encrypted with wrong passphrase, or not ECDSA P-256", err=True)
            sys.exit(1)
    
    except Exception as e:
        click.echo(f"Error verifying key: {e}", err=True)
        logger.error(f"Failed to verify key: {e}", exc_info=True)
        sys.exit(1)


@merkle.command("rotate-key")
@click.option(
    "--old-key",
    "-o",
    required=True,
    help="Path to current private key",
)
@click.option(
    "--new-key",
    "-n",
    required=True,
    help="Path to store new private key",
)
@click.option(
    "--new-public-key",
    "-p",
    required=True,
    help="Path to store new public key",
)
@click.option(
    "--passphrase",
    "-P",
    help="Passphrase to encrypt new private key (optional)",
)
@click.option(
    "--no-backup",
    is_flag=True,
    help="Do not backup old key (WARNING: old key will be deleted)",
)
@click.option(
    "--audit-log",
    "-a",
    help="Path to audit log file for key operations (optional)",
)
def rotate_key(old_key, new_key, new_public_key, passphrase, no_backup, audit_log):
    """
    Rotate Merkle signing key.
    
    This command generates a new key pair and optionally backs up the old key.
    The old key is renamed with a timestamp suffix for backup.
    
    Examples:
    
        # Rotate key with backup
        caracal merkle rotate-key -o /etc/caracal/keys/old.pem -n /etc/caracal/keys/new.pem -p /etc/caracal/keys/new.pub
        
        # Rotate key without backup (WARNING: old key will be deleted)
        caracal merkle rotate-key -o /etc/caracal/keys/old.pem -n /etc/caracal/keys/new.pem -p /etc/caracal/keys/new.pub --no-backup
    """
    try:
        # Get passphrase from environment if not provided
        if not passphrase:
            passphrase = os.environ.get('MERKLE_KEY_PASSPHRASE')
        
        # Expand paths
        old_key_path = Path(old_key).expanduser()
        new_key_path = Path(new_key).expanduser()
        new_public_key_path = Path(new_public_key).expanduser()
        
        if not old_key_path.exists():
            click.echo(f"Error: Old key not found: {old_key_path}", err=True)
            sys.exit(1)
        
        if new_key_path.exists():
            click.echo(f"Error: New key already exists: {new_key_path}", err=True)
            sys.exit(1)
        
        # Confirm rotation
        click.echo(f"Rotating Merkle signing key:")
        click.echo(f"  Old key: {old_key_path}")
        click.echo(f"  New key: {new_key_path}")
        click.echo(f"  Backup old key: {'No (will be deleted)' if no_backup else 'Yes'}")
        click.echo()
        
        if no_backup:
            click.echo("WARNING: Old key will be permanently deleted!")
            if not click.confirm("Are you sure you want to continue?"):
                click.echo("Rotation cancelled.")
                sys.exit(0)
        
        # Rotate key
        key_manager = KeyManager(audit_log_path=audit_log)
        key_manager.rotate_key(
            str(old_key_path),
            str(new_key_path),
            str(new_public_key_path),
            passphrase=passphrase,
            backup_old_key=not no_backup,
        )
        
        click.echo()
        click.echo("✓ Key rotation successful!")
        click.echo()
        click.echo("IMPORTANT:")
        click.echo("  1. Update your Caracal configuration to use the new key")
        click.echo("  2. Restart all Caracal services")
        click.echo("  3. Verify the new key works before deleting backups")
    
    except Exception as e:
        click.echo(f"Error rotating key: {e}", err=True)
        logger.error(f"Failed to rotate key: {e}", exc_info=True)
        sys.exit(1)


@merkle.command("export-public-key")
@click.option(
    "--private-key",
    "-k",
    required=True,
    help="Path to private key",
)
@click.option(
    "--public-key",
    "-p",
    required=True,
    help="Path to store exported public key",
)
@click.option(
    "--passphrase",
    "-P",
    help="Passphrase if private key is encrypted (optional)",
)
def export_public_key(private_key, public_key, passphrase):
    """
    Export public key from private key.
    
    This command extracts the public key from a private key file.
    Useful if you lost the public key or need to distribute it.
    
    Examples:
    
        # Export public key
        caracal merkle export-public-key -k /etc/caracal/keys/private.pem -p /etc/caracal/keys/public.pem
    """
    try:
        # Get passphrase from environment if not provided
        if not passphrase:
            passphrase = os.environ.get('MERKLE_KEY_PASSPHRASE')
        
        # Expand paths
        private_key_path = Path(private_key).expanduser()
        public_key_path = Path(public_key).expanduser()
        
        if not private_key_path.exists():
            click.echo(f"Error: Private key not found: {private_key_path}", err=True)
            sys.exit(1)
        
        click.echo(f"Exporting public key from: {private_key_path}")
        click.echo(f"  Output: {public_key_path}")
        
        # Export public key
        key_manager = KeyManager()
        key_manager.export_public_key(
            str(private_key_path),
            str(public_key_path),
            passphrase=passphrase,
        )
        
        click.echo("✓ Public key exported successfully!")
    
    except Exception as e:
        click.echo(f"Error exporting public key: {e}", err=True)
        logger.error(f"Failed to export public key: {e}", exc_info=True)
        sys.exit(1)



@merkle.command("verify-batch")
@click.option(
    "--batch-id",
    "-b",
    required=True,
    help="Batch ID to verify (UUID)",
)
@click.option(
    "--config",
    "-c",
    help="Path to configuration file (default: ~/.caracal/config.yaml)",
)
def verify_batch(batch_id, config):
    """
    Verify integrity of a single Merkle batch.
    
    This command recomputes the Merkle root from ledger events and compares
    it with the stored signed root to detect tampering.
    
    Examples:
    
        # Verify a batch
        caracal merkle verify-batch -b 550e8400-e29b-41d4-a716-446655440000
        
        # Verify with custom config
        caracal merkle verify-batch -b 550e8400-e29b-41d4-a716-446655440000 -c /etc/caracal/config.yaml
    """
    import asyncio
    from uuid import UUID
    
    from caracal.config.settings import load_config
    from caracal.db.connection import get_async_session
    from caracal.merkle import create_merkle_signer, MerkleVerifier
    
    try:
        # Parse batch ID
        try:
            batch_uuid = UUID(batch_id)
        except ValueError:
            click.echo(f"Error: Invalid batch ID format: {batch_id}", err=True)
            click.echo("Batch ID must be a valid UUID", err=True)
            sys.exit(1)
        
        # Load configuration
        cfg = load_config(config)
        
        # Create signer for verification
        signer = create_merkle_signer(cfg.merkle)
        
        click.echo(f"Verifying batch: {batch_uuid}")
        click.echo()
        
        # Run verification
        async def run_verification():
            async with get_async_session(cfg.database) as session:
                verifier = MerkleVerifier(session, signer)
                result = await verifier.verify_batch(batch_uuid)
                return result
        
        result = asyncio.run(run_verification())
        
        # Display results
        if result.verified:
            click.echo("✓ Batch verification PASSED")
            click.echo()
            click.echo(f"  Batch ID: {result.batch_id}")
            click.echo(f"  Merkle root: {result.stored_root.hex()}")
            click.echo(f"  Signature: Valid")
            click.echo(f"  Integrity: Verified")
            sys.exit(0)
        else:
            click.echo("✗ Batch verification FAILED", err=True)
            click.echo()
            click.echo(f"  Batch ID: {result.batch_id}", err=True)
            click.echo(f"  Error: {result.error_message}", err=True)
            
            if result.stored_root and result.computed_root:
                click.echo(f"  Stored root: {result.stored_root.hex()}", err=True)
                click.echo(f"  Computed root: {result.computed_root.hex()}", err=True)
            
            click.echo(f"  Signature valid: {result.signature_valid}", err=True)
            sys.exit(1)
    
    except Exception as e:
        click.echo(f"Error verifying batch: {e}", err=True)
        logger.error(f"Failed to verify batch: {e}", exc_info=True)
        sys.exit(1)


@merkle.command("verify-range")
@click.option(
    "--start-time",
    "-s",
    required=True,
    help="Start time (ISO 8601 format, e.g., 2024-01-01T00:00:00)",
)
@click.option(
    "--end-time",
    "-e",
    required=True,
    help="End time (ISO 8601 format, e.g., 2024-01-31T23:59:59)",
)
@click.option(
    "--config",
    "-c",
    help="Path to configuration file (default: ~/.caracal/config.yaml)",
)
@click.option(
    "--verbose",
    "-v",
    is_flag=True,
    help="Show details of failed verifications",
)
def verify_range(start_time, end_time, config, verbose):
    """
    Verify integrity of all batches in a time range.
    
    This command verifies all Merkle batches created within the specified
    time range and provides a summary of results.
    
    Examples:
    
        # Verify batches for January 2024
        caracal merkle verify-range -s 2024-01-01T00:00:00 -e 2024-01-31T23:59:59
        
        # Verify with verbose output
        caracal merkle verify-range -s 2024-01-01T00:00:00 -e 2024-01-31T23:59:59 -v
    """
    import asyncio
    from datetime import datetime
    
    from caracal.config.settings import load_config
    from caracal.db.connection import get_async_session
    from caracal.merkle import create_merkle_signer, MerkleVerifier
    
    try:
        # Parse timestamps
        try:
            start_dt = datetime.fromisoformat(start_time)
            end_dt = datetime.fromisoformat(end_time)
        except ValueError as e:
            click.echo(f"Error: Invalid timestamp format: {e}", err=True)
            click.echo("Use ISO 8601 format: YYYY-MM-DDTHH:MM:SS", err=True)
            sys.exit(1)
        
        if start_dt >= end_dt:
            click.echo("Error: Start time must be before end time", err=True)
            sys.exit(1)
        
        # Load configuration
        cfg = load_config(config)
        
        # Create signer for verification
        signer = create_merkle_signer(cfg.merkle)
        
        click.echo(f"Verifying batches from {start_dt} to {end_dt}")
        click.echo()
        
        # Run verification
        async def run_verification():
            async with get_async_session(cfg.database) as session:
                verifier = MerkleVerifier(session, signer)
                summary = await verifier.verify_time_range(start_dt, end_dt)
                return summary
        
        summary = asyncio.run(run_verification())
        
        # Display summary
        click.echo("Verification Summary:")
        click.echo(f"  Total batches: {summary.total_batches}")
        click.echo(f"  Verified: {summary.verified_batches}")
        click.echo(f"  Failed: {summary.failed_batches}")
        click.echo()
        
        if summary.failed_batches == 0:
            click.echo("✓ All batches verified successfully!")
            sys.exit(0)
        else:
            click.echo(f"✗ {summary.failed_batches} batch(es) failed verification", err=True)
            
            if verbose and summary.verification_errors:
                click.echo()
                click.echo("Failed batches:", err=True)
                for error in summary.verification_errors:
                    click.echo(f"  - Batch {error.batch_id}: {error.error_message}", err=True)
            
            sys.exit(1)
    
    except Exception as e:
        click.echo(f"Error verifying time range: {e}", err=True)
        logger.error(f"Failed to verify time range: {e}", exc_info=True)
        sys.exit(1)


@merkle.command("verify-event")
@click.option(
    "--event-id",
    "-e",
    required=True,
    type=int,
    help="Ledger event ID to verify",
)
@click.option(
    "--config",
    "-c",
    help="Path to configuration file (default: ~/.caracal/config.yaml)",
)
def verify_event(event_id, config):
    """
    Verify that an event is included in the ledger.
    
    This command generates a Merkle proof for the event and verifies it
    against the signed Merkle root to prove the event is in the ledger.
    
    Examples:
    
        # Verify event inclusion
        caracal merkle verify-event -e 12345
        
        # Verify with custom config
        caracal merkle verify-event -e 12345 -c /etc/caracal/config.yaml
    """

    import asyncio
    from caracal.config.settings import load_config
    from caracal.db.connection import get_async_session
    from caracal.merkle import create_merkle_signer, MerkleVerifier
    
    try:
        if event_id < 0:
            click.echo(f"Error: Event ID must be non-negative", err=True)
            sys.exit(1)
        
        # Load configuration
        cfg = load_config(config)
        
        # Create signer for verification
        signer = create_merkle_signer(cfg.merkle)
        
        click.echo(f"Verifying inclusion of event: {event_id}")
        click.echo()
        
        # Run verification
        async def run_verification():
            async with get_async_session(cfg.database) as session:
                verifier = MerkleVerifier(session, signer)
                is_included = await verifier.verify_event_inclusion(event_id)
                return is_included
        
        is_included = asyncio.run(run_verification())
        
        # Display results
        if is_included:
            click.echo(f"✓ Event {event_id} is included in the ledger")
            click.echo("  Merkle proof verified successfully")
            sys.exit(0)
        else:
            click.echo(f"✗ Event {event_id} inclusion verification failed", err=True)
            click.echo("  Event may not exist or proof verification failed", err=True)
            sys.exit(1)
    
    except Exception as e:
        click.echo(f"Error verifying event: {e}", err=True)
        logger.error(f"Failed to verify event: {e}", exc_info=True)
        sys.exit(1)


@merkle.command("export-roots")
@click.option(
    "--output",
    "-o",
    required=True,
    help="Output file path (JSON format)",
)
@click.option(
    "--start-time",
    "-s",
    help="Start time (ISO 8601 format, optional)",
)
@click.option(
    "--end-time",
    "-e",
    help="End time (ISO 8601 format, optional)",
)
@click.option(
    "--config",
    "-c",
    help="Path to configuration file (default: ~/.caracal/config.yaml)",
)
def export_roots(output, start_time, end_time, config):
    """
    Export signed Merkle roots for external verification.
    
    This command exports all Merkle roots (or roots in a time range) to a
    JSON file for external verification or archival.
    
    Examples:
    
        # Export all roots
        caracal merkle export-roots -o merkle_roots.json
        
        # Export roots for a time range
        caracal merkle export-roots -o merkle_roots.json -s 2024-01-01T00:00:00 -e 2024-01-31T23:59:59
    
    """
    import asyncio
    import json
    from datetime import datetime
    from pathlib import Path
    
    from sqlalchemy import select
    
    from caracal.config.settings import load_config
    from caracal.db.connection import get_async_session
    from caracal.db.models import MerkleRoot
    
    try:
        # Parse timestamps if provided
        start_dt = None
        end_dt = None
        
        if start_time:
            try:
                start_dt = datetime.fromisoformat(start_time)
            except ValueError as e:
                click.echo(f"Error: Invalid start time format: {e}", err=True)
                sys.exit(1)
        
        if end_time:
            try:
                end_dt = datetime.fromisoformat(end_time)
            except ValueError as e:
                click.echo(f"Error: Invalid end time format: {e}", err=True)
                sys.exit(1)
        
        if start_dt and end_dt and start_dt >= end_dt:
            click.echo("Error: Start time must be before end time", err=True)
            sys.exit(1)
        
        # Load configuration
        cfg = load_config(config)
        
        # Expand output path
        output_path = Path(output).expanduser()
        
        if output_path.exists():
            if not click.confirm(f"Output file {output_path} already exists. Overwrite?"):
                click.echo("Export cancelled.")
                sys.exit(0)
        
        click.echo("Exporting Merkle roots...")
        if start_dt and end_dt:
            click.echo(f"  Time range: {start_dt} to {end_dt}")
        elif start_dt:
            click.echo(f"  From: {start_dt}")
        elif end_dt:
            click.echo(f"  Until: {end_dt}")
        else:
            click.echo("  All roots")
        
        click.echo(f"  Output: {output_path}")
        click.echo()
        
        # Export roots
        async def export():
            async with get_async_session(cfg.database) as session:
                # Build query
                stmt = select(MerkleRoot)
                
                if start_dt:
                    stmt = stmt.where(MerkleRoot.created_at >= start_dt)
                if end_dt:
                    stmt = stmt.where(MerkleRoot.created_at <= end_dt)
                
                stmt = stmt.order_by(MerkleRoot.created_at)
                
                # Execute query
                result = await session.execute(stmt)
                roots = result.scalars().all()
                
                # Convert to JSON-serializable format
                roots_data = []
                for root in roots:
                    roots_data.append({
                        "root_id": str(root.root_id),
                        "batch_id": str(root.batch_id),
                        "merkle_root": root.merkle_root,
                        "signature": root.signature,
                        "event_count": root.event_count,
                        "first_event_id": root.first_event_id,
                        "last_event_id": root.last_event_id,
                        "created_at": root.created_at.isoformat(),
                    })
                
                return roots_data
        
        roots_data = asyncio.run(export())
        
        # Write to file
        with open(output_path, 'w') as f:
            json.dump({
                "export_timestamp": datetime.utcnow().isoformat(),
                "start_time": start_dt.isoformat() if start_dt else None,
                "end_time": end_dt.isoformat() if end_dt else None,
                "total_roots": len(roots_data),
                "roots": roots_data,
            }, f, indent=2)
        
        click.echo(f"✓ Exported {len(roots_data)} Merkle root(s) to {output_path}")
    
    except Exception as e:
        click.echo(f"Error exporting roots: {e}", err=True)
        logger.error(f"Failed to export roots: {e}", exc_info=True)
        sys.exit(1)



@merkle.command("backfill")
@click.option(
    "--source-version",
    "-s",
    default="v0.2",
    help="Source version to backfill from (default: v0.2)",
)
@click.option(
    "--batch-size",
    "-b",
    default=1000,
    type=int,
    help="Number of events per batch (default: 1000)",
)
@click.option(
    "--dry-run",
    "-d",
    is_flag=True,
    help="Validate without writing to database",
)
@click.option(
    "--config",
    "-c",
    help="Path to configuration file (default: ~/.caracal/config.yaml)",
)
def backfill(source_version, batch_size, dry_run, config):
    """
    Backfill v0.2 ledger events with Merkle roots.
    
    This command retroactively computes Merkle roots for ledger events that
    were created before Merkle tree support was added. The process groups
    events into batches, computes Merkle trees, signs the roots, and stores
    them with source='migration' to distinguish from live batches.
    
    IMPORTANT: Migration batches have reduced integrity guarantees because
    signatures are created retroactively (signature timestamp > event timestamp).
    
    Examples:
    
        # Dry run to validate without writing
        caracal merkle backfill --dry-run
        
        # Backfill with default batch size (1000 events)
        caracal merkle backfill
        
        # Backfill with custom batch size
        caracal merkle backfill --batch-size 5000
        
        # Backfill from specific version
        caracal merkle backfill --source-version v0.2
    """
    import asyncio
    from caracal.config.settings import load_config
    from caracal.db.connection import get_session
    from caracal.merkle import create_merkle_signer
    from caracal.merkle.backfill import LedgerBackfillManager
    
    try:
        if batch_size < 1:
            click.echo("Error: Batch size must be at least 1", err=True)
            sys.exit(1)
        
        # Load configuration
        cfg = load_config(config)
        
        # Create signer
        signer = create_merkle_signer(cfg.merkle)
        
        click.echo("Ledger Backfill for v0.2 Events")
        click.echo("=" * 50)
        click.echo()
        click.echo(f"  Source version: {source_version}")
        click.echo(f"  Batch size: {batch_size} events")
        click.echo(f"  Mode: {'DRY RUN (no changes will be made)' if dry_run else 'LIVE (database will be modified)'}")
        click.echo()
        
        if dry_run:
            click.echo("Running in DRY RUN mode - no changes will be made to the database")
        else:
            click.echo("WARNING: This operation will modify the database!")
            click.echo("  - Merkle roots will be created with source='migration'")
            click.echo("  - Ledger events will be updated with merkle_root_id")
            click.echo()
            if not click.confirm("Do you want to continue?"):
                click.echo("Backfill cancelled.")
                sys.exit(0)
        
        click.echo()
        click.echo("Starting backfill process...")
        click.echo()
        
        # Run backfill
        with get_session(cfg.database) as session:
            manager = LedgerBackfillManager(
                db_session=session,
                merkle_signer=signer,
                batch_size=batch_size,
                dry_run=dry_run
            )
            
            result = manager.backfill_v02_events()
        
        # Display results
        click.echo()
        click.echo("Backfill Complete")
        click.echo("=" * 50)
        click.echo()
        
        if result.success:
            click.echo("✓ Backfill completed successfully!")
            click.echo()
            click.echo(f"  Events processed: {result.total_events_processed}")
            click.echo(f"  Batches created: {result.total_batches_created}")
            click.echo(f"  Duration: {result.duration_seconds:.2f} seconds")
            
            if dry_run:
                click.echo()
                click.echo("DRY RUN: No changes were made to the database")
                click.echo("Run without --dry-run to apply changes")
            else:
                click.echo()
                click.echo("IMPORTANT:")
                click.echo("  1. Migration batches have reduced integrity guarantees")
                click.echo("  2. Signatures were created retroactively (after events)")
                click.echo("  3. Run 'caracal merkle verify-backfill' to validate results")
            
            sys.exit(0)
        else:
            click.echo("✗ Backfill failed!", err=True)
            click.echo()
            click.echo(f"  Events processed: {result.total_events_processed}", err=True)
            click.echo(f"  Batches created: {result.total_batches_created}", err=True)
            click.echo(f"  Duration: {result.duration_seconds:.2f} seconds", err=True)
            click.echo(f"  Errors: {len(result.errors)}", err=True)
            
            if result.errors:
                click.echo()
                click.echo("Errors:", err=True)
                for error in result.errors[:10]:  # Show first 10 errors
                    click.echo(f"  - {error}", err=True)
                
                if len(result.errors) > 10:
                    click.echo(f"  ... and {len(result.errors) - 10} more errors", err=True)
            
            sys.exit(1)
    
    except Exception as e:
        click.echo(f"Error during backfill: {e}", err=True)
        logger.error(f"Backfill failed: {e}", exc_info=True)
        sys.exit(1)


@merkle.command("backfill-status")
@click.option(
    "--config",
    "-c",
    help="Path to configuration file (default: ~/.caracal/config.yaml)",
)
def backfill_status(config):
    """
    Show status of ledger backfill operation.
    
    This command displays the current progress of a running backfill operation,
    including phase, event counts, batch counts, and estimated time remaining.
    
    Examples:
    
        # Check backfill status
        caracal merkle backfill-status
    """
    from caracal.config.settings import load_config
    from caracal.db.connection import get_session
    from sqlalchemy import func, select
    from caracal.db.models import LedgerEvent, MerkleRoot
    
    try:
        # Load configuration
        cfg = load_config(config)
        
        click.echo("Ledger Backfill Status")
        click.echo("=" * 50)
        click.echo()
        
        # Query database for status
        with get_session(cfg.database) as session:
            # Count total events
            total_events = session.query(func.count(LedgerEvent.event_id)).scalar()
            
            # Count events without merkle_root_id
            events_without_root = session.query(func.count(LedgerEvent.event_id)).filter(
                LedgerEvent.merkle_root_id.is_(None)
            ).scalar()
            
            # Count events with merkle_root_id
            events_with_root = total_events - events_without_root
            
            # Count migration batches
            migration_batches = session.query(func.count(MerkleRoot.root_id)).filter(
                MerkleRoot.source == "migration"
            ).scalar()
            
            # Count live batches
            live_batches = session.query(func.count(MerkleRoot.root_id)).filter(
                MerkleRoot.source == "live"
            ).scalar()
        
        # Display status
        click.echo(f"Total events: {total_events}")
        click.echo(f"  With Merkle root: {events_with_root} ({events_with_root * 100 // total_events if total_events > 0 else 0}%)")
        click.echo(f"  Without Merkle root: {events_without_root} ({events_without_root * 100 // total_events if total_events > 0 else 0}%)")
        click.echo()
        click.echo(f"Merkle batches:")
        click.echo(f"  Live batches: {live_batches}")
        click.echo(f"  Migration batches: {migration_batches}")
        click.echo()
        
        if events_without_root == 0:
            click.echo("✓ All events have been backfilled")
        else:
            click.echo(f"⚠ {events_without_root} event(s) still need to be backfilled")
            click.echo()
            click.echo("Run 'caracal merkle backfill' to backfill remaining events")
    
    except Exception as e:
        click.echo(f"Error checking backfill status: {e}", err=True)
        logger.error(f"Failed to check backfill status: {e}", exc_info=True)
        sys.exit(1)


@merkle.command("verify-backfill")
@click.option(
    "--config",
    "-c",
    help="Path to configuration file (default: ~/.caracal/config.yaml)",
)
@click.option(
    "--verbose",
    "-v",
    is_flag=True,
    help="Show details of failed verifications",
)
def verify_backfill(config, verbose):
    """
    Verify integrity of all migration batches (v0.2 backfill).
    
    This command verifies all Merkle batches created during the v0.2 to v0.3
    migration process. Migration batches have reduced integrity guarantees
    because signatures were created retroactively.
    
    Examples:
    
        # Verify all migration batches
        caracal merkle verify-backfill
        
        # Verify with verbose output
        caracal merkle verify-backfill -v
    """
    import asyncio
    
    from caracal.config.settings import load_config
    from caracal.db.connection import get_async_session
    from caracal.merkle import create_merkle_signer, MerkleVerifier
    
    try:
        # Load configuration
        cfg = load_config(config)
        
        # Create signer for verification
        signer = create_merkle_signer(cfg.merkle)
        
        click.echo("Verifying Migration Batches (v0.2 Backfill)")
        click.echo("=" * 50)
        click.echo()
        click.echo("NOTE: Migration batches have reduced integrity guarantees.")
        click.echo("Signatures were created retroactively during v0.2 to v0.3 migration.")
        click.echo()
        
        # Run verification
        async def run_verification():
            async with get_async_session(cfg.database) as session:
                verifier = MerkleVerifier(session, signer)
                summary = await verifier.verify_backfill()
                return summary
        
        summary = asyncio.run(run_verification())
        
        # Display summary
        click.echo("Verification Summary:")
        click.echo(f"  Total migration batches: {summary.total_batches}")
        click.echo(f"  Verified: {summary.verified_batches}")
        click.echo(f"  Failed: {summary.failed_batches}")
        click.echo()
        
        if summary.failed_batches == 0:
            click.echo("✓ All migration batches verified successfully!")
            sys.exit(0)
        else:
            click.echo(f"✗ {summary.failed_batches} migration batch(es) failed verification", err=True)
            
            if verbose and summary.verification_errors:
                click.echo()
                click.echo("Failed batches:", err=True)
                for error in summary.verification_errors:
                    click.echo(f"  - Batch {error.batch_id}: {error.error_message}", err=True)
            
            sys.exit(1)
    
    except Exception as e:
        click.echo(f"Error verifying migration batches: {e}", err=True)
        logger.error(f"Failed to verify migration batches: {e}", exc_info=True)
        sys.exit(1)


@merkle.command("list-batches")
@click.option(
    "--source",
    "-s",
    type=click.Choice(["all", "live", "migration"]),
    default="all",
    help="Filter by batch source (default: all)",
)
@click.option(
    "--limit",
    "-l",
    default=20,
    type=int,
    help="Maximum number of batches to display (default: 20)",
)
@click.option(
    "--config",
    "-c",
    help="Path to configuration file (default: ~/.caracal/config.yaml)",
)
def list_batches(source, limit, config):
    """
    List Merkle batches with optional filtering.
    
    This command lists Merkle batches, optionally filtered by source
    (live or migration). Useful for inspecting backfill results.
    
    Examples:
    
        # List all batches
        caracal merkle list-batches
        
        # List only migration batches
        caracal merkle list-batches --source migration
        
        # List only live batches
        caracal merkle list-batches --source live
        
        # List first 50 batches
        caracal merkle list-batches --limit 50
    """
    import asyncio
    from sqlalchemy import select
    
    from caracal.config.settings import load_config
    from caracal.db.connection import get_async_session
    from caracal.db.models import MerkleRoot
    
    try:
        if limit < 1:
            click.echo("Error: Limit must be at least 1", err=True)
            sys.exit(1)
        
        # Load configuration
        cfg = load_config(config)
        
        click.echo(f"Merkle Batches (source: {source}, limit: {limit})")
        click.echo("=" * 80)
        click.echo()
        
        # Query batches
        async def query_batches():
            async with get_async_session(cfg.database) as session:
                stmt = select(MerkleRoot)
                
                if source != "all":
                    stmt = stmt.where(MerkleRoot.source == source)
                
                stmt = stmt.order_by(MerkleRoot.created_at.desc()).limit(limit)
                
                result = await session.execute(stmt)
                return result.scalars().all()
        
        batches = asyncio.run(query_batches())
        
        if not batches:
            click.echo(f"No batches found (source: {source})")
            sys.exit(0)
        
        # Display batches
        click.echo(f"{'Batch ID':<38} {'Source':<10} {'Events':<12} {'Created':<20}")
        click.echo("-" * 80)
        
        for batch in batches:
            event_range = f"{batch.first_event_id}-{batch.last_event_id}"
            created = batch.created_at.strftime("%Y-%m-%d %H:%M:%S")
            click.echo(f"{str(batch.batch_id):<38} {batch.source:<10} {event_range:<12} {created:<20}")
        
        click.echo()
        click.echo(f"Showing {len(batches)} batch(es)")
        
        if len(batches) == limit:
            click.echo(f"(Limited to {limit} batches, use --limit to show more)")
    
    except Exception as e:
        click.echo(f"Error listing batches: {e}", err=True)
        logger.error(f"Failed to list batches: {e}", exc_info=True)
        sys.exit(1)
