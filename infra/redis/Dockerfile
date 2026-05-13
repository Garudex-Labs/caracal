# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Redis 8 image for the Caracal message bus.

# syntax=docker/dockerfile:1.7
FROM redis:8-alpine@sha256:69f2c586c8a7e9cce4ae1ee9bbaf60bc4bb5f4bb3880e4ed022b1fd758a7cab9

RUN apk add --no-cache tini
COPY redis.conf /etc/caracal/redis.conf
COPY --chmod=0755 entrypoint.sh /usr/local/bin/caracal-redis-entrypoint
RUN chown -R redis:redis /etc/caracal

USER redis
EXPOSE 6379
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/caracal-redis-entrypoint"]
