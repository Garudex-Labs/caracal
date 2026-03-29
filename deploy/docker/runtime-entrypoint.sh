#!/bin/sh
set -eu

CARACAL_HOME="${CARACAL_HOME:-${HOME:-/home/caracal}/.caracal}"
STATE_DIR="${CARACAL_HOME}"
CONFIG_PATH="${CARACAL_CONFIG_PATH:-${STATE_DIR}/config.yaml}"
HOST_IO_ROOT="${CARACAL_HOST_IO_ROOT:-/caracal-host}"

mkdir -p "${STATE_DIR}"
mkdir -p "$(dirname "${CONFIG_PATH}")"
mkdir -p "${HOST_IO_ROOT}" || true

if [ ! -f "${CONFIG_PATH}" ] && [ -f /opt/caracal/config/config.example.yaml ]; then
    cp /opt/caracal/config/config.example.yaml "${CONFIG_PATH}"
fi

export CARACAL_CONFIG_PATH="${CONFIG_PATH}"
export CARACAL_HOME="${STATE_DIR}"

if [ "$#" -eq 0 ]; then
    set -- caracal
fi

case "$1" in
    caracal)
        ;;
    python)
        if [ "${2:-}" = "-m" ] && [ "${3:-}" = "caracal.mcp.service" ]; then
            :
        elif [ "${2:-}" = "-m" ] && [ "${3:-}" = "caracal.flow.main" ]; then
            :
        else
            echo "Blocked: only Caracal runtime commands are allowed in this container." >&2
            exit 126
        fi
        ;;
    *)
        echo "Blocked: only Caracal runtime commands are allowed in this container." >&2
        exit 126
        ;;
esac

if [ "$(id -u)" = "0" ]; then
    chown -R caracal:caracal "${STATE_DIR}" || true
    chown -R caracal:caracal "${HOST_IO_ROOT}" || true
    if command -v gosu >/dev/null 2>&1; then
        exec gosu caracal "$@"
    fi
fi

exec "$@"
