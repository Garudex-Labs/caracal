// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for Control key token exchange authorization.

package internal

import "testing"

func TestIsControlKeyExchange(t *testing.T) {
	app := &Application{ID: "app-1", Traits: []string{controlInvokeTrait, controlScopeTrait + "control:agent:read"}}
	req := TokenExchangeRequest{ApplicationID: "app-1"}
	resource := &Resource{Identifier: defaultControlAudience}

	if !isControlKeyExchange(app, req, resource, []string{"control:agent:read"}) {
		t.Fatalf("expected control key exchange to be allowed")
	}

	for name, tc := range map[string]struct {
		app      *Application
		req      TokenExchangeRequest
		resource *Resource
		scopes   []string
	}{
		"missing trait": {
			app:      &Application{ID: "app-1", Traits: []string{controlScopeTrait + "control:agent:read"}},
			req:      req,
			resource: resource,
			scopes:   []string{"control:agent:read"},
		},
		"missing scoped permission": {
			app:      &Application{ID: "app-1", Traits: []string{controlInvokeTrait}},
			req:      req,
			resource: resource,
			scopes:   []string{"control:agent:read"},
		},
		"ungranted scope": {
			app:      app,
			req:      req,
			resource: resource,
			scopes:   []string{"control:agent:delete"},
		},
		"wrong resource": {
			app:      app,
			req:      req,
			resource: &Resource{Identifier: "api"},
			scopes:   []string{"control:agent:read"},
		},
		"subject token": {
			app:      app,
			req:      TokenExchangeRequest{ApplicationID: "app-1", SubjectToken: "subject"},
			resource: resource,
			scopes:   []string{"control:agent:read"},
		},
		"empty scopes": {
			app:      app,
			req:      req,
			resource: resource,
			scopes:   nil,
		},
		"non-control scope": {
			app:      app,
			req:      req,
			resource: resource,
			scopes:   []string{"zone:read"},
		},
	} {
		t.Run(name, func(t *testing.T) {
			if isControlKeyExchange(tc.app, tc.req, tc.resource, tc.scopes) {
				t.Fatalf("expected control key exchange to be denied")
			}
		})
	}
}

func TestIsControlKeyExchangeRestrictions(t *testing.T) {
	resource := &Resource{Identifier: defaultControlAudience}
	scope := []string{"control:agent:read"}

	if isControlKeyExchange(&Application{ID: "app-1", Traits: []string{
		controlInvokeTrait,
		controlScopeTrait + "control:agent:read",
		controlMaxTTLTrait + "60",
	}}, TokenExchangeRequest{ApplicationID: "app-1", TTLSeconds: 300}, resource, scope) {
		t.Fatalf("expected ttl above key maximum to be denied")
	}

	if isControlKeyExchange(&Application{ID: "app-1", Traits: []string{
		controlInvokeTrait,
		controlScopeTrait + "control:agent:read",
		controlExpiresTrait + "2000-01-01T00:00:00Z",
	}}, TokenExchangeRequest{ApplicationID: "app-1"}, resource, scope) {
		t.Fatalf("expected expired key to be denied")
	}
}
