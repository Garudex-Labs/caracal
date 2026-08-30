# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0

# ECS task definitions: api, web, auth, init.
# All run on EC2 capacity provider with awsvpc networking.

# ── Common config injected into every Caracal task ───────────────────────

locals {
  # Non-secret env vars shared by the API server and init.
  server_environment = [
    { name = "CARACAL_JWKS_URL", value = "${local.app_url}/api/auth/jwks" },
    { name = "CARACAL_JWT_ISSUER", value = local.app_url },
    { name = "CARACAL_JWT_AUDIENCE", value = "caracal-api" },
    { name = "CARACAL_AUTH_SERVICE_URL", value = local.app_url },
  ]

  # Secrets injected by ECS at task start via SSM Parameter Store ARNs.
  server_secrets = [
    { name = "CARACAL_POSTGRES_URL", valueFrom = aws_ssm_parameter.urls["DATABASE_URL"].arn },
    { name = "CARACAL_REDIS_URL", valueFrom = aws_ssm_parameter.urls["REDIS_URL"].arn },
    { name = "CARACAL_CLICKHOUSE_URL", valueFrom = aws_ssm_parameter.urls["CLICKHOUSE_URL"].arn },
    { name = "AUTH_INTERNAL_SECRET", valueFrom = aws_ssm_parameter.app["AUTH_INTERNAL_SECRET"].arn },
    { name = "SECRET_KEY", valueFrom = aws_ssm_parameter.app["SECRET_KEY"].arn },
  ]

  auth_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "AUTH_PORT", value = "8001" },
    { name = "BETTER_AUTH_URL", value = local.app_url },
    { name = "AUTH_TRUSTED_ORIGINS", value = local.app_url },
  ]

  auth_secrets = [
    { name = "DATABASE_URL", valueFrom = aws_ssm_parameter.urls["DATABASE_URL"].arn },
    { name = "BETTER_AUTH_SECRET", valueFrom = aws_ssm_parameter.app["BETTER_AUTH_SECRET"].arn },
    { name = "AUTH_INTERNAL_SECRET", valueFrom = aws_ssm_parameter.app["AUTH_INTERNAL_SECRET"].arn },
  ]
}

# ── Task: init (one-shot, applies Postgres + ClickHouse migrations) ──────────

resource "aws_ecs_task_definition" "init" {
  family                   = "${local.name}-init"
  network_mode             = "awsvpc"
  requires_compatibilities = ["EC2"]
  cpu                      = "512"
  memory                   = "1024"

  execution_role_arn = aws_iam_role.ecs_execution.arn
  task_role_arn      = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name        = "init"
    image       = local.server_image
    essential   = true
    command     = ["init"]
    environment = local.server_environment
    secrets     = local.server_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.ecs_init.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "init"
      }
    }
    readonlyRootFilesystem = true
    linuxParameters = {
      initProcessEnabled = true
      tmpfs              = [{ containerPath = "/tmp", size = 128, mountOptions = ["rw"] }]
    }
  }])

  tags = { Name = "${local.name}-init" }
}

# ── Task: api ─────────────────────────────────────────────────────────────

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["EC2"]
  cpu                      = tostring(local.effective_api_cpu)
  memory                   = tostring(local.effective_api_memory)

  execution_role_arn = aws_iam_role.ecs_execution.arn
  task_role_arn      = aws_iam_role.ecs_task.arn

  # No command: the image default runs the API server on port 8080.
  # No container healthCheck: the image is distroless (no shell), so the ALB
  # target group health check on /health is the health authority.
  container_definitions = jsonencode([{
    name         = "api"
    image        = local.server_image
    essential    = true
    portMappings = [{ containerPort = 8080, protocol = "tcp" }]
    environment = concat(local.server_environment, [
      { name = "MIGRATION_ARTIFACT_ROOT", value = "/data/migration_artifacts" },
      { name = "TMPDIR", value = "/data/tmp" },
    ])
    secrets = local.server_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.ecs_api.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "api"
      }
    }
    linuxParameters = {
      initProcessEnabled = true
    }
  }])

  tags = { Name = "${local.name}-api" }
}

# ── Task: auth (identity service) ─────────────────────────────────────────

resource "aws_ecs_task_definition" "auth" {
  family                   = "${local.name}-auth"
  network_mode             = "awsvpc"
  requires_compatibilities = ["EC2"]
  cpu                      = tostring(local.effective_auth_cpu)
  memory                   = tostring(local.effective_auth_memory)

  execution_role_arn = aws_iam_role.ecs_execution.arn
  task_role_arn      = aws_iam_role.ecs_task.arn

  # No container healthCheck: no shell in the image. The ALB target group
  # health check on /healthz (port 8001) is the health authority.
  container_definitions = jsonencode([{
    name         = "auth"
    image        = local.auth_image
    essential    = true
    portMappings = [{ containerPort = 8001, protocol = "tcp" }]
    environment  = local.auth_environment
    secrets      = local.auth_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.ecs_auth.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "auth"
      }
    }
    linuxParameters = {
      initProcessEnabled = true
    }
  }])

  tags = { Name = "${local.name}-auth" }
}

# ── Task: web ─────────────────────────────────────────────────────────────

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name}-web"
  network_mode             = "awsvpc"
  requires_compatibilities = ["EC2"]
  cpu                      = tostring(local.effective_web_cpu)
  memory                   = tostring(local.effective_web_memory)

  execution_role_arn = aws_iam_role.ecs_execution.arn
  task_role_arn      = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name         = "web"
    image        = local.web_image
    essential    = true
    portMappings = [{ containerPort = 8000, protocol = "tcp" }]
    # Override entrypoint to skip nginx's docker-entrypoint.sh which runs
    # envsubst on config files (breaks $uri/$uri/ in nginx directives).
    # Write ECS-safe nginx config (no proxy_pass to Docker Compose hostnames
    # that don't exist in ECS). The ALB routes /api/auth/* to the identity
    # service and /api/* to the API target group before reaching this container.
    entryPoint = ["/bin/sh", "-c"]
    command = [
      "printf 'server {\\n  listen 8000;\\n  root /usr/share/nginx/html;\\n  index index.html;\\n  location /assets/ {\\n    expires 1y;\\n    add_header Cache-Control \"public, immutable\" always;\\n  }\\n  location / {\\n    try_files $uri $uri/ /index.html;\\n  }\\n}\\n' > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"
    ]
    healthCheck = {
      command     = ["CMD-SHELL", "wget -q --spider http://localhost:8000/ || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.ecs_web.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "web"
      }
    }
    linuxParameters = {
      initProcessEnabled = true
    }
  }])

  tags = { Name = "${local.name}-web" }
}
