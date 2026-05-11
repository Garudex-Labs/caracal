# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Mock provider container: runs any of the mock servers depending on CMD.

FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml ./
COPY app ./app
COPY _mock ./_mock

RUN pip install --no-cache-dir \
        fastapi "uvicorn[standard]" sse-starlette pydantic pyyaml \
        httpx grpcio python-dotenv \
    && pip install --no-cache-dir -e ./_mock/sdk/lynx_sdk_stripe_treasury \
    && pip install --no-cache-dir -e ./_mock/sdk/lynx_sdk_tax

ENV PYTHONUNBUFFERED=1
