# Control API bootstrap

Non-interactive zone provisioning through the Caracal **Control API**. This is the
automation answer to "I want a repeatable script that creates a demo
resource/provider/policy on every developer laptop" without adding management
verbs to the runtime CLI.

The runtime CLI stays small on purpose (`up`, `down`, `status`, `purge`, `run`,
`console`). Product management is owned by Console for humans and by the Control
API for automation. Both run the **same engine dispatch**, so a script follows
the exact path a human does in Console — with scopes, replay protection, rate
limiting, and audit on every call.

## Why the Control API instead of a root admin token

Automation does not get the root admin token. It gets a **scoped control key**:

- Zone-bound and application-only (no subject or delegated authority).
- Limited to the exact `control:<command>:<verb>` scopes you allow.
- Short-lived: every call uses a fresh STS token (seconds, not hours).
- Replay-protected, rate-limited, and audited per request.

This keeps least-privilege automation the easy path rather than the exception.

A control key operates **inside its bound zone**. Creating zones stays a Console
operation because a zone is the tenancy boundary the key is scoped to; the script
provisions the resource, provider, and policy within an existing zone.

## One-time setup in Console

1. Start the stack and open Console:
   ```bash
   caracal up
   caracal console
   ```
2. In the Control menu, create a control key. Grant only the scopes this script
   needs (provider, resource, and policy read/write/delete). Console returns a
   one-time `client_id` and `client_secret`.
3. Note the zone id and the control audience the deployment uses.

## Run the bootstrap

```bash
cp env.example .env
$EDITOR .env        # fill in CONTROL_CLIENT_ID, CONTROL_CLIENT_SECRET, zone, URLs
. .env
npm run bootstrap   # creates the PiperNet provider, resource, and policy
npm run teardown    # removes them again
```

`bootstrap` is idempotent: it skips objects that already exist, so it is safe to
re-run. `teardown` removes the policy, then the resource, then the provider.

## What it provisions

| Object | Identifier | Purpose |
| --- | --- | --- |
| Provider | `pipernet-mandate` (`caracal_mandate`) | Upstream authority for the resource, no committed secret. |
| Resource | `resource://pipernet` | Protected API the agent reaches through the Gateway. |
| Policy | `PiperNet baseline` | Allows `read` on the resource. |

To broker a real upstream credential instead, change `PROVIDER` in
`provisionPlan.mjs` to an `api_key` or `oauth2_client_credentials` provider and
supply the secret from the environment. Never commit upstream secrets.

## Files

- `controlClient.mjs` — reusable client: STS client-credentials exchange plus
  `/v1/control/invoke`, with the canonical Control status taxonomy. Copy it into
  your own automation as a starting point.
- `provisionPlan.mjs` — single source of truth for the demo objects, the
  required scopes, and the environment-driven client config.
- `bootstrap.mjs` / `teardown.mjs` — the provisioning and cleanup flows.
- `tests/` — offline tests that pin the request contract against a mock fetch.

## Test

```bash
npm test
```

The tests are fully offline; they never call a live Caracal stack.
