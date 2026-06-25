---
name: provider-onboarding
description: Guide provider-side setup before filling Caracal web console Provider fields.
allowed-tools: Read, Grep, WebFetch
---

# Provider Onboarding

## Procedure

1. Ask which provider and authentication flow the user needs.
2. Ask whether they are creating a client, application, API key, token, secret, credential, connector, or integration.
3. Read `.claude/console-fields.ground-truth.json`.
4. Check provider docs and Caracal docs when available.
5. Tell the user which visible Caracal web console field receives each provider value.
6. If the provider requires unsupported fields, link the Caracal issue form.

Never ask for raw secrets in chat.
