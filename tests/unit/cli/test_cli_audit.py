"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for CLI audit helper functions.
"""

from __future__ import annotations

import click
import pytest

from caracal.cli.cli_audit import (
    _collect_command_surface,
    _command_short_help,
    _extract_principal_id,
    _lint_command_surface,
    _required_workflow_commands,
    _workflow_gaps,
)


def _make_group(*commands: click.Command) -> click.Group:
    @click.group()
    def root():
        pass

    for cmd in commands:
        root.add_command(cmd)
    return root


@pytest.mark.unit
class TestCommandShortHelp:
    def test_short_help_returned(self) -> None:
        @click.command(short_help="Short help text")
        def cmd():
            pass

        assert _command_short_help(cmd) == "Short help text"

    def test_help_first_line_used_when_no_short_help(self) -> None:
        @click.command()
        @click.pass_context
        def cmd(ctx):
            """First line of help.

            Second line.
            """

        assert _command_short_help(cmd) == "First line of help."

    def test_no_help_returns_placeholder(self) -> None:
        @click.command()
        def cmd():
            pass

        assert _command_short_help(cmd) == "(no help text)"


@pytest.mark.unit
class TestCollectCommandSurface:
    def test_empty_group_returns_empty(self) -> None:
        root = _make_group()
        result = _collect_command_surface(root)
        assert result == {}

    def test_simple_command_collected(self) -> None:
        @click.command(name="mycommand", short_help="Does a thing")
        def my_cmd():
            pass

        root = _make_group(my_cmd)
        result = _collect_command_surface(root)
        assert "mycommand" in result
        assert result["mycommand"]["help"] == "Does a thing"

    def test_group_command_has_subcommands(self) -> None:
        @click.group(short_help="Group of stuff")
        def sub():
            pass

        @sub.command()
        def action():
            """Does action."""

        root = _make_group(sub)
        result = _collect_command_surface(root)
        assert "sub" in result
        assert result["sub"]["is_group"] is True
        assert "action" in result["sub"]["subcommands"]

    def test_flat_command_has_no_subcommands(self) -> None:
        @click.command(short_help="flat cmd")
        def flat():
            pass

        root = _make_group(flat)
        result = _collect_command_surface(root)
        assert result["flat"]["subcommands"] == []
        assert result["flat"]["is_group"] is False


@pytest.mark.unit
class TestLintCommandSurface:
    def test_clean_surface_no_findings(self) -> None:
        surface = {
            "workspace": {
                "help": "Manage workspaces.",
                "is_group": True,
                "subcommands": ["create", "list"],
            }
        }
        findings = _lint_command_surface(surface)
        assert findings == []

    def test_underscore_command_name_flagged(self) -> None:
        surface = {
            "my_cmd": {
                "help": "Some help.",
                "is_group": False,
                "subcommands": [],
            }
        }
        findings = _lint_command_surface(surface)
        assert any("my_cmd" in f for f in findings)

    def test_missing_help_text_flagged(self) -> None:
        surface = {
            "workspace": {
                "help": "(no help text)",
                "is_group": False,
                "subcommands": [],
            }
        }
        findings = _lint_command_surface(surface)
        assert any("missing help text" in f for f in findings)

    def test_underscore_subcommand_flagged(self) -> None:
        surface = {
            "workspace": {
                "help": "Manage workspaces.",
                "is_group": True,
                "subcommands": ["create_workspace"],
            }
        }
        findings = _lint_command_surface(surface)
        assert any("create_workspace" in f for f in findings)


@pytest.mark.unit
class TestRequiredWorkflowCommands:
    def test_returns_list_of_tuples(self) -> None:
        result = _required_workflow_commands()
        assert isinstance(result, list)
        assert all(isinstance(item, tuple) and len(item) == 2 for item in result)

    def test_contains_workspace_create(self) -> None:
        assert ("workspace", "create") in _required_workflow_commands()

    def test_contains_principal_register(self) -> None:
        assert ("principal", "register") in _required_workflow_commands()


@pytest.mark.unit
class TestWorkflowGaps:
    def test_empty_root_has_all_gaps(self) -> None:
        root = _make_group()
        gaps = _workflow_gaps(root)
        assert len(gaps) > 0
        assert any("workspace" in g for g in gaps)

    def test_present_command_no_top_level_gap(self) -> None:
        @click.group(short_help="Workspace mgmt")
        def workspace():
            pass

        @workspace.command()
        def create():
            """Create workspace."""

        root = _make_group(workspace)
        gaps = _workflow_gaps(root)
        assert not any(g == "Missing top-level command: workspace" for g in gaps)


@pytest.mark.unit
class TestExtractPrincipalId:
    def test_extracts_id_from_output(self) -> None:
        output = "Created successfully\nPrincipal ID: abc-123-def\nMore output"
        assert _extract_principal_id(output) == "abc-123-def"

    def test_no_principal_id_returns_empty(self) -> None:
        output = "Some output\nNo ID here"
        assert _extract_principal_id(output) == ""

    def test_whitespace_stripped(self) -> None:
        output = "Principal ID:   uuid-456   "
        assert _extract_principal_id(output) == "uuid-456"

    def test_first_match_returned(self) -> None:
        output = "Principal ID: first-id\nPrincipal ID: second-id"
        assert _extract_principal_id(output) == "first-id"
