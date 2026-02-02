"""
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
