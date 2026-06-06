# Lynx Capital

Autonomous financial execution reference lab. A FastAPI + LangGraph swarm that processes a global SaaS payout cycle (~4,200 invoices, 5 regions) end-to-end with a live agent topology view and SSE log stream.

## Requirements

- Python 3.14+
- Docker
- An OpenAI API key

## Quick start

### 1: Install dependencies

```bash
cd caracal/examples/lynxCapital
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -e ".[dev]"
```

### 2: Configure environment

```bash
cp -n .env.example .env
```

Open `.env` and set `OPENAI_API_KEY=sk-...`.

### 3: Start the local provider network

Each provider runs on its own localhost port (`9400`–`9419`) with a small control UI and behaves like a real third-party vendor.

```bash
docker compose -f _mock/docker-compose.yml up -d --build --wait
```

To re-check status later:

```bash
docker compose -f _mock/docker-compose.yml ps -a
```

### 4: Run Lynx Capital

Pick one path:

```bash
# Local Python (development)
python -m uvicorn app.main:app --reload --port 8000
```

Open **http://localhost:8000**. The landing page leads through `/overview/about`, `/overview/architecture`, and `/overview/notice` before setup is unlocked.

## Tests

```bash
python -m pytest tests/test_caracal_integration.py -q
python -m pytest -q
```

## Tear down

```bash
docker compose -f _mock/docker-compose.yml down
```

## Provider ecosystem

| Provider | Domain | Auth | Protocol | Port |
|---|---|---|---|---|
| Halcyon Bank | Open/business banking | OAuth 2.0 auth code (PKCE) | REST + webhooks | 9400 |
| Meridian Pay | Card/wallet accept + payouts | API key (header) | REST + webhooks | 9401 |
| Cordoba FX | Cross-border FX | OAuth 2.0 client credentials (basic) | REST | 9402 |
| Ironbark ERP | Enterprise ERP | OAuth 2.0 client credentials (post + audience) | REST async-job | 9403 |
| Tallyhall Books | SMB accounting | OAuth 2.0 auth code (offline refresh) | REST | 9404 |
| Slate Ledger | Double-entry GL + close | Bearer token | REST async-job | 9405 |
| Inkwell OCR | Invoice/document extraction | API key (query) | REST async-job + LLM | 9406 |
| Aegis Screening | Sanctions/AML/KYB | Caracal mandate | REST + LLM | 9407 |
| Verafin Monitor | Txn monitoring + filing | Caracal mandate (delegation) | REST async-job | 9408 |
| Lumen Identity | Internal directory & IAM | none (internal) | REST | 9409 |
| Beacon CRM | Vendor/customer CRM | OAuth 2.0 auth code (refresh) | REST + webhooks | 9410 |
| Atlas Vendor Network | Vendor master data | MCP (bearer) | MCP JSON-RPC | 9411 |
| Keystone Treasury | Cash position/forecast/hedge/transfer/exposure | API key (`x-api-key` metadata) | gRPC-style (unary + server streaming) | 9412 |
| Sabre Tax | Tax determination | SDK (api key) | SDK shim over REST | 9413 |
| Quetzal Payouts | Global mass payouts | SDK (bearer token) | SDK shim + webhooks | 9414 |
| Vela Notify | Email/SMS dunning | Bearer (custom header) | REST | 9415 |
| Core Billing | Internal AR/billing | none (internal) | REST | 9416 |
| Relay Automation | Workflow/job automation | MCP (mandate, delegation) | MCP JSON-RPC | 9417 |
| Pulse Market Data | Real-time FX/reference | API key (header) | SSE + REST | 9418 |
| Junction Procurement | Procure-to-pay | OAuth 2.0 client credentials | REST | 9419 |
