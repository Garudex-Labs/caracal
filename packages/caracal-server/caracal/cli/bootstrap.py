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
from caracal.db.models import (
    Principal,
    PrincipalAttestationStatus,
    PrincipalKind,
    PrincipalLifecycleStatus,
    ResourceAllowlist,
)

_BOOTSTRAP_ADMIN_CAPABILITIES = {
    "system.admin",
    "system.stats.read",
    "mcp.tool_registry.manage",
}

def _runtime_env_path() -> Path:
    """Resolve the runtime .env file that compose loads via --env-file.

    Mirrors caracal.runtime.host_io.resolve_caracal_home() so bootstrap and
    `caracal up` agree on the same path.
    """
    config_dir = os.environ.get("CCL_CFG_DIR", "").strip()
    if config_dir:
        home = Path(config_dir).expanduser()
    else:
        caracal_home = os.environ.get("CCL_HOME", "").strip()
        home = Path(caracal_home).expanduser() if caracal_home else Path.home() / ".caracal"
    if os.environ.get("CCL_RUNTIME_IN_CONTAINER"):
        return home / ".env"
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


def _dev_example_mode_enabled() -> bool:
    return (os.environ.get("CCL_ENV_MODE") or "").strip().lower() in {"dev", "development", "test"}


def _grant_bootstrap_authority(session, principal_id: str) -> None:
    system_principal = session.query(Principal).filter_by(principal_id=principal_id).first()
    if system_principal is None:
        raise click.ClickException(f"System principal not found after bootstrap: {principal_id}")

    capabilities = {
        str(capability).strip()
        for capability in (getattr(system_principal, "capabilities", []) or [])
        if str(capability).strip()
    }
    capabilities.update(_BOOTSTRAP_ADMIN_CAPABILITIES)
    system_principal.capabilities = sorted(capabilities)

    if _dev_example_mode_enabled():
        existing_allowlist = (
            session.query(ResourceAllowlist)
            .filter_by(
                principal_id=system_principal.principal_id,
                resource_pattern="*",
                pattern_type="glob",
                active=True,
            )
            .first()
        )
        if existing_allowlist is None:
            session.add(
                ResourceAllowlist(
                    principal_id=system_principal.principal_id,
                    resource_pattern="*",
                    pattern_type="glob",
                    active=True,
                )
            )
    session.commit()


@click.command(name="bootstrap")
@click.option(
    "--force",
    is_flag=True,
    default=False,
    help="Re-issue nonce even if principals already exist.",
)
@click.pass_context
def bootstrap(ctx, force: bool) -> None:
    """Provision the system principal and issue the first-boot AIS nonce.

    Idempotent: skips principal creation on subsequent runs unless --force is
    passed. Generated values are written to the internal runtime .env that
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
                raise click.ClickException(
                    "Database contains principals but no service principal named 'system'. "
                    "Refusing to elect an arbitrary principal as system. "
                    "Re-run with --force to recreate the system principal explicitly."
                )

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

        _grant_bootstrap_authority(session, principal_id)

    redis_host = os.environ.get("REDIS_HOST", "localhost").strip() or "localhost"
    redis_port = int(os.environ.get("REDIS_PORT", "6379").strip() or "6379")
    redis_password = os.environ.get("CCL_REDIS_PASSWORD", "").strip()
    if not redis_password:
        raise click.ClickException("CCL_REDIS_PASSWORD is required before running bootstrap.")

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

    existing_caveat_key = _read_env_var(env_path, "CCL_SESS_HMAC")
    caveat_hmac_key = existing_caveat_key or secrets.token_hex(32)

    _write_env_vars(env_path, {
        "CCL_AIS_ATTESTATION_NONCE": issued.nonce,
        "CCL_AIS_ATTESTATION_PID": principal_id,
        "CCL_SESS_HMAC": caveat_hmac_key,
    })

    click.echo()
    click.echo(f"Bootstrap complete. Internal state written to {env_path}")
    click.echo("  AIS startup nonce issued.")
    click.echo()
    click.echo("Next steps:")
    click.echo("  caracal up            # start the runtime stack")
    click.echo("  eval \"$(caracal auth token --format env)\"")

    db_manager.close()
