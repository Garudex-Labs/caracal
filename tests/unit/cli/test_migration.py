"""Unit tests for migration hard-cut guardrails."""

import pytest
from click.testing import CliRunner

from caracal.cli.migration import migrate_group


@pytest.mark.unit
def test_migration_command_is_blocked_by_hardcut_preflight() -> None:
    runner = CliRunner()
    result = runner.invoke(migrate_group, ["list-backups"])

    assert result.exit_code != 0
    assert "Hard-cut preflight blocked migration command usage" in result.output