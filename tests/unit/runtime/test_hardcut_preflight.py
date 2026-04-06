"""Unit tests for strict hard-cut preflight checks."""

from pathlib import Path

import pytest

from caracal.runtime.hardcut_preflight import (
    HardCutPreflightError,
    assert_enterprise_hardcut,
    assert_migration_hardcut,
    assert_migration_cli_allowed,
    assert_runtime_hardcut,
)


def _valid_vault_env() -> dict[str, str]:
    return {
        "CARACAL_PRINCIPAL_KEY_BACKEND": "vault",
        "CARACAL_VAULT_URL": "http://vault.example",
        "CARACAL_VAULT_TOKEN": "test-token",
        "CARACAL_VAULT_SIGNING_KEY_REF": "keys/mandate-signing",
        "CARACAL_VAULT_SESSION_PUBLIC_KEY_REF": "keys/session-public",
    }


@pytest.mark.unit
def test_enterprise_preflight_blocks_sqlite_when_jsonb_check_disabled() -> None:
    with pytest.raises(HardCutPreflightError, match="SQLite"):
        assert_enterprise_hardcut(
            database_urls={"DATABASE_URL": "sqlite:///tmp/caracal.db"},
            check_jsonb=False,
        )


@pytest.mark.unit
def test_runtime_preflight_blocks_file_backed_state_markers(tmp_path: Path) -> None:
    compose_file = tmp_path / "docker-compose.yml"
    compose_file.write_text(
        """
services:
  mcp:
    image: example
    volumes:
      - caracal_state:/home/caracal/.caracal
volumes:
  caracal_state:
""".strip(),
        encoding="utf-8",
    )

    with pytest.raises(HardCutPreflightError, match="file-backed state"):
        assert_runtime_hardcut(
            compose_file=compose_file,
            database_urls={"DATABASE_URL": "postgresql://ok"},
            check_jsonb=False,
        )


@pytest.mark.unit
def test_runtime_preflight_blocks_jsonb_models(tmp_path: Path) -> None:
    models_file = tmp_path / "models.py"
    models_file.write_text("from sqlalchemy.dialects.postgresql import JSONB\n", encoding="utf-8")

    with pytest.raises(HardCutPreflightError, match="JSON/JSONB"):
        assert_runtime_hardcut(
            compose_file=None,
            database_urls={"DATABASE_URL": "postgresql://ok"},
            models_file=models_file,
            check_jsonb=True,
        )


@pytest.mark.unit
def test_runtime_preflight_blocks_compatibility_alias_flags() -> None:
    with pytest.raises(HardCutPreflightError, match="Compatibility aliases"):
        env_vars = _valid_vault_env()
        env_vars["CARACAL_ENABLE_COMPAT_ALIASES"] = "true"
        assert_runtime_hardcut(
            compose_file=None,
            database_urls={"DATABASE_URL": "postgresql://ok"},
            check_jsonb=False,
            env_vars=env_vars,
        )


@pytest.mark.unit
def test_runtime_preflight_blocks_legacy_state_artifacts(tmp_path: Path) -> None:
    legacy_state_file = tmp_path / "workspaces.json"
    legacy_state_file.write_text("{}", encoding="utf-8")

    with pytest.raises(HardCutPreflightError, match="Legacy file-backed state artifact"):
        assert_runtime_hardcut(
            compose_file=None,
            database_urls={"DATABASE_URL": "postgresql://ok"},
            check_jsonb=False,
            state_roots=[tmp_path],
        )


@pytest.mark.unit
def test_runtime_preflight_blocks_local_secret_backend() -> None:
    with pytest.raises(HardCutPreflightError, match="CARACAL_PRINCIPAL_KEY_BACKEND"):
        assert_runtime_hardcut(
            compose_file=None,
            database_urls={"DATABASE_URL": "postgresql://ok"},
            check_jsonb=False,
            env_vars={"CARACAL_PRINCIPAL_KEY_BACKEND": "local"},
        )


@pytest.mark.unit
def test_runtime_preflight_requires_explicit_secret_backend() -> None:
    with pytest.raises(HardCutPreflightError, match="CARACAL_PRINCIPAL_KEY_BACKEND"):
        assert_runtime_hardcut(
            compose_file=None,
            database_urls={"DATABASE_URL": "postgresql://ok"},
            check_jsonb=False,
            env_vars={},
        )


@pytest.mark.unit
def test_migration_preflight_blocks_sqlite_and_compat_markers_in_config(tmp_path: Path) -> None:
    alembic_ini = tmp_path / "alembic.ini"
    alembic_ini.write_text("sqlalchemy.url = sqlite:///tmp/caracal.db\n", encoding="utf-8")

    with pytest.raises(HardCutPreflightError, match="Config path"):
        assert_migration_hardcut(
            database_urls={"DATABASE_URL": "postgresql://ok"},
            check_jsonb=False,
            config_paths=[alembic_ini],
        )


@pytest.mark.unit
def test_runtime_preflight_blocks_gateway_enabled_without_endpoint() -> None:
    with pytest.raises(HardCutPreflightError, match="gateway endpoint"):
        env_vars = _valid_vault_env()
        env_vars["CARACAL_GATEWAY_ENABLED"] = "true"
        assert_runtime_hardcut(
            compose_file=None,
            database_urls={"DATABASE_URL": "postgresql://ok"},
            check_jsonb=False,
            env_vars=env_vars,
        )


@pytest.mark.unit
def test_runtime_preflight_blocks_conflicting_gateway_enabled_and_endpoint() -> None:
    with pytest.raises(HardCutPreflightError, match="Execution exclusivity violation"):
        env_vars = _valid_vault_env()
        env_vars["CARACAL_GATEWAY_ENABLED"] = "false"
        env_vars["CARACAL_ENTERPRISE_URL"] = "https://gateway.example"
        assert_runtime_hardcut(
            compose_file=None,
            database_urls={"DATABASE_URL": "postgresql://ok"},
            check_jsonb=False,
            env_vars=env_vars,
        )


@pytest.mark.unit
def test_runtime_preflight_requires_vault_readiness_env() -> None:
    with pytest.raises(HardCutPreflightError, match="CARACAL_VAULT_URL"):
        assert_runtime_hardcut(
            compose_file=None,
            database_urls={"DATABASE_URL": "postgresql://ok"},
            check_jsonb=False,
            env_vars={"CARACAL_PRINCIPAL_KEY_BACKEND": "vault"},
        )


@pytest.mark.unit
def test_runtime_preflight_blocks_local_vault_mode_in_hardcut() -> None:
    with pytest.raises(HardCutPreflightError, match="Local vault mode"):
        env_vars = _valid_vault_env()
        env_vars["CARACAL_VAULT_MODE"] = "local"
        env_vars["CARACAL_HARDCUT_MODE"] = "true"
        assert_runtime_hardcut(
            compose_file=None,
            database_urls={"DATABASE_URL": "postgresql://ok"},
            check_jsonb=False,
            env_vars=env_vars,
        )


@pytest.mark.unit
def test_runtime_preflight_blocks_symmetric_session_signing_algorithm() -> None:
    with pytest.raises(HardCutPreflightError, match="asymmetric signing algorithms"):
        env_vars = _valid_vault_env()
        env_vars["CARACAL_SESSION_SIGNING_ALGORITHM"] = "HS256"
        assert_runtime_hardcut(
            compose_file=None,
            database_urls={"DATABASE_URL": "postgresql://ok"},
            check_jsonb=False,
            env_vars=env_vars,
        )


@pytest.mark.unit
def test_migration_preflight_blocks_symmetric_session_signing_algorithm() -> None:
    with pytest.raises(HardCutPreflightError, match="asymmetric signing algorithms"):
        env_vars = _valid_vault_env()
        env_vars["CARACAL_SESSION_SIGNING_ALGORITHM"] = "HS256"
        assert_migration_hardcut(
            database_urls={"DATABASE_URL": "postgresql://ok"},
            check_jsonb=False,
            env_vars=env_vars,
        )


@pytest.mark.unit
def test_runtime_preflight_allows_asymmetric_session_signing_algorithm() -> None:
    env_vars = _valid_vault_env()
    env_vars["CARACAL_SESSION_SIGNING_ALGORITHM"] = "RS256"
    assert_runtime_hardcut(
        compose_file=None,
        database_urls={"DATABASE_URL": "postgresql://ok"},
        check_jsonb=False,
        env_vars=env_vars,
    )


@pytest.mark.unit
def test_runtime_preflight_blocks_legacy_session_signing_alias_env() -> None:
    with pytest.raises(HardCutPreflightError, match="Compatibility aliases"):
        env_vars = _valid_vault_env()
        env_vars["CARACAL_SESSION_JWT_ALGORITHM"] = "RS256"
        assert_runtime_hardcut(
            compose_file=None,
            database_urls={"DATABASE_URL": "postgresql://ok"},
            check_jsonb=False,
            env_vars=env_vars,
        )


@pytest.mark.unit
def test_migration_cli_is_always_blocked() -> None:
    with pytest.raises(HardCutPreflightError, match="migration"):
        assert_migration_cli_allowed()