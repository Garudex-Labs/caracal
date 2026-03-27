"""Unit tests for host/container runtime entrypoints."""

from __future__ import annotations

import argparse
from pathlib import Path

from caracal.runtime import entrypoints


class _Result:
    def __init__(self, code: int = 0):
        self.returncode = code


def test_host_help_lists_orchestrator_commands(capsys):
    code = entrypoints._run_host_orchestrator(())

    assert code == 0
    output = capsys.readouterr().out
    assert "up" in output
    assert "down" in output
    assert "cli" in output
    assert "flow" in output
    assert "logs" in output
    assert "reset" in output


def test_caracal_entrypoint_uses_host_orchestrator(monkeypatch):
    monkeypatch.setattr(entrypoints, "_in_container_runtime", lambda: False)
    monkeypatch.setattr(entrypoints.sys, "argv", ["caracal", "up"])
    monkeypatch.setattr(entrypoints, "_run_host_orchestrator", lambda args: 7)

    try:
        entrypoints.caracal_entrypoint()
        assert False, "Expected SystemExit"
    except SystemExit as exc:
        assert exc.code == 7


def test_caracal_entrypoint_uses_local_cli_in_container(monkeypatch):
    calls: list[tuple[str, ...]] = []

    monkeypatch.setattr(entrypoints, "_in_container_runtime", lambda: True)
    monkeypatch.setattr(entrypoints.sys, "argv", ["caracal", "principal", "list"])
    monkeypatch.setattr(entrypoints, "_run_local_caracal", lambda args: calls.append(tuple(args)))

    entrypoints.caracal_entrypoint()
    assert calls == [("principal", "list")]


def test_host_up_starts_full_stack(monkeypatch):
    commands: list[list[str]] = []

    monkeypatch.setattr(entrypoints, "_resolve_compose_file", lambda compose_file=None: Path("/tmp/compose.yml"))
    monkeypatch.setattr(entrypoints, "_compose_cmd", lambda _: ["docker", "compose", "-f", "/tmp/compose.yml"])

    def _fake_run(cmd, check=False):
        commands.append(list(cmd))
        return _Result(0)

    monkeypatch.setattr(entrypoints.subprocess, "run", _fake_run)

    namespace = argparse.Namespace(compose_file=None, no_pull=True)
    code = entrypoints._host_up(namespace)

    assert code == 0
    assert commands == [["docker", "compose", "-f", "/tmp/compose.yml", "up", "-d", "postgres", "redis", "mcp"]]


def test_host_cli_runs_container_cli_and_strips_separator(monkeypatch):
    commands: list[list[str]] = []

    monkeypatch.setattr(entrypoints, "_resolve_compose_file", lambda compose_file=None: Path("/tmp/compose.yml"))
    monkeypatch.setattr(entrypoints, "_compose_cmd", lambda _: ["docker", "compose", "-f", "/tmp/compose.yml"])
    monkeypatch.setattr(entrypoints, "_host_up", lambda ns: 0)

    def _fake_run(cmd, check=False):
        commands.append(list(cmd))
        return _Result(0)

    monkeypatch.setattr(entrypoints.subprocess, "run", _fake_run)

    namespace = argparse.Namespace(compose_file=None, cli_args=["--", "--help"])
    code = entrypoints._host_cli(namespace)

    assert code == 0
    assert commands == [["docker", "compose", "-f", "/tmp/compose.yml", "run", "--rm", "cli", "caracal", "--help"]]
