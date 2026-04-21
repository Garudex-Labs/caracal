"""Restricted interactive CLI for in-container Caracal sessions."""

from __future__ import annotations

import difflib
import importlib
import shlex
import sys
from pathlib import Path
from typing import Iterable

import click
from prompt_toolkit import PromptSession
from prompt_toolkit.auto_suggest import AutoSuggestFromHistory
from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.formatted_text import HTML
from prompt_toolkit.history import FileHistory
from prompt_toolkit.styles import Style

from caracal.storage.layout import get_caracal_layout


ROOT_COMMAND = "caracal"
REPL_PROMPT = HTML("<brand>caracal</brand><accent>></accent> ")
REPL_HISTORY_PATH = get_caracal_layout().history_dir / "cli.history"
EXIT_COMMANDS = {"exit", "quit"}
HELP_COMMANDS = {"help", "?"}
CLEAR_COMMANDS = {"clear", "cls"}
REPL_STYLE = Style.from_dict(
    {
        "brand": "bold ansicyan",
        "accent": "bold ansibrightblack",
        "hint": "ansibrightblack",
        "error": "bold ansired",
        "warning": "bold ansiyellow",
        "info": "ansibrightblack",
    }
)


def _load_root_cli() -> click.Command:
    cli_module = importlib.import_module("caracal.cli.main")
    return cli_module.cli


def run_restricted_repl() -> int:
    """Run the in-container restricted command loop."""
    cli = _load_root_cli()
    _ensure_history_parent(REPL_HISTORY_PATH)
    session = PromptSession(
        history=FileHistory(str(REPL_HISTORY_PATH)),
        auto_suggest=AutoSuggestFromHistory(),
        completer=CaracalCompleter(cli),
        style=REPL_STYLE,
    )

    _render_banner()

    while True:
        try:
            raw_line = session.prompt(REPL_PROMPT).strip()
        except (EOFError, KeyboardInterrupt):
            click.echo()
            return 0

        if not raw_line:
            continue

        if raw_line in EXIT_COMMANDS:
            return 0

        parsed = parse_restricted_input(raw_line)
        if parsed.action == "exit":
            return 0
        if parsed.action == "clear":
            click.clear()
            _render_banner()
            continue
        if parsed.message:
            _render_message(parsed.message, is_error=parsed.is_error)
            continue

        _run_cli_command(parsed.args)


def run_restricted_command(args: list[str]) -> int:
    """Run a single restricted command invocation."""
    if not args:
        return run_restricted_repl()

    parsed = parse_restricted_tokens(args)
    if parsed.action == "exit":
        return 0
    if parsed.action == "clear":
        click.clear()
        return 0
    if parsed.message:
        _render_message(parsed.message, is_error=parsed.is_error)
        return 1

    return _run_cli_command(parsed.args)


class ParsedRestrictedInput:
    """Normalized REPL input."""

    def __init__(
        self,
        *,
        args: list[str] | None = None,
        message: str | None = None,
        is_error: bool = False,
        action: str | None = None,
    ):
        self.args = args or []
        self.message = message
        self.is_error = is_error
        self.action = action


def parse_restricted_input(raw_line: str) -> ParsedRestrictedInput:
    """Parse a line entered into the restricted REPL."""
    try:
        tokens = shlex.split(raw_line)
    except ValueError as exc:
        return ParsedRestrictedInput(message=f"Input error: {exc}", is_error=True)

    return parse_restricted_tokens(tokens)


def parse_restricted_tokens(tokens: list[str]) -> ParsedRestrictedInput:
    """Normalize tokenized restricted-shell input."""
    if not tokens:
        return ParsedRestrictedInput()

    if tokens[0] == ROOT_COMMAND:
        tokens = tokens[1:]
        if not tokens:
            return ParsedRestrictedInput(args=["--help"])

    if not tokens:
        return ParsedRestrictedInput(args=["--help"])

    first = tokens[0]
    if first in EXIT_COMMANDS:
        return ParsedRestrictedInput(action="exit")
    if first in CLEAR_COMMANDS:
        return ParsedRestrictedInput(action="clear")
    if first in HELP_COMMANDS:
        return ParsedRestrictedInput(args=_help_args(tokens[1:]))

    if len(tokens) > 1 and tokens[-1] in HELP_COMMANDS:
        return ParsedRestrictedInput(args=[*tokens[:-1], "--help"])

    root_suggestion = _suggest(first, [ROOT_COMMAND])
    if root_suggestion:
        return ParsedRestrictedInput(
            message=f"Command not found: {first}. Did you mean '{ROOT_COMMAND}'?",
            is_error=True,
        )

    return ParsedRestrictedInput(args=tokens)


def _run_cli_command(args: list[str]) -> int:
    cli = _load_root_cli()
    try:
        cli.main(args=args, prog_name=ROOT_COMMAND, standalone_mode=False)
        return 0
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else 1
        return code
    except click.ClickException as exc:
        exc.show()
        return exc.exit_code


def _suggest(value: str, options: Iterable[str]) -> str | None:
    matches = difflib.get_close_matches(value, list(options), n=1, cutoff=0.5)
    return matches[0] if matches else None


def _ensure_history_parent(history_path: Path) -> None:
    history_path.parent.mkdir(parents=True, exist_ok=True)


def _help_args(tokens: list[str]) -> list[str]:
    if not tokens:
        return ["--help"]
    return [*tokens, "--help"]


def _render_banner() -> None:
    click.secho("Caracal CLI", fg="cyan", bold=True)
    click.secho("Command Line Interface Caracal", fg="bright_black")
    click.echo()
    click.secho("  help", fg="green", bold=True, nl=False)
    click.secho("  show available Caracal commands", fg="bright_black")
    click.secho("  clear", fg="blue", bold=True, nl=False)
    click.secho("  refresh the screen", fg="bright_black")
    click.secho("  exit", fg="yellow", bold=True, nl=False)
    click.secho("  leave this session", fg="bright_black")
    click.echo()


def _render_message(message: str, *, is_error: bool) -> None:
    if is_error:
        click.secho(f"Error: {message}", fg="red", bold=True, err=True)
        return
    click.secho(message, fg="yellow", err=False)


class CaracalCompleter(Completer):
    """Prompt-toolkit completer backed by the Click command tree."""

    def __init__(self, root_command: click.Command):
        self.root_command = root_command

    def get_completions(self, document, complete_event):
        text = document.text_before_cursor
        trailing_space = text.endswith(" ")
        try:
            tokens = shlex.split(text)
        except ValueError:
            return

        if not tokens:
            yield from self._yield_matches(
                "",
                [ROOT_COMMAND, "help", "clear", "exit", *self._children(self.root_command)],
            )
            return

        explicit_root = tokens[:1] == [ROOT_COMMAND]
        current_prefix = ""
        if trailing_space:
            current_prefix = ""
        else:
            current_prefix = tokens.pop()

        if explicit_root:
            tokens = tokens[1:]

        if tokens[:1] == ["help"]:
            tokens = tokens[1:]

        node, command_depth = self._resolve_node(tokens)

        if node is None:
            return

        candidates = self._candidates_for_context(
            node=node,
            explicit_root=explicit_root,
            command_depth=command_depth,
            current_prefix=current_prefix,
        )

        if not explicit_root and not tokens and current_prefix and ROOT_COMMAND.startswith(current_prefix):
            candidates = [ROOT_COMMAND, *candidates]

        yield from self._yield_matches(current_prefix, candidates)

    def _resolve_node(self, tokens: list[str]) -> tuple[click.Command | None, int]:
        node: click.Command = self.root_command
        command_depth = 0
        for token in tokens:
            if token.startswith("-"):
                continue
            if not isinstance(node, click.MultiCommand):
                return node, command_depth
            next_node = node.get_command(click.Context(node), token)
            if next_node is None:
                return None, command_depth
            node = next_node
            command_depth += 1
        return node, command_depth

    def _candidates_for_context(
        self,
        *,
        node: click.Command,
        explicit_root: bool,
        command_depth: int,
        current_prefix: str,
    ) -> list[str]:
        command_options = self._options(node)
        command_children = self._children(node)

        if explicit_root:
            if command_depth == 0:
                return [*command_options, *command_children]
            return [*command_options, *command_children]

        if command_depth == 0:
            return ["help", "clear", "exit", *command_options, *command_children]
        else:
            return [*command_options, *command_children]

    def _children(self, command: click.Command) -> list[str]:
        if not isinstance(command, click.MultiCommand):
            return []
        return list(command.list_commands(click.Context(command)))

    def _options(self, command: click.Command) -> list[str]:
        options: list[str] = []
        for param in getattr(command, "params", []):
            if isinstance(param, click.Option):
                options.extend(param.opts)
                options.extend(param.secondary_opts)

        if "--help" not in options:
            options.append("--help")

        seen: set[str] = set()
        ordered: list[str] = []
        for option in options:
            if option not in seen:
                seen.add(option)
                ordered.append(option)
        return ordered

    def _yield_matches(self, prefix: str, candidates: Iterable[str]):
        seen: set[str] = set()
        for candidate in candidates:
            if candidate in seen:
                continue
            if candidate.startswith(prefix):
                seen.add(candidate)
                yield Completion(candidate, start_position=-len(prefix))
