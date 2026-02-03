"""
CLI commands for Merkle key management.

Provides commands for:
- Generating new key pairs
- Rotating keys
- Verifying keys
- Exporting public keys
"""

import sys
from pathlib import Path

import click

from caracal.logging_config import get_logger
from caracal.merkle.key_management import KeyManager

logger = get_logger(__name__)


@click.group(name="keys")
def keys_group():
    """Manage Merkle signing keys."""
    pass


@keys_group.command(name="generate")
@click.option(
    "--private-key",
    "-p",
    required=True,
    help="Path to store private key",
)
@click.option(
    "--public-key",
    "-u",
    required=True,
    help="Path to store public key",
)
@click.option(
    "--passphrase",
    "-P",
    help="Passphrase to encrypt private key (prompted if not provided)",
)
@click.option(
    "--audit-log",
    "-a",
    help="Path to audit log file",
)
def generate_key(private_key: str, public_key: str, passphrase: str, audit_log: str):
    """
    Generate new ECDSA P-256 key pair for Merkle signing.
    
    Example:
        caracal keys generate -p /etc/caracal/keys/merkle-key.pem -u /etc/caracal/keys/merkle-key.pub
    """
    try:
        # Prompt for passphrase if not provided
        if not passphrase:
            passphrase = click.prompt(
                "Enter passphrase to encrypt private key (leave empty for no encryption)",
                hide_input=True,
                default="",
                show_default=False,
            )
            
            if passphrase:
                passphrase_confirm = click.prompt(
                    "Confirm passphrase",
                    hide_input=True,
                )
                
                if passphrase != passphrase_confirm:
                    click.echo("Error: Passphrases do not match", err=True)
                    sys.exit(1)
        
        # Use None for empty passphrase
        if passphrase == "":
            passphrase = None
        
        # Generate key pair
        key_manager = KeyManager(audit_log_path=audit_log)
        key_manager.generate_key_pair(
            private_key,
            public_key,
            passphrase=passphrase,
        )
        
        click.echo(f"✓ Generated key pair:")
        click.echo(f"  Private key: {private_key}")
        click.echo(f"  Public key: {public_key}")
        
        if passphrase:
            click.echo(f"  Private key is encrypted with passphrase")
        else:
            click.echo(f"  WARNING: Private key is NOT encrypted")
        
        if audit_log:
            click.echo(f"  Audit log: {audit_log}")
        
    except FileExistsError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Error generating key pair: {e}", err=True)
        logger.error(f"Failed to generate key pair: {e}", exc_info=True)
        sys.exit(1)


@keys_group.command(name="rotate")
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
    "-u",
    required=True,
    help="Path to store new public key",
)
@click.option(
    "--passphrase",
    "-P",
    help="Passphrase to encrypt new private key (prompted if not provided)",
)
@click.option(
    "--no-backup",
    is_flag=True,
    help="Do not backup old key (WARNING: old key will be deleted)",
)
@click.option(
    "--audit-log",
    "-a",
    help="Path to audit log file",
)
def rotate_key(
    old_key: str,
    new_key: str,
    new_public_key: str,
    passphrase: str,
    no_backup: bool,
    audit_log: str,
):
    """
    Rotate Merkle signing key.
    
    Generates a new key pair and backs up the old key (unless --no-backup is specified).
    
    Example:
        caracal keys rotate -o /etc/caracal/keys/merkle-key.pem -n /etc/caracal/keys/merkle-key-new.pem -u /etc/caracal/keys/merkle-key-new.pub
    """
    try:
        # Verify old key exists
        if not Path(old_key).expanduser().exists():
            click.echo(f"Error: Old key not found: {old_key}", err=True)
            sys.exit(1)
        
        # Prompt for passphrase if not provided
        if not passphrase:
            passphrase = click.prompt(
                "Enter passphrase to encrypt new private key (leave empty for no encryption)",
                hide_input=True,
                default="",
                show_default=False,
            )
            
            if passphrase:
                passphrase_confirm = click.prompt(
                    "Confirm passphrase",
                    hide_input=True,
                )
                
                if passphrase != passphrase_confirm:
                    click.echo("Error: Passphrases do not match", err=True)
                    sys.exit(1)
        
        # Use None for empty passphrase
        if passphrase == "":
            passphrase = None
        
        # Confirm rotation
        if no_backup:
            click.echo("WARNING: Old key will be DELETED without backup!")
            if not click.confirm("Are you sure you want to continue?"):
                click.echo("Rotation cancelled")
                sys.exit(0)
        
        # Rotate key
        key_manager = KeyManager(audit_log_path=audit_log)
        key_manager.rotate_key(
            old_key,
            new_key,
            new_public_key,
            passphrase=passphrase,
            backup_old_key=not no_backup,
        )
        
        click.echo(f"✓ Key rotation completed:")
        click.echo(f"  New private key: {new_key}")
        click.echo(f"  New public key: {new_public_key}")
        
        if not no_backup:
            click.echo(f"  Old key backed up")
        else:
            click.echo(f"  Old key deleted (no backup)")
        
        if audit_log:
            click.echo(f"  Audit log: {audit_log}")
        
    except FileNotFoundError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except FileExistsError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Error rotating key: {e}", err=True)
        logger.error(f"Failed to rotate key: {e}", exc_info=True)
        sys.exit(1)


@keys_group.command(name="verify")
@click.option(
    "--private-key",
    "-p",
    required=True,
    help="Path to private key",
)
@click.option(
    "--passphrase",
    "-P",
    help="Passphrase if private key is encrypted (prompted if not provided)",
)
@click.option(
    "--audit-log",
    "-a",
    help="Path to audit log file",
)
def verify_key(private_key: str, passphrase: str, audit_log: str):
    """
    Verify that a private key is valid.
    
    Example:
        caracal keys verify -p /etc/caracal/keys/merkle-key.pem
    """
    try:
        # Check if key exists
        if not Path(private_key).expanduser().exists():
            click.echo(f"Error: Key not found: {private_key}", err=True)
            sys.exit(1)
        
        # Prompt for passphrase if not provided
        if not passphrase:
            passphrase = click.prompt(
                "Enter passphrase (leave empty if key is not encrypted)",
                hide_input=True,
                default="",
                show_default=False,
            )
        
        # Use None for empty passphrase
        if passphrase == "":
            passphrase = None
        
        # Verify key
        key_manager = KeyManager(audit_log_path=audit_log)
        is_valid = key_manager.verify_key(private_key, passphrase=passphrase)
        
        if is_valid:
            click.echo(f"✓ Key is valid: {private_key}")
            sys.exit(0)
        else:
            click.echo(f"✗ Key is invalid: {private_key}", err=True)
            sys.exit(1)
        
    except Exception as e:
        click.echo(f"Error verifying key: {e}", err=True)
        logger.error(f"Failed to verify key: {e}", exc_info=True)
        sys.exit(1)


@keys_group.command(name="export-public")
@click.option(
    "--private-key",
    "-p",
    required=True,
    help="Path to private key",
)
@click.option(
    "--public-key",
    "-u",
    required=True,
    help="Path to store public key",
)
@click.option(
    "--passphrase",
    "-P",
    help="Passphrase if private key is encrypted (prompted if not provided)",
)
@click.option(
    "--audit-log",
    "-a",
    help="Path to audit log file",
)
def export_public_key(private_key: str, public_key: str, passphrase: str, audit_log: str):
    """
    Export public key from private key.
    
    Example:
        caracal keys export-public -p /etc/caracal/keys/merkle-key.pem -u /etc/caracal/keys/merkle-key.pub
    """
    try:
        # Check if private key exists
        if not Path(private_key).expanduser().exists():
            click.echo(f"Error: Private key not found: {private_key}", err=True)
            sys.exit(1)
        
        # Prompt for passphrase if not provided
        if not passphrase:
            passphrase = click.prompt(
                "Enter passphrase (leave empty if key is not encrypted)",
                hide_input=True,
                default="",
                show_default=False,
            )
        
        # Use None for empty passphrase
        if passphrase == "":
            passphrase = None
        
        # Export public key
        key_manager = KeyManager(audit_log_path=audit_log)
        key_manager.export_public_key(
            private_key,
            public_key,
            passphrase=passphrase,
        )
        
        click.echo(f"✓ Exported public key:")
        click.echo(f"  From: {private_key}")
        click.echo(f"  To: {public_key}")
        
        if audit_log:
            click.echo(f"  Audit log: {audit_log}")
        
    except FileNotFoundError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Error exporting public key: {e}", err=True)
        logger.error(f"Failed to export public key: {e}", exc_info=True)
        sys.exit(1)
