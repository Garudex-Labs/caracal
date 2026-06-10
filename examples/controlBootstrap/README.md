# Control API automation example

Set up a Caracal zone from a script instead of clicking through Console.

This pipeline uses the **Control API** to create and maintain everything one
agent needs — its application, provider, resource, and policy — from a plan
declared in code. Run it from CI, a provisioning script, or an onboarding tool.

## Try it

```bash
# 1. Start the stack, then create a control key in Console (Control menu)
#    with app, identity-provider, resource, and policy scopes.
caracal up
caracal console

# 2. Configure the key and run the pipeline from this directory:
cp env.example .env
$EDITOR .env        # paste CONTROL_CLIENT_ID and CONTROL_CLIENT_SECRET
. .env
npm run apply       # create or fix everything in the plan
npm run verify      # exits 1 if the zone has drifted (CI gate)
npm run teardown    # remove everything again
```

No stack handy? `npm test` runs the whole pipeline offline against a fake zone.

## How it works

`plan.mjs` declares the desired state. `apply` compares it with the live zone
and only changes what differs — it creates missing objects, patches drifted
ones, and publishes a new policy version when the policy content changed.
Re-running it on an in-sync zone changes nothing:

```text
= app PiperNet Reporter unchanged
= identity-provider provider://pipernet-mandate unchanged
~ resource resource://pipernet updated (scopes, upstream_url)
~ policy PiperNet reporter baseline updated (content)
apply complete: 0 created, 2 updated, 2 unchanged
```

`verify` does the same comparison read-only and fails when anything is missing
or drifted, so CI can catch hand-edited environments.

## Security model

The pipeline never uses the root admin token. It authenticates with a
**control key** created in Console: zone-bound, limited to the
`control:<command>:<verb>` scopes you grant, and exchanged for short-lived STS
tokens that are replay-protected, rate-limited, and audited. Each stage
requests only what it needs — `verify` runs with read-only scopes.

## Files

| File | Purpose |
| --- | --- |
| `plan.mjs` | Desired state, drift checks, and scopes. Edit this for your own agent. |
| `apply.mjs` / `verify.mjs` / `teardown.mjs` | The pipeline stages. |
| `controlClient.mjs` | Reusable STS + Control API client. Copy into your own automation. |
| `tests/` | Offline tests (`npm test`); no live stack needed. |
