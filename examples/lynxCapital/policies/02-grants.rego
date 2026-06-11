# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Generated grants data: resource views, owning applications, and role scope sets.
# Rendered by app.tenancy.render_grants_rego from config/tenancy.yaml; do not edit.
package caracal.authz

import rego.v1

grants := {
	"resource://audit-atlas": {
		"application": "audit",
		"roles": {"audit": ["atlas:read"]},
	},
	"resource://audit-cordoba": {
		"application": "audit",
		"roles": {
			"audit": ["cordoba:read"],
			"partner-integration": ["cordoba:read"],
		},
	},
	"resource://audit-meridian": {
		"application": "audit",
		"roles": {
			"audit": ["meridian:read"],
			"partner-integration": ["meridian:read"],
		},
	},
	"resource://audit-tallyhall": {
		"application": "audit",
		"roles": {"audit": ["tallyhall:report"]},
	},
	"resource://compliance-aegis": {
		"application": "compliance",
		"roles": {
			"compliance": ["aegis:screen"],
			"exception": ["aegis:screen"],
			"partner-integration": ["aegis:case", "aegis:screen"],
			"policy-check": ["aegis:screen"],
		},
	},
	"resource://compliance-atlas": {
		"application": "compliance",
		"roles": {"exception": ["atlas:read"]},
	},
	"resource://compliance-lumen": {
		"application": "compliance",
		"roles": {
			"compliance": ["lumen:read"],
			"partner-integration": ["lumen:read"],
		},
	},
	"resource://compliance-sabre": {
		"application": "compliance",
		"roles": {
			"partner-integration": ["sabre:tax"],
			"policy-check": ["sabre:tax"],
		},
	},
	"resource://compliance-verafin": {
		"application": "compliance",
		"roles": {
			"compliance": ["verafin:attest", "verafin:case", "verafin:file", "verafin:monitor"],
			"partner-integration": ["verafin:attest", "verafin:case", "verafin:file", "verafin:monitor"],
			"policy-check": ["verafin:monitor"],
		},
	},
	"resource://intake-aegis": {
		"application": "intake",
		"roles": {"vendor-lifecycle": ["aegis:verify"]},
	},
	"resource://intake-atlas": {
		"application": "intake",
		"roles": {
			"invoice-intake": ["atlas:read"],
			"partner-integration": ["atlas:onboard", "atlas:read"],
			"vendor-lifecycle": ["atlas:onboard", "atlas:read"],
		},
	},
	"resource://intake-beacon": {
		"application": "intake",
		"roles": {
			"partner-integration": ["beacon:read", "beacon:write"],
			"vendor-lifecycle": ["beacon:read", "beacon:write"],
		},
	},
	"resource://intake-cordoba": {
		"application": "intake",
		"roles": {"invoice-intake": ["cordoba:quote"]},
	},
	"resource://intake-inkwell": {
		"application": "intake",
		"roles": {
			"invoice-intake": ["inkwell:extract"],
			"partner-integration": ["inkwell:extract"],
		},
	},
	"resource://intake-junction": {
		"application": "intake",
		"roles": {
			"partner-integration": ["junction:order", "junction:read", "junction:requisition"],
			"vendor-lifecycle": ["junction:order", "junction:read", "junction:requisition"],
		},
	},
	"resource://ledger-corebilling": {
		"application": "ledger",
		"roles": {
			"partner-integration": ["corebilling:collect", "corebilling:post", "corebilling:read"],
			"receivables": ["corebilling:collect", "corebilling:post", "corebilling:read"],
		},
	},
	"resource://ledger-ironbark": {
		"application": "ledger",
		"roles": {
			"ledger-match": ["ironbark:post", "ironbark:read"],
			"partner-integration": ["ironbark:post", "ironbark:read"],
		},
	},
	"resource://ledger-slate": {
		"application": "ledger",
		"roles": {
			"close": ["slate:post", "slate:read"],
			"partner-integration": ["slate:post", "slate:read"],
		},
	},
	"resource://ledger-tallyhall": {
		"application": "ledger",
		"roles": {
			"ledger-match": ["tallyhall:post", "tallyhall:read"],
			"partner-integration": ["tallyhall:ar", "tallyhall:post", "tallyhall:read"],
		},
	},
	"resource://ledger-vela": {
		"application": "ledger",
		"roles": {
			"partner-integration": ["vela:read", "vela:send"],
			"receivables": ["vela:read", "vela:send"],
		},
	},
	"resource://ops-relay": {
		"application": "operations",
		"roles": {"partner-integration": ["relay:execute", "relay:read"]},
	},
	"resource://payments-cordoba": {
		"application": "payments",
		"roles": {"payment-execution": ["cordoba:convert", "cordoba:transfer"]},
	},
	"resource://payments-halcyon": {
		"application": "payments",
		"roles": {"payment-execution": ["halcyon:pay", "halcyon:read"]},
	},
	"resource://payments-meridian": {
		"application": "payments",
		"roles": {"payment-execution": ["meridian:payout"]},
	},
	"resource://payments-quetzal": {
		"application": "payments",
		"roles": {
			"partner-integration": ["quetzal:payout"],
			"payment-execution": ["quetzal:payout"],
		},
	},
	"resource://payments-tallyhall": {
		"application": "payments",
		"roles": {"payment-execution": ["tallyhall:pay"]},
	},
	"resource://payments-vela": {
		"application": "payments",
		"roles": {"payments": ["vela:send"]},
	},
	"resource://treasury-cordoba": {
		"application": "treasury",
		"roles": {"route-optimization": ["cordoba:convert", "cordoba:quote"]},
	},
	"resource://treasury-halcyon": {
		"application": "treasury",
		"roles": {
			"partner-integration": ["halcyon:read"],
			"route-optimization": ["halcyon:read"],
		},
	},
	"resource://treasury-keystone": {
		"application": "treasury",
		"roles": {
			"partner-integration": ["keystone:move", "keystone:read"],
			"treasury": ["keystone:move", "keystone:read"],
		},
	},
	"resource://treasury-pulse": {
		"application": "treasury",
		"roles": {
			"partner-integration": ["pulse:read"],
			"route-optimization": ["pulse:read"],
		},
	},
	"resource://treasury-sabre": {
		"application": "treasury",
		"roles": {"route-optimization": ["sabre:tax"]},
	},
}

# Grants are data for the shared rules in 00-base; this document never decides on
# its own. The inert rule below satisfies the platform's policy authoring contract,
# which requires every authored policy to define a result rule.
result := allow_result("lynx-grants") if {
	false
}
