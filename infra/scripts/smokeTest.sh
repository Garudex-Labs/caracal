#!/bin/sh
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Post-boot smoke test against a running Caracal stack. Exits non-zero on first
# failed probe and prints a one-line summary per service.

set -eu

host="${CARACAL_SMOKE_HOST:-127.0.0.1}"
curl_args="-fsS --max-time 5"

probe() {
    name="$1"
    url="$2"
    if curl ${curl_args} -o /dev/null -w "%{http_code}" "${url}" | grep -qE '^(2|3)[0-9][0-9]$'; then
        echo "ok    ${name} ${url}"
    else
        echo "fail  ${name} ${url}"
        exit 1
    fi
}

probe "api-ready"   "http://${host}:3000/ready"
probe "api-live"    "http://${host}:3000/live"
probe "gateway"     "http://${host}:8081/ready"
probe "sts"         "http://${host}:8080/ready"
probe "audit"       "http://${host}:9090/ready"
probe "coordinator" "http://${host}:4000/ready"

echo "smoke ok"
