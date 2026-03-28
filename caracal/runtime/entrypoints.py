"""Host/container command entrypoints for Caracal runtime.

Host command (``caracal``): orchestration-only UX.
Container command (``caracal``): full interactive Caracal CLI.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Sequence

COMPOSE_FILE_ENV = "CARACAL_DOCKER_COMPOSE_FILE"
IN_CONTAINER_ENV = "CARACAL_RUNTIME_IN_CONTAINER"
NETWORK_IN_USE_MARKER = "Resource is still in use"

_EMBEDDED_COMPOSE_FILE = Path.home() / ".caracal" / "runtime" / "docker-compose.image.yml"
_EMBEDDED_COMPOSE_CONTENT = """name: caracal

services:
    postgres:
        image: postgres:16-alpine
        environment:
            POSTGRES_DB: ${CARACAL_DB_NAME:-caracal}
            POSTGRES_USER: ${CARACAL_DB_USER:-caracal}
            POSTGRES_PASSWORD: ${CARACAL_DB_PASSWORD:-caracal}
            POSTGRES_INITDB_ARGS: --encoding=UTF8
        volumes:
            - postgres_data:/var/lib/postgresql/data
        healthcheck:
            test:
                - CMD-SHELL
                - pg_isready -U ${CARACAL_DB_USER:-caracal} -d ${CARACAL_DB_NAME:-caracal}
            interval: 10s
            timeout: 5s
            retries: 10
            start_period: 10s
        restart: unless-stopped
        networks:
            - caracal-runtime

    redis:
        image: redis:7-alpine
        command:
            - redis-server
            - --appendonly
            - "yes"
            - --save
            - "900"
            - "1"
            - --save
            - "300"
            - "10"
            - --save
            - "60"
            - "10000"
        volumes:
            - redis_data:/data
        healthcheck:
            test:
                - CMD
                - redis-cli
                - ping
            interval: 10s
            timeout: 5s
            retries: 10
            start_period: 5s
        restart: unless-stopped
        networks:
            - caracal-runtime

    mcp:
        image: ${CARACAL_RUNTIME_IMAGE:-ghcr.io/garudex-labs/caracal-runtime:latest}
        depends_on:
            postgres:
                condition: service_healthy
            redis:
                condition: service_healthy
        environment:
            HOME: /home/caracal
            CARACAL_RUNTIME_IN_CONTAINER: "1"
            CARACAL_WORKSPACE_ROOT: /home/caracal/.caracal
            CARACAL_API_URL: http://mcp:8080
            CARACAL_CONFIG_PATH: /home/caracal/.caracal/config.yaml
            CARACAL_MCP_LISTEN_ADDRESS: 0.0.0.0:8080
            CARACAL_GATEWAY_URL: ${CARACAL_GATEWAY_URL:-}
            CARACAL_GATEWAY_ENDPOINT: ${CARACAL_GATEWAY_ENDPOINT:-}
            CARACAL_GATEWAY_ENABLED: ${CARACAL_GATEWAY_ENABLED:-false}
            CARACAL_ENV_MODE: ${CARACAL_ENV_MODE:-dev}
            CARACAL_DEBUG_LOGS: ${CARACAL_DEBUG_LOGS:-false}
            CARACAL_JSON_LOGS: ${CARACAL_JSON_LOGS:-false}
            CARACAL_DB_HOST: postgres
            CARACAL_DB_PORT: 5432
            CARACAL_DB_NAME: ${CARACAL_DB_NAME:-caracal}
            CARACAL_DB_USER: ${CARACAL_DB_USER:-caracal}
            CARACAL_DB_PASSWORD: ${CARACAL_DB_PASSWORD:-caracal}
            REDIS_HOST: redis
            REDIS_PORT: 6379
            REDIS_PASSWORD: ${REDIS_PASSWORD:-}
            LOG_LEVEL: ${LOG_LEVEL:-INFO}
        command:
            - python
            - -m
            - caracal.mcp.service
        volumes:
            - caracal_state:/home/caracal/.caracal
        ports:
            - ${MCP_ADAPTER_PORT:-8000}:8080
        healthcheck:
            test:
                - CMD
                - python
                - -c
                - import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health').read()
            interval: 30s
            timeout: 10s
            retries: 5
            start_period: 30s
        restart: unless-stopped
        networks:
            - caracal-runtime

    cli:
        profiles:
            - tools
        image: ${CARACAL_RUNTIME_IMAGE:-ghcr.io/garudex-labs/caracal-runtime:latest}
        depends_on:
            postgres:
                condition: service_healthy
            redis:
                condition: service_healthy
        environment:
            HOME: /home/caracal
            CARACAL_RUNTIME_IN_CONTAINER: "1"
            CARACAL_WORKSPACE_ROOT: /home/caracal/.caracal
            CARACAL_API_URL: http://mcp:8080
            CARACAL_CONFIG_PATH: /home/caracal/.caracal/config.yaml
            CARACAL_GATEWAY_URL: ${CARACAL_GATEWAY_URL:-}
            CARACAL_GATEWAY_ENDPOINT: ${CARACAL_GATEWAY_ENDPOINT:-}
            CARACAL_GATEWAY_ENABLED: ${CARACAL_GATEWAY_ENABLED:-false}
            CARACAL_ENV_MODE: ${CARACAL_ENV_MODE:-dev}
            CARACAL_DEBUG_LOGS: ${CARACAL_DEBUG_LOGS:-false}
            CARACAL_JSON_LOGS: ${CARACAL_JSON_LOGS:-false}
            CARACAL_DB_HOST: postgres
            CARACAL_DB_PORT: 5432
            CARACAL_DB_NAME: ${CARACAL_DB_NAME:-caracal}
            CARACAL_DB_USER: ${CARACAL_DB_USER:-caracal}
            CARACAL_DB_PASSWORD: ${CARACAL_DB_PASSWORD:-caracal}
            REDIS_HOST: redis
            REDIS_PORT: 6379
            REDIS_PASSWORD: ${REDIS_PASSWORD:-}
            LOG_LEVEL: ${LOG_LEVEL:-INFO}
        command:
            - caracal
        volumes:
            - caracal_state:/home/caracal/.caracal
        stdin_open: true
        tty: true
        networks:
            - caracal-runtime

    flow:
        profiles:
            - tui
        image: ${CARACAL_RUNTIME_IMAGE:-ghcr.io/garudex-labs/caracal-runtime:latest}
        depends_on:
            postgres:
                condition: service_healthy
            redis:
                condition: service_healthy
        environment:
            HOME: /home/caracal
            CARACAL_RUNTIME_IN_CONTAINER: "1"
            CARACAL_WORKSPACE_ROOT: /home/caracal/.caracal
            CARACAL_API_URL: http://mcp:8080
            CARACAL_CONFIG_PATH: /home/caracal/.caracal/config.yaml
            CARACAL_GATEWAY_URL: ${CARACAL_GATEWAY_URL:-}
            CARACAL_GATEWAY_ENDPOINT: ${CARACAL_GATEWAY_ENDPOINT:-}
            CARACAL_GATEWAY_ENABLED: ${CARACAL_GATEWAY_ENABLED:-false}
            CARACAL_ENV_MODE: ${CARACAL_ENV_MODE:-dev}
            CARACAL_DEBUG_LOGS: ${CARACAL_DEBUG_LOGS:-false}
            CARACAL_JSON_LOGS: ${CARACAL_JSON_LOGS:-false}
            TERM: xterm-256color
            COLORTERM: truecolor
            CARACAL_DB_HOST: postgres
            CARACAL_DB_PORT: 5432
            CARACAL_DB_NAME: ${CARACAL_DB_NAME:-caracal}
            CARACAL_DB_USER: ${CARACAL_DB_USER:-caracal}
            CARACAL_DB_PASSWORD: ${CARACAL_DB_PASSWORD:-caracal}
            REDIS_HOST: redis
            REDIS_PORT: 6379
            REDIS_PASSWORD: ${REDIS_PASSWORD:-}
            LOG_LEVEL: ${LOG_LEVEL:-INFO}
        command:
            - python
            - -m
            - caracal.flow.main
        volumes:
            - caracal_state:/home/caracal/.caracal
        stdin_open: true
        tty: true
        networks:
            - caracal-runtime

volumes:
    postgres_data:
    redis_data:
    caracal_state:

networks:
    caracal-runtime:
        name: ${CARACAL_RUNTIME_NETWORK:-caracal-runtime}
"""


def caracal_entrypoint() -> None:
    """Entrypoint for host orchestrator / container CLI."""
    args = tuple(sys.argv[1:])
    if _in_container_runtime():
        _run_local_caracal(args)
        return

    exit_code = _run_host_orchestrator(args)
    raise SystemExit(exit_code)


def _run_host_orchestrator(args: Sequence[str]) -> int:
    os_name = platform.system()
    parser = argparse.ArgumentParser(
        prog="caracal",
        description=(
            "Caracal host orchestrator.\n"
            "Use this command to manage Docker runtime services.\n"
            "Use 'caracal cli' to open an in-container shell session."
        ),
        formatter_class=argparse.RawTextHelpFormatter,
        epilog=(
            f"Detected OS: {os_name}\n"
            "Examples:\n"
            "  caracal up\n"
            "  caracal cli\n"
            "  caracal flow"
        ),
    )

    subparsers = parser.add_subparsers(dest="command")

    up_parser = subparsers.add_parser("up", help="Start full stack (postgres, redis, mcp)")
    up_parser.add_argument("--no-pull", action="store_true", help="Skip docker compose pull")
    up_parser.set_defaults(handler=_host_up)

    down_parser = subparsers.add_parser("down", help="Stop stack and remove services")
    down_parser.set_defaults(handler=_host_down)

    reset_parser = subparsers.add_parser("reset", help="Stop stack and remove volumes")
    reset_parser.set_defaults(handler=_host_reset)

    logs_parser = subparsers.add_parser("logs", help="Show runtime logs")
    logs_parser.add_argument("-f", "--follow", action="store_true", help="Follow log output")
    logs_parser.add_argument(
        "services",
        nargs="*",
        default=["mcp", "postgres", "redis"],
        help="Optional service names",
    )
    logs_parser.set_defaults(handler=_host_logs)

    cli_parser = subparsers.add_parser(
        "cli",
        help="Open an interactive shell session inside the runtime container",
    )
    cli_parser.set_defaults(handler=_host_cli)

    flow_parser = subparsers.add_parser("flow", help="Launch Flow (TUI) inside runtime container")
    flow_parser.set_defaults(handler=_host_flow)

    for command_parser in (up_parser, down_parser, reset_parser, logs_parser, cli_parser, flow_parser):
        command_parser.add_argument(
            "--compose-file",
            default=None,
            help=(
                "Advanced: override compose file path. "
                "Default: auto-detect image compose, then fallback to embedded compose."
            ),
        )

    if not args:
        parser.print_help()
        return 0

    try:
        namespace = parser.parse_args(list(args))
        handler = getattr(namespace, "handler", None)
        if handler is None:
            parser.print_help()
            return 2
        return int(handler(namespace))
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else 2
        return int(code)
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2


def _host_up(namespace: argparse.Namespace) -> int:
    compose_file = _resolve_compose_file(namespace.compose_file)
    compose_cmd = _compose_cmd(compose_file)
    if not namespace.no_pull:
        pull_services = ["postgres", "redis"]
        if not _service_uses_local_build(compose_file, "mcp"):
            pull_services.insert(0, "mcp")

        pull_result = subprocess.run(compose_cmd + ["pull", *pull_services], check=False)
        if pull_result.returncode != 0:
            return pull_result.returncode

    up_result = subprocess.run(
        compose_cmd + ["up", "-d", "postgres", "redis", "mcp"],
        check=False,
    )
    return up_result.returncode


def _host_down(namespace: argparse.Namespace) -> int:
    compose_file = _resolve_compose_file(namespace.compose_file)
    compose_cmd = _compose_cmd(compose_file)
    result = subprocess.run(
        compose_cmd + ["down", "--remove-orphans"],
        check=False,
        capture_output=True,
        text=True,
    )
    _emit_compose_teardown_output(result.stdout, result.stderr)
    return result.returncode


def _host_reset(namespace: argparse.Namespace) -> int:
    compose_file = _resolve_compose_file(namespace.compose_file)
    compose_cmd = _compose_cmd(compose_file)
    result = subprocess.run(
        compose_cmd + ["down", "-v", "--remove-orphans"],
        check=False,
        capture_output=True,
        text=True,
    )
    _emit_compose_teardown_output(result.stdout, result.stderr)
    return result.returncode


def _emit_compose_teardown_output(stdout: str | None, stderr: str | None) -> None:
    filtered_stdout, stdout_network_in_use = _filter_compose_teardown_stream(stdout)
    filtered_stderr, stderr_network_in_use = _filter_compose_teardown_stream(stderr)
    filtered_network_in_use = stdout_network_in_use or stderr_network_in_use

    if filtered_stdout:
        print(filtered_stdout)

    if filtered_stderr:
        print(filtered_stderr, file=sys.stderr, end="" if filtered_stderr.endswith("\n") else "\n")

    if filtered_network_in_use:
        network_name = os.environ.get("CARACAL_RUNTIME_NETWORK", "caracal-runtime")
        attached_containers = _list_network_container_names(network_name)
        if attached_containers:
            container_list = ", ".join(attached_containers)
            print(
                f"Note: shared Docker network '{network_name}' is still attached to: "
                f"{container_list}. It was left intact."
            )
            return

        print(
            f"Note: shared Docker network '{network_name}' is still in use by other containers and was left intact."
        )


def _filter_compose_teardown_stream(output: str | None) -> tuple[str, bool]:
    if not output:
        return "", False

    filtered_lines: list[str] = []
    filtered_network_in_use = False
    for line in output.splitlines():
        if "Network" in line and NETWORK_IN_USE_MARKER in line:
            filtered_network_in_use = True
            continue
        filtered_lines.append(line)

    return "\n".join(filtered_lines), filtered_network_in_use


def _list_network_container_names(network_name: str) -> list[str]:
    docker = shutil.which("docker")
    if docker is None:
        return []

    result = subprocess.run(
        [docker, "network", "inspect", network_name, "--format", "{{json .Containers}}"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return []

    raw_payload = (result.stdout or "").strip()
    if not raw_payload or raw_payload == "null":
        return []

    try:
        containers = json.loads(raw_payload)
    except json.JSONDecodeError:
        return []

    if not isinstance(containers, dict):
        return []

    names = [
        container.get("Name")
        for container in containers.values()
        if isinstance(container, dict) and isinstance(container.get("Name"), str)
    ]
    return sorted(name for name in names if name)


def _host_logs(namespace: argparse.Namespace) -> int:
    compose_file = _resolve_compose_file(namespace.compose_file)
    compose_cmd = _compose_cmd(compose_file)
    cmd = compose_cmd + ["logs"]
    if namespace.follow:
        cmd.append("-f")
    cmd.extend(namespace.services)
    result = subprocess.run(cmd, check=False)
    return result.returncode


def _host_cli(namespace: argparse.Namespace) -> int:
    compose_file = _resolve_compose_file(namespace.compose_file)
    start_code = _host_up(argparse.Namespace(compose_file=namespace.compose_file, no_pull=True))
    if start_code != 0:
        return start_code

    compose_cmd = _compose_cmd(compose_file)
    cmd = compose_cmd + ["exec", "-u", "caracal", "mcp", "/bin/bash"]
    result = subprocess.run(cmd, check=False)
    return result.returncode


def _host_flow(namespace: argparse.Namespace) -> int:
    compose_file = _resolve_compose_file(namespace.compose_file)
    start_code = _host_up(argparse.Namespace(compose_file=namespace.compose_file, no_pull=True))
    if start_code != 0:
        return start_code

    compose_cmd = _compose_cmd(compose_file)
    cmd = compose_cmd + [
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
    ]
    result = subprocess.run(cmd, check=False)
    return result.returncode


def _resolve_compose_file(override_path: str | None = None) -> Path:
    env_path = override_path or os.environ.get(COMPOSE_FILE_ENV)
    if env_path:
        candidate = Path(env_path).expanduser().resolve()
        if candidate.exists() and _compose_supports_runtime_services(candidate):
            return candidate
        raise RuntimeError(f"{COMPOSE_FILE_ENV} points to a missing or invalid file: {candidate}")

    candidates: list[Path] = []

    # In source checkouts, prefer build compose to avoid registry auth requirements.
    # For packaged installs where build files are unavailable, image compose remains a fallback.
    package_root = Path(__file__).resolve()
    for root in (package_root, *package_root.parents):
        candidates.append(root / "deploy" / "docker-compose.yml")
        candidates.append(root / "docker-compose.yml")
        candidates.append(root / "deploy" / "docker-compose.image.yml")
        candidates.append(root / "docker-compose.image.yml")

    current = Path.cwd().resolve()
    for root in (current, *current.parents):
        candidates.append(root / "deploy" / "docker-compose.yml")
        candidates.append(root / "docker-compose.yml")
        candidates.append(root / "deploy" / "docker-compose.image.yml")
        candidates.append(root / "docker-compose.image.yml")

    for candidate in candidates:
        if candidate.exists() and _compose_supports_runtime_services(candidate):
            return candidate

    embedded = _ensure_embedded_compose_file()
    if embedded.exists():
        return embedded

    raise RuntimeError("Unable to locate runtime compose file for Caracal.")


def _ensure_embedded_compose_file() -> Path:
    _EMBEDDED_COMPOSE_FILE.parent.mkdir(parents=True, exist_ok=True)
    if not _EMBEDDED_COMPOSE_FILE.exists():
        _EMBEDDED_COMPOSE_FILE.write_text(_EMBEDDED_COMPOSE_CONTENT, encoding="utf-8")
    return _EMBEDDED_COMPOSE_FILE


def _compose_supports_runtime_services(compose_file: Path) -> bool:
    try:
        data = compose_file.read_text(encoding="utf-8")
    except OSError:
        return False

    return all(marker in data for marker in ("mcp:", "cli:", "flow:"))


def _service_uses_local_build(compose_file: Path, service_name: str) -> bool:
    try:
        data = compose_file.read_text(encoding="utf-8")
    except OSError:
        return False

    lines = data.splitlines()
    in_services = False
    services_indent = 0
    target_header = f"{service_name}:"
    in_target_service = False
    target_indent = 0

    for raw_line in lines:
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        indent = len(raw_line) - len(raw_line.lstrip(" "))

        if not in_services:
            if stripped == "services:":
                in_services = True
                services_indent = indent
            continue

        if indent <= services_indent and stripped.endswith(":"):
            break

        if not in_target_service and indent == services_indent + 2 and stripped == target_header:
            in_target_service = True
            target_indent = indent
            continue

        if in_target_service:
            if indent <= target_indent and stripped.endswith(":"):
                return False
            if stripped.startswith("build:"):
                return True

    return False


def _compose_cmd(compose_file: Path) -> list[str]:
    return _resolve_compose_command() + ["-f", str(compose_file)]


def _resolve_compose_command() -> list[str]:
    docker = shutil.which("docker")
    if docker is not None:
        probe = subprocess.run(
            [docker, "compose", "version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if probe.returncode == 0:
            return [docker, "compose"]

    legacy = shutil.which("docker-compose")
    if legacy is not None:
        return [legacy]

    raise RuntimeError(
        "Docker Compose is required but not available. "
        "Install Docker Compose plugin or docker-compose."
    )


def _run_local_caracal(args: Sequence[str]) -> None:
    from caracal.cli.main import cli

    cli.main(args=list(args), prog_name="caracal", standalone_mode=True)


def _is_truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _in_container_runtime() -> bool:
    return _is_truthy(os.environ.get(IN_CONTAINER_ENV)) or Path("/.dockerenv").exists()
