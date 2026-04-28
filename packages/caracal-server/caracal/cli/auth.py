"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for authentication guidance.
"""

from __future__ import annotations

import click


@click.group(name="auth")
def auth() -> None:
    """Inspect authentication setup."""


@auth.command(name="token")
@click.option(
    "--quiet",
    is_flag=True,
    default=False,
    help="Suppress explanatory text.",
)
def token(quiet: bool) -> None:
    """Explain the supported AIS session-token flow."""
    if quiet:
        return

    click.echo("Local API-key exchange has been removed.")
    click.echo("Use the authenticated /v1/ais/token flow to mint an AIS session token.")
