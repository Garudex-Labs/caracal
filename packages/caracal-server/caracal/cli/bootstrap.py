"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Bootstrap command: provisions the system root principal, issues the first-boot AIS nonce, and mints the local SDK API key.
"""

from __future__ import annotations

import os
import re
import secrets
from pathlib import Path

import click

from caracal.db import DatabaseConfig, DatabaseConnectionManager
from caracal.db.models import Principal, PrincipalAttestationStatus, PrincipalKind, PrincipalLifecycleStatus

API_KEY_PREFIX = "cark_"


def _runtime_env_path() -> Path:
    """Resolve the runtime .env file that compose loads via --env-file.

    Mirrors caracal.runtime.host_io.resolve_caracal_home() so bootstrap and
    `caracal up` agree on the same path.
    """
    config_dir = os.environ.get("CARACAL_CONFIG_DIR", "").strip()
    if config_dir:
        home = Path(config_dir).expanduser()
    else:
        caracal_home = os.environ.get("CARACAL_HOME", "").strip()
        home = Path(caracal_home).expanduser() if caracal_home else Path.home() / ".caracal"
    return home / "runtime" / ".env"


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
    try:
        env_path.chmod(0o600)
    except OSError:
        pass


def _read_env_var(env_path: Path, key: str) -> str | None:
    if not env_path.exists():
        return None
    pattern = re.compile(rf"^{re.escape(key)}\s*=(.*)$")
    for line in env_path.read_text(encoding="utf-8").splitlines():
        match = pattern.match(line)
        if match:
            return match.group(1).strip()
    return None


def _mint_api_key() -> str:
    return f"{API_KEY_PREFIX}{secrets.token_urlsafe(32)}"


@click.command(name="bootstrap")
@click.option(
    "--force",
    is_flag=True,
    default=False,
    help="Re-issue nonce even if principals already exist.",
)
@click.option(
    "--rotate-api-key",
    is_flag=True,
    default=False,
    help="Generate a fresh CARACAL_API_KEY even if one already exists.",
)
@click.pass_context
def bootstrap(ctx, force: bool, rotate_api_key: bool) -> None:
    """Provision the system principal, issue the first-boot AIS nonce, and mint the local SDK API key.

    Idempotent: skips principal creation and reuses the existing API key on
    subsequent runs unless --force or --rotate-api-key is passed. All
    generated values are written to the internal runtime .env that
    `caracal up` reads automatically; users do not need to touch it.
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

            identity_service = PrincipalRegistry(session)
            identity = identity_service.register_principal(
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

    from caracal.identity.principal_ttl import PrincipalTTLManager
    ttl_manager = PrincipalTTLManager(redis_client)
    ttl_manager.register_pending_principal(
        principal_id=principal_id,
        pending_ttl_seconds=nonce_manager.ttl_seconds,
        active_ttl_seconds=86400 * 365,
    )

    env_path = _runtime_env_path()

    existing_caveat_key = _read_env_var(env_path, "CARACAL_SESSION_CAVEAT_HMAC_KEY")
    caveat_hmac_key = existing_caveat_key or secrets.token_hex(32)

    existing_api_key = _read_env_var(env_path, "CARACAL_API_KEY")
    if rotate_api_key or not existing_api_key:
        api_key = _mint_api_key()
        api_key_action = "rotated" if existing_api_key else "issued"
    else:
        api_key = existing_api_key
        api_key_action = "reused"

    _write_env_vars(env_path, {
        "CARACAL_AIS_ATTESTATION_NONCE": issued.nonce,
        "CARACAL_AIS_ATTESTATION_PRINCIPAL_ID": principal_id,
        "CARACAL_SESSION_CAVEAT_HMAC_KEY": caveat_hmac_key,
        "CARACAL_API_KEY": api_key,
    })

    click.echo()
    click.echo(f"Bootstrap complete. Internal state written to {env_path}")
    click.echo(f"  CARACAL_API_KEY ({api_key_action}): {api_key}")
    click.echo()
    click.echo("Next steps:")
    click.echo("  caracal up            # start the runtime stack")
    click.echo("  caracal auth token    # reprint the API key at any time")

    db_manager.close()
