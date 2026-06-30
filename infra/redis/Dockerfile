# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Redis 8 image for the Caracal message bus.

# syntax=docker/dockerfile:1.7
FROM redis:8-alpine@sha256:9d317178eceac8454a2284a9e6df2466b93c745529947f0cd42a0fa9609d7005

RUN apk add --no-cache tini
COPY redis.conf /etc/caracal/redis.conf
COPY --chmod=0755 entrypoint.sh /usr/local/bin/caracal-redis-entrypoint
COPY --chmod=0755 provision-streams.sh /usr/local/bin/caracal-provision-streams
RUN mkdir -p /run/caracal && chown -R redis:redis /etc/caracal /run/caracal

USER redis
EXPOSE 6379
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/caracal-redis-entrypoint"]
