"""Host/container command entrypoints for Caracal runtime.

Host command (``caracal``): orchestration-only UX.
Container command (``caracal``): restricted interactive Caracal CLI.
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

from caracal.storage.layout import resolve_caracal_home

COMPOSE_FILE_ENV = "CARACAL_DOCKER_COMPOSE_FILE"
IN_CONTAINER_ENV = "CARACAL_RUNTIME_IN_CONTAINER"
NETWORK_IN_USE_MARKER = "Resource is still in use"
PURGE_CONFIRMATION_TEXT = "purge"

_EMBEDDED_COMPOSE_FILE = resolve_caracal_home(require_explicit=False) / "runtime" / "docker-compose.image.yml"
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
            CARACAL_HOME: /home/caracal/.caracal
            CARACAL_API_URL: http://mcp:8080
            CARACAL_CONFIG_PATH: /home/caracal/.caracal/config.yaml
            CARACAL_MCP_LISTEN_ADDRESS: 0.0.0.0:8080
            CARACAL_ENTERPRISE_URL: ${CARACAL_ENTERPRISE_URL:-}
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
            - ${CARACAL_API_PORT:-8000}:8080
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
            CARACAL_HOME: /home/caracal/.caracal
            CARACAL_API_URL: http://mcp:8080
            CARACAL_CONFIG_PATH: /home/caracal/.caracal/config.yaml
            CARACAL_ENTERPRISE_URL: ${CARACAL_ENTERPRISE_URL:-}
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
            CARACAL_HOME: /home/caracal/.caracal
            CARACAL_API_URL: http://mcp:8080
            CARACAL_CONFIG_PATH: /home/caracal/.caracal/config.yaml
            CARACAL_ENTERPRISE_URL: ${CARACAL_ENTERPRISE_URL:-}
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
            "Caracal Help\n"
        ),
        formatter_class=argparse.RawTextHelpFormatter,
        epilog=(
            f"Detected OS: {os_name}\n"
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

    purge_parser = subparsers.add_parser(
        "purge",
        help="Purge all Caracal resources, data, and dependencies from the system",
    )
    purge_parser.add_argument(
        "--force",
        action="store_true",
        help="Skip interactive confirmation and permanently purge Caracal resources",
    )
    purge_parser.set_defaults(handler=_host_purge)

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
        help="Launch a restricted interactive Caracal CLI session in the container",
    )
    cli_parser.set_defaults(handler=_host_cli)

    flow_parser = subparsers.add_parser("flow", help="Launch Flow (TUI) inside runtime container")
    flow_parser.set_defaults(handler=_host_flow)

    for command_parser in (up_parser, down_parser, reset_parser, purge_parser, logs_parser, cli_parser, flow_parser):
        command_parser.add_argument(
            "--compose-file",
            default=None,
            help=(
                "Advanced: override compose file path. "
                "Default: auto-detect compose file, then use embedded runtime compose."
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
    uses_local_build = _service_uses_local_build(compose_file, "mcp")

    if not namespace.no_pull:
        pull_services = ["postgres", "redis"]
        if not uses_local_build:
            pull_services.insert(0, "mcp")

        pull_result = subprocess.run(compose_cmd + ["pull", *pull_services], check=False)
        if pull_result.returncode != 0:
            return pull_result.returncode

    up_cmd = [*compose_cmd, "up", "-d"]
    if uses_local_build:
        # Ensure source changes are reflected in the runtime image during local development.
        up_cmd.append("--build")

    up_result = subprocess.run(
        [*up_cmd, "postgres", "redis", "mcp"],
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
    network_in_use = _emit_compose_teardown_output(result.stdout, result.stderr)
    return _finalize_teardown_result(result.returncode, network_in_use)


def _host_reset(namespace: argparse.Namespace) -> int:
    compose_file = _resolve_compose_file(namespace.compose_file)
    compose_cmd = _compose_cmd(compose_file)
    result = subprocess.run(
        compose_cmd + ["down", "-v", "--remove-orphans"],
        check=False,
        capture_output=True,
        text=True,
    )
    network_in_use = _emit_compose_teardown_output(result.stdout, result.stderr)
    return _finalize_teardown_result(result.returncode, network_in_use)


def _host_purge(namespace: argparse.Namespace) -> int:
    if not _confirm_purge(force=bool(namespace.force)):
        return 2

    compose_file = None
    compose_override = getattr(namespace, "compose_file", None)
    if compose_override:
        try:
            compose_file = _resolve_compose_file(compose_override)
        except RuntimeError:
            compose_file = None

    containers = _list_caracal_container_names()
    volumes = _list_caracal_volume_names()
    networks = _list_caracal_network_names()
    images = _list_caracal_image_refs(compose_file)
    paths = _list_caracal_purge_paths()

    removed: dict[str, list[str]] = {
        "containers": [],
        "volumes": [],
        "networks": [],
        "images": [],
        "paths": [],
        "keyring": [],
    }
    failures: list[str] = []

    for container_name in containers:
        if _remove_container(container_name):
            removed["containers"].append(container_name)
        else:
            failures.append(f"container:{container_name}")

    for volume_name in volumes:
        if _remove_volume(volume_name):
            removed["volumes"].append(volume_name)
        else:
            failures.append(f"volume:{volume_name}")

    for network_name in networks:
        if _remove_network(network_name):
            removed["networks"].append(network_name)
        else:
            failures.append(f"network:{network_name}")

    for image_ref in images:
        if _remove_image(image_ref):
            removed["images"].append(image_ref)
        else:
            failures.append(f"image:{image_ref}")

    for path in paths:
        if _delete_path(path):
            removed["paths"].append(str(path))
        else:
            failures.append(f"path:{path}")

    if _purge_keyring_credentials():
        removed["keyring"].append("caracal/encryption_key")

    _print_purge_summary(removed)

    if failures:
        print(
            "Error: Caracal purge left behind resources that could not be removed: "
            + ", ".join(failures),
            file=sys.stderr,
        )
        return 1

    print("Caracal purge completed. The system is now clean.")
    return 0


def _confirm_purge(*, force: bool) -> bool:
    if force:
        return True

    if not sys.stdin.isatty():
        print(
            "Error: 'caracal purge' is destructive. Re-run with '--force' in non-interactive environments.",
            file=sys.stderr,
        )
        return False

    print("This will permanently remove all Caracal Docker resources and local data.")
    print("It deletes Caracal containers, volumes, networks, images, workspaces, and CARACAL_HOME state.")
    response = input(f"Type '{PURGE_CONFIRMATION_TEXT}' to continue: ").strip().lower()
    if response != PURGE_CONFIRMATION_TEXT:
        print("Purge cancelled.")
        return False

    return True


def _finalize_teardown_result(returncode: int, network_in_use: bool) -> int:
    if not network_in_use:
        return returncode

    network_name = os.environ.get("CARACAL_RUNTIME_NETWORK", "caracal-runtime")
    removed_blockers, remaining_blockers, network_removed = _reconcile_shared_runtime_network(network_name)

    if removed_blockers:
        print(
            f"Removed shared runtime blocker container(s): {', '.join(removed_blockers)}."
        )

    if network_removed:
        print(f"Removed shared Docker network '{network_name}'.")
        return returncode

    if remaining_blockers:
        print(
            f"Error: shared Docker network '{network_name}' is still attached to: "
            f"{', '.join(remaining_blockers)}.",
            file=sys.stderr,
        )
        return returncode or 1

    print(
        f"Error: failed to remove shared Docker network '{network_name}'.",
        file=sys.stderr,
    )
    return returncode or 1


def _emit_compose_teardown_output(stdout: str | None, stderr: str | None) -> bool:
    filtered_stdout, stdout_network_in_use = _filter_compose_teardown_stream(stdout)
    filtered_stderr, stderr_network_in_use = _filter_compose_teardown_stream(stderr)
    filtered_network_in_use = stdout_network_in_use or stderr_network_in_use

    if filtered_stdout:
        print(filtered_stdout)

    if filtered_stderr:
        print(filtered_stderr, file=sys.stderr, end="" if filtered_stderr.endswith("\n") else "\n")

    return filtered_network_in_use


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


def _list_caracal_container_names() -> list[str]:
    docker = shutil.which("docker")
    if docker is None:
        return []

    result = subprocess.run(
        [docker, "ps", "-a", "--format", "{{.Names}}"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return []

    names = []
    for raw_name in result.stdout.splitlines():
        container_name = raw_name.strip()
        if not container_name:
            continue
        if _is_caracal_managed_container(container_name):
            names.append(container_name)
    return sorted(set(names))


def _is_caracal_managed_container(container_name: str) -> bool:
    labels = _inspect_container_labels(container_name)
    project = labels.get("com.docker.compose.project", "").lower()
    if project.startswith("caracal"):
        return True

    image_ref = _inspect_container_image(container_name).lower()
    if "caracal" in image_ref:
        return True

    return container_name.lower().startswith("caracal")


def _reconcile_shared_runtime_network(network_name: str) -> tuple[list[str], list[str], bool]:
    attached_containers = _list_network_container_names(network_name)
    removed_blockers: list[str] = []

    for container_name in attached_containers:
        if not _is_caracal_managed_shared_container(container_name):
            continue
        if _remove_container(container_name):
            removed_blockers.append(container_name)

    remaining_blockers = _list_network_container_names(network_name)
    if remaining_blockers:
        return removed_blockers, remaining_blockers, False

    return removed_blockers, [], _remove_network(network_name)


def _is_caracal_managed_shared_container(container_name: str) -> bool:
    return _is_caracal_managed_container(container_name)


def _inspect_container_labels(container_name: str) -> dict[str, str]:
    docker = shutil.which("docker")
    if docker is None:
        return {}

    result = subprocess.run(
        [docker, "inspect", container_name, "--format", "{{json .Config.Labels}}"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return {}

    raw_payload = (result.stdout or "").strip()
    if not raw_payload or raw_payload == "null":
        return {}

    try:
        labels = json.loads(raw_payload)
    except json.JSONDecodeError:
        return {}

    if not isinstance(labels, dict):
        return {}

    return {
        str(key): str(value)
        for key, value in labels.items()
        if isinstance(key, str) and isinstance(value, str)
    }


def _inspect_container_image(container_name: str) -> str:
    docker = shutil.which("docker")
    if docker is None:
        return ""

    result = subprocess.run(
        [docker, "inspect", container_name, "--format", "{{.Config.Image}}"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return ""

    return (result.stdout or "").strip()


def _remove_container(container_name: str) -> bool:
    docker = shutil.which("docker")
    if docker is None:
        return False

    result = subprocess.run(
        [docker, "rm", "-f", container_name],
        check=False,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def _list_caracal_volume_names() -> list[str]:
    docker = shutil.which("docker")
    if docker is None:
        return []

    result = subprocess.run(
        [docker, "volume", "ls", "--format", "{{.Name}}"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return []

    names = []
    for raw_name in result.stdout.splitlines():
        volume_name = raw_name.strip()
        if not volume_name:
            continue
        if _is_caracal_managed_volume(volume_name):
            names.append(volume_name)
    return sorted(set(names))


def _is_caracal_managed_volume(volume_name: str) -> bool:
    labels = _inspect_volume_labels(volume_name)
    project = labels.get("com.docker.compose.project", "").lower()
    if project.startswith("caracal"):
        return True

    return volume_name.lower().startswith("caracal")


def _inspect_volume_labels(volume_name: str) -> dict[str, str]:
    docker = shutil.which("docker")
    if docker is None:
        return {}

    result = subprocess.run(
        [docker, "volume", "inspect", volume_name, "--format", "{{json .Labels}}"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return {}

    return _parse_string_dict(result.stdout)


def _remove_volume(volume_name: str) -> bool:
    docker = shutil.which("docker")
    if docker is None:
        return False

    result = subprocess.run(
        [docker, "volume", "rm", "-f", volume_name],
        check=False,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def _list_caracal_network_names() -> list[str]:
    docker = shutil.which("docker")
    if docker is None:
        return []

    result = subprocess.run(
        [docker, "network", "ls", "--format", "{{.Name}}"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return []

    names = []
    for raw_name in result.stdout.splitlines():
        network_name = raw_name.strip()
        if not network_name:
            continue
        if _is_caracal_managed_network(network_name):
            names.append(network_name)
    return sorted(set(names))


def _is_caracal_managed_network(network_name: str) -> bool:
    if network_name in {"bridge", "host", "none"}:
        return False

    labels = _inspect_network_labels(network_name)
    project = labels.get("com.docker.compose.project", "").lower()
    if project.startswith("caracal"):
        return True

    return network_name.lower().startswith("caracal")


def _inspect_network_labels(network_name: str) -> dict[str, str]:
    docker = shutil.which("docker")
    if docker is None:
        return {}

    result = subprocess.run(
        [docker, "network", "inspect", network_name, "--format", "{{json .Labels}}"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return {}

    return _parse_string_dict(result.stdout)


def _list_caracal_image_refs(compose_file: Path | None = None) -> list[str]:
    docker = shutil.which("docker")
    if docker is None:
        return []

    image_refs: set[str] = set()
    result = subprocess.run(
        [docker, "images", "--format", "{{.Repository}}\t{{.Tag}}"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        for line in result.stdout.splitlines():
            repo, _, tag = line.partition("\t")
            repo = repo.strip()
            tag = tag.strip()
            if not repo or repo == "<none>" or tag == "<none>":
                continue
            image_ref = f"{repo}:{tag}"
            if "caracal" in image_ref.lower():
                image_refs.add(image_ref)

    if compose_file is not None:
        image_refs.update(_compose_runtime_image_refs(compose_file))

    return sorted(image_refs)


def _compose_runtime_image_refs(compose_file: Path) -> set[str]:
    try:
        data = compose_file.read_text(encoding="utf-8")
    except OSError:
        return set()

    image_refs: set[str] = set()
    for line in data.splitlines():
        stripped = line.strip()
        if not stripped.startswith("image:"):
            continue
        _, _, image_value = stripped.partition(":")
        image_value = image_value.strip()
        if not image_value:
            continue
        if "${CARACAL_RUNTIME_IMAGE:-" in image_value and image_value.endswith("}"):
            default_ref = image_value.split("${CARACAL_RUNTIME_IMAGE:-", 1)[1][:-1]
            if default_ref:
                image_refs.add(default_ref)
            env_ref = os.environ.get("CARACAL_RUNTIME_IMAGE")
            if env_ref:
                image_refs.add(env_ref)
            continue
        if "caracal" in image_value.lower():
            image_refs.add(image_value)

    return image_refs


def _remove_image(image_ref: str) -> bool:
    docker = shutil.which("docker")
    if docker is None:
        return False

    result = subprocess.run(
        [docker, "image", "rm", "-f", image_ref],
        check=False,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def _remove_network(network_name: str) -> bool:
    docker = shutil.which("docker")
    if docker is None:
        return False

    result = subprocess.run(
        [docker, "network", "rm", network_name],
        check=False,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def _list_caracal_purge_paths() -> list[Path]:
    caracal_home = _caracal_home_dir()
    paths: set[Path] = set()

    for workspace_path in _load_registered_workspace_paths():
        if workspace_path == caracal_home or caracal_home in workspace_path.parents:
            continue
        paths.add(workspace_path)

    paths.add(caracal_home)
    paths.update(_completion_artifact_paths())

    return sorted(paths, key=lambda path: len(path.parts), reverse=True)


def _caracal_home_dir() -> Path:
    return resolve_caracal_home(require_explicit=False)


def _completion_artifact_paths() -> set[Path]:
    home = Path.home()
    return {
        home / ".caracal-completion.bash",
        home / ".caracal-completion.zsh",
        home / ".caracal-completion.fish",
        home / ".config" / "fish" / "completions" / "caracal.fish",
    }


def _load_registered_workspace_paths() -> list[Path]:
    registry_path = _caracal_home_dir() / "workspaces.json"
    if not registry_path.exists():
        return []

    try:
        payload = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []

    workspaces = payload.get("workspaces", [])
    if not isinstance(workspaces, list):
        return []

    paths: list[Path] = []
    for workspace in workspaces:
        if not isinstance(workspace, dict):
            continue
        raw_path = workspace.get("path")
        if not isinstance(raw_path, str) or not raw_path.strip():
            continue
        paths.append(Path(raw_path).expanduser())
    return paths


def _delete_path(path: Path) -> bool:
    if not path.exists() and not path.is_symlink():
        return True

    try:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path, onerror=_handle_remove_readonly)
        else:
            path.unlink()
        return True
    except OSError:
        return False


def _handle_remove_readonly(func, path: str, exc_info) -> None:
    del exc_info
    os.chmod(path, 0o700)
    func(path)


def _purge_keyring_credentials() -> bool:
    try:
        import keyring
    except Exception:
        return False

    try:
        keyring.delete_password("caracal", "encryption_key")
        return True
    except Exception:
        return False


def _print_purge_summary(removed: dict[str, list[str]]) -> None:
    labels = {
        "containers": "containers",
        "volumes": "volumes",
        "networks": "networks",
        "images": "images",
        "paths": "paths",
        "keyring": "keyring entries",
    }

    found_any = False
    for key in ("containers", "volumes", "networks", "images", "paths", "keyring"):
        values = removed.get(key, [])
        if not values:
            continue
        found_any = True
        print(f"Removed {labels[key]}: {', '.join(values)}")

    if not found_any:
        print("No Caracal runtime resources were found to purge.")


def _parse_string_dict(raw_payload: str | None) -> dict[str, str]:
    raw_payload = (raw_payload or "").strip()
    if not raw_payload or raw_payload == "null":
        return {}

    try:
        data = json.loads(raw_payload)
    except json.JSONDecodeError:
        return {}

    if not isinstance(data, dict):
        return {}

    return {
        str(key): str(value)
        for key, value in data.items()
        if isinstance(key, str) and isinstance(value, str)
    }


def _host_logs(namespace: argparse.Namespace) -> int:
    compose_file = _resolve_compose_file(namespace.compose_file)
    compose_cmd = _compose_cmd(compose_file)
    cmd = compose_cmd + ["logs"]
    if namespace.follow:
        cmd.append("-f")
        cmd.extend(namespace.services)
        result = subprocess.run(cmd, check=False)
        return result.returncode

    cmd.extend(namespace.services)
    result = subprocess.run(
        cmd,
        check=False,
        capture_output=True,
        text=True,
    )

    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")

    if result.stderr:
        print(result.stderr, file=sys.stderr, end="" if result.stderr.endswith("\n") else "\n")

    if not (result.stdout or "").strip() and not (result.stderr or "").strip():
        print("No runtime logs are available. Start the stack with 'caracal up' first.")

    return result.returncode


def _host_cli(namespace: argparse.Namespace) -> int:
    compose_file = _resolve_compose_file(namespace.compose_file)
    start_code = _host_up(argparse.Namespace(compose_file=namespace.compose_file, no_pull=True))
    if start_code != 0:
        return start_code

    compose_cmd = _compose_cmd(compose_file)
    cmd = compose_cmd + ["exec", "-u", "caracal", "mcp", "caracal"]
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
    # For packaged installs where build files are unavailable, image compose is used.
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

    raise RuntimeError(
        "Docker Compose plugin is required but not available. "
        "Install Docker Compose plugin and ensure 'docker compose version' works."
    )


def _run_local_caracal(args: Sequence[str]) -> None:
    from caracal.runtime.restricted_shell import run_restricted_command

    raise SystemExit(run_restricted_command(list(args)))


def _is_truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _in_container_runtime() -> bool:
    return _is_truthy(os.environ.get(IN_CONTAINER_ENV)) or Path("/.dockerenv").exists()
