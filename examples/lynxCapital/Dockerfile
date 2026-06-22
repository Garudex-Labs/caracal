# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Lynx Capital application container.

FROM python:3.14-slim@sha256:7a500125bc50693f2214e842a621440a1b1b9cbb2188f74ab045d29ed2ea5856

WORKDIR /app

COPY pyproject.toml ./
COPY requirements.lock ./
COPY .env.example ./
COPY app ./app

RUN python -m pip install --no-cache-dir --require-hashes -r requirements.lock

RUN useradd --create-home --uid 10001 lynx && chown -R lynx:lynx /app
USER lynx

ENV PYTHONUNBUFFERED=1
EXPOSE 8000

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
