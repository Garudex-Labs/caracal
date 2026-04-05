"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for secret vault management.

Commands:
  caracal secrets list    — list secret refs in (org, env)
  caracal secrets rotate  — rotate the CaracalVault master key
"""

from __future__ import annotations

import sys

import click


@click.group(name="secrets")
def secrets_group():
    """Manage secrets in the tier-appropriate vault backend."""


@secrets_group.command(name="list")
@click.option("--org-id", required=True, help="Organisation ID.")
@click.option("--env-id", default="default", show_default=True, help="Environment ID.")
@click.option("--tier", required=True,
              type=click.Choice(["starter", "growth", "scale", "enterprise"], case_sensitive=False),
              help="Subscription tier (determines backend).")
def list_secrets(org_id: str, env_id: str, tier: str) -> None:
    """List secret refs in the vault for (org, env)."""
    try:
        from caracal_sdk.secrets import SecretsAdapter
        adapter = SecretsAdapter(tier=tier, org_id=org_id, env_id=env_id)
        refs = adapter.list_refs()
        if not refs:
            click.echo(f"No secrets found for org={org_id} env={env_id} (backend: {adapter.backend_name}).")
            return
        click.echo(f"Secrets in {adapter.backend_name} for org={org_id} env={env_id}:\n")
        for ref in refs:
            click.echo(f"  {ref}")
        click.echo(f"\nTotal: {len(refs)}")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


@secrets_group.command(name="rotate")
@click.option("--org-id", required=True, help="Organisation ID.")
@click.option("--env-id", default="default", show_default=True, help="Environment ID.")
@click.option("--confirm", is_flag=True, help="Confirm the rotation without prompting.")
def rotate_key(org_id: str, env_id: str, confirm: bool) -> None:
    """
    Rotate the CaracalVault master key for (org, env).

    Available only for Starter tier.  Re-encrypts all DEKs under a new MEK
    version.  No secret values are exposed during rotation.
    """
    if not confirm:
        click.confirm(
            f"Rotate master key for org={org_id} env={env_id}? "
            "All DEKs will be re-wrapped under a new key version.",
            abort=True,
        )
    try:
        from caracal.core.vault import get_vault, gateway_context
        vault = get_vault()
        with gateway_context():
            result = vault.rotate_master_key(org_id, env_id, actor="cli")
        click.echo(
            f"Key rotation complete.\n"
            f"  Secrets rotated : {result.secrets_rotated}\n"
            f"  Secrets failed  : {result.secrets_failed}\n"
            f"  New key version : {result.new_key_version}\n"
            f"  Duration        : {result.duration_seconds}s"
        )
        if result.secrets_failed > 0:
            click.echo("WARNING: Some secrets failed to rotate.  Check logs.", err=True)
            sys.exit(1)
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

