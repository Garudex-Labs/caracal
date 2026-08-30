#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0
#
# Deploy Caracal onto the EC2 instance provisioned by OpenTofu.
# Uses pre-built images from GHCR (no source builds required).
# Run this AFTER `tofu apply` completes.
#
# Usage: ./deploy.sh

set -euo pipefail

# ── Read OpenTofu outputs ────────────────────────────────────────────────────

if command -v tofu >/dev/null 2>&1; then
  TF="tofu"
elif command -v terraform >/dev/null 2>&1; then
  TF="terraform" # compatibility fallback
else
  echo "ERROR: tofu not found. Install: https://opentofu.org/docs/intro/install/" >&2
  exit 1
fi

INSTANCE_ID=$($TF output -raw instance_id)
PUBLIC_IP=$($TF output -raw public_ip)
REGION=$($TF output -raw region)
DOMAIN=$($TF output -raw domain)
IMAGE_TAG=$($TF output -raw image_tag)
CARACAL_REF=$($TF output -raw caracal_ref)
CARACAL_REPO=$($TF output -raw caracal_repo)
ENV_OVERRIDES=$($TF output -json env_overrides 2>/dev/null || echo "{}")
OBSERVABILITY_STACK=$($TF output -raw observability_stack 2>/dev/null || echo "none")

echo "=== Caracal EC2 Deploy ==="
echo "  Instance:  $INSTANCE_ID"
echo "  IP:        $PUBLIC_IP"
echo "  Region:    $REGION"
echo "  Domain:    ${DOMAIN:-"(none - HTTP only)"}"
echo "  Image:     ghcr.io/garudex-labs/caracal-server:$IMAGE_TAG"
echo "  Observability: $OBSERVABILITY_STACK"
echo ""

# ── Helper: run command on instance via SSM ──────────────────────────────────

run_remote() {
  local cmd="$1"
  local timeout="${2:-600}"

  local cmd_id
  cmd_id=$(aws ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --document-name "AWS-RunShellScript" \
    --parameters "{\"commands\":[\"$cmd\"]}" \
    --timeout-seconds "$timeout" \
    --region "$REGION" \
    --query "Command.CommandId" \
    --output text)

  # Poll for completion
  local status="InProgress"
  while [ "$status" = "InProgress" ] || [ "$status" = "Pending" ]; do
    sleep 5
    status=$(aws ssm get-command-invocation \
      --command-id "$cmd_id" \
      --instance-id "$INSTANCE_ID" \
      --region "$REGION" \
      --query "Status" \
      --output text 2>/dev/null || echo "InProgress")
  done

  if [ "$status" != "Success" ]; then
    echo "ERROR: Command failed with status: $status"
    aws ssm get-command-invocation \
      --command-id "$cmd_id" \
      --instance-id "$INSTANCE_ID" \
      --region "$REGION" \
      --query "StandardErrorContent" \
      --output text 2>/dev/null || true
    return 1
  fi

  # Print output
  aws ssm get-command-invocation \
    --command-id "$cmd_id" \
    --instance-id "$INSTANCE_ID" \
    --region "$REGION" \
    --query "StandardOutputContent" \
    --output text 2>/dev/null || true
}

# ── Wait for SSM agent to come online ────────────────────────────────────────

echo "Waiting for instance to be reachable via SSM..."
for i in $(seq 1 60); do
  online=$(aws ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
    --region "$REGION" \
    --query "InstanceInformationList[0].PingStatus" \
    --output text 2>/dev/null || echo "None")
  if [ "$online" = "Online" ]; then
    echo "  SSM agent online."
    break
  fi
  if [ "$i" = "60" ]; then
    echo "ERROR: Instance not reachable via SSM after 5 minutes."
    exit 1
  fi
  sleep 5
done

# ── Wait for startup script to finish ────────────────────────────────────────

echo "Waiting for instance startup script to complete..."
for i in $(seq 1 60); do
  result=$(run_remote "test -f /var/run/caracal-startup-complete && echo done || echo waiting" 30 2>/dev/null || echo "waiting")
  if echo "$result" | grep -q "done"; then
    echo "  Startup complete."
    break
  fi
  if [ "$i" = "60" ]; then
    echo "ERROR: Startup script did not complete after 5 minutes."
    exit 1
  fi
  sleep 5
done

# ── Deploy server package (pre-built images from GHCR) ───────────────────────

echo "Setting up Caracal server package..."

# Stage the server package the same way the release workflow does: package
# files plus the LB config, ClickHouse config, and Grafana assets that live
# outside the package directory in the repo.
run_remote "rm -rf /opt/caracal && git clone --depth 1 --branch $CARACAL_REF $CARACAL_REPO /opt/caracal-src && mkdir -p /opt/caracal/clickhouse/users.d /opt/caracal/grafana && cp /opt/caracal-src/infra/docker/server-package/* /opt/caracal/ && cp /opt/caracal-src/infra/docker/nginx.conf /opt/caracal/nginx.conf && cp -r /opt/caracal-src/infra/docker/clickhouse/config.d /opt/caracal/clickhouse/config.d && cp /opt/caracal-src/infra/docker/clickhouse/users.d/memory.xml /opt/caracal/clickhouse/users.d/ && cp -r /opt/caracal-src/infra/grafana/provisioning /opt/caracal/grafana/provisioning && cp -r /opt/caracal-src/infra/grafana/dashboards /opt/caracal/grafana/dashboards && rm -rf /opt/caracal-src"

# ── Configure .env ───────────────────────────────────────────────────────────

echo "Configuring environment..."

FRONTEND_URL="${DOMAIN:+https://$DOMAIN}"
FRONTEND_URL="${FRONTEND_URL:-http://$PUBLIC_IP}"

# Pin the released image tag before setup so the first boot pulls it directly.
run_remote "cd /opt/caracal && sed -i 's|^CARACAL_VERSION=.*|CARACAL_VERSION=$IMAGE_TAG|' env.template"

# setup.sh generates ./secrets (postgres, clickhouse, auth, grafana), writes
# .env, and starts the stack. Piped answers: frontend URL, bind address
# (all interfaces; the security group is the network boundary), observability.
# On redeploys it keeps the existing configuration and exits cleanly.
run_remote "cd /opt/caracal && printf '%s\n%s\n%s\n' '$FRONTEND_URL' '0.0.0.0' '$OBSERVABILITY_STACK' | CARACAL_INSTALL_DIR=/opt/caracal bash setup.sh" 900

# Apply env overrides (skip empty values)
while IFS='=' read -r key value; do
  [ -z "$key" ] && continue
  [ -z "$value" ] && continue
  run_remote "cd /opt/caracal && sed -i \"s|${key}=.*|${key}=${value}|\" .env || echo '${key}=${value}' >> .env"
done < <(echo "$ENV_OVERRIDES" | python3 -c "import sys,json; [print(f'{k}={v}') for k,v in json.load(sys.stdin).items()]" 2>/dev/null || true)

# ── Configure TLS (if domain set) ───────────────────────────────────────────

if [ -n "$DOMAIN" ]; then
  echo "Obtaining TLS certificate for $DOMAIN..."
  run_remote "certbot certonly --standalone -d $DOMAIN --non-interactive --agree-tos -m admin@$DOMAIN"
fi

# ── Pull and start (pre-built images - fast) ────────────────────────────────

COMPOSE_FILES="-f docker-compose.yml"
COMPOSE_PROFILE_ARGS=""
if [ "$OBSERVABILITY_STACK" != "none" ]; then
  COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.observability.yml"
fi
if [ "$OBSERVABILITY_STACK" = "grafana" ]; then
  COMPOSE_PROFILE_ARGS="--profile grafana"
fi

echo "Pulling pre-built images from GHCR..."
run_remote "cd /opt/caracal && docker compose $COMPOSE_PROFILE_ARGS $COMPOSE_FILES pull" 300

echo "Starting services..."
run_remote "cd /opt/caracal && docker compose $COMPOSE_PROFILE_ARGS $COMPOSE_FILES --env-file .env up -d"

# ── Health check ─────────────────────────────────────────────────────────────

echo "Waiting for Caracal to become healthy..."
URL="${DOMAIN:+https://$DOMAIN}"
URL="${URL:-http://$PUBLIC_IP}"

for i in $(seq 1 40); do
  status=$(curl -sf -o /dev/null -w "%{http_code}" "$URL/readyz" 2>/dev/null || echo "000")
  if [ "$status" = "200" ]; then
    echo ""
    echo "=== Caracal is live ==="
    echo "  URL: $URL"
    echo "  SSM: aws ssm start-session --target $INSTANCE_ID --region $REGION"
    echo ""
    echo "  First login: caracal auth login  # bootstraps the administrator account"
    echo ""
    exit 0
  fi
  printf "."
  sleep 15
done

echo ""
echo "WARNING: Health check did not pass within 10 minutes."
echo "Services may still be starting. Check with:"
echo "  aws ssm start-session --target $INSTANCE_ID --region $REGION"
echo "  sudo docker compose -f /opt/caracal/docker-compose.yml ps"
echo ""
exit 1
