# Lynx Capital Policy Library

Reusable Caracal authorization policies for the Lynx Capital SaaS deployment. Every file is
a Rego document in the `caracal.authz` package using the `2026-05-20` policy input contract,
so each one imports cleanly into the Caracal Console or activates through the Control API as
part of a policy set.

## Decision model

The library is **default-deny**. `00-base.rego` owns the decision contract and the
per-customer subject scoping rule; every other file is a focused capability that contributes
the scopes it grants into a shared `allowed_scopes` set. The base allows an exchange only
when **every** requested scope is in `allowed_scopes` for that principal, resource, and
customer.

```
result := {
  "decision": "allow" | "deny",
  "evaluation_status": "complete",
  "determining_policies": [{"policy": "<name>"}, ...],
  "diagnostics": [...]   # e.g. [{"step_up_required": "mfa"}]
}
```

### Customer scoping

Lynx Capital runs one zone and one managed application per domain service; **each customer is
a Caracal subject**, not a separate application. Every agent is spawned for an identified
customer under its service application, so its requests carry that customer's `customer_id`
subject claim. The base denies any customer-scoped request that arrives without a customer
subject — a service application's credential alone can never read customer data; it can only
spawn the agents that act for a customer. Because customer identity lives in the subject (and
the upstream serves only that subject's data), isolation between customers is structural rather
than a label that could be forged.

### Plan entitlements

A customer's `plan` subject claim drives **per-customer authority for the same role**.
Administrative and break-glass capabilities (`portfolio-admin`, `customer-admin`,
`emergency-access`) require a premium plan (`scale` or `enterprise`); a growth-plan customer
carrying the identical capability label is denied by the entitlement gate.

### Capabilities and roles

Each scenario policy keys on a **capability label** of the same name. Agents are spawned
with the capability labels their role needs (see `manifest.json` → `roles`):

| Role | Capability labels |
| --- | --- |
| Portfolio agent | `portfolio-read`, `portfolio-write`, `research-read` |
| Research agent | `research-read`, `research-write`, `portfolio-read` |
| Compliance agent | `compliance-review`, `portfolio-read`, `research-read` |
| Customer admin | `customer-admin` |
| Auditor | `auditor` |
| Advisor (delegated) | `delegated-advisor` |
| Emergency responder | `emergency-access` |

## Policies

| Policy | Grants | Resource | Expected behavior |
| --- | --- | --- | --- |
| `portfolio-read` | `portfolio:read` | `resource://portfolio` | Read the customer's portfolio data. |
| `portfolio-write` | `portfolio:write` | `resource://portfolio` | Modify the customer's portfolio positions. |
| `portfolio-admin` | `portfolio:admin` | `resource://portfolio` | Administer portfolio configuration; premium plan only. |
| `research-read` | `research:read` | `resource://research` | Read the customer's research outputs. |
| `research-write` | `research:write` | `resource://research` | Publish research for the customer. |
| `compliance-review` | `compliance:review` | `resource://compliance` | Review the customer's compliance findings. |
| `compliance-admin` | `compliance:admin` | `resource://compliance` | Administer the customer's compliance rules. |
| `customer-admin` | all domain scopes | any Lynx resource | Full authority for the customer; premium plan only. |
| `auditor` | `*:read`, `compliance:review` | any Lynx resource | Read-only for the customer; never write or admin. |
| `delegated-advisor` | subset of `portfolio:read`, `research:read` | any Lynx resource | Only the scopes carried on the request's delegation edge. |
| `emergency-access` | admin scopes | any Lynx resource | Break-glass admin; premium plan and a satisfied step-up. |

## Usage examples

### Import into the Console

Create each policy, bundle the versions into a policy set, then activate the set. The
provisioning script `scripts/provision.py` automates exactly this sequence:

```bash
# Author each policy from this directory.
caracal policy create --name portfolio-read --file policies/portfolio-read.rego --schema-version 2026-05-20
# ... repeat for 00-base.rego and every scenario file ...

# Bundle the resulting policy versions and activate.
caracal policy-set create --name lynx-platform --description "Lynx Capital authorization"
caracal policy-set version --policy-versions <id-base>,<id-portfolio-read>,...
caracal policy-set activate --version <policy-set-version-id>
```

`00-base.rego` must always be included: it is the decision contract every other policy
contributes to.

### Evaluate a single request

```bash
opa eval -d policies/ -i request.json 'data.caracal.authz.result'
```

with `request.json`:

```json
{
  "action": {"id": "TokenExchange"},
  "principal": {"id": "app_lynx_platform", "registration_method": "managed",
                "labels": ["portfolio-read", "portfolio-write"]},
  "resource": {"identifier": "resource://portfolio"},
  "context": {"requested_scopes": ["portfolio:read", "portfolio:write"],
              "subject_claims": {"customer_id": "aurora", "plan": "enterprise"}}
}
```

## Testing

The library ships with a decision test suite covering every policy and the customer-scoping,
plan-entitlement, delegation, and step-up boundaries.

```bash
# Validate that every policy compiles against the input contract.
opa check policies/

# Run the decision tests (allow, deny, customer scoping, plan tiers, delegation, step-up).
opa test policies/ -v
```

The same scenarios are exercised from Python in `tests/test_policy_library.py`, which shells
out to `opa` and skips gracefully when the `opa` binary is not on `PATH`.

## Expected access behavior summary

- An agent only ever receives the scopes its capability labels grant for its own customer.
- A request that mixes a granted and an ungranted scope is denied as a whole.
- A customer-scoped request with no customer subject is denied.
- Administrative and break-glass capabilities require a premium (`scale`/`enterprise`) plan.
- A delegated advisor can never exceed the scopes on its delegation edge.
- Break-glass access requires a satisfied step-up challenge; otherwise the result is a deny
  carrying `{"step_up_required": "mfa"}`.
