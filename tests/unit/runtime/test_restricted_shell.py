"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for the restricted interactive shell parser and utilities.
"""

from __future__ import annotations

from pathlib import Path

import click
import pytest
from prompt_toolkit.document import Document

from caracal.runtime.restricted_shell import (
    CaracalCompleter,
    ParsedRestrictedInput,
    _ensure_history_parent,
    _help_args,
    _suggest,
    parse_restricted_input,
    parse_restricted_tokens,
)


@pytest.mark.unit
class TestParsedRestrictedInput:
    def test_defaults(self) -> None:
        p = ParsedRestrictedInput()
        assert p.args == []
        assert p.message is None
        assert p.is_error is False
        assert p.action is None

    def test_args_normalised_from_none(self) -> None:
        p = ParsedRestrictedInput(args=None)
        assert p.args == []

    def test_explicit_values(self) -> None:
        p = ParsedRestrictedInput(
            args=["workspace", "list"],
            message="hello",
            is_error=True,
            action="help",
        )
        assert p.args == ["workspace", "list"]
        assert p.message == "hello"
        assert p.is_error is True
        assert p.action == "help"


@pytest.mark.unit
class TestParseRestrictedInput:
    def test_empty_string_returns_empty(self) -> None:
        result = parse_restricted_input("")
        assert result.args == []
        assert result.action is None

    def test_simple_command(self) -> None:
        result = parse_restricted_input("workspace list")
        assert result.args == ["workspace", "list"]
        assert result.is_error is False

    def test_unclosed_quote_returns_error(self) -> None:
        result = parse_restricted_input("workspace 'unclosed")
        assert result.is_error is True
        assert result.message is not None
        assert "Input error" in result.message

    def test_exit_command(self) -> None:
        result = parse_restricted_input("exit")
        assert result.action == "exit"

    def test_quit_command(self) -> None:
        result = parse_restricted_input("quit")
        assert result.action == "exit"

    def test_help_keyword(self) -> None:
        result = parse_restricted_input("help")
        assert result.action == "help"

    def test_question_mark_help(self) -> None:
        result = parse_restricted_input("?")
        assert result.action == "help"

    def test_clear_command(self) -> None:
        result = parse_restricted_input("clear")
        assert result.action == "clear"

    def test_cls_command(self) -> None:
        result = parse_restricted_input("cls")
        assert result.action == "clear"

    def test_help_flag(self) -> None:
        result = parse_restricted_input("--help")
        assert result.action == "help"

    def test_short_help_flag(self) -> None:
        result = parse_restricted_input("-h")
        assert result.action == "help"

    def test_trailing_help_keyword_appended(self) -> None:
        result = parse_restricted_input("workspace help")
        assert "--help" in result.args

    def test_trailing_question_mark_appended(self) -> None:
        result = parse_restricted_input("workspace ?")
        assert "--help" in result.args


@pytest.mark.unit
class TestParseRestrictedTokens:
    def test_empty_tokens(self) -> None:
        result = parse_restricted_tokens([])
        assert result.args == []
        assert result.action is None

    def test_root_command_alone_is_error(self) -> None:
        result = parse_restricted_tokens(["caracal"])
        assert result.is_error is True
        assert "already inside" in result.message

    def test_root_command_with_help_flag(self) -> None:
        result = parse_restricted_tokens(["caracal", "--help"])
        assert result.action == "help"

    def test_root_command_with_short_help(self) -> None:
        result = parse_restricted_tokens(["caracal", "-h"])
        assert result.action == "help"

    def test_root_command_with_subcommand_is_error(self) -> None:
        result = parse_restricted_tokens(["caracal", "workspace", "list"])
        assert result.is_error is True
        assert "workspace list" in result.message

    def test_exit_token(self) -> None:
        result = parse_restricted_tokens(["exit"])
        assert result.action == "exit"

    def test_quit_token(self) -> None:
        result = parse_restricted_tokens(["quit"])
        assert result.action == "exit"

    def test_help_token(self) -> None:
        result = parse_restricted_tokens(["help"])
        assert result.action == "help"

    def test_clear_token(self) -> None:
        result = parse_restricted_tokens(["clear"])
        assert result.action == "clear"

    def test_normal_command_returned_as_args(self) -> None:
        result = parse_restricted_tokens(["workspace", "create", "myws"])
        assert result.args == ["workspace", "create", "myws"]
        assert not result.is_error

    def test_trailing_help_keyword_converted(self) -> None:
        result = parse_restricted_tokens(["workspace", "help"])
        assert "--help" in result.args

    def test_similar_to_caracal_suggests_correction(self) -> None:
        result = parse_restricted_tokens(["caraca"])
        assert result.is_error is True
        assert "caracal" in result.message

    def test_unrecognised_no_suggestion(self) -> None:
        result = parse_restricted_tokens(["zzzzunknown"])
        assert not result.is_error
        assert result.args == ["zzzzunknown"]


@pytest.mark.unit
class TestSuggest:
    def test_close_match_returned(self) -> None:
        result = _suggest("caraca", ["caracal"])
        assert result == "caracal"

    def test_no_match_below_cutoff(self) -> None:
        result = _suggest("zzzzz", ["caracal"])
        assert result is None

    def test_exact_match(self) -> None:
        result = _suggest("exit", ["exit", "quit"])
        assert result == "exit"

    def test_empty_options(self) -> None:
        result = _suggest("something", [])
        assert result is None


@pytest.mark.unit
class TestHelpArgs:
    def test_empty_tokens_returns_help_flag(self) -> None:
        assert _help_args([]) == ["--help"]

    def test_tokens_appended_with_help_flag(self) -> None:
        assert _help_args(["workspace"]) == ["workspace", "--help"]

    def test_two_tokens(self) -> None:
        assert _help_args(["workspace", "create"]) == ["workspace", "create", "--help"]


@pytest.mark.unit
class TestEnsureHistoryParent:
    def test_creates_parent_directory(self, tmp_path: Path) -> None:
        history_file = tmp_path / "nested" / "dir" / "history.txt"
        assert not history_file.parent.exists()
        _ensure_history_parent(history_file)
        assert history_file.parent.exists()

    def test_existing_parent_is_noop(self, tmp_path: Path) -> None:
        history_file = tmp_path / "history.txt"
        _ensure_history_parent(history_file)
        assert tmp_path.exists()


def _make_root() -> click.MultiCommand:
    @click.group()
    def root():
        pass

    @root.group()
    def workspace():
        pass

    @workspace.command()
    @click.argument("name")
    @click.option("--dry-run", is_flag=True)
    def create(name: str, dry_run: bool):
        pass

    @workspace.command(name="list")
    def list_cmd():
        pass

    @root.command()
    def status():
        pass

    return root


def _completions(completer: CaracalCompleter, text: str) -> list[str]:
    doc = Document(text, cursor_position=len(text))
    return [c.text for c in completer.get_completions(doc, None)]


@pytest.mark.unit
class TestCaracalCompleter:
    def setup_method(self) -> None:
        self.root = _make_root()
        self.completer = CaracalCompleter(self.root)

    def test_empty_input_yields_top_level(self) -> None:
        items = _completions(self.completer, "")
        assert "workspace" in items
        assert "status" in items
        assert "help" in items
        assert "exit" in items
        assert "clear" in items

    def test_partial_command_matches(self) -> None:
        items = _completions(self.completer, "work")
        assert "workspace" in items

    def test_subcommand_completion_after_space(self) -> None:
        items = _completions(self.completer, "workspace ")
        assert "create" in items
        assert "list" in items

    def test_subcommand_partial(self) -> None:
        items = _completions(self.completer, "workspace cr")
        assert "create" in items

    def test_option_completion(self) -> None:
        items = _completions(self.completer, "workspace create name ")
        assert "--dry-run" in items

    def test_explicit_root_with_subcommand(self) -> None:
        items = _completions(self.completer, "caracal workspace ")
        assert "create" in items
        assert "list" in items

    def test_explicit_root_alone(self) -> None:
        items = _completions(self.completer, "caracal ")
        assert "workspace" in items

    def test_unknown_subcommand_returns_nothing(self) -> None:
        items = _completions(self.completer, "workspace unknowncmd ")
        assert items == []

    def test_leaf_command_offers_options(self) -> None:
        items = _completions(self.completer, "status ")
        assert "--help" in items

    def test_help_prefix_completion(self) -> None:
        items = _completions(self.completer, "help workspace ")
        assert "create" in items

    def test_invalid_shlex_returns_nothing(self) -> None:
        items = _completions(self.completer, "workspace 'unclosed")
        assert items == []

    def test_children_of_non_multicommand_empty(self) -> None:
        items = _completions(self.completer, "status sub")
        assert items == []

    def test_options_deduplication(self) -> None:
        items = _completions(self.completer, "workspace create name ")
        assert items.count("--help") == 1
