"""Unit tests for CLI command audit and workflow validation commands."""

from click.testing import CliRunner

from caracal.cli.main import cli


EXPECTED_TOP_LEVEL_COMMANDS = {
    "agent",
    "audit",
    "authority",
    "backup",
    "config-encrypt",
    "db",
    "delegation",
    "keys",
    "ledger",
    "mcp-service",
    "merkle",
    "policy",
    "secrets",
    "snapshot",
}


def test_cli_help_is_clean_and_includes_expected_groups():
    """Top-level help should avoid noisy config logs and show command groups."""
    runner = CliRunner()
    result = runner.invoke(cli, ["--help"])

    assert result.exit_code == 0
    assert "Configuration file not found" not in result.output
    for command in EXPECTED_TOP_LEVEL_COMMANDS:
        assert command in result.output


def test_audit_commands_reports_surface():
    """`audit commands` should provide command-surface diagnostics."""
    runner = CliRunner()
    result = runner.invoke(cli, ["audit", "commands"])

    assert result.exit_code == 0
    assert "CLI Command Audit" in result.output
    assert "Top-level commands" in result.output
    assert "agent" in result.output
    assert "authority" in result.output


def test_audit_commands_smoke_mode_runs():
    """`audit commands --smoke` should execute help smoke checks."""
    runner = CliRunner()
    result = runner.invoke(cli, ["audit", "commands", "--smoke"])

    assert result.exit_code == 0
    assert "Smoke checks:" in result.output


def test_audit_workflow_strict_passes_for_expected_flow():
    """`audit workflow --strict` should succeed when workflow commands exist."""
    runner = CliRunner()
    result = runner.invoke(cli, ["audit", "workflow", "--strict"])

    assert result.exit_code == 0
    assert "Workflow commands: complete" in result.output
    assert "workspace -> agent -> policy -> delegation -> authority -> audit" in result.output


def test_audit_workflow_execute_mode_reports_probe():
    """`audit workflow --execute` should run and report workflow probe results."""
    runner = CliRunner()
    result = runner.invoke(cli, ["audit", "workflow", "--execute"])

    assert result.exit_code == 0
    assert "Execution probe:" in result.output
