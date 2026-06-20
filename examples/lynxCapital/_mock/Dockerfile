# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Mock provider container: runs any of the mock servers depending on CMD.
# Build context is the repository root so the mandate-verifying providers run
# the in-repo caracalai kits, matching the platform they verify against.

FROM python:3.14-slim@sha256:7a500125bc50693f2214e842a621440a1b1b9cbb2188f74ab045d29ed2ea5856

WORKDIR /app

COPY examples/lynxCapital/pyproject.toml ./
COPY examples/lynxCapital/_mock/requirements.lock ./requirements.lock
COPY examples/lynxCapital/app ./app
COPY examples/lynxCapital/_mock ./_mock
COPY packages/core/python /tmp/caracalai-core
COPY packages/identity/python /tmp/caracalai-identity

RUN python -m pip install --no-cache-dir --require-hashes -r requirements.lock \
    && python -m pip install --no-cache-dir --no-deps /tmp/caracalai-core /tmp/caracalai-identity \
    && rm -rf /tmp/caracalai-core /tmp/caracalai-identity

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app
