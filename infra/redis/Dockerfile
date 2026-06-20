# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Redis 8 image for the Caracal message bus.

# syntax=docker/dockerfile:1.7
FROM redis:8-alpine@sha256:09160599abd229764c0fb44cb6be640294e1d360a54b19985ab4843dcf2d90f1

RUN apk add --no-cache tini
COPY redis.conf /etc/caracal/redis.conf
COPY --chmod=0755 entrypoint.sh /usr/local/bin/caracal-redis-entrypoint
COPY --chmod=0755 provision-streams.sh /usr/local/bin/caracal-provision-streams
RUN mkdir -p /run/caracal && chown -R redis:redis /etc/caracal /run/caracal

USER redis
EXPOSE 6379
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/caracal-redis-entrypoint"]
