// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Policy template catalog: built-in Rego starters for common access patterns.

import type { FastifyPluginAsync } from 'fastify'

const TEMPLATES = [
  {
    id: 'role-based',
    name: 'Role-Based Access Control',
    description: 'Allow access based on principal roles defined in policy data.',
    content: `package caracal.authz

import rego.v1

default allow := false
default result := {"decision": "deny", "evaluation_status": "complete", "determining_policies": [], "diagnostics": []}

result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [{"policy": "role-based"}], "diagnostics": []} if {
  allow
}

allow if {
  role := input.context.actor_claims.roles[_]
  required_role := data.roles[input.resource.identifier]
  role == required_role
}
`,
  },
  {
    id: 'attribute-based',
    name: 'Attribute-Based Access Control',
    description: 'Allow access by matching principal and resource attributes.',
    content: `package caracal.authz

import rego.v1

default allow := false
default result := {"decision": "deny", "evaluation_status": "complete", "determining_policies": [], "diagnostics": []}

result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [{"policy": "attribute-based"}], "diagnostics": []} if {
  allow
}

allow if {
  input.context.actor_claims.department == data.resource_departments[input.resource.identifier]
  input.context.actor_claims.clearance_level >= data.required_clearance[input.resource.identifier]
}
`,
  },
  {
    id: 'delegation',
    name: 'Delegation Chain',
    description: 'Allow direct access and delegated access via subject token claims.',
    content: `package caracal.authz

import rego.v1

default allow := false
default result := {"decision": "deny", "evaluation_status": "complete", "determining_policies": [], "diagnostics": []}

result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [{"policy": "delegation"}], "diagnostics": []} if {
  allow
}

allow if {
  input.principal.id in data.allowed_principals[input.resource.identifier]
}

allow if {
  grant := input.context.subject_claims
  grant.delegator in data.allowed_principals[input.resource.identifier]
  input.action.id in grant.delegated_scopes
}
`,
  },
  {
    id: 'baseline-scopes',
    name: 'Baseline Scopes',
    description: 'Allow only requested scopes explicitly listed for a principal and resource.',
    content: `package caracal.authz

import rego.v1

default allow := false
default result := {"decision": "deny", "evaluation_status": "complete", "determining_policies": [], "diagnostics": []}

result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [{"policy": "baseline-scopes"}], "diagnostics": []} if {
  allow
}

allow if {
  every scope in input.context.requested_scopes {
    scope in data.allowed_scopes[input.principal.id][input.resource.identifier]
  }
}
`,
  },
  {
    id: 'baseline-resource-constraints',
    name: 'Baseline Resource Constraints',
    description: 'Allow only resources listed for the principal and matching required resource attributes.',
    content: `package caracal.authz

import rego.v1

default allow := false
default result := {"decision": "deny", "evaluation_status": "complete", "determining_policies": [], "diagnostics": []}

result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [{"policy": "baseline-resource-constraints"}], "diagnostics": []} if {
  allow
}

allow if {
  input.resource.identifier in data.allowed_resources[input.principal.id]
  required := data.resource_constraints[input.resource.identifier]
  input.resource.type == required.type
  input.resource.id == required.id
}
`,
  },
  {
    id: 'baseline-delegation-constraints',
    name: 'Baseline Delegation Constraints',
    description: 'Allow delegated exchange only when source-target graph proof, hop count, and budget constraints are present.',
    content: `package caracal.authz

import rego.v1

default allow := false
default result := {"decision": "deny", "evaluation_status": "complete", "determining_policies": [], "diagnostics": []}

result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [{"policy": "baseline-delegation-constraints"}], "diagnostics": []} if {
  allow
}

allow if {
  edge := input.delegation_edge
  count(edge.path) > 0
  count(edge.path) <= edge.constraints_json.max_hops
  count(input.context.requested_scopes) <= edge.constraints_json.budget
  edge.constraints_json.policy_approved == true
  input.context.agent_session_id == edge.source_session_id
}
`,
  },
  {
    id: 'baseline-session-state',
    name: 'Baseline Session State',
    description: 'Allow session-bound requests only when session state is active and bound to the principal.',
    content: `package caracal.authz

import rego.v1

default allow := false
default result := {"decision": "deny", "evaluation_status": "complete", "determining_policies": [], "diagnostics": []}

result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [{"policy": "baseline-session-state"}], "diagnostics": []} if {
  allow
}

allow if {
  input.session.id
  input.session.id in data.active_sessions[input.principal.id]
}
`,
  },
  {
    id: 'baseline-step-up-triggers',
    name: 'Baseline Step-Up Triggers',
    description: 'Return a step-up diagnostic for configured sensitive resources without an approved challenge.',
    content: `package caracal.authz

import rego.v1

default result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [{"policy": "baseline-step-up-triggers"}], "diagnostics": []}

result := {"decision": "deny", "evaluation_status": "complete", "determining_policies": [{"policy": "baseline-step-up-triggers"}], "diagnostics": [{"step_up_required": data.step_up_type[input.resource.identifier]}]} if {
  input.resource.identifier in data.sensitive_resources
  input.context.challenge_resolved != true
}
`,
  },
  {
    id: 'baseline-rate-limits',
    name: 'Baseline Rate Limits',
    description: 'Emit a rate-limit diagnostic for resources with externally enforced provider limits.',
    content: `package caracal.authz

import rego.v1

default result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [{"policy": "baseline-rate-limits"}], "diagnostics": []}

result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [{"policy": "baseline-rate-limits"}], "diagnostics": [{"rate_limit_policy": data.rate_limits[input.resource.identifier]}]} if {
  data.rate_limits[input.resource.identifier]
}
`,
  },
]

export const policyTemplatesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/policy-templates', async () => TEMPLATES)
}
