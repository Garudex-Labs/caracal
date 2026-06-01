---
description: "Use when writing, editing, or reviewing Console help, info pages, field examples, guided setup copy, or example-facing Console UI text. Enforces the approved Caracal demo naming universe."
applyTo: "{apps/console/**,tests/typescript/unit/console/**}"
---

# Console Example Naming

- Applies to Console-facing help, info pages, tooltips, field examples, guided setup copy, placeholder examples, and tests that assert those strings.
- Use the approved naming universe when example, demo, placeholder, or reference data is needed.
- Keep names contextually appropriate, realistic, operational, and internally consistent.
- Do not introduce random placeholder names such as `payments-api`, `payments-worker`, `alice`, `bob`, `Acme`, generic GitHub examples, or unrelated fake brands.
- Do not modify anything inside the `examples/` directory for this rule.

## Approved Naming Universe

- Person names: Richard Hendricks, Bertram Gilfoyle, Erlich Bachman, Jian Yang, Peter Gregory, Gavin Belson, Monica Hall, Laurie Bream.
- AI names: Son of Anton, Fiona, PiperNet AI.
- Company names: Pied Piper, Hooli, Raviga Capital, Endframe.
- Product names: Nucleus, PiperChat, Not Hotdog, HooliBox, PiperNet.

## Contextual Defaults

- Application or agent names: Son of Anton, Fiona, PiperNet AI.
- Zone names: Pied Piper Production, Hooli Staging, Raviga Capital Sandbox.
- Resource names: PiperNet, Not Hotdog, PiperChat, HooliBox, Nucleus.
- Resource identifiers: `resource://pipernet`, `resource://not-hotdog`, `resource://piperchat`, `resource://hoolibox`, `resource://nucleus`.
- Provider names: Hooli OIDC, Hooli PiperNet OIDC, Raviga Capital OAuth.
- User or subject examples: Richard Hendricks, Monica Hall, `user:richard.hendricks@piedpiper.example`.
- Policy examples: allow PiperNet read for Pied Piper operators; PiperNet baseline v3.
- File/path examples: `/home/richard/pied-piper/policies/pipernet.rego`, `~/.config/caracal/son-of-anton-client-secret`.
- Environment variable examples: `CARACAL_RESOURCE_PIPERNET_TOKEN`.

## Writing Rules

- Prefer human-readable names in explanatory UI copy.
- Use numeric or typed examples for numeric, duration, boolean, URL, identifier, path, JSON, and enum fields; do not substitute names from the approved universe when the field is not a name-like value.
- Prefer slugged identifiers only where the backend/API value is specifically being illustrated.
- Match the entity type: use an AI name for an Application/agent, a product name for a Resource, a company name for a Zone or organization-like boundary, and a person name for a user/session subject.
- Use reserved example domains only when a URL is required, with the approved brand in the host, such as `https://api.pipernet.example` or `https://login.hooli.example/oauth/token`.
- Do not use generic help boilerplate such as "Use this when the form needs a concrete value before it can continue" or "supplies the value used by the current workflow"; explain the field's operational purpose and downstream impact.
