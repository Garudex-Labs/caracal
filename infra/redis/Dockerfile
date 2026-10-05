# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Redis 8 image for the Caracal message bus.

# syntax=docker/dockerfile:1.7
FROM redis:8-alpine@sha256:3811787313eba226a2ef38658c6ccb91cd5e110edc89c37767de373120a0e5a0

# Apply Alpine security updates even when the published base digest lags.
RUN apk upgrade --no-cache && apk add --no-cache tini
COPY redis.conf /etc/caracal/redis.conf
COPY --chmod=0755 entrypoint.sh /usr/local/bin/caracal-redis-entrypoint
COPY --chmod=0755 provision-streams.sh /usr/local/bin/caracal-provision-streams
RUN mkdir -p /run/caracal && chown -R redis:redis /etc/caracal /run/caracal

USER redis
EXPOSE 6379
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/caracal-redis-entrypoint"]
