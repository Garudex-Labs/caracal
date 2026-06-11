# Policy Iterate

A script that turns a denied request into a tested policy fix. It checks that
your new policy version allows the request that was denied — and breaks nothing
else — before you activate it.

## Try it

No Caracal stack needed — the tests run the whole loop offline:

```bash
cd examples/policyIterate
node --test
```

## How it works

```
denied request → simulate fix → check regressions → safe? → activate
```

1. **Diagnose** — fetch why the request was denied from audit, including the
   exact input that produced the denial.
2. **Simulate** — replay that input against your staged (not yet live) policy
   version. Does it allow now?
3. **Regress** — replay your known-good cases too, so the fix doesn't change
   decisions for anyone else.
4. **Activate** — only if every check passes, and only when you opt in with
   `ACTIVATE=true`. The script waits until the runtime confirms the new
   version is live.

## Run against a live stack

Grab the `request_id` of a denied request from audit, stage a fixed policy-set
version, then:

```bash
CARACAL_API_URL=http://127.0.0.1:3000 \
CARACAL_ADMIN_TOKEN=<admin-token> \
CARACAL_ZONE_ID=<zone-id> \
DENIED_REQUEST_ID=<denied-request-id> \
POLICY_SET_ID=<policy-set-id> \
CANDIDATE_VERSION_ID=<staged-version-id> \
node run.mjs
```

This is a dry run — nothing changes. The output tells you whether the fix
works and what blocks rollout, if anything:

```
[diagnose] denial reproduced — reasons: [no_matching_policy]
[simulate] candidate decision: allow, contract ok: true, warnings: 0
[decide]   all gates passed — candidate is safe to activate
[activate] dry run — re-run with ACTIVATE=true to roll out this version
```

Exit code `0` means safe to activate. Re-run with `ACTIVATE=true` to roll out.

## Options

| Variable | Purpose |
| --- | --- |
| `REGRESSION_FILE` | JSON file of cases that must keep their decision — see `regressions.example.json`. |
| `ACTIVATE=true` | Activate the version after a clean verdict (default: dry run). |

## Good to know

- Actor/subject claims are never stored in audit, so the reconstructed input
  omits them. For a claim-dependent denial, add `context.actor_claims` to a
  regression case and iterate with that.
- Exit codes: `0` safe (and live, with `ACTIVATE=true`), `1` blocked or not
  denied, `2` config or transport error.
