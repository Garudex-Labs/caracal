"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for configuration encryption.

Provides commands for:
- Encrypting configuration values
- Decrypting configuration values
- Managing local key lifecycle
"""

import sys

import click

from caracal.logging_config import get_logger

logger = get_logger(__name__)


@click.group(name="config-encrypt")
def config_encrypt_group():
    """Encrypt and decrypt configuration values."""


@config_encrypt_group.command(name="status")
def key_status() -> None:
    """Show config encryption backend status."""
    try:
        from caracal.config.encryption import get_key_status

        status = get_key_status()
        click.echo("Config Encryption Key Status")
        click.echo(f"  Backend          : {status['backend']}")
        click.echo(f"  Vault URL        : {status.get('vault_url') or 'not configured'}")
        click.echo(f"  Vault project    : {status.get('vault_project') or 'default'}")
        click.echo(f"  Vault env        : {status.get('vault_environment') or 'dev'}")
        click.echo(f"  Configured       : {'yes' if status.get('configured') else 'no'}")
    except Exception as exc:
        click.echo(f"Error reading key status: {exc}", err=True)
        logger.error(f"Failed to read key status: {exc}", exc_info=True)
        sys.exit(1)


@config_encrypt_group.command(name="encrypt")
@click.argument("value")
def encrypt_value(value: str):
    """
    Encrypt a configuration value.
    
    The encrypted value can be used in configuration files with the format: ENC[...]
    
    Example:
        caracal config-encrypt encrypt "my_secret_password"
    """
    try:
        from caracal.config.encryption import encrypt_value as do_encrypt

        # Encrypt value
        encrypted = do_encrypt(value)

        click.echo(f"Encrypted value: {encrypted}")
        click.echo("")
        click.echo("Use this value in your configuration file:")
        click.echo(f"  password: {encrypted}")

    except Exception as exc:
        click.echo(f"Error encrypting value: {exc}", err=True)
        logger.error(f"Failed to encrypt value: {exc}", exc_info=True)
        sys.exit(1)


@config_encrypt_group.command(name="decrypt")
@click.argument("encrypted_value")
def decrypt_value(encrypted_value: str):
    """
    Decrypt an encrypted configuration value.
    
    Example:
        caracal config-encrypt decrypt "ENC[v2:...]"
    """
    try:
        from caracal.config.encryption import decrypt_value as do_decrypt

        # Decrypt value
        decrypted = do_decrypt(encrypted_value)

        click.echo(f"Decrypted value: {decrypted}")

    except Exception as exc:
        click.echo(f"Error decrypting value: {exc}", err=True)
        logger.error(f"Failed to decrypt value: {exc}", exc_info=True)
        sys.exit(1)


@config_encrypt_group.command(name="encrypt-file")
@click.argument("config_file", type=click.Path(exists=True))
@click.option(
    "--output",
    "-o",
    help="Output file (default: overwrite input file)",
)
@click.option(
    "--keys",
    "-k",
    multiple=True,
    help="Keys to encrypt (e.g., 'database.password')",
)
def encrypt_file(config_file: str, output: str, keys: tuple):
    """
    Encrypt specific values in a configuration file.
    
    Example:
        caracal config-encrypt encrypt-file config.yaml -k database.password
    """
    try:
        import yaml
        from caracal.config.encryption import encrypt_value as do_encrypt
        
        # Load configuration file
        with open(config_file, 'r') as f:
            config_data = yaml.safe_load(f)
        
        # Encrypt specified keys
        for key_path in keys:
            # Navigate to the key
            parts = key_path.split('.')
            current = config_data
            
            for part in parts[:-1]:
                if part not in current:
                    click.echo(f"Warning: Key path not found: {key_path}", err=True)
                    continue
                current = current[part]
            
            # Encrypt the value
            final_key = parts[-1]
            if final_key in current:
                value = current[final_key]
                if isinstance(value, str) and not value.startswith("ENC["):
                    encrypted = do_encrypt(value)
                    current[final_key] = encrypted
                    click.echo(f"✓ Encrypted: {key_path}")
                else:
                    click.echo(f"  Skipped (already encrypted or not a string): {key_path}")
            else:
                click.echo(f"Warning: Key not found: {key_path}", err=True)
        
        # Write output file
        output_file = output or config_file
        with open(output_file, 'w') as f:
            yaml.dump(config_data, f, default_flow_style=False, sort_keys=False)
        
        click.echo(f"✓ Configuration file encrypted: {output_file}")
        
    except Exception as exc:
        click.echo(f"Error encrypting file: {exc}", err=True)
        logger.error(f"Failed to encrypt file: {exc}", exc_info=True)
        sys.exit(1)


@config_encrypt_group.command(name="rotate-key")
@click.option(
    "--confirm",
    is_flag=True,
    help="Confirm rotation without interactive prompt.",
)
def rotate_key(confirm: bool) -> None:
    """Rotate local master key and re-wrap all configuration DEKs."""
    if not confirm:
        click.confirm(
            "Rotate local master key and re-wrap all config DEKs?",
            abort=True,
        )

    try:
        from caracal.config.encryption import rotate_master_key

        result = rotate_master_key(actor="cli")
        click.echo("Key rotation complete.")
        click.echo(f"  Re-wrapped DEKs : {result.rewrapped_deks}")
        click.echo(f"  Rotated at      : {result.rotated_at}")
    except Exception as exc:
        click.echo(f"Error rotating key: {exc}", err=True)
        logger.error(f"Failed to rotate key: {exc}", exc_info=True)
        sys.exit(1)
