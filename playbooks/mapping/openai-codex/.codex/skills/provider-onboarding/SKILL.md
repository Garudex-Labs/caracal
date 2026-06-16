# Provider Onboarding

Use to guide provider-side setup before filling Caracal Console.

## Procedure

1. Ask which provider and authentication flow the user needs.
2. Ask whether they are creating a client, application, API key, token, secret, credential, connector, or integration.
3. Read `.codex/console-fields.ground-truth.json`.
4. Check provider docs and Caracal docs.
5. Tell the user which visible Caracal Console field receives each provider value.
6. If the provider requires unsupported fields, link the Caracal issue form.

Never ask for raw secrets in chat.
Do not invent onboarding steps that are not supported by the provider docs or visible Console fields.
