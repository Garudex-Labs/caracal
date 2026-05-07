# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Redis 8 image for the Caracal message bus.

FROM redis:8-alpine@sha256:69f2c586c8a7e9cce4ae1ee9bbaf60bc4bb5f4bb3880e4ed022b1fd758a7cab9

COPY redis.conf /etc/caracal/redis.conf
EXPOSE 6379

ENTRYPOINT ["redis-server", "/etc/caracal/redis.conf"]
