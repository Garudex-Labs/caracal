#!/bin/sh
set -eu

CARACAL_HOME="${HOME:-/home/caracal}"
STATE_DIR="${CARACAL_HOME}/.caracal"
CONFIG_PATH="${CARACAL_CONFIG_PATH:-${STATE_DIR}/config.yaml}"

mkdir -p "${STATE_DIR}"
mkdir -p "$(dirname "${CONFIG_PATH}")"

if [ ! -f "${CONFIG_PATH}" ] && [ -f /opt/caracal/config/config.example.yaml ]; then
    cp /opt/caracal/config/config.example.yaml "${CONFIG_PATH}"
fi

export CARACAL_CONFIG_PATH="${CONFIG_PATH}"

if [ "$#" -eq 0 ]; then
    set -- caracal
fi

if [ "$(id -u)" = "0" ]; then
    chown -R caracal:caracal "${STATE_DIR}" || true
    if command -v gosu >/dev/null 2>&1; then
        exec gosu caracal "$@"
    fi
fi

exec "$@"
