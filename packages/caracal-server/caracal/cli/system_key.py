"""System key management commands."""

from __future__ import annotations

import sys

import click


@click.group(name="key")
def key_group() -> None:
    """Manage Caracal key lifecycle operations."""


@key_group.command(name="rotate")
@click.option(
    "--confirm",
    is_flag=True,
    help="Confirm rotation without interactive prompt.",
)
def rotate(confirm: bool) -> None:
    """Request master-key rotation for the active backend."""
    if not confirm:
        click.confirm(
            "Record a master-key rotation request?",
            abort=True,
        )

    try:
        from caracal.config.encryption import rotate_master_key

        summary = rotate_master_key(actor="cli")
        click.echo("Master key rotation request recorded.")
        click.echo(f"  Re-wrapped DEKs : {summary.rewrapped_deks}")
        click.echo(f"  Requested at    : {summary.rotated_at}")
    except Exception as exc:
        click.echo(f"Error rotating master key: {exc}", err=True)
        sys.exit(1)


@key_group.command(name="status")
def status() -> None:
    """Show current key backend status."""
    try:
        from caracal.config.encryption import get_key_status

        key_status = get_key_status()
        click.echo("Master Key Status")
        click.echo(f"  Backend          : {key_status['backend']}")
        click.echo(f"  Vault URL        : {key_status.get('vault_url') or 'not configured'}")
        click.echo(f"  Vault project    : {key_status.get('vault_project') or 'default'}")
        click.echo(f"  Vault env        : {key_status.get('vault_environment') or 'dev'}")
        click.echo(f"  Configured       : {'yes' if key_status.get('configured') else 'no'}")
    except Exception as exc:
        click.echo(f"Error reading key status: {exc}", err=True)
        sys.exit(1)
