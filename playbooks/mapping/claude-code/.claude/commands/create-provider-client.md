---
description: Guide creation of a provider client, API key, token, or connector for Caracal.
argument-hint: "Provider name and intended Caracal provider type"
---

# Create Provider Client

Guide the user through provider-side setup needed before filling Caracal Console.

Ask what the provider is creating: OAuth client, service app, API key, bearer token, secret, or connector.

Use provider docs and Caracal docs to identify only values that fit current Caracal Console fields:

- callback or redirect URI
- client ID
- client secret or private key
- token endpoint
- authorization endpoint
- scopes
- audience or resource parameter
- API key header or query parameter

Tell the user which Caracal Console field receives each value. Never ask them to paste raw secrets into chat.

If the provider requires an unsupported auth mode or field, do not provide a fake mapping. Say it is not currently supported and link `https://github.com/Garudex-Labs/caracal/issues/new/choose`.
