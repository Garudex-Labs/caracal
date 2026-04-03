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
        assert_runtime_hardcut(
            compose_file=None,
            database_urls={"DATABASE_URL": "postgresql://ok"},
            check_jsonb=False,
            env_vars={"CARACAL_ENABLE_COMPAT_ALIASES": "true"},
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
def test_migration_cli_is_always_blocked() -> None:
    with pytest.raises(HardCutPreflightError, match="migration"):
        assert_migration_cli_allowed()