# Lynx Capital Policy Library

Reusable Caracal authorization policies for the Lynx Capital multi-tenant SaaS deployment.
Every file is a Rego document in the `caracal.authz` package using the
`2026-05-20` policy input contract, so each one imports cleanly into the Caracal Console
or activates through the Control API as part of a policy set.

## Decision model

The library is **default-deny**. `00-base.rego` owns the decision contract and the tenant
isolation rule; every other file is a focused capability that contributes the scopes it
grants into a shared `allowed_scopes` set. The base allows an exchange only when **every**
requested scope is in `allowed_scopes` for that principal, resource, and tenant.

```
result := {
  "decision": "allow" | "deny",
  "evaluation_status": "complete",
  "determining_policies": [{"policy": "<name>"}, ...],
  "diagnostics": [...]   # e.g. [{"step_up_required": "mfa"}]
}
```

### Tenant isolation

A principal carries a `tenant:<id>` label (set at `spawn(labels=[...])`, or minted with the
tenant's DCR application). The base derives the **effective tenant** from the delegated
subject's `tenant_id` claim, falling back to the acting credential's `tenant_id` claim for a
DCR tenant application acting as itself. Authority is granted only when the principal's
`tenant:<id>` label matches the effective tenant. A label minted for one tenant can never
satisfy a request whose subject or credential belongs to another tenant, so cross-tenant
access is structurally impossible regardless of the requested scope.

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
| `portfolio-read` | `portfolio:read` | `resource://portfolio` | Read portfolio data for the principal's own tenant. |
| `portfolio-write` | `portfolio:write` | `resource://portfolio` | Modify portfolio positions for the own tenant. |
| `portfolio-admin` | `portfolio:admin` | `resource://portfolio` | Administer portfolio configuration for the own tenant. |
| `research-read` | `research:read` | `resource://research` | Read research outputs for the own tenant. |
| `research-write` | `research:write` | `resource://research` | Publish research for the own tenant. |
| `compliance-review` | `compliance:review` | `resource://compliance` | Review compliance findings for the own tenant. |
| `compliance-admin` | `compliance:admin` | `resource://compliance` | Administer compliance rules for the own tenant. |
| `customer-admin` | all domain scopes | any Lynx resource | Full authority across the admin's own tenant, never another. |
| `auditor` | `*:read`, `compliance:review` | any Lynx resource | Read-only across the own tenant; never write or admin. |
| `delegated-advisor` | subset of `portfolio:read`, `research:read` | any Lynx resource | Only the scopes carried on the request's delegation edge. |
| `emergency-access` | admin scopes | any Lynx resource | Break-glass admin, only after a satisfied step-up challenge. |

## Usage examples

### Import into the Console

Create each policy, bundle the versions into a policy set, then activate the set. The
provisioning script `scripts/provision.py` automates exactly this sequence:

```bash
# Author each policy from this directory.
caracal policy create --name portfolio-read --file policies/portfolio-read.rego --schema-version 2026-05-20
# ... repeat for 00-base.rego and every scenario file ...

# Bundle the resulting policy versions and activate.
caracal policy-set create --name lynx-multitenant --description "Lynx Capital multi-tenant authorization"
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
  "principal": {"id": "app_aurora_portfolio", "registration_method": "managed",
                "labels": ["tenant:aurora", "portfolio-read", "portfolio-write"]},
  "resource": {"identifier": "resource://portfolio"},
  "context": {"requested_scopes": ["portfolio:read", "portfolio:write"],
              "subject_claims": {"tenant_id": "aurora"}}
}
```

## Testing

The library ships with a decision test suite covering every policy and the isolation,
delegation, and step-up boundaries.

```bash
# Validate that every policy compiles against the input contract.
opa check policies/

# Run the decision tests (allow, deny, cross-tenant, delegation, step-up).
opa test policies/ -v
```

The same scenarios are exercised from Python in
`tests/test_policy_library.py`, which shells out to `opa` and skips gracefully when the
`opa` binary is not on `PATH`.

## Expected access behavior summary

- An agent only ever receives the scopes its capability labels grant for its own tenant.
- A request that mixes a granted and an ungranted scope is denied as a whole.
- Cross-tenant requests are denied even when the requested scope exists.
- A delegated advisor can never exceed the scopes on its delegation edge.
- Break-glass access requires a satisfied step-up challenge; otherwise the result is a
  deny carrying `{"step_up_required": "mfa"}`.
