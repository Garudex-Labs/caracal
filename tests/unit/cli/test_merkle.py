"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI tests for Merkle tree operations.
"""

from __future__ import annotations

import pytest
from click.testing import CliRunner
from unittest.mock import patch, MagicMock

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


@pytest.mark.unit
def test_rotate_key_is_blocked_in_hardcut_mode() -> None:
    runner = CliRunner()
    result = runner.invoke(
        merkle,
        ["rotate-key", "-k", "/tmp/old.pem", "-n", "/tmp/new.pem", "-p", "/tmp/pub.pem"],
    )
    assert result.exit_code != 0
    assert "disabled in runtime paths" in result.output


@pytest.mark.unit
def test_export_public_key_is_blocked_in_hardcut_mode() -> None:
    runner = CliRunner()
    result = runner.invoke(
        merkle,
        ["export-public-key", "-k", "/tmp/priv.pem", "-p", "/tmp/pub.pem"],
    )
    assert result.exit_code != 0
    assert "disabled in runtime paths" in result.output


@pytest.mark.unit
def test_verify_batch_rejects_invalid_uuid() -> None:
    runner = CliRunner()
    result = runner.invoke(merkle, ["verify-batch", "-b", "not-a-uuid"])
    assert result.exit_code != 0
    assert "Invalid batch ID format" in result.output


@pytest.mark.unit
def test_verify_event_rejects_invalid_uuid() -> None:
    runner = CliRunner()
    result = runner.invoke(merkle, ["verify-event", "-e", "bad-id"])
    assert result.exit_code != 0


@pytest.mark.unit
def test_merkle_group_help() -> None:
    runner = CliRunner()
    result = runner.invoke(merkle, ["--help"])
    assert result.exit_code == 0
    assert "Merkle" in result.output
