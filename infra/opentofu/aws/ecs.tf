# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0

# ECS Fargate stack: api, auth, web, init.
#
# api + init share the caracal-server image (different commands). The identity
# service (auth) and web have their own images. init applies Postgres +
# ClickHouse migrations and is invoked as a one-shot RunTask whenever
# image_tag changes (or on first apply when run_init_on_apply is true).

resource "aws_ecs_cluster" "main" {
  name = "${local.name}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = { Name = "${local.name}-cluster" }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}

# ── Common config injected into every Caracal task ───────────────────────

locals {
  server_image = "${var.image_repo_server}:${var.image_tag}"
  auth_image   = "${var.image_repo_auth}:${var.image_tag}"
  web_image    = "${var.image_repo_web}:${var.image_tag}"

  # Non-secret env vars shared by the API server and init.
  server_environment = [
    { name = "CARACAL_JWKS_URL", value = "${local.app_url}/api/auth/jwks" },
    { name = "CARACAL_JWT_ISSUER", value = local.app_url },
    { name = "CARACAL_JWT_AUDIENCE", value = "caracal-api" },
    { name = "CARACAL_AUTH_SERVICE_URL", value = local.app_url },
  ]

  # Secrets injected by ECS at task start. Reference SSM Parameter Store ARNs.
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
  requires_compatibilities = ["FARGATE"]
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
  requires_compatibilities = ["FARGATE"]
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
    readonlyRootFilesystem = true
    linuxParameters = {
      initProcessEnabled = true
      tmpfs = [
        { containerPath = "/tmp", size = 256, mountOptions = ["rw"] },
        { containerPath = "/data", size = 512, mountOptions = ["rw"] },
      ]
    }
  }])

  tags = { Name = "${local.name}-api" }
}

# ── Task: auth (identity service) ─────────────────────────────────────────

resource "aws_ecs_task_definition" "auth" {
  family                   = "${local.name}-auth"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
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
    readonlyRootFilesystem = true
    linuxParameters = {
      initProcessEnabled = true
      tmpfs              = [{ containerPath = "/tmp", size = 64, mountOptions = ["rw"] }]
    }
  }])

  tags = { Name = "${local.name}-auth" }
}

# ── Task: web ─────────────────────────────────────────────────────────────

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name}-web"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(local.effective_web_cpu)
  memory                   = tostring(local.effective_web_memory)

  execution_role_arn = aws_iam_role.ecs_execution.arn
  task_role_arn      = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name         = "web"
    image        = local.web_image
    essential    = true
    portMappings = [{ containerPort = 8000, protocol = "tcp" }]
    # Override the entrypoint to skip nginx's stock startup script, which runs
    # envsubst on config files (breaks $uri/$uri/ in nginx directives).
    # Write ECS-safe nginx config (no proxy_pass to Docker Compose hostnames
    # that don't exist in Fargate). The ALB routes /api/auth/* to the identity
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
    readonlyRootFilesystem = true
    linuxParameters = {
      initProcessEnabled = true
      tmpfs = [
        { containerPath = "/tmp", size = 64, mountOptions = ["rw"] },
        { containerPath = "/var/cache/nginx", size = 64, mountOptions = ["rw"] },
        { containerPath = "/var/run", size = 8, mountOptions = ["rw"] },
        { containerPath = "/etc/nginx/conf.d", size = 8, mountOptions = ["rw"] },
      ]
    }
  }])

  tags = { Name = "${local.name}-web" }
}

# ── Services ──────────────────────────────────────────────────────────────

resource "aws_ecs_service" "api" {
  name            = "${local.name}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  launch_type     = "FARGATE"
  desired_count   = local.effective_api_desired_count

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 60

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [local.ecs_sg_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8080
  }

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [
    aws_lb_listener.http,
    null_resource.run_init,
  ]

  tags = { Name = "${local.name}-api" }
}

resource "aws_ecs_service" "web" {
  name            = "${local.name}-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  launch_type     = "FARGATE"
  desired_count   = local.effective_web_desired_count

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 30

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [local.ecs_sg_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 8000
  }

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.http]

  tags = { Name = "${local.name}-web" }
}

resource "aws_ecs_service" "auth" {
  name            = "${local.name}-auth"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.auth.arn
  launch_type     = "FARGATE"
  desired_count   = local.effective_auth_desired_count

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 30

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [local.ecs_sg_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.auth.arn
    container_name   = "auth"
    container_port   = 8001
  }

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [
    aws_lb_listener.http,
    null_resource.run_init,
  ]

  tags = { Name = "${local.name}-auth" }
}

# ── One-shot init task (migrations + seeds) ───────────────────────────────
# Triggers on every image_tag change. Uses local-exec so the user must have
# the AWS CLI configured - same prerequisite as `terraform apply` itself.

resource "null_resource" "run_init" {
  count = var.run_init_on_apply ? 1 : 0

  triggers = {
    image_tag      = var.image_tag
    task_def       = aws_ecs_task_definition.init.arn
    cluster        = aws_ecs_cluster.main.name
    db_endpoint    = aws_db_instance.postgres.address
    redis_endpoint = aws_elasticache_replication_group.redis.primary_endpoint_address
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command     = <<-EOT
      set -euo pipefail

      # Give the data-host EC2 instance time to bootstrap ClickHouse.
      # user-data takes 2-4 minutes (package install + docker pull + start).
      # The init task retries its database connections with backoff, so this
      # is a best-effort head start, not a hard gate.
      echo "Waiting 120s for data-tier bootstrap to complete..."
      sleep 120

      task_arn=$(aws ecs run-task \
        --region ${var.region} \
        --cluster ${aws_ecs_cluster.main.name} \
        --launch-type FARGATE \
        --task-definition ${aws_ecs_task_definition.init.arn} \
        --network-configuration "awsvpcConfiguration={subnets=[${join(",", local.private_subnet_ids)}],securityGroups=[${local.ecs_sg_id}],assignPublicIp=DISABLED}" \
        --query 'tasks[0].taskArn' --output text)
      echo "Init task started: $task_arn"
      aws ecs wait tasks-stopped --region ${var.region} --cluster ${aws_ecs_cluster.main.name} --tasks "$task_arn"
      exit_code=$(aws ecs describe-tasks --region ${var.region} --cluster ${aws_ecs_cluster.main.name} --tasks "$task_arn" --query 'tasks[0].containers[0].exitCode' --output text)
      echo "Init task exit code: $exit_code"
      if [ "$exit_code" != "0" ]; then
        echo "Init task failed. See log group ${aws_cloudwatch_log_group.ecs_init.name}." >&2
        exit 1
      fi
    EOT
  }

  depends_on = [
    aws_db_instance.postgres,
    aws_elasticache_replication_group.redis,
    aws_ecs_cluster.main,
    aws_iam_role_policy_attachment.ecs_execution_managed,
    aws_iam_role_policy_attachment.ecs_execution_secrets,
    aws_instance.data_host,
    aws_route53_record.clickhouse_internal,
  ]
}

# ── Service autoscaling ────────────────────────────────────────────────────

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = local.effective_api_autoscale_min
  max_capacity       = local.effective_api_autoscale_max
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.name}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value = var.service_autoscale_cpu_target
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    scale_in_cooldown  = 120
    scale_out_cooldown = 60
  }
}

resource "aws_appautoscaling_target" "web" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.web.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = local.effective_web_autoscale_min
  max_capacity       = local.effective_web_autoscale_max
}

resource "aws_appautoscaling_policy" "web_cpu" {
  name               = "${local.name}-web-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.web.service_namespace
  resource_id        = aws_appautoscaling_target.web.resource_id
  scalable_dimension = aws_appautoscaling_target.web.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value = var.service_autoscale_cpu_target
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    scale_in_cooldown  = 120
    scale_out_cooldown = 60
  }
}

resource "aws_appautoscaling_target" "auth" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.auth.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = local.effective_auth_autoscale_min
  max_capacity       = local.effective_auth_autoscale_max
}

resource "aws_appautoscaling_policy" "auth_cpu" {
  name               = "${local.name}-auth-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.auth.service_namespace
  resource_id        = aws_appautoscaling_target.auth.resource_id
  scalable_dimension = aws_appautoscaling_target.auth.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value = var.service_autoscale_cpu_target
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    scale_in_cooldown  = 120
    scale_out_cooldown = 60
  }
}
