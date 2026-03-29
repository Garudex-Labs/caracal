"""CLI command for storage migration into canonical layout."""

from __future__ import annotations

import sys
from pathlib import Path

import click

from caracal.storage.layout import get_caracal_layout
from caracal.storage.migration import migrate_storage


@click.command(name="migrate-storage")
@click.option(
    "--source",
    type=click.Path(path_type=Path),
    required=True,
    help="Source storage root to migrate from.",
)
@click.option(
    "--target",
    type=click.Path(path_type=Path),
    help="Target canonical CARACAL_HOME root.",
)
@click.option("--dry-run", is_flag=True, help="Plan migration without copying or moving files.")
@click.option(
    "--purge-source",
    is_flag=True,
    help="Move files instead of copying and remove source data.",
)
@click.option("--confirm", is_flag=True, help="Confirm migration without interactive prompt.")
def migrate_storage_command(
    source: Path | None,
    target: Path | None,
    dry_run: bool,
    purge_source: bool,
    confirm: bool,
) -> None:
    """Migrate canonical storage domains into a different CARACAL_HOME root."""
    source_root = source
    target_root = target or get_caracal_layout().root

    if not confirm:
        click.confirm(
            f"Migrate storage from {source_root} to {target_root}?",
            abort=True,
        )

    try:
        summary = migrate_storage(
            source_root=source_root,
            target_root=target_root,
            dry_run=dry_run,
            purge_source=purge_source,
        )
    except Exception as exc:
        click.echo(f"Error migrating storage: {exc}", err=True)
        sys.exit(1)

    click.echo("Storage migration plan complete.")
    click.echo(f"  Source       : {summary.source_root}")
    click.echo(f"  Target       : {summary.target_root}")
    click.echo(f"  Mode         : {'dry-run' if summary.dry_run else ('move' if purge_source else 'copy')}")
    click.echo(f"  To migrate   : {summary.moved_items}")
    click.echo(f"  Skipped      : {summary.skipped_items}")

    if summary.operations:
        click.echo("  Operations:")
        for src, dst in summary.operations:
            click.echo(f"    {src} -> {dst}")
