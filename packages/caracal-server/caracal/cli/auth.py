"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for inspecting and rotating the local SDK API key.
"""

from __future__ import annotations

import secrets

import click

from caracal.cli.bootstrap import (
    API_KEY_PREFIX,
    _read_env_var,
    _runtime_env_path,
    _write_env_vars,
)


@click.group(name="auth")
def auth() -> None:
    """Inspect and rotate the local SDK API key."""


@auth.command(name="token")
@click.option(
    "--rotate",
    is_flag=True,
    default=False,
    help="Generate a fresh CARACAL_API_KEY and write it to the runtime .env.",
)
@click.option(
    "--quiet",
    is_flag=True,
    default=False,
    help="Print only the bare API key value (suitable for scripting).",
)
def token(rotate: bool, quiet: bool) -> None:
    """Print the local CARACAL_API_KEY managed by `caracal bootstrap`."""
    env_path = _runtime_env_path()
    existing = _read_env_var(env_path, "CARACAL_API_KEY")

    if rotate or not existing:
        if not env_path.parent.exists() and not rotate:
            raise click.ClickException(
                "No API key found. Run `caracal bootstrap` first, or pass --rotate to mint one."
            )
        new_key = f"{API_KEY_PREFIX}{secrets.token_urlsafe(32)}"
        _write_env_vars(env_path, {"CARACAL_API_KEY": new_key})
        value = new_key
        action = "rotated" if existing else "issued"
    else:
        value = existing
        action = "current"

    if quiet:
        click.echo(value)
        return

    click.echo(f"CARACAL_API_KEY ({action}): {value}")
    click.echo(f"Source: {env_path}")
