"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Bootstrap command: provisions the system root principal and issues the first-boot AIS nonce.
"""

from __future__ import annotations

import os
import re
import secrets
from pathlib import Path

import click

from caracal.db import DatabaseConfig, DatabaseConnectionManager
from caracal.db.models import Principal, PrincipalAttestationStatus, PrincipalKind, PrincipalLifecycleStatus


def _runtime_env_path() -> Path:
    """Resolve the runtime .env file that holds AIS bootstrap vars."""
    caracal_home = os.environ.get("CARACAL_HOME", "").strip()
    if caracal_home:
        candidate = Path(caracal_home) / ".env"
        if candidate.parent.exists():
            return candidate
    return Path.home() / ".config" / "caracal" / "runtime" / ".env"


def _write_env_vars(env_path: Path, updates: dict[str, str]) -> None:
    """Upsert key=value pairs in the given .env file."""
    env_path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    if env_path.exists():
        lines = env_path.read_text(encoding="utf-8").splitlines()

    written: set[str] = set()
    for i, line in enumerate(lines):
        for key in updates:
            if re.match(rf"^{re.escape(key)}\s*=", line):
                lines[i] = f"{key}={updates[key]}"
                written.add(key)

    for key, val in updates.items():
        if key not in written:
            lines.append(f"{key}={val}")

    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


@click.command(name="bootstrap")
@click.option(
    "--force",
    is_flag=True,
    default=False,
    help="Re-issue nonce even if principals already exist.",
)
@click.pass_context
def bootstrap(ctx, force: bool) -> None:
    """Provision the system root principal and issue the first-boot AIS nonce.

    Idempotent: skips principal creation if one already exists, unless --force.
    Writes CARACAL_AIS_ATTESTATION_NONCE and CARACAL_AIS_ATTESTATION_PRINCIPAL_ID
    to the runtime .env so that `caracal up` picks them up automatically.
    """
    from caracal.identity import AttestationNonceManager
    from caracal.redis.client import RedisClient

    db_config = DatabaseConfig()
    db_manager = DatabaseConnectionManager(db_config)
    db_manager.initialize()

    if not db_manager.health_check():
        raise click.ClickException(
            f"Cannot connect to database at {db_config.host}:{db_config.port}/{db_config.database}."
        )

    session_factory = db_manager._session_factory
    if session_factory is None:
        raise click.ClickException("Database session factory not available after initialize().")

    with session_factory() as session:
        existing_count = session.query(Principal).count()

        if existing_count > 0 and not force:
            system_principal = (
                session.query(Principal)
                .filter_by(principal_kind=PrincipalKind.SERVICE.value, name="system")
                .first()
            )
            if system_principal is None:
                system_principal = session.query(Principal).first()

            principal_id = str(system_principal.principal_id)
            click.echo(
                f"System principal already exists ({principal_id}). "
                "Issuing fresh nonce. Pass --force to recreate the principal."
            )
        else:
            from caracal.core.identity import PrincipalRegistry

            registry = PrincipalRegistry(session)
            identity = registry.register_principal(
                name="system",
                owner="caracal",
                principal_kind=PrincipalKind.SERVICE.value,
                lifecycle_status=PrincipalLifecycleStatus.ACTIVE.value,
                attestation_status=PrincipalAttestationStatus.ATTESTED.value,
                metadata={"bootstrap": True},
                generate_keys=False,
            )
            principal_id = identity.principal_id
            click.echo(f"System principal created: {principal_id}")

    redis_host = os.environ.get("REDIS_HOST", "localhost").strip() or "localhost"
    redis_port = int(os.environ.get("REDIS_PORT", "6379").strip() or "6379")
    redis_password = os.environ.get("REDIS_PASSWORD", "").strip() or None

    redis_client = RedisClient(host=redis_host, port=redis_port, password=redis_password)
    nonce_manager = AttestationNonceManager(redis_client)
    issued = nonce_manager.issue_nonce(principal_id)

    # Register the TTL lease for the system principal so that MCP's
    # activate_principal() call succeeds at startup.
    # pending_ttl matches the nonce lifetime; active_ttl is 1 year (system process).
    from caracal.identity.principal_ttl import PrincipalTTLManager
    ttl_manager = PrincipalTTLManager(redis_client)
    ttl_manager.register_pending_principal(
        principal_id=principal_id,
        pending_ttl_seconds=nonce_manager.ttl_seconds,
        active_ttl_seconds=86400 * 365,
    )

    # Generate a stable session caveat HMAC key for MCP.  This is a
    # one-time secret; subsequent restarts re-read it from the volume .env.
    caveat_hmac_key = secrets.token_hex(32)

    env_path = _runtime_env_path()
    _write_env_vars(env_path, {
        "CARACAL_AIS_ATTESTATION_NONCE": issued.nonce,
        "CARACAL_AIS_ATTESTATION_PRINCIPAL_ID": principal_id,
        "CARACAL_SESSION_CAVEAT_HMAC_KEY": caveat_hmac_key,
    })

    click.echo(f"AIS nonce issued and written to {env_path}")
    click.echo(f"  CARACAL_AIS_ATTESTATION_PRINCIPAL_ID={principal_id}")
    click.echo(f"  CARACAL_AIS_ATTESTATION_NONCE=<written>")
    click.echo(f"  CARACAL_SESSION_CAVEAT_HMAC_KEY=<written>")
    click.echo()
    click.echo("Run 'caracal up' to start MCP with full enforcement.")

    db_manager.close()
