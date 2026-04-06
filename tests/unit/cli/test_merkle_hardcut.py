"""CLI hard-cut tests for Merkle key-file commands."""

from __future__ import annotations

import pytest
from click.testing import CliRunner

from caracal.cli.merkle import merkle


@pytest.mark.unit
def test_generate_key_is_blocked_in_hardcut_mode() -> None:
    runner = CliRunner()

    result = runner.invoke(
        merkle,
        ["generate-key", "-k", "/tmp/private.pem", "-p", "/tmp/public.pem"],
    )

    assert result.exit_code != 0
    assert "disabled in runtime paths" in result.output


@pytest.mark.unit
def test_verify_key_is_blocked_in_hardcut_mode() -> None:
    runner = CliRunner()

    result = runner.invoke(
        merkle,
        ["verify-key", "-k", "/tmp/private.pem"],
    )

    assert result.exit_code != 0
    assert "disabled in runtime paths" in result.output
