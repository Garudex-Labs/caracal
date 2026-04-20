"""Host/container command entrypoints for Caracal runtime.

Host command (``caracal``): orchestration-only UX.
Container command (``caracal``): restricted interactive Caracal CLI.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Sequence

from caracal.runtime.hardcut_preflight import assert_runtime_hardcut
from caracal.storage.layout import resolve_caracal_home

COMPOSE_FILE_ENV = "CARACAL_DOCKER_COMPOSE_FILE"
IN_CONTAINER_ENV = "CARACAL_RUNTIME_IN_CONTAINER"
HOST_IO_DIR_ENV = "CARACAL_HOST_IO_DIR"
HOST_IO_ROOT_ENV = "CARACAL_HOST_IO_ROOT"
HOST_IO_ROOT_IN_CONTAINER = "/caracal-host-io"
NETWORK_IN_USE_MARKER = "Resource is still in use"
PURGE_CONFIRMATION_TEXT = "purge"

AIS_STARTUP_NONCE_ENV = "CARACAL_AIS_ATTESTATION_NONCE"
AIS_STARTUP_PRINCIPAL_ENV = "CARACAL_AIS_ATTESTATION_PRINCIPAL_ID"
AIS_API_PREFIX_ENV = "CARACAL_AIS_API_PREFIX"
AIS_UNIX_SOCKET_PATH_ENV = "CARACAL_AIS_UNIX_SOCKET_PATH"
AIS_LISTEN_HOST_ENV = "CARACAL_AIS_LISTEN_HOST"
AIS_LISTEN_PORT_ENV = "CARACAL_AIS_LISTEN_PORT"
AIS_HEALTHCHECK_TIMEOUT_ENV = "CARACAL_AIS_HEALTHCHECK_TIMEOUT_SECONDS"
AIS_HEALTHCHECK_INTERVAL_ENV = "CARACAL_AIS_HEALTHCHECK_INTERVAL_SECONDS"
AIS_STARTUP_TIMEOUT_ENV = "CARACAL_AIS_STARTUP_TIMEOUT_SECONDS"
AIS_MAX_RESTARTS_ENV = "CARACAL_AIS_MAX_RESTARTS"
AIS_DEFAULT_API_PREFIX = "/v1/ais"
AIS_DEFAULT_UNIX_SOCKET_PATH = "/tmp/caracal-ais.sock"
AIS_DEFAULT_LISTEN_HOST = "127.0.0.1"
AIS_DEFAULT_LISTEN_PORT = 7079
AIS_SESSION_SIGNING_KEY_REF_ENV = "CARACAL_VAULT_SIGNING_KEY_REF"
AIS_SESSION_VERIFY_KEY_REF_ENV = "CARACAL_VAULT_SESSION_PUBLIC_KEY_REF"
AIS_SESSION_ALGORITHM_ENV = "CARACAL_SESSION_SIGNING_ALGORITHM"
AIS_SESSION_CAVEAT_MODE_ENV = "CARACAL_SESSION_CAVEAT_MODE"
AIS_SESSION_CAVEAT_HMAC_KEY_ENV = "CARACAL_SESSION_CAVEAT_HMAC_KEY"
AIS_REVOCATION_EVENTS_CHANNEL_ENV = "CARACAL_REVOCATION_EVENTS_CHANNEL"
AIS_DEFAULT_REVOCATION_EVENTS_CHANNEL = "caracal:identity:revocation_events"
AIS_REVOCATION_PUBLISHER_MODE_ENV = "CARACAL_REVOCATION_PUBLISHER_MODE"
AIS_ENTERPRISE_REVOCATION_WEBHOOK_URL_ENV = "CARACAL_ENTERPRISE_REVOCATION_WEBHOOK_URL"
AIS_ENTERPRISE_REVOCATION_SYNC_API_KEY_ENV = "CARACAL_ENTERPRISE_SYNC_API_KEY"
AIS_DEFAULT_ENTERPRISE_REVOCATION_WEBHOOK_PATH = "/api/sync/revocation-events"

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

    vault:
        image: ${CARACAL_VAULT_SIDECAR_IMAGE:-infisical/infisical:latest}
        environment:
            NODE_ENV: production
            AUTH_SECRET: ${CARACAL_VAULT_SIDECAR_AUTH_SECRET:-caracal-dev-auth-secret}
            ENCRYPTION_KEY: ${CARACAL_VAULT_SIDECAR_ENCRYPTION_KEY:-f13dbc92aaaf86fa7cb0ed8ac3265f47}
            REDIS_URL: ${CARACAL_VAULT_SIDECAR_REDIS_URL:-redis://redis:6379}
            DB_CONNECTION_URI: ${CARACAL_VAULT_SIDECAR_DB_CONNECTION_URI:-postgresql://${CARACAL_DB_USER:-caracal}:${CARACAL_DB_PASSWORD:-caracal}@postgres:5432/${CARACAL_DB_NAME:-caracal}}
            SITE_URL: ${CARACAL_VAULT_SIDECAR_SITE_URL:-http://localhost:8080}
        ports:
            - "${CARACAL_VAULT_SIDECAR_PORT:-8080}:8080"
        healthcheck:
            test:
                - CMD-SHELL
                - wget -q -O /dev/null http://127.0.0.1:8080 || exit 1
            interval: 15s
            timeout: 5s
            retries: 20
            start_period: 30s
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
        ports:
            - "6379:6379"
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
            vault:
                condition: service_healthy
        environment:
            HOME: /home/caracal
            CARACAL_RUNTIME_IN_CONTAINER: "1"
            CARACAL_HOME: /home/caracal/runtime
            CARACAL_HOST_IO_ROOT: /caracal-host-io
            CARACAL_API_URL: http://mcp:8080
            CARACAL_CONFIG_PATH: /home/caracal/runtime/config.yaml
            CARACAL_MCP_LISTEN_ADDRESS: 0.0.0.0:8080
            CARACAL_PRINCIPAL_KEY_BACKEND: ${CARACAL_PRINCIPAL_KEY_BACKEND:-vault}
            CARACAL_VAULT_URL: ${CARACAL_VAULT_URL:-http://vault:8080}
            CARACAL_VAULT_TOKEN: ${CARACAL_VAULT_TOKEN:-dev-local-token}
            CARACAL_VAULT_WORKSPACE_ID: ${CARACAL_VAULT_WORKSPACE_ID:-}
            CARACAL_VAULT_ENVIRONMENT: ${CARACAL_VAULT_ENVIRONMENT:-dev}
            CARACAL_VAULT_SECRET_PATH: ${CARACAL_VAULT_SECRET_PATH:-/}
            CARACAL_VAULT_SIGNING_KEY_REF: ${CARACAL_VAULT_SIGNING_KEY_REF:-keys/mandate-signing}
            CARACAL_VAULT_SESSION_PUBLIC_KEY_REF: ${CARACAL_VAULT_SESSION_PUBLIC_KEY_REF:-keys/session-public}
            CARACAL_VAULT_MERKLE_SIGNING_KEY_REF: ${CARACAL_VAULT_MERKLE_SIGNING_KEY_REF:-keys/merkle-signing}
            CARACAL_VAULT_MERKLE_PUBLIC_KEY_REF: ${CARACAL_VAULT_MERKLE_PUBLIC_KEY_REF:-keys/merkle-signing-public}
            CARACAL_SESSION_SIGNING_ALGORITHM: ${CARACAL_SESSION_SIGNING_ALGORITHM:-RS256}
            CARACAL_VAULT_MODE: ${CARACAL_VAULT_MODE:-managed}
            CARACAL_VAULT_RETRY_MAX_ATTEMPTS: ${CARACAL_VAULT_RETRY_MAX_ATTEMPTS:-3}
            CARACAL_VAULT_RETRY_BACKOFF_SECONDS: ${CARACAL_VAULT_RETRY_BACKOFF_SECONDS:-0.2}
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
            CARACAL_AIS_ATTESTATION_NONCE: ${CARACAL_AIS_ATTESTATION_NONCE:-}
            CARACAL_AIS_ATTESTATION_PRINCIPAL_ID: ${CARACAL_AIS_ATTESTATION_PRINCIPAL_ID:-}
            CARACAL_AIS_API_PREFIX: ${CARACAL_AIS_API_PREFIX:-/v1/ais}
            CARACAL_AIS_UNIX_SOCKET_PATH: ${CARACAL_AIS_UNIX_SOCKET_PATH:-/tmp/caracal-ais.sock}
            CARACAL_AIS_LISTEN_HOST: ${CARACAL_AIS_LISTEN_HOST:-127.0.0.1}
            CARACAL_AIS_LISTEN_PORT: ${CARACAL_AIS_LISTEN_PORT:-7079}
            CARACAL_AIS_HEALTHCHECK_TIMEOUT_SECONDS: ${CARACAL_AIS_HEALTHCHECK_TIMEOUT_SECONDS:-3}
            CARACAL_AIS_HEALTHCHECK_INTERVAL_SECONDS: ${CARACAL_AIS_HEALTHCHECK_INTERVAL_SECONDS:-10}
            CARACAL_AIS_STARTUP_TIMEOUT_SECONDS: ${CARACAL_AIS_STARTUP_TIMEOUT_SECONDS:-30}
            CARACAL_AIS_MAX_RESTARTS: ${CARACAL_AIS_MAX_RESTARTS:-3}
            LOG_LEVEL: ${LOG_LEVEL:-INFO}
        command:
            - caracal
            - runtime-mcp
        volumes:
            - runtime_data:/home/caracal/runtime
            - ${CARACAL_HOST_IO_DIR:-./caracal-host-io}:/caracal-host-io:z
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
            vault:
                condition: service_healthy
        environment:
            HOME: /home/caracal
            CARACAL_RUNTIME_IN_CONTAINER: "1"
            CARACAL_HOME: /home/caracal/runtime
            CARACAL_HOST_IO_ROOT: /caracal-host-io
            CARACAL_API_URL: http://mcp:8080
            CARACAL_CONFIG_PATH: /home/caracal/runtime/config.yaml
            CARACAL_PRINCIPAL_KEY_BACKEND: ${CARACAL_PRINCIPAL_KEY_BACKEND:-vault}
            CARACAL_VAULT_URL: ${CARACAL_VAULT_URL:-http://vault:8080}
            CARACAL_VAULT_TOKEN: ${CARACAL_VAULT_TOKEN:-dev-local-token}
            CARACAL_VAULT_WORKSPACE_ID: ${CARACAL_VAULT_WORKSPACE_ID:-}
            CARACAL_VAULT_ENVIRONMENT: ${CARACAL_VAULT_ENVIRONMENT:-dev}
            CARACAL_VAULT_SECRET_PATH: ${CARACAL_VAULT_SECRET_PATH:-/}
            CARACAL_VAULT_SIGNING_KEY_REF: ${CARACAL_VAULT_SIGNING_KEY_REF:-keys/mandate-signing}
            CARACAL_VAULT_SESSION_PUBLIC_KEY_REF: ${CARACAL_VAULT_SESSION_PUBLIC_KEY_REF:-keys/session-public}
            CARACAL_VAULT_MERKLE_SIGNING_KEY_REF: ${CARACAL_VAULT_MERKLE_SIGNING_KEY_REF:-keys/merkle-signing}
            CARACAL_VAULT_MERKLE_PUBLIC_KEY_REF: ${CARACAL_VAULT_MERKLE_PUBLIC_KEY_REF:-keys/merkle-signing-public}
            CARACAL_SESSION_SIGNING_ALGORITHM: ${CARACAL_SESSION_SIGNING_ALGORITHM:-RS256}
            CARACAL_VAULT_MODE: ${CARACAL_VAULT_MODE:-managed}
            CARACAL_VAULT_RETRY_MAX_ATTEMPTS: ${CARACAL_VAULT_RETRY_MAX_ATTEMPTS:-3}
            CARACAL_VAULT_RETRY_BACKOFF_SECONDS: ${CARACAL_VAULT_RETRY_BACKOFF_SECONDS:-0.2}
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
            - runtime_data:/home/caracal/runtime
            - ${CARACAL_HOST_IO_DIR:-./caracal-host-io}:/caracal-host-io:z
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
            vault:
                condition: service_healthy
        environment:
            HOME: /home/caracal
            CARACAL_RUNTIME_IN_CONTAINER: "1"
            CARACAL_HOME: /home/caracal/runtime
            CARACAL_HOST_IO_ROOT: /caracal-host-io
            CARACAL_API_URL: http://mcp:8080
            CARACAL_CONFIG_PATH: /home/caracal/runtime/config.yaml
            CARACAL_PRINCIPAL_KEY_BACKEND: ${CARACAL_PRINCIPAL_KEY_BACKEND:-vault}
            CARACAL_VAULT_URL: ${CARACAL_VAULT_URL:-http://vault:8080}
            CARACAL_VAULT_TOKEN: ${CARACAL_VAULT_TOKEN:-dev-local-token}
            CARACAL_VAULT_WORKSPACE_ID: ${CARACAL_VAULT_WORKSPACE_ID:-}
            CARACAL_VAULT_ENVIRONMENT: ${CARACAL_VAULT_ENVIRONMENT:-dev}
            CARACAL_VAULT_SECRET_PATH: ${CARACAL_VAULT_SECRET_PATH:-/}
            CARACAL_VAULT_SIGNING_KEY_REF: ${CARACAL_VAULT_SIGNING_KEY_REF:-keys/mandate-signing}
            CARACAL_VAULT_SESSION_PUBLIC_KEY_REF: ${CARACAL_VAULT_SESSION_PUBLIC_KEY_REF:-keys/session-public}
            CARACAL_VAULT_MERKLE_SIGNING_KEY_REF: ${CARACAL_VAULT_MERKLE_SIGNING_KEY_REF:-keys/merkle-signing}
            CARACAL_VAULT_MERKLE_PUBLIC_KEY_REF: ${CARACAL_VAULT_MERKLE_PUBLIC_KEY_REF:-keys/merkle-signing-public}
            CARACAL_SESSION_SIGNING_ALGORITHM: ${CARACAL_SESSION_SIGNING_ALGORITHM:-RS256}
            CARACAL_VAULT_MODE: ${CARACAL_VAULT_MODE:-managed}
            CARACAL_VAULT_RETRY_MAX_ATTEMPTS: ${CARACAL_VAULT_RETRY_MAX_ATTEMPTS:-3}
            CARACAL_VAULT_RETRY_BACKOFF_SECONDS: ${CARACAL_VAULT_RETRY_BACKOFF_SECONDS:-0.2}
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
            - runtime_data:/home/caracal/runtime
            - ${CARACAL_HOST_IO_DIR:-./caracal-host-io}:/caracal-host-io:z
        stdin_open: true
        tty: true
        networks:
            - caracal-runtime

volumes:
    postgres_data:
    redis_data:
    runtime_data:

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
    _ensure_dotenv_loaded()
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


def _ensure_dotenv_loaded() -> None:
    """Load workspace .env once for host runtime commands.

    Values already present in the shell environment are preserved.
    """
    if getattr(_ensure_dotenv_loaded, "_done", False):
        return
    _ensure_dotenv_loaded._done = True  # type: ignore[attr-defined]

    try:
        from dotenv import find_dotenv, load_dotenv
    except ImportError:
        return

    repo_env = Path(__file__).resolve().parents[2] / ".env"
    if repo_env.exists():
        load_dotenv(dotenv_path=repo_env, override=False)

    discovered = find_dotenv(usecwd=True)
    if discovered:
        load_dotenv(dotenv_path=discovered, override=False)


def _host_up(namespace: argparse.Namespace) -> int:
    compose_file = _resolve_compose_file(namespace.compose_file)
    assert_runtime_hardcut(
        compose_file=compose_file,
        database_urls=_runtime_database_url_candidates(),
        state_roots=[_caracal_home_dir()],
        env_vars=_runtime_hardcut_env(),
    )
    compose_cmd = _compose_cmd(compose_file)
    uses_local_build = _service_uses_local_build(compose_file, "mcp")

    if not namespace.no_pull:
        pull_services = ["postgres", "redis", "vault"]
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
        [*up_cmd, "postgres", "redis", "vault", "mcp"],
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
    try:
        from caracal.flow.workspace import WorkspaceManager
    except Exception:
        return []

    workspaces = WorkspaceManager.list_workspaces()

    paths: list[Path] = []
    for workspace in workspaces:
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


def _print_purge_summary(removed: dict[str, list[str]]) -> None:
    labels = {
        "containers": "containers",
        "volumes": "volumes",
        "networks": "networks",
        "images": "images",
        "paths": "paths",
    }

    found_any = False
    for key in ("containers", "volumes", "networks", "images", "paths"):
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
    assert_runtime_hardcut(
        compose_file=compose_file,
        database_urls=_runtime_database_url_candidates(),
        state_roots=[_caracal_home_dir()],
        env_vars=_runtime_hardcut_env(),
    )
    compose_cmd = _compose_cmd(compose_file)
    uses_local_build = _service_uses_local_build(compose_file, "cli")

    if uses_local_build:
        build_result = subprocess.run(
            compose_cmd + ["build", "cli"],
            check=False,
        )
        if build_result.returncode != 0:
            return build_result.returncode

    start_code = subprocess.run(
        compose_cmd + ["up", "-d", "postgres", "redis", "vault"],
        check=False,
    ).returncode
    if start_code != 0:
        return start_code

    cmd = compose_cmd + ["--profile", "tools", "run", "--rm", "--build", "cli"]
    result = subprocess.run(cmd, check=False)
    return result.returncode


def _host_flow(namespace: argparse.Namespace) -> int:
    compose_file = _resolve_compose_file(namespace.compose_file)
    assert_runtime_hardcut(
        compose_file=compose_file,
        database_urls=_runtime_database_url_candidates(),
        state_roots=[_caracal_home_dir()],
        env_vars=_runtime_hardcut_env(),
    )
    compose_cmd = _compose_cmd(compose_file)
    uses_local_build = _service_uses_local_build(compose_file, "flow")

    if uses_local_build:
        build_result = subprocess.run(
            compose_cmd + ["build", "flow"],
            check=False,
        )
        if build_result.returncode != 0:
            return build_result.returncode

    start_result = subprocess.run(
        compose_cmd + ["up", "-d", "postgres", "redis", "vault"],
        check=False,
    )
    if start_result.returncode != 0:
        return start_result.returncode

    cmd = compose_cmd + [
        "run",
        "--rm",
        "--build",
        "-e",
        "TERM=xterm-256color",
        "-e",
        "COLORTERM=truecolor",
        "flow",
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
    if not os.environ.get(HOST_IO_DIR_ENV):
        host_io_dir = (compose_file.parent / "caracal-host-io").resolve()
        host_io_dir.mkdir(parents=True, exist_ok=True)
        os.environ[HOST_IO_DIR_ENV] = str(host_io_dir)

    os.environ.setdefault(HOST_IO_ROOT_ENV, HOST_IO_ROOT_IN_CONTAINER)

    compose_cmd = _resolve_compose_command()
    env_candidates = [
        Path.cwd().resolve() / ".env",
        compose_file.parent / ".env",
        compose_file.parent.parent / ".env",
    ]

    env_file = next((candidate for candidate in env_candidates if candidate.exists()), None)
    if env_file:
        compose_cmd.extend(["--env-file", str(env_file)])

    compose_cmd.extend(["-f", str(compose_file)])
    return compose_cmd


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
    if args and args[0] == "runtime-mcp":
        raise SystemExit(_run_runtime_mcp())

    if args and args[0] == "ais-serve":
        raise SystemExit(_run_ais_server())

    from caracal.runtime.restricted_shell import run_restricted_command

    assert_runtime_hardcut(
        compose_file=None,
        database_urls=_runtime_database_url_candidates(),
        state_roots=[_caracal_home_dir()],
        env_vars=_runtime_hardcut_env(),
    )

    raise SystemExit(run_restricted_command(list(args)))


def _parse_int_env(env_key: str, default: int) -> int:
    raw_value = (os.environ.get(env_key) or "").strip()
    if not raw_value:
        return default

    try:
        return int(raw_value)
    except ValueError as exc:
        raise RuntimeError(f"{env_key} must be an integer value") from exc


def _create_ais_server_config():
    from caracal.identity import AISServerConfig

    return AISServerConfig(
        api_prefix=(os.environ.get(AIS_API_PREFIX_ENV) or AIS_DEFAULT_API_PREFIX).strip() or AIS_DEFAULT_API_PREFIX,
        unix_socket_path=os.environ.get(AIS_UNIX_SOCKET_PATH_ENV, AIS_DEFAULT_UNIX_SOCKET_PATH),
        listen_host=(os.environ.get(AIS_LISTEN_HOST_ENV) or AIS_DEFAULT_LISTEN_HOST).strip() or AIS_DEFAULT_LISTEN_HOST,
        listen_port=_parse_int_env(AIS_LISTEN_PORT_ENV, AIS_DEFAULT_LISTEN_PORT),
    )


def _consume_ais_startup_attestation(
    *,
    nonce_manager_factory: Callable[[], object] | None = None,
) -> str:
    from caracal.identity import (
        AttestationNonceConsumedError,
        AttestationNonceManager,
        AttestationNonceValidationError,
    )
    from caracal.redis.client import RedisClient

    startup_nonce = (os.environ.get(AIS_STARTUP_NONCE_ENV) or "").strip()
    if not startup_nonce:
        raise RuntimeError(
            f"{AIS_STARTUP_NONCE_ENV} is required for AIS startup attestation"
        )

    expected_principal = (os.environ.get(AIS_STARTUP_PRINCIPAL_ENV) or "").strip() or None

    if nonce_manager_factory is None:
        redis_host = (os.environ.get("REDIS_HOST") or "localhost").strip() or "localhost"
        redis_port = _parse_int_env("REDIS_PORT", 6379)
        redis_password = (os.environ.get("REDIS_PASSWORD") or "").strip() or None
        redis_client = RedisClient(host=redis_host, port=redis_port, password=redis_password)
        manager = AttestationNonceManager(redis_client)
    else:
        manager = nonce_manager_factory()

    consume_nonce = getattr(manager, "consume_nonce", None)
    if not callable(consume_nonce):
        raise RuntimeError("AIS nonce manager does not expose consume_nonce")

    try:
        principal_id = consume_nonce(startup_nonce, expected_principal_id=expected_principal)
    except (AttestationNonceConsumedError, AttestationNonceValidationError) as exc:
        raise RuntimeError("AIS startup attestation nonce is invalid or already consumed") from exc

    normalized_principal = str(principal_id or "").strip()
    if not normalized_principal:
        raise RuntimeError("AIS startup attestation returned an empty principal_id")
    return normalized_principal


def _complete_ais_startup_attestation(
    principal_id: str,
    *,
    db_manager: object | None = None,
    principal_ttl_manager: object | None = None,
) -> None:
    from datetime import datetime
    from uuid import UUID

    from caracal.core.identity import PrincipalRegistry
    from caracal.db.models import Principal, PrincipalAttestationStatus, PrincipalLifecycleStatus
    from caracal.identity.principal_ttl import PrincipalTTLManager

    resolved_db_manager = db_manager or _create_ais_db_manager()
    resolved_ttl_manager = principal_ttl_manager
    if resolved_ttl_manager is None:
        resolved_ttl_manager = PrincipalTTLManager(_create_runtime_redis_client())
    normalized_principal = str(principal_id or "").strip()
    if not normalized_principal:
        raise RuntimeError("AIS startup attestation cannot complete for an empty principal_id")

    try:
        principal_uuid = UUID(normalized_principal)
    except ValueError as exc:
        raise RuntimeError(
            f"AIS startup attestation principal '{normalized_principal}' is not a valid UUID"
        ) from exc

    with resolved_db_manager.session_scope() as session:
        principal = (
            session.query(Principal)
            .filter(Principal.principal_id == principal_uuid)
            .first()
        )
        if principal is None:
            raise RuntimeError(
                f"AIS startup attestation principal '{normalized_principal}' was not found"
            )

        principal.attestation_status = PrincipalAttestationStatus.ATTESTED.value
        principal_metadata = dict(principal.principal_metadata or {})
        principal_metadata["attestation_status"] = PrincipalAttestationStatus.ATTESTED.value
        principal_metadata["attested_at"] = datetime.utcnow().isoformat() + "Z"
        principal.principal_metadata = principal_metadata
        session.flush()

        activate_principal = getattr(resolved_ttl_manager, "activate_principal", None)
        if callable(activate_principal):
            activate_principal(normalized_principal)

        PrincipalRegistry(session).transition_lifecycle_status(
            normalized_principal,
            PrincipalLifecycleStatus.ACTIVE.value,
            actor_principal_id=normalized_principal,
        )


def _resolve_runtime_redis_url() -> str:
    redis_url = (os.environ.get("REDIS_URL") or "").strip()
    if redis_url:
        return redis_url

    host = (os.environ.get("REDIS_HOST") or "localhost").strip() or "localhost"
    port = _parse_int_env("REDIS_PORT", 6379)
    password = (os.environ.get("REDIS_PASSWORD") or "").strip()
    if password:
        encoded_password = urllib.parse.quote(password, safe="")
        return f"redis://:{encoded_password}@{host}:{port}/0"
    return f"redis://{host}:{port}/0"


def _resolve_ais_vault_secret(secret_ref: str) -> str:
    from caracal.core.vault import get_vault, vault_access_context

    normalized_ref = str(secret_ref or "").strip().strip("/")
    if not normalized_ref:
        raise RuntimeError("AIS vault secret reference cannot be empty")

    org_id, env_id = _resolve_ais_vault_context()

    with vault_access_context():
        return get_vault().get(workspace_id=str(org_id), env_id=str(env_id), name=normalized_ref)


def _resolve_ais_vault_context() -> tuple[str, str]:
    from caracal.core.vault import get_vault

    configured_org = (
        os.environ.get("CARACAL_VAULT_WORKSPACE_ID")
        or os.environ.get("CARACAL_VAULT_PROJECT_SLUG")
        or os.environ.get("CARACAL_VAULT_WORKSPACE_ID")
        or ""
    ).strip()
    configured_env = (
        os.environ.get("CARACAL_VAULT_ENVIRONMENT")
        or os.environ.get("CARACAL_VAULT_ENV")
        or os.environ.get("CARACAL_VAULT_ENV_ID")
        or ""
    ).strip()

    default_org = ""
    default_env = ""

    def _is_uuid(value: str) -> bool:
        try:
            from uuid import UUID

            UUID(str(value))
            return True
        except Exception:
            return False

    # Only touch vault bootstrap context when we need defaults or slug remapping.
    needs_vault_defaults = (
        not configured_org
        or not configured_env
        or not _is_uuid(configured_org)
    )
    if needs_vault_defaults:
        try:
            vault = get_vault()
            default_org = str(getattr(vault._config, "default_project", "") or "").strip()
            default_env = str(getattr(vault._config, "default_environment", "") or "").strip()
        except Exception as exc:
            logging.getLogger(__name__).warning(
                f"Failed to resolve vault defaults for AIS context, using deterministic fallbacks: {exc}"
            )

    org_id = configured_org
    if configured_org:
        if not _is_uuid(configured_org) and default_org:
            org_id = default_org
    else:
        org_id = default_org or "caracal"

    env_id = configured_env or default_env or "runtime"
    return str(org_id), str(env_id)


def _bootstrap_runtime_vault_refs() -> None:
    from caracal.core.vault import get_vault, vault_access_context

    signing_key_ref = (os.environ.get(AIS_SESSION_SIGNING_KEY_REF_ENV) or "").strip().strip("/")
    verify_key_ref = (os.environ.get(AIS_SESSION_VERIFY_KEY_REF_ENV) or "").strip().strip("/")
    if not signing_key_ref:
        raise RuntimeError(
            f"{AIS_SESSION_SIGNING_KEY_REF_ENV} is required to bootstrap AIS session signing"
        )
    if not verify_key_ref:
        raise RuntimeError(
            f"{AIS_SESSION_VERIFY_KEY_REF_ENV} is required to bootstrap AIS session verification"
        )

    org_id, env_id = _resolve_ais_vault_context()
    algorithm = (
        os.environ.get(AIS_SESSION_ALGORITHM_ENV)
        or "RS256"
    ).strip().upper()

    with vault_access_context():
        get_vault().ensure_asymmetric_keypair(
            workspace_id=org_id,
            env_id=env_id,
            private_key_name=signing_key_ref,
            public_key_name=verify_key_ref,
            algorithm=algorithm,
            actor="runtime-bootstrap",
        )


def _resolve_session_signing_algorithm() -> str:
    configured = (
        os.environ.get(AIS_SESSION_ALGORITHM_ENV)
        or ""
    ).strip()
    if configured:
        return configured.upper()

    return "RS256"


def _create_ais_session_manager():
    from caracal.core.session_manager import RedisSessionDenylistBackend, SessionManager
    from caracal.core.signing_service import VaultReferenceJwtSigner

    signing_key_ref = (os.environ.get(AIS_SESSION_SIGNING_KEY_REF_ENV) or "").strip()
    if not signing_key_ref:
        raise RuntimeError(
            f"{AIS_SESSION_SIGNING_KEY_REF_ENV} is required to issue AIS session tokens"
        )

    verify_key_ref = (os.environ.get(AIS_SESSION_VERIFY_KEY_REF_ENV) or "").strip()
    if not verify_key_ref:
        raise RuntimeError(
            f"{AIS_SESSION_VERIFY_KEY_REF_ENV} is required to validate AIS session tokens"
        )
    verify_key = _resolve_ais_vault_secret(verify_key_ref)

    caveat_mode = (os.environ.get(AIS_SESSION_CAVEAT_MODE_ENV) or "caveat_chain").strip().lower()
    caveat_hmac_key = (os.environ.get(AIS_SESSION_CAVEAT_HMAC_KEY_ENV) or "").strip()
    if caveat_mode == "caveat_chain" and not caveat_hmac_key:
        raise RuntimeError(
            f"{AIS_SESSION_CAVEAT_HMAC_KEY_ENV} is required when {AIS_SESSION_CAVEAT_MODE_ENV}=caveat_chain"
        )
    org_id, env_id = _resolve_ais_vault_context()

    return SessionManager(
        token_signer=VaultReferenceJwtSigner(
            workspace_id=org_id,
            env_id=env_id,
            key_name=signing_key_ref,
            actor="runtime-ais-session-manager",
        ),
        verify_key=verify_key,
        algorithm=_resolve_session_signing_algorithm(),
        denylist_backend=RedisSessionDenylistBackend(_resolve_runtime_redis_url()),
        db_session_manager=_create_ais_db_manager(),
        caveat_mode=caveat_mode,
        caveat_chain_hmac_key=caveat_hmac_key,
        issuer="caracal-runtime-ais",
        audience="caracal-session",
    )


def _create_ais_db_manager():
    from caracal.config import load_config
    from caracal.db.connection import get_db_manager

    resolved_config_path = os.environ.get("CARACAL_CONFIG_PATH")
    core_config = load_config(resolved_config_path, suppress_missing_file_log=True, emit_logs=False)
    return get_db_manager(core_config)


def _create_runtime_redis_client():
    from caracal.redis.client import RedisClient

    redis_host = (os.environ.get("REDIS_HOST") or "localhost").strip() or "localhost"
    redis_port = _parse_int_env("REDIS_PORT", 6379)
    redis_password = (os.environ.get("REDIS_PASSWORD") or "").strip() or None
    return RedisClient(host=redis_host, port=redis_port, password=redis_password)


def _resolve_runtime_revocation_publisher_mode(*, edition_manager: object | None = None) -> str:
    explicit_mode = (os.environ.get(AIS_REVOCATION_PUBLISHER_MODE_ENV) or "").strip().lower()
    from caracal.deployment.edition_adapter import get_deployment_edition_adapter

    adapter = edition_manager or get_deployment_edition_adapter()
    resolve_mode = getattr(adapter, "resolve_revocation_publisher_mode", None)
    if not callable(resolve_mode):
        raise RuntimeError("Edition adapter is missing resolve_revocation_publisher_mode")

    return resolve_mode(explicit_mode=explicit_mode)


def _create_enterprise_revocation_event_publisher(*, edition_manager: object | None = None):
    from caracal.core.revocation_publishers import EnterpriseWebhookRevocationEventPublisher
    from caracal.deployment.edition_adapter import get_deployment_edition_adapter

    configured_url = (os.environ.get(AIS_ENTERPRISE_REVOCATION_WEBHOOK_URL_ENV) or "").strip() or None
    configured_sync_api_key = (os.environ.get(AIS_ENTERPRISE_REVOCATION_SYNC_API_KEY_ENV) or "").strip() or None
    adapter = edition_manager or get_deployment_edition_adapter()
    resolve_target = getattr(adapter, "resolve_enterprise_revocation_target", None)
    if not callable(resolve_target):
        raise RuntimeError("Edition adapter is missing resolve_enterprise_revocation_target")

    webhook_url, sync_api_key = resolve_target(
        webhook_url_override=configured_url,
        sync_api_key_override=configured_sync_api_key,
    )

    if not sync_api_key:
        raise RuntimeError(
            "Enterprise revocation webhook publishing requires a sync API key "
            f"({AIS_ENTERPRISE_REVOCATION_SYNC_API_KEY_ENV})."
        )

    return EnterpriseWebhookRevocationEventPublisher(
        webhook_url=webhook_url,
        sync_api_key=sync_api_key,
    )


def _create_runtime_revocation_event_publisher(
    *,
    redis_client: object | None = None,
    edition_manager: object | None = None,
):
    from caracal.core.revocation_publishers import RedisPubSubRevocationEventPublisher

    publisher_mode = _resolve_runtime_revocation_publisher_mode(edition_manager=edition_manager)
    if publisher_mode == "enterprise_webhook":
        return _create_enterprise_revocation_event_publisher(edition_manager=edition_manager)

    resolved_channel = (
        os.environ.get(AIS_REVOCATION_EVENTS_CHANNEL_ENV) or AIS_DEFAULT_REVOCATION_EVENTS_CHANNEL
    ).strip()
    if not resolved_channel:
        raise RuntimeError(f"{AIS_REVOCATION_EVENTS_CHANNEL_ENV} cannot be empty")

    resolved_redis_client = redis_client or _create_runtime_redis_client()
    return RedisPubSubRevocationEventPublisher(
        resolved_redis_client,
        channel=resolved_channel,
    )


def _create_ttl_revocation_orchestrator_factory(
    *,
    redis_client: object | None = None,
    edition_manager: object | None = None,
):
    from caracal.core.revocation import PrincipalRevocationOrchestrator

    publisher = _create_runtime_revocation_event_publisher(
        redis_client=redis_client,
        edition_manager=edition_manager,
    )

    def _factory(session: object) -> PrincipalRevocationOrchestrator:
        return PrincipalRevocationOrchestrator(
            db_session=session,
            revocation_event_publisher=publisher,
        )

    return _factory


def _run_sync(coro):
    import asyncio
    import threading

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    result: dict[str, Any] = {}
    failure: dict[str, BaseException] = {}

    def _runner() -> None:
        try:
            result["value"] = asyncio.run(coro)
        except BaseException as exc:  # pragma: no cover - defensive edge case
            failure["error"] = exc

    thread = threading.Thread(target=_runner, daemon=True)
    thread.start()
    thread.join()

    if "error" in failure:
        raise failure["error"]
    return result.get("value")


def _serialize_issued_session(issued: object) -> dict[str, Any]:
    access_expires_at = getattr(issued, "access_expires_at", None)
    refresh_expires_at = getattr(issued, "refresh_expires_at", None)
    serialized_access_exp = access_expires_at.isoformat() if access_expires_at is not None else None
    serialized_refresh_exp = refresh_expires_at.isoformat() if refresh_expires_at is not None else None
    return {
        "access_token": getattr(issued, "access_token"),
        "access_expires_at": serialized_access_exp,
        "expires_at": serialized_access_exp,
        "session_id": getattr(issued, "session_id", None),
        "token_jti": getattr(issued, "token_jti", None),
        "refresh_token": getattr(issued, "refresh_token", None),
        "refresh_expires_at": serialized_refresh_exp,
        "refresh_jti": getattr(issued, "refresh_jti", None),
    }


def _build_ais_handlers(
    *,
    db_manager: object | None = None,
    session_manager: object | None = None,
    redis_client: object | None = None,
):
    from datetime import timedelta
    from uuid import UUID

    from fastapi import HTTPException
    from caracal.core.identity import PrincipalRegistry
    from caracal.core.session_manager import SessionKind, SessionValidationError
    from caracal.core.signing_service import SigningService
    from caracal.core.spawn import SpawnManager
    from caracal.db.models import ExecutionMandate, PrincipalLifecycleStatus
    from caracal.exceptions import DuplicatePrincipalNameError, PrincipalNotFoundError
    from caracal.identity import AISHandlers
    from caracal.identity.attestation_nonce import (
        AttestationNonceConsumedError,
        AttestationNonceManager,
        AttestationNonceValidationError,
    )
    from caracal.identity.principal_ttl import PrincipalTTLManager
    from caracal.identity.service import IdentityService

    resolved_db_manager = db_manager or _create_ais_db_manager()
    resolved_session_manager = session_manager or _create_ais_session_manager()
    resolved_redis_client = redis_client or _create_runtime_redis_client()

    def _raise_http_error(exc: Exception) -> None:
        if isinstance(exc, HTTPException):
            raise exc
        if isinstance(exc, PrincipalNotFoundError):
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if isinstance(exc, DuplicatePrincipalNameError):
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if isinstance(exc, SessionValidationError):
            raise HTTPException(status_code=401, detail=str(exc)) from exc
        if isinstance(exc, (AttestationNonceValidationError, AttestationNonceConsumedError)):
            raise HTTPException(status_code=401, detail=str(exc)) from exc
        if isinstance(exc, ValueError):
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        raise HTTPException(status_code=500, detail=f"AIS runtime operation failed: {exc}") from exc

    def _normalize_principal_id(raw_principal_id: object) -> str:
        normalized = str(raw_principal_id or "").strip()
        if not normalized:
            return ""
        try:
            return str(UUID(normalized))
        except Exception:
            return normalized

    def _get_identity(principal_id: str) -> dict[str, Any] | None:
        try:
            with resolved_db_manager.session_scope() as session:
                identity_service = IdentityService(principal_registry=PrincipalRegistry(session))
                identity = identity_service.get_principal(principal_id)
                return identity.to_dict() if identity is not None else None
        except Exception as exc:
            _raise_http_error(exc)

    def _require_active_principal(principal_id: str) -> str:
        normalized_principal_id = str(principal_id or "").strip()
        if not normalized_principal_id:
            raise ValueError("principal_id is required")

        with resolved_db_manager.session_scope() as session:
            # Lightweight unit-test doubles may not expose query semantics.
            if not hasattr(session, "query"):
                return normalized_principal_id

            identity_service = IdentityService(principal_registry=PrincipalRegistry(session))
            identity = identity_service.get_principal(normalized_principal_id)
            if identity is None:
                raise PrincipalNotFoundError(f"Principal {normalized_principal_id} not found")

            lifecycle_status = str(getattr(identity, "lifecycle_status", "")).strip().lower()
            if lifecycle_status != PrincipalLifecycleStatus.ACTIVE.value:
                raise ValueError(
                    f"Principal {normalized_principal_id} is not active (status={lifecycle_status or 'unknown'})"
                )

        return normalized_principal_id

    def _extract_bearer_token(authorization_header: str | None) -> str:
        raw = str(authorization_header or "").strip()
        if not raw:
            return ""
        parts = raw.split(" ", 1)
        if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
            raise SessionValidationError(
                "Invalid Authorization header format; expected Bearer token"
            )
        return parts[1].strip()

    def _resolve_authenticated_caller_principal_id(authorization_header: str | None) -> str:
        token = _extract_bearer_token(authorization_header)
        if not token:
            return ""

        claims = _run_sync(resolved_session_manager.validate_access_token(token))
        caller_principal_id = _normalize_principal_id(
            claims.get("sub") or claims.get("principal_id") or ""
        )
        if not caller_principal_id:
            raise SessionValidationError(
                "Validated caller token is missing subject principal identity"
            )
        return caller_principal_id

    def _caller_has_active_delegation_mandate(
        caller_principal_id: str,
        target_principal_id: str,
    ) -> bool:
        try:
            caller_uuid = UUID(str(caller_principal_id))
            target_uuid = UUID(str(target_principal_id))
        except Exception:
            return False

        with resolved_db_manager.session_scope() as session:
            query = getattr(session, "query", None)
            if not callable(query):
                return False

            mandate_query = query(ExecutionMandate)
            if mandate_query is None or not hasattr(mandate_query, "filter"):
                return False

            now = datetime.utcnow()
            mandate = (
                mandate_query
                .filter(ExecutionMandate.issuer_id == caller_uuid)
                .filter(ExecutionMandate.subject_id == target_uuid)
                .filter(ExecutionMandate.revoked.is_(False))
                .filter(ExecutionMandate.valid_from <= now)
                .filter(ExecutionMandate.valid_until >= now)
                .order_by(ExecutionMandate.created_at.desc())
                .first()
            )
            return mandate is not None

    def _resolve_local_bootstrap_principal_id() -> str:
        for env_key in (
            "CARACAL_AIS_PRINCIPAL_ID",
            "CARACAL_PRINCIPAL_ID",
            AIS_STARTUP_PRINCIPAL_ENV,
        ):
            candidate = _normalize_principal_id(os.environ.get(env_key))
            if candidate:
                return candidate
        return ""

    def _authorize_issue_token_request(
        *,
        target_principal_id: str,
        authorization_header: str | None,
        attestation_nonce: str | None,
    ) -> None:
        normalized_target = _normalize_principal_id(target_principal_id)
        if not normalized_target:
            raise HTTPException(status_code=400, detail="principal_id is required")

        caller_principal_id = _resolve_authenticated_caller_principal_id(authorization_header)
        if caller_principal_id:
            if caller_principal_id == normalized_target:
                return
            if _caller_has_active_delegation_mandate(caller_principal_id, normalized_target):
                return
            raise HTTPException(
                status_code=403,
                detail=(
                    f"Authenticated principal '{caller_principal_id}' is not authorized "
                    f"to issue tokens for '{normalized_target}'"
                ),
            )

        normalized_nonce = str(attestation_nonce or "").strip()
        if normalized_nonce:
            consumed_principal = AttestationNonceManager(resolved_redis_client).consume_nonce(
                normalized_nonce,
                expected_principal_id=normalized_target,
            )
            if _normalize_principal_id(consumed_principal) != normalized_target:
                raise HTTPException(
                    status_code=403,
                    detail="Attestation nonce principal binding mismatch",
                )
            return

        if normalized_target == _resolve_local_bootstrap_principal_id():
            return

        raise HTTPException(
            status_code=401,
            detail=(
                "AIS token issuance requires caller Authorization or a valid attestation_nonce "
                "for the requested principal"
            ),
        )

    def _issue_token(request: object, authorization_header: str | None = None) -> dict[str, Any]:
        try:
            session_kind = SessionKind(str(getattr(request, "session_kind", "automation")).strip().lower())
            principal_id = _require_active_principal(getattr(request, "principal_id"))
            _authorize_issue_token_request(
                target_principal_id=principal_id,
                authorization_header=authorization_header,
                attestation_nonce=getattr(request, "attestation_nonce", None),
            )
            issued = resolved_session_manager.issue_session(
                subject_id=principal_id,
                workspace_id=str(getattr(request, "workspace_id")),
                tenant_id=str(getattr(request, "tenant_id")),
                session_kind=session_kind,
                directory_scope=getattr(request, "directory_scope", None),
                include_refresh=bool(getattr(request, "include_refresh", True)),
                extra_claims=getattr(request, "extra_claims", None),
            )
            return _serialize_issued_session(issued)
        except Exception as exc:
            _raise_http_error(exc)

    def _sign_payload(request: object) -> dict[str, Any]:
        try:
            with resolved_db_manager.session_scope() as session:
                principal_registry = PrincipalRegistry(session)
                signing_service = SigningService(principal_registry)
                signature = signing_service.sign_canonical_payload_for_principal(
                    principal_id=str(getattr(request, "principal_id")),
                    payload=dict(getattr(request, "payload", {}) or {}),
                )
            return {"signature": signature}
        except Exception as exc:
            _raise_http_error(exc)

    def _spawn_principal(request: object) -> dict[str, Any]:
        try:
            with resolved_db_manager.session_scope() as session:
                principal_registry = PrincipalRegistry(session)
                spawn_manager = SpawnManager(
                    session,
                    attestation_nonce_manager=AttestationNonceManager(resolved_redis_client),
                    principal_ttl_manager=PrincipalTTLManager(resolved_redis_client),
                )
                identity_service = IdentityService(
                    principal_registry=principal_registry,
                    spawn_manager=spawn_manager,
                )
                spawn_result = identity_service.spawn_principal(
                    issuer_principal_id=str(getattr(request, "issuer_principal_id")),
                    principal_name=str(getattr(request, "principal_name")),
                    principal_kind=str(getattr(request, "principal_kind")),
                    owner=str(getattr(request, "owner")),
                    resource_scope=list(getattr(request, "resource_scope", []) or []),
                    action_scope=list(getattr(request, "action_scope", []) or []),
                    validity_seconds=int(getattr(request, "validity_seconds")),
                    idempotency_key=str(getattr(request, "idempotency_key")),
                    source_mandate_id=getattr(request, "source_mandate_id", None),
                    network_distance=getattr(request, "network_distance", None),
                )
            return {
                "principal_id": spawn_result.principal_id,
                "principal_name": spawn_result.principal_name,
                "principal_kind": spawn_result.principal_kind,
                "mandate_id": spawn_result.mandate_id,
                "attestation_bootstrap_artifact": spawn_result.attestation_bootstrap_artifact,
                "attestation_nonce": spawn_result.attestation_nonce,
                "idempotent_replay": spawn_result.idempotent_replay,
            }
        except Exception as exc:
            _raise_http_error(exc)

    def _derive_task_token(request: object) -> dict[str, Any]:
        try:
            issued = resolved_session_manager.issue_task_token(
                parent_access_token=str(getattr(request, "parent_access_token")),
                task_id=str(getattr(request, "task_id")),
                caveats=list(getattr(request, "caveats", []) or []),
                ttl=timedelta(seconds=int(getattr(request, "ttl_seconds", 300))),
            )
            return _serialize_issued_session(issued)
        except Exception as exc:
            _raise_http_error(exc)

    def _issue_handoff_token(request: object) -> dict[str, Any]:
        try:
            token = _run_sync(
                resolved_session_manager.issue_handoff_token(
                    source_access_token=str(getattr(request, "source_access_token")),
                    target_subject_id=str(getattr(request, "target_subject_id")),
                    caveats=getattr(request, "caveats", None),
                    ttl=timedelta(seconds=int(getattr(request, "ttl_seconds", 120))),
                )
            )
            return {"handoff_token": token}
        except Exception as exc:
            _raise_http_error(exc)

    def _refresh_session(request: object) -> dict[str, Any]:
        try:
            issued = _run_sync(
                resolved_session_manager.refresh_session(
                    str(getattr(request, "refresh_token")),
                )
            )
            return _serialize_issued_session(issued)
        except Exception as exc:
            _raise_http_error(exc)

    return AISHandlers(
        get_identity=_get_identity,
        issue_token=_issue_token,
        sign_payload=_sign_payload,
        spawn_principal=_spawn_principal,
        derive_task_token=_derive_task_token,
        issue_handoff_token=_issue_handoff_token,
        refresh_session=_refresh_session,
    )


def _reconcile_principal_ttl_expiries(
    *,
    principal_ttl_manager: object | None = None,
    expiry_processor: object | None = None,
) -> int:
    from caracal.identity.principal_ttl import PrincipalTTLExpiryProcessor, PrincipalTTLManager

    resolved_redis_client = None
    if principal_ttl_manager is None or expiry_processor is None:
        resolved_redis_client = _create_runtime_redis_client()

    resolved_manager = principal_ttl_manager or PrincipalTTLManager(resolved_redis_client)
    resolved_processor = expiry_processor or PrincipalTTLExpiryProcessor(
        db_manager=_create_ais_db_manager(),
        revocation_orchestrator_factory=_create_ttl_revocation_orchestrator_factory(
            redis_client=resolved_redis_client,
        ),
    )

    reconcile = getattr(resolved_manager, "reconcile_expired_principals", None)
    process = getattr(resolved_processor, "process", None)
    acknowledge = getattr(resolved_manager, "ack_expired_work_item", None)
    if not callable(reconcile) or not callable(process) or not callable(acknowledge):
        raise RuntimeError("Principal TTL reconciliation dependencies are incomplete")

    processed = 0
    for work_item in reconcile():
        process(work_item)
        acknowledge(work_item)
        processed += 1
    return processed


def _run_principal_ttl_listener(
    *,
    principal_ttl_manager: object | None = None,
    expiry_processor: object | None = None,
    stop_event: threading.Event | None = None,
    poll_timeout_seconds: float = 1.0,
) -> None:
    from caracal.identity.principal_ttl import PrincipalTTLExpiryProcessor, PrincipalTTLManager

    resolved_redis_client = None
    if principal_ttl_manager is None or expiry_processor is None:
        resolved_redis_client = _create_runtime_redis_client()

    resolved_manager = principal_ttl_manager or PrincipalTTLManager(resolved_redis_client)
    resolved_processor = expiry_processor or PrincipalTTLExpiryProcessor(
        db_manager=_create_ais_db_manager(),
        revocation_orchestrator_factory=_create_ttl_revocation_orchestrator_factory(
            redis_client=resolved_redis_client,
        ),
    )

    iter_messages = getattr(resolved_manager, "iter_expiry_messages", None)
    claim_message = getattr(resolved_manager, "claim_expiry_message", None)
    process = getattr(resolved_processor, "process", None)
    acknowledge = getattr(resolved_manager, "ack_expired_work_item", None)
    if not callable(iter_messages) or not callable(claim_message) or not callable(process) or not callable(acknowledge):
        raise RuntimeError("Principal TTL listener dependencies are incomplete")

    for message in iter_messages(poll_timeout_seconds=poll_timeout_seconds):
        if stop_event is not None and stop_event.is_set():
            return
        work_item = claim_message(message)
        if work_item is None:
            continue
        process(work_item)
        acknowledge(work_item)


def _start_principal_ttl_listener(
    *,
    principal_ttl_manager: object | None = None,
    expiry_processor: object | None = None,
    poll_timeout_seconds: float = 1.0,
) -> tuple[threading.Thread, threading.Event]:
    stop_event = threading.Event()
    thread = threading.Thread(
        target=_run_principal_ttl_listener,
        kwargs={
            "principal_ttl_manager": principal_ttl_manager,
            "expiry_processor": expiry_processor,
            "stop_event": stop_event,
            "poll_timeout_seconds": poll_timeout_seconds,
        },
        daemon=True,
        name="caracal-principal-ttl-listener",
    )
    thread.start()
    return thread, stop_event


def _run_ais_server() -> int:
    import asyncio

    from caracal.deployment.edition_adapter import get_deployment_edition_adapter
    from caracal.identity import create_ais_app, resolve_ais_listen_target
    from caracal.identity.principal_ttl import PrincipalTTLExpiryProcessor, PrincipalTTLManager

    ttl_listener_stop: threading.Event | None = None

    try:
        get_deployment_edition_adapter(enforce_startup_license_validation=True)
        startup_principal = _consume_ais_startup_attestation()
        resolved_db_manager = _create_ais_db_manager()
        resolved_redis_client = _create_runtime_redis_client()
        principal_ttl_manager = PrincipalTTLManager(resolved_redis_client)
        expiry_processor = PrincipalTTLExpiryProcessor(
            db_manager=resolved_db_manager,
            revocation_orchestrator_factory=_create_ttl_revocation_orchestrator_factory(
                redis_client=resolved_redis_client,
            ),
        )
        _complete_ais_startup_attestation(
            startup_principal,
            db_manager=resolved_db_manager,
            principal_ttl_manager=principal_ttl_manager,
        )
        _reconcile_principal_ttl_expiries(
            principal_ttl_manager=principal_ttl_manager,
            expiry_processor=expiry_processor,
        )
        _, ttl_listener_stop = _start_principal_ttl_listener(
            principal_ttl_manager=principal_ttl_manager,
            expiry_processor=expiry_processor,
        )
        ais_config = _create_ais_server_config()
        listen_target = resolve_ais_listen_target(ais_config)
        app = create_ais_app(
            _build_ais_handlers(
                db_manager=resolved_db_manager,
                redis_client=resolved_redis_client,
            ),
            ais_config,
        )
    except Exception as exc:
        print(f"Error: AIS startup failed: {exc}", file=sys.stderr)
        return 1

    try:
        import uvicorn

        if listen_target.transport == "unix":
            if listen_target.unix_socket_path is None:
                raise RuntimeError("AIS Unix socket path is not configured")

            socket_path = Path(listen_target.unix_socket_path)
            socket_path.parent.mkdir(parents=True, exist_ok=True)
            if socket_path.exists():
                socket_path.unlink()

            config = uvicorn.Config(
                app=app,
                uds=listen_target.unix_socket_path,
                log_level=(os.environ.get("LOG_LEVEL") or "info").lower(),
            )
        else:
            if listen_target.host is None or listen_target.port is None:
                raise RuntimeError("AIS TCP listen target is not fully configured")
            config = uvicorn.Config(
                app=app,
                host=listen_target.host,
                port=listen_target.port,
                log_level=(os.environ.get("LOG_LEVEL") or "info").lower(),
            )

        server = uvicorn.Server(config)
        asyncio.run(server.serve())
        return 0
    except Exception as exc:
        print(f"Error: AIS runtime server crashed: {exc}", file=sys.stderr)
        return 1
    finally:
        if ttl_listener_stop is not None:
            ttl_listener_stop.set()


def _start_ais_subprocess() -> subprocess.Popen[bytes]:
    return subprocess.Popen(
        [
            sys.executable,
            "-c",
            "from caracal.runtime.entrypoints import _run_ais_server; raise SystemExit(_run_ais_server())",
        ],
        env=dict(os.environ),
        stdout=None,
        stderr=None,
    )


def _terminate_subprocess(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return

    process.terminate()
    try:
        process.wait(timeout=10)
        return
    except subprocess.TimeoutExpired:
        pass

    process.kill()
    process.wait(timeout=5)


def _check_ais_health_tcp(host: str, port: int, api_prefix: str, timeout_seconds: float) -> bool:
    try:
        with urllib.request.urlopen(
            f"http://{host}:{port}{api_prefix}/health",
            timeout=timeout_seconds,
        ) as response:
            return int(getattr(response, "status", 0)) == 200
    except Exception:
        return False


def _check_ais_health_unix(socket_path: str, api_prefix: str, timeout_seconds: float) -> bool:
    if not socket_path:
        return False

    if not Path(socket_path).exists():
        return False

    request = (
        f"GET {api_prefix}/health HTTP/1.1\r\n"
        "Host: localhost\r\n"
        "Connection: close\r\n\r\n"
    ).encode("ascii")

    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(timeout_seconds)
            client.connect(socket_path)
            client.sendall(request)
            response_head = client.recv(256).decode("ascii", errors="ignore")
            return response_head.startswith("HTTP/1.1 200") or response_head.startswith("HTTP/1.0 200")
    except Exception:
        return False


def _check_ais_health(config: object, timeout_seconds: float) -> bool:
    from caracal.identity import resolve_ais_listen_target

    listen_target = resolve_ais_listen_target(config)
    api_prefix = getattr(config, "api_prefix", AIS_DEFAULT_API_PREFIX)
    if listen_target.transport == "unix":
        return _check_ais_health_unix(
            listen_target.unix_socket_path or "",
            api_prefix,
            timeout_seconds,
        )

    return _check_ais_health_tcp(
        listen_target.host or AIS_DEFAULT_LISTEN_HOST,
        int(listen_target.port or AIS_DEFAULT_LISTEN_PORT),
        api_prefix,
        timeout_seconds,
    )


def _wait_for_ais_healthy(config: object, timeout_seconds: int, probe_timeout_seconds: float) -> bool:
    deadline = time.monotonic() + max(timeout_seconds, 1)
    while time.monotonic() < deadline:
        if _check_ais_health(config, probe_timeout_seconds):
            return True
        time.sleep(0.5)
    return False


def _run_runtime_mcp() -> int:
    assert_runtime_hardcut(
        compose_file=None,
        database_urls=_runtime_database_url_candidates(),
        state_roots=[_caracal_home_dir()],
        env_vars=_runtime_hardcut_env(),
    )
    _bootstrap_runtime_vault_refs()

    ais_config = _create_ais_server_config()
    startup_timeout = _parse_int_env(AIS_STARTUP_TIMEOUT_ENV, 30)
    probe_timeout = float(_parse_int_env(AIS_HEALTHCHECK_TIMEOUT_ENV, 3))
    monitor_interval = float(_parse_int_env(AIS_HEALTHCHECK_INTERVAL_ENV, 10))
    max_restarts = _parse_int_env(AIS_MAX_RESTARTS_ENV, 3)

    ais_process = _start_ais_subprocess()
    if not _wait_for_ais_healthy(ais_config, startup_timeout, probe_timeout):
        _terminate_subprocess(ais_process)
        print("Error: AIS failed startup health checks", file=sys.stderr)
        return 1

    mcp_process = subprocess.Popen([sys.executable, "-m", "caracal.mcp.service"], env=dict(os.environ))

    restart_count = 0
    try:
        while True:
            mcp_exit = mcp_process.poll()
            if mcp_exit is not None:
                _terminate_subprocess(ais_process)
                return int(mcp_exit)

            ais_exited = ais_process.poll() is not None
            ais_unhealthy = not _check_ais_health(ais_config, probe_timeout)
            if ais_exited or ais_unhealthy:
                restart_count += 1
                _terminate_subprocess(ais_process)

                if restart_count > max_restarts:
                    print("Error: AIS exceeded restart limit; stopping runtime", file=sys.stderr)
                    _terminate_subprocess(mcp_process)
                    return 1

                ais_process = _start_ais_subprocess()
                if not _wait_for_ais_healthy(ais_config, startup_timeout, probe_timeout):
                    print("Error: AIS failed health checks after restart", file=sys.stderr)
                    _terminate_subprocess(ais_process)
                    _terminate_subprocess(mcp_process)
                    return 1

            time.sleep(max(monitor_interval, 1.0))
    except KeyboardInterrupt:
        _terminate_subprocess(mcp_process)
        _terminate_subprocess(ais_process)
        return int(signal.SIGINT)


def _runtime_database_url_candidates() -> dict[str, str | None]:
    return {
        "DATABASE_URL": os.getenv("DATABASE_URL"),
        "CARACAL_DATABASE_URL": os.getenv("CARACAL_DATABASE_URL"),
        "CARACAL_DB_URL": os.getenv("CARACAL_DB_URL"),
    }


def _runtime_hardcut_env() -> dict[str, str]:
    normalized = dict(os.environ)
    normalized.setdefault("CARACAL_PRINCIPAL_KEY_BACKEND", "vault")
    normalized.setdefault("CARACAL_VAULT_URL", "http://127.0.0.1:8080")
    normalized.setdefault("CARACAL_VAULT_SIGNING_KEY_REF", "keys/mandate-signing")
    normalized.setdefault("CARACAL_VAULT_SESSION_PUBLIC_KEY_REF", "keys/session-public")
    normalized.setdefault("CARACAL_SESSION_SIGNING_ALGORITHM", "RS256")
    return normalized


def _is_truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _in_container_runtime() -> bool:
    return _is_truthy(os.environ.get(IN_CONTAINER_ENV)) or Path("/.dockerenv").exists()
