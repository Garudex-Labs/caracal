"""Unit tests for host/container runtime entrypoints."""

from __future__ import annotations

import argparse
from pathlib import Path

from caracal.runtime import entrypoints


class _Result:
    def __init__(self, code: int = 0, stdout: str = "", stderr: str = ""):
        self.returncode = code
        self.stdout = stdout
        self.stderr = stderr


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


def test_host_up_skips_mcp_pull_for_local_build(monkeypatch):
    commands: list[list[str]] = []

    monkeypatch.setattr(entrypoints, "_resolve_compose_file", lambda compose_file=None: Path("/tmp/compose.yml"))
    monkeypatch.setattr(entrypoints, "_compose_cmd", lambda _: ["docker", "compose", "-f", "/tmp/compose.yml"])
    monkeypatch.setattr(entrypoints, "_service_uses_local_build", lambda *_args, **_kwargs: True)

    def _fake_run(cmd, check=False):
        commands.append(list(cmd))
        return _Result(0)

    monkeypatch.setattr(entrypoints.subprocess, "run", _fake_run)

    namespace = argparse.Namespace(compose_file=None, no_pull=False)
    code = entrypoints._host_up(namespace)

    assert code == 0
    assert commands == [
        ["docker", "compose", "-f", "/tmp/compose.yml", "pull", "postgres", "redis"],
        ["docker", "compose", "-f", "/tmp/compose.yml", "up", "-d", "postgres", "redis", "mcp"],
    ]


def test_host_cli_opens_interactive_shell_in_running_container(monkeypatch):
    commands: list[list[str]] = []

    monkeypatch.setattr(entrypoints, "_resolve_compose_file", lambda compose_file=None: Path("/tmp/compose.yml"))
    monkeypatch.setattr(entrypoints, "_compose_cmd", lambda _: ["docker", "compose", "-f", "/tmp/compose.yml"])
    monkeypatch.setattr(entrypoints, "_host_up", lambda ns: 0)

    def _fake_run(cmd, check=False):
        commands.append(list(cmd))
        return _Result(0)

    monkeypatch.setattr(entrypoints.subprocess, "run", _fake_run)

    namespace = argparse.Namespace(compose_file=None)
    code = entrypoints._host_cli(namespace)

    assert code == 0
    assert commands == [["docker", "compose", "-f", "/tmp/compose.yml", "exec", "-u", "caracal", "mcp", "/bin/bash"]]


def test_host_flow_runs_inside_runtime_container(monkeypatch):
    commands: list[list[str]] = []

    monkeypatch.setattr(entrypoints, "_resolve_compose_file", lambda compose_file=None: Path("/tmp/compose.yml"))
    monkeypatch.setattr(entrypoints, "_compose_cmd", lambda _: ["docker", "compose", "-f", "/tmp/compose.yml"])
    monkeypatch.setattr(entrypoints, "_host_up", lambda ns: 0)

    def _fake_run(cmd, check=False):
        commands.append(list(cmd))
        return _Result(0)

    monkeypatch.setattr(entrypoints.subprocess, "run", _fake_run)

    namespace = argparse.Namespace(compose_file=None)
    code = entrypoints._host_flow(namespace)

    assert code == 0
    assert commands == [[
        "docker",
        "compose",
        "-f",
        "/tmp/compose.yml",
        "exec",
        "-u",
        "caracal",
        "-e",
        "TERM=xterm-256color",
        "-e",
        "COLORTERM=truecolor",
        "mcp",
        "python",
        "-m",
        "caracal.flow.main",
    ]]


def test_host_cli_rejects_passthrough_arguments(capsys):
    code = entrypoints._run_host_orchestrator(("cli", "--", "--help"))

    assert code == 2
    error_output = capsys.readouterr().err
    assert "unrecognized arguments" in error_output


def test_emit_compose_teardown_output_filters_network_warning_from_stderr(monkeypatch, capsys):
    monkeypatch.setattr(
        entrypoints,
        "_list_network_container_names",
        lambda network_name: ["caracal-gateway-dev"] if network_name == "caracal-runtime" else [],
    )

    entrypoints._emit_compose_teardown_output(
        stdout="",
        stderr=" Network caracal-runtime Removing \n Network caracal-runtime Resource is still in use \n",
    )

    captured = capsys.readouterr()
    assert "Network caracal-runtime Removing" in captured.err
    assert "Resource is still in use" not in captured.err
    assert "Resource is still in use" not in captured.out
    assert "caracal-gateway-dev" in captured.out


def test_list_network_container_names_parses_docker_inspect(monkeypatch):
    monkeypatch.setattr(entrypoints.shutil, "which", lambda cmd: "/usr/bin/docker" if cmd == "docker" else None)

    def _fake_run(cmd, check=False, capture_output=False, text=False):
        assert cmd == [
            "/usr/bin/docker",
            "network",
            "inspect",
            "caracal-runtime",
            "--format",
            "{{json .Containers}}",
        ]
        assert check is False
        assert capture_output is True
        assert text is True
        return _Result(
            0,
            stdout='{"abc":{"Name":"caracal-gateway-dev"},"def":{"Name":"caracal-mcp"}}',
        )

    monkeypatch.setattr(entrypoints.subprocess, "run", _fake_run)

    assert entrypoints._list_network_container_names("caracal-runtime") == [
        "caracal-gateway-dev",
        "caracal-mcp",
    ]
