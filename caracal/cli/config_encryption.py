"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for configuration encryption.

Provides commands for:
- Encrypting configuration values
- Decrypting configuration values
- Generating master passwords
"""

import sys

import click

from caracal.logging_config import get_logger

logger = get_logger(__name__)


@click.group(name="config-encrypt")
def config_encrypt_group():
    """Encrypt and decrypt configuration values."""
    pass


@config_encrypt_group.command(name="generate-password")
@click.option(
    "--save",
    "-s",
    help="Save password to file",
)
def generate_password(save: str):
    """
    Generate a secure master password for configuration encryption.
    
    Example:
        caracal config-encrypt generate-password
        caracal config-encrypt generate-password --save ~/.caracal/master_password
    """
    try:
        from caracal.config.encryption import generate_master_password, save_master_password
        
        # Generate password
        password = generate_master_password()
        
        # Save if requested
        if save:
            save_master_password(password, save)
            click.echo(f"✓ Master password generated and saved to: {save}")
            click.echo(f"  Set environment variable: export CARACAL_MASTER_PASSWORD=$(cat {save})")
        else:
            click.echo(f"Master password: {password}")
            click.echo(f"  Set environment variable: export CARACAL_MASTER_PASSWORD='{password}'")
        
        click.echo("")
        click.echo("IMPORTANT: Keep this password secure!")
        click.echo("You will need it to decrypt configuration values.")
        
    except Exception as e:
        click.echo(f"Error generating password: {e}", err=True)
        logger.error(f"Failed to generate password: {e}", exc_info=True)
        sys.exit(1)


@config_encrypt_group.command(name="encrypt")
@click.argument("value")
@click.option(
    "--password",
    "-p",
    help="Master password (prompted if not provided, or from CARACAL_MASTER_PASSWORD env var)",
)
def encrypt_value(value: str, password: str):
    """
    Encrypt a configuration value.
    
    The encrypted value can be used in configuration files with the format: ENC[...]
    
    Example:
        caracal config-encrypt encrypt "my_secret_password"
        caracal config-encrypt encrypt "my_secret_password" --password "master_password"
    """
    try:
        from caracal.config.encryption import encrypt_value as do_encrypt
        
        # Prompt for password if not provided and not in env var
        if not password:
            import os
            password = os.environ.get("CARACAL_MASTER_PASSWORD")
            
            if not password:
                password = click.prompt(
                    "Enter master password",
                    hide_input=True,
                )
        
        # Encrypt value
        encrypted = do_encrypt(value, master_password=password)
        
        click.echo(f"Encrypted value: {encrypted}")
        click.echo("")
        click.echo("Use this value in your configuration file:")
        click.echo(f"  password: {encrypted}")
        
    except Exception as e:
        click.echo(f"Error encrypting value: {e}", err=True)
        logger.error(f"Failed to encrypt value: {e}", exc_info=True)
        sys.exit(1)


@config_encrypt_group.command(name="decrypt")
@click.argument("encrypted_value")
@click.option(
    "--password",
    "-p",
    help="Master password (prompted if not provided, or from CARACAL_MASTER_PASSWORD env var)",
)
def decrypt_value(encrypted_value: str, password: str):
    """
    Decrypt an encrypted configuration value.
    
    Example:
        caracal config-encrypt decrypt "ENC[...]"
        caracal config-encrypt decrypt "ENC[...]" --password "master_password"
    """
    try:
        from caracal.config.encryption import decrypt_value as do_decrypt
        
        # Prompt for password if not provided and not in env var
        if not password:
            import os
            password = os.environ.get("CARACAL_MASTER_PASSWORD")
            
            if not password:
                password = click.prompt(
                    "Enter master password",
                    hide_input=True,
                )
        
        # Decrypt value
        decrypted = do_decrypt(encrypted_value, master_password=password)
        
        click.echo(f"Decrypted value: {decrypted}")
        
    except Exception as e:
        click.echo(f"Error decrypting value: {e}", err=True)
        logger.error(f"Failed to decrypt value: {e}", exc_info=True)
        sys.exit(1)


@config_encrypt_group.command(name="encrypt-file")
@click.argument("config_file", type=click.Path(exists=True))
@click.option(
    "--output",
    "-o",
    help="Output file (default: overwrite input file)",
)
@click.option(
    "--password",
    "-p",
    help="Master password (prompted if not provided, or from CARACAL_MASTER_PASSWORD env var)",
)
@click.option(
    "--keys",
    "-k",
    multiple=True,
    help="Keys to encrypt (e.g., 'database.password')",
)
def encrypt_file(config_file: str, output: str, password: str, keys: tuple):
    """
    Encrypt specific values in a configuration file.
    
    Example:
        caracal config-encrypt encrypt-file config.yaml -k database.password
    """
    try:
        import yaml
        from caracal.config.encryption import encrypt_value as do_encrypt
        
        # Prompt for password if not provided and not in env var
        if not password:
            import os
            password = os.environ.get("CARACAL_MASTER_PASSWORD")
            
            if not password:
                password = click.prompt(
                    "Enter master password",
                    hide_input=True,
                )
        
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
                    encrypted = do_encrypt(value, master_password=password)
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
        
    except Exception as e:
        click.echo(f"Error encrypting file: {e}", err=True)
        logger.error(f"Failed to encrypt file: {e}", exc_info=True)
        sys.exit(1)
