// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Policy template catalog: built-in data-document starters for the platform decision contract.

import type { FastifyPluginAsync } from 'fastify'

// Adopters supply data, never decision logic: the signed, versioned platform decision
// contract reads these documents and owns every allow/deny. Each template is a data
// document marked `# caracal:data-document`; it defines only the data the contract
// consumes and can never decide on its own.
const TEMPLATES = [
  {
    id: 'application-bindings',
    name: 'Application Bindings',
    description:
      'Map each application key used in grants to the control-plane application id the STS sees as input.principal.id. Author the real ids when provisioning.',
    content: `# caracal:data-document
package caracal.authz

import rego.v1

app_ids := {
  "payments": "app-payments",
  "ledger": "app-ledger",
}
`,
  },
  {
    id: 'resource-grants',
    name: 'Resource Grants',
    description:
      'For each resource view, declare the owning application and the scope set each role may hold. The platform contract allows a mint only when the acting application owns the view, the Session role grants the scope, and the Delegation narrows to it.',
    content: `# caracal:data-document
package caracal.authz

import rego.v1

grants := {
  "resource://example": {
    "application": "payments",
    "roles": {"payment-execution": ["example:read", "example:write"]},
  },
}
`,
  },
  {
    id: 'label-confinement',
    name: 'Label Confinement',
    description:
      'Cap every Session whose principal carries a label prefix to a fixed scope set. A Session labelled customer:<id> may mint only these scopes, whatever its role would otherwise allow.',
    content: `# caracal:data-document
package caracal.authz

import rego.v1

confinement := [{
  "label_prefix": "customer:",
  "scopes": ["example:read"],
}]
`,
  },
  {
    id: 'zone-restriction',
    name: 'Zone Restriction',
    description:
      'Deny overlay. Any entry present here makes the platform decision contract deny every exchange in the zone, overriding all grants. Add an entry to freeze the zone during a maintenance window; keep it empty to authorize normally.',
    content: `# caracal:data-document
package caracal.authz

import rego.v1

restrict := {}
`,
  },
]

export const policyTemplatesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/policy-templates', async () => TEMPLATES)
}
