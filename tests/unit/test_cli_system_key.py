"""CLI tests for system key lifecycle commands."""

from __future__ import annotations

from click.testing import CliRunner

from caracal.cli.main import cli


def test_system_key_status_and_rotate(tmp_path, monkeypatch):
    monkeypatch.setenv("CARACAL_HOME", str(tmp_path / "caracal-home"))
    runner = CliRunner()

    bootstrap = runner.invoke(cli, ["config-encrypt", "encrypt", "bootstrap"])
    assert bootstrap.exit_code == 0
    assert "Encrypted value:" in bootstrap.output

    status = runner.invoke(cli, ["system", "key", "status"])
    assert status.exit_code == 0
    assert "Master Key Status" in status.output

    rotate = runner.invoke(cli, ["system", "key", "rotate", "--confirm"])
    assert rotate.exit_code == 0
    assert "Master key rotation complete." in rotate.output


def test_migrate_storage_command_dry_run(tmp_path, monkeypatch):
    source_root = tmp_path / "legacy-root"
    source_root.mkdir(parents=True)
    (source_root / "keys").mkdir()
    (source_root / "workspaces").mkdir()

    monkeypatch.setenv("CARACAL_HOME", str(tmp_path / "target-root"))
    runner = CliRunner()

    result = runner.invoke(
        cli,
        [
            "system",
            "migrate-storage",
            "--source",
            str(source_root),
            "--dry-run",
            "--confirm",
        ],
    )

    assert result.exit_code == 0
    assert "Storage migration plan complete." in result.output
