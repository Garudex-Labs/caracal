"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for secret vault management.

Commands:
  caracal secrets list    — list secret refs in (org, env)
  caracal secrets rotate  — rotate the CaracalVault master key (Starter only)
  caracal secrets migrate — plan and execute a CaracalVault → AWS SM migration
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
        from caracal.sdk.secrets import SecretsAdapter
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


@secrets_group.command(name="migrate")
@click.option("--org-id", required=True, help="Organisation ID.")
@click.option("--env-id", default="default", show_default=True, help="Environment ID.")
@click.option(
    "--to-tier",
    required=True,
    type=click.Choice(["growth", "scale", "enterprise"], case_sensitive=False),
    help="Target tier for migration (CaracalVault → AWS SM).",
)
@click.option("--rotate-credentials", is_flag=True, help="Rotate credentials during migration.")
@click.option("--dry-run", is_flag=True, help="Show migration plan without executing.")
@click.option("--confirm", is_flag=True, help="Confirm migration without prompting.")
def migrate_secrets(
    org_id: str, env_id: str, to_tier: str,
    rotate_credentials: bool, dry_run: bool, confirm: bool,
) -> None:
    """
    Migrate secrets from CaracalVault (Starter) to AWS Secrets Manager (Growth+).

    Shows cost estimate and impact summary before confirming.
    """
    try:
        from caracalEnterprise.services.gateway.vault_migration import MigrationOrchestrator
        orchestrator = MigrationOrchestrator()
        plan = orchestrator.plan_upgrade(
            org_id=org_id, env_id=env_id,
            source_tier="starter", target_tier=to_tier,
            rotate_credentials=rotate_credentials,
        )
    except Exception as exc:
        click.echo(f"Failed to build migration plan: {exc}", err=True)
        sys.exit(1)

    # Show plan
    click.echo(f"\n{'=' * 60}")
    click.echo(f"  Migration Plan ({plan.plan_id})")
    click.echo(f"{'=' * 60}")
    click.echo(f"  Direction   : {plan.source_tier} → {plan.target_tier}")
    click.echo(f"  Secrets     : {plan.total_secrets}")
    click.echo(f"  Rotation    : {'yes' if rotate_credentials else 'no'}")
    if plan.cost_estimate:
        e = plan.cost_estimate
        click.echo(f"\n  AWS Estimated Cost:")
        click.echo(f"    Per month  : ${e.total_per_month_usd:.4f} USD")
        click.echo(f"    Per year   : ${e.total_per_year_usd:.4f} USD")
        click.echo(f"    (${e.cost_per_month_usd:.4f}/secret/month + ${e.api_call_cost_per_month_usd:.4f} API calls)")
    for k, v in plan.impact_summary.items():
        if k not in ("aws_region",):
            click.echo(f"  {k.replace('_', ' ').title():30s}: {v}")
    click.echo(f"{'=' * 60}\n")

    if dry_run:
        click.echo("Dry run — no changes made.")
        return

    if not confirm:
        click.confirm("Proceed with migration?", abort=True)

    try:
        result = orchestrator.execute_upgrade(plan, actor="cli")
        click.echo(
            f"\nMigration {'complete' if result.status.value == 'completed' else 'FAILED'}.\n"
            f"  Status           : {result.status.value}\n"
            f"  Migrated         : {result.secrets_migrated}/{result.secrets_total}\n"
            f"  Validated        : {result.secrets_validated}\n"
            f"  Failed           : {result.secrets_failed}\n"
            f"  Duration         : {result.duration_seconds}s"
        )
        if result.error:
            click.echo(f"\nError: {result.error}", err=True)
            sys.exit(1)
    except Exception as exc:
        click.echo(f"Migration execution failed: {exc}", err=True)
        sys.exit(1)
