# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Mock provider container: runs any of the mock servers depending on CMD.

FROM python:3.14-slim@sha256:7a500125bc50693f2214e842a621440a1b1b9cbb2188f74ab045d29ed2ea5856

WORKDIR /app

COPY pyproject.toml ./
COPY _mock/requirements.lock ./requirements.lock
COPY app ./app
COPY _mock ./_mock

RUN python -m pip install --no-cache-dir --require-hashes -r requirements.lock

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/_mock/sdk/lynx_sdk_stripe_treasury:/app/_mock/sdk/lynx_sdk_tax
