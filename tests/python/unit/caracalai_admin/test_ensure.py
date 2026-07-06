"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Reconciler tests: applications, api-key providers, resources, and policy sets converge idempotently and fail closed on unusable state.
"""

from __future__ import annotations

import hashlib
import unittest
from unittest import mock

from caracalai_admin import (
    GovernedUpstream,
    GovernedUpstreamGrant,
    GovernedUpstreamProvider,
    GovernedUpstreamResource,
    ResourceGrant,
    author_grants_document,
    ensure_active_policy_set,
    ensure_api_key_provider,
    ensure_application,
    ensure_governed_upstreams,
    ensure_grants,
    ensure_resource,
)

ZONE = "zone-1"


def app_admin(existing):
    client = mock.Mock()
    client.applications.list.return_value = existing
    client.applications.create.return_value = {"id": "app-created"}
    client.applications.patch.return_value = {}
    return client


class EnsureApplicationTests(unittest.TestCase):
    def test_creates_managed_application_and_seals_secret(self):
        client = app_admin([])
        appId = ensure_application(
            client,
            ZONE,
            name="Fiona",
            traits=["system:operator"],
            client_secret="cs_fresh",
        )

        self.assertEqual(appId, "app-created")
        client.applications.create.assert_called_once_with(
            ZONE,
            {
                "name": "Fiona",
                "registration_method": "managed",
                "traits": ["system:operator"],
            },
        )
        client.applications.patch.assert_called_once_with(
            ZONE, "app-created", {"client_secret": "cs_fresh"}
        )

    def test_fails_closed_on_unusable_credential(self):
        dcr = app_admin(
            [
                {
                    "id": "app-1",
                    "name": "Fiona",
                    "registration_method": "dcr",
                    "expires_at": None,
                    "traits": [],
                }
            ]
        )
        with self.assertRaisesRegex(RuntimeError, "not a usable managed credential"):
            ensure_application(dcr, ZONE, name="Fiona", traits=[], client_secret="cs")

        expiring = app_admin(
            [
                {
                    "id": "app-1",
                    "name": "Fiona",
                    "registration_method": "managed",
                    "expires_at": "2026-01-01T00:00:00Z",
                    "traits": [],
                }
            ]
        )
        with self.assertRaisesRegex(RuntimeError, "not a usable managed credential"):
            ensure_application(
                expiring, ZONE, name="Fiona", traits=[], client_secret="cs"
            )

    def test_reconciles_drifted_traits_and_always_rotates_secret(self):
        client = app_admin(
            [
                {
                    "id": "app-1",
                    "name": "Fiona",
                    "registration_method": "managed",
                    "expires_at": None,
                    "traits": ["stale"],
                }
            ]
        )
        appId = ensure_application(
            client,
            ZONE,
            name="Fiona",
            traits=["system:operator"],
            client_secret="cs_next",
        )

        self.assertEqual(appId, "app-1")
        client.applications.patch.assert_has_calls(
            [
                mock.call(ZONE, "app-1", {"traits": ["system:operator"]}),
                mock.call(ZONE, "app-1", {"client_secret": "cs_next"}),
            ]
        )

    def test_matching_traits_only_rotate_secret(self):
        client = app_admin(
            [
                {
                    "id": "app-1",
                    "name": "Fiona",
                    "registration_method": "managed",
                    "expires_at": None,
                    "traits": ["system:operator"],
                }
            ]
        )
        ensure_application(
            client,
            ZONE,
            name="Fiona",
            traits=["system:operator"],
            client_secret="cs_next",
        )

        client.applications.patch.assert_called_once_with(
            ZONE, "app-1", {"client_secret": "cs_next"}
        )


PLACEMENT = {
    "auth_location": "header",
    "header_name": "Authorization",
    "auth_scheme": "Bearer",
    "allow_runtime_injection": True,
}


def provider_admin(existing):
    client = mock.Mock()
    client.providers.list.return_value = existing
    client.providers.create.return_value = {"id": "prov-created"}
    client.providers.patch.return_value = {}
    return client


class EnsureApiKeyProviderTests(unittest.TestCase):
    def test_returns_none_when_absent_and_no_key(self):
        client = provider_admin([])
        providerId = ensure_api_key_provider(
            client,
            ZONE,
            name="Hooli OIDC",
            identifier="provider://hooli",
            public_config=PLACEMENT,
        )

        self.assertIsNone(providerId)
        client.providers.create.assert_not_called()
        client.providers.patch.assert_not_called()

    def test_patches_only_public_placement_without_key(self):
        client = provider_admin([{"id": "prov-1", "identifier": "provider://hooli"}])
        providerId = ensure_api_key_provider(
            client,
            ZONE,
            name="Hooli OIDC",
            identifier="provider://hooli",
            public_config=PLACEMENT,
        )

        self.assertEqual(providerId, "prov-1")
        client.providers.patch.assert_called_once_with(
            ZONE, "prov-1", {"config_json": PLACEMENT}
        )

    def test_creates_provider_with_sealed_key(self):
        client = provider_admin([])
        providerId = ensure_api_key_provider(
            client,
            ZONE,
            name="Hooli OIDC",
            identifier="provider://hooli",
            public_config=PLACEMENT,
            api_key="sk-sealed",
        )

        self.assertEqual(providerId, "prov-created")
        client.providers.create.assert_called_once_with(
            ZONE,
            {
                "name": "Hooli OIDC",
                "identifier": "provider://hooli",
                "kind": "api_key",
                "config_json": {**PLACEMENT, "api_key": "sk-sealed"},
            },
        )

    def test_reseals_existing_provider_with_key(self):
        client = provider_admin([{"id": "prov-1", "identifier": "provider://hooli"}])
        ensure_api_key_provider(
            client,
            ZONE,
            name="Hooli OIDC",
            identifier="provider://hooli",
            public_config=PLACEMENT,
            api_key="sk-rotated",
        )

        client.providers.patch.assert_called_once_with(
            ZONE,
            "prov-1",
            {"kind": "api_key", "config_json": {**PLACEMENT, "api_key": "sk-rotated"}},
        )


def resource_admin(existing):
    client = mock.Mock()
    client.resources.list.return_value = existing
    client.resources.create.side_effect = lambda zone, body: {
        "id": "res-created",
        **body,
    }
    client.resources.patch.side_effect = lambda zone, resourceId, body: {
        "id": resourceId,
        **body,
    }
    return client


class EnsureResourceTests(unittest.TestCase):
    def test_creates_resource_with_managed_fields(self):
        client = resource_admin([])
        resource = ensure_resource(
            client,
            ZONE,
            name="PiperNet",
            identifier="resource://pipernet",
            scopes=["data:read"],
            upstream_url="https://api.pipernet.example",
            operation_enforcement="transport_uniform",
        )

        self.assertEqual(resource["id"], "res-created")
        client.resources.create.assert_called_once_with(
            ZONE,
            {
                "name": "PiperNet",
                "identifier": "resource://pipernet",
                "scopes": ["data:read", "agent:lifecycle"],
                "upstream_url": "https://api.pipernet.example",
                "operation_enforcement": "transport_uniform",
            },
        )

    def test_returns_live_resource_without_patch_when_converged(self):
        existing = {
            "id": "res-1",
            "identifier": "resource://pipernet",
            "scopes": ["data:read", "agent:lifecycle"],
            "upstream_url": "https://api.pipernet.example",
        }
        client = resource_admin([existing])
        resource = ensure_resource(
            client,
            ZONE,
            name="PiperNet",
            identifier="resource://pipernet",
            scopes=["data:read"],
            upstream_url="https://api.pipernet.example",
        )

        self.assertIs(resource, existing)
        client.resources.patch.assert_not_called()

    def test_patches_only_managed_fields_on_drift(self):
        client = resource_admin(
            [
                {
                    "id": "res-1",
                    "identifier": "resource://pipernet",
                    "scopes": ["data:read", "agent:lifecycle"],
                    "upstream_url": "https://stale.pipernet.example",
                    "credential_provider_id": "prov-unmanaged",
                }
            ]
        )
        ensure_resource(
            client,
            ZONE,
            name="PiperNet",
            identifier="resource://pipernet",
            scopes=["data:read"],
            upstream_url="https://api.pipernet.example",
        )

        client.resources.patch.assert_called_once_with(
            ZONE,
            "res-1",
            {
                "scopes": ["data:read", "agent:lifecycle"],
                "upstream_url": "https://api.pipernet.example",
            },
        )

    def test_adds_lifecycle_scope_to_gateway_routed_resource(self):
        client = resource_admin([])
        ensure_resource(
            client,
            ZONE,
            name="PiperNet",
            identifier="resource://pipernet",
            scopes=["data:read"],
            upstream_url="https://api.pipernet.example",
        )

        client.resources.create.assert_called_once_with(
            ZONE,
            {
                "name": "PiperNet",
                "identifier": "resource://pipernet",
                "scopes": ["data:read", "agent:lifecycle"],
                "upstream_url": "https://api.pipernet.example",
            },
        )

    def test_does_not_duplicate_lifecycle_scope(self):
        client = resource_admin([])
        ensure_resource(
            client,
            ZONE,
            name="PiperNet",
            identifier="resource://pipernet",
            scopes=["agent:lifecycle", "data:read"],
            upstream_url="https://api.pipernet.example",
        )

        body = client.resources.create.call_args[0][1]
        self.assertEqual(body["scopes"], ["agent:lifecycle", "data:read"])

    def test_gateway_routed_resource_with_lifecycle_is_converged(self):
        client = resource_admin(
            [
                {
                    "id": "res-1",
                    "identifier": "resource://pipernet",
                    "scopes": ["data:read", "agent:lifecycle"],
                    "upstream_url": "https://api.pipernet.example",
                }
            ]
        )
        ensure_resource(
            client,
            ZONE,
            name="PiperNet",
            identifier="resource://pipernet",
            scopes=["data:read"],
            upstream_url="https://api.pipernet.example",
        )

        client.resources.patch.assert_not_called()

    def test_never_adds_lifecycle_without_upstream(self):
        client = resource_admin([])
        ensure_resource(
            client,
            ZONE,
            name="PiperNet",
            identifier="resource://pipernet",
            scopes=["data:read"],
        )

        body = client.resources.create.call_args[0][1]
        self.assertEqual(body["scopes"], ["data:read"])


CONTENT = "package caracal.authz\n"
CONTENT_SHA = hashlib.sha256(CONTENT.encode()).hexdigest()


def policy_admin(policies=None, versions=None, sets=None):
    client = mock.Mock()
    client.policies.list.return_value = policies or []
    client.policies.create.return_value = {
        "id": "pol-created",
        "version_id": "ver-created",
    }
    client.policies.get.return_value = {"id": "pol-1", "versions": versions or []}
    client.policies.add_version.return_value = {"version_id": "ver-added"}
    client.policy_sets.list.return_value = sets or []
    client.policy_sets.create.return_value = {
        "id": "set-created",
        "active_version_id": None,
    }
    client.policy_sets.add_version.return_value = {"version_id": "setver-1"}
    client.policy_sets.activate.return_value = {}
    return client


class EnsureActivePolicySetTests(unittest.TestCase):
    def test_creates_nothing_when_creation_suppressed(self):
        client = policy_admin()
        ensure_active_policy_set(
            client,
            ZONE,
            policy_name="PiperNet baseline",
            set_name="PiperNet set",
            content=CONTENT,
            create_when_missing=False,
        )

        client.policies.create.assert_not_called()
        client.policy_sets.list.assert_not_called()

    def test_creates_policy_and_set_and_activates_first_version(self):
        client = policy_admin()
        ensure_active_policy_set(
            client,
            ZONE,
            policy_name="PiperNet baseline",
            set_name="PiperNet set",
            content=CONTENT,
        )

        client.policies.create.assert_called_once_with(
            ZONE, {"name": "PiperNet baseline", "content": CONTENT}
        )
        client.policy_sets.create.assert_called_once_with(ZONE, "PiperNet set")
        client.policy_sets.add_version.assert_called_once_with(
            ZONE, "set-created", [{"policy_version_id": "ver-created"}]
        )
        client.policy_sets.activate.assert_called_once_with(
            ZONE, "set-created", "setver-1"
        )

    def test_adds_and_activates_new_version_on_digest_change(self):
        client = policy_admin(
            policies=[{"id": "pol-1", "name": "PiperNet baseline"}],
            versions=[{"id": "ver-1", "version": 1, "content_sha256": "stale-sha"}],
            sets=[
                {"id": "set-1", "name": "PiperNet set", "active_version_id": "setver-0"}
            ],
        )
        ensure_active_policy_set(
            client,
            ZONE,
            policy_name="PiperNet baseline",
            set_name="PiperNet set",
            content=CONTENT,
        )

        client.policies.add_version.assert_called_once_with(ZONE, "pol-1", CONTENT)
        client.policy_sets.add_version.assert_called_once_with(
            ZONE, "set-1", [{"policy_version_id": "ver-added"}]
        )
        client.policy_sets.activate.assert_called_once_with(ZONE, "set-1", "setver-1")

    def test_changes_nothing_when_content_matches_and_set_active(self):
        client = policy_admin(
            policies=[{"id": "pol-1", "name": "PiperNet baseline"}],
            versions=[
                {"id": "ver-1", "version": 1, "content_sha256": "stale-sha"},
                {"id": "ver-2", "version": 2, "content_sha256": CONTENT_SHA},
            ],
            sets=[
                {"id": "set-1", "name": "PiperNet set", "active_version_id": "setver-0"}
            ],
        )
        ensure_active_policy_set(
            client,
            ZONE,
            policy_name="PiperNet baseline",
            set_name="PiperNet set",
            content=CONTENT,
        )

        client.policies.add_version.assert_not_called()
        client.policy_sets.add_version.assert_not_called()
        client.policy_sets.activate.assert_not_called()

    def test_self_heals_deactivated_set(self):
        client = policy_admin(
            policies=[{"id": "pol-1", "name": "PiperNet baseline"}],
            versions=[{"id": "ver-2", "version": 2, "content_sha256": CONTENT_SHA}],
            sets=[{"id": "set-1", "name": "PiperNet set", "active_version_id": None}],
        )
        ensure_active_policy_set(
            client,
            ZONE,
            policy_name="PiperNet baseline",
            set_name="PiperNet set",
            content=CONTENT,
        )

        client.policies.add_version.assert_not_called()
        client.policy_sets.add_version.assert_called_once_with(
            ZONE, "set-1", [{"policy_version_id": "ver-2"}]
        )
        client.policy_sets.activate.assert_called_once_with(ZONE, "set-1", "setver-1")


class AuthorGrantsDocumentTests(unittest.TestCase):
    def test_renders_data_documents(self):
        content = author_grants_document(
            [
                ResourceGrant(
                    application_id="app-son-of-anton",
                    resource_identifier="resource://pipernet",
                    scopes=["data:read"],
                    role="operator",
                )
            ]
        )
        self.assertIn("# caracal:data-document", content)
        self.assertIn("package caracal.authz", content)
        self.assertIn('app_ids := {"operator":"app-son-of-anton"}', content)
        self.assertIn(
            'grants := {"resource://pipernet":{"application":"operator","roles":{"operator":["data:read"]}}}',
            content,
        )

    def test_role_defaults_to_application_id(self):
        content = author_grants_document(
            [
                ResourceGrant(
                    application_id="app-son-of-anton",
                    resource_identifier="resource://pipernet",
                    scopes=["data:read"],
                )
            ]
        )
        self.assertIn('app_ids := {"app-son-of-anton":"app-son-of-anton"}', content)
        self.assertIn('"roles":{"app-son-of-anton":["data:read"]}', content)

    def test_deterministic_across_order_and_duplicates(self):
        a = author_grants_document(
            [
                ResourceGrant(
                    application_id="app-1",
                    resource_identifier="resource://b",
                    scopes=["y", "x"],
                    role="operator",
                ),
                ResourceGrant(
                    application_id="app-1",
                    resource_identifier="resource://a",
                    scopes=["x"],
                    role="operator",
                ),
            ]
        )
        b = author_grants_document(
            [
                ResourceGrant(
                    application_id="app-1",
                    resource_identifier="resource://a",
                    scopes=["x"],
                    role="operator",
                ),
                ResourceGrant(
                    application_id="app-1",
                    resource_identifier="resource://b",
                    scopes=["x", "y", "x"],
                    role="operator",
                ),
            ]
        )
        self.assertEqual(a, b)

    def test_merges_scopes_for_repeated_grants(self):
        content = author_grants_document(
            [
                ResourceGrant(
                    application_id="app-1",
                    resource_identifier="resource://pipernet",
                    scopes=["data:read"],
                    role="operator",
                ),
                ResourceGrant(
                    application_id="app-1",
                    resource_identifier="resource://pipernet",
                    scopes=["data:write"],
                    role="operator",
                ),
            ]
        )
        self.assertIn('"roles":{"operator":["data:read","data:write"]}', content)

    def test_rejects_role_claimed_by_two_applications(self):
        with self.assertRaisesRegex(ValueError, "claimed by two applications"):
            author_grants_document(
                [
                    ResourceGrant(
                        application_id="app-1",
                        resource_identifier="resource://a",
                        scopes=["x"],
                        role="operator",
                    ),
                    ResourceGrant(
                        application_id="app-2",
                        resource_identifier="resource://b",
                        scopes=["x"],
                        role="operator",
                    ),
                ]
            )


class EnsureGrantsTests(unittest.TestCase):
    def test_converges_default_named_policy_and_set(self):
        client = policy_admin()
        grants = [
            ResourceGrant(
                application_id="app-son-of-anton",
                resource_identifier="resource://pipernet",
                scopes=["data:read"],
            )
        ]
        ensure_grants(client, ZONE, grants=grants)

        client.policies.create.assert_called_once_with(
            ZONE,
            {"name": "application-grants", "content": author_grants_document(grants)},
        )
        client.policy_sets.create.assert_called_once_with(
            ZONE, "application-grant-policy"
        )
        client.policy_sets.activate.assert_called_once()

    def test_creates_nothing_for_empty_grants_with_no_policy(self):
        client = policy_admin()
        ensure_grants(client, ZONE, grants=[])

        client.policies.create.assert_not_called()
        client.policy_sets.create.assert_not_called()

    def test_uses_caller_supplied_names(self):
        client = policy_admin()
        ensure_grants(
            client,
            ZONE,
            policy_name="caracal.sys/operator-bindings",
            set_name="caracal.sys/operator-policy",
            grants=[
                ResourceGrant(
                    application_id="app-op",
                    resource_identifier="resource://pipernet",
                    scopes=["llm:invoke"],
                    role="operator",
                )
            ],
        )

        body = client.policies.create.call_args[0][1]
        self.assertEqual(body["name"], "caracal.sys/operator-bindings")
        client.policy_sets.create.assert_called_once_with(
            ZONE, "caracal.sys/operator-policy"
        )


def upstream_admin():
    client = mock.Mock()
    client.providers.list.return_value = []
    client.providers.create.return_value = {"id": "prov-created"}
    client.providers.patch.return_value = {}
    client.resources.list.return_value = []
    client.resources.create.side_effect = lambda zone, body: {
        "id": "res-created",
        **body,
    }
    client.policies.list.return_value = []
    client.policies.create.return_value = {
        "id": "pol-created",
        "version_id": "ver-created",
    }
    client.policy_sets.list.return_value = []
    client.policy_sets.create.return_value = {
        "id": "set-created",
        "active_version_id": None,
    }
    client.policy_sets.add_version.return_value = {"version_id": "setver-1"}
    client.policy_sets.activate.return_value = {}
    return client


def pipernet_upstream(api_key="sk-pipernet"):
    return GovernedUpstream(
        provider=GovernedUpstreamProvider(
            name="Hooli PiperNet OIDC",
            identifier="provider://pipernet",
            public_config={
                "auth_location": "header",
                "header_name": "Authorization",
                "auth_scheme": "Bearer",
            },
            api_key=api_key,
        ),
        resource=GovernedUpstreamResource(
            name="PiperNet",
            identifier="resource://pipernet",
            scopes=["data:read"],
            upstream_url="https://api.pipernet.example",
        ),
        grants=[
            GovernedUpstreamGrant(
                application_id="app-son-of-anton", scopes=["data:read"]
            )
        ],
    )


class EnsureGovernedUpstreamsTests(unittest.TestCase):
    def test_converges_provider_resource_and_grants_in_dependency_order(self):
        client = upstream_admin()
        results = ensure_governed_upstreams(
            client, ZONE, upstreams=[pipernet_upstream()]
        )

        client.providers.create.assert_called_once_with(
            ZONE,
            {
                "name": "Hooli PiperNet OIDC",
                "identifier": "provider://pipernet",
                "kind": "api_key",
                "config_json": {
                    "auth_location": "header",
                    "header_name": "Authorization",
                    "auth_scheme": "Bearer",
                    "api_key": "sk-pipernet",
                },
            },
        )
        client.resources.create.assert_called_once_with(
            ZONE,
            {
                "name": "PiperNet",
                "identifier": "resource://pipernet",
                "scopes": ["data:read", "agent:lifecycle"],
                "upstream_url": "https://api.pipernet.example",
                "credential_provider_id": "prov-created",
            },
        )
        client.policies.create.assert_called_once_with(
            ZONE,
            {
                "name": "application-grants",
                "content": author_grants_document(
                    [
                        ResourceGrant(
                            application_id="app-son-of-anton",
                            resource_identifier="resource://pipernet",
                            scopes=["data:read"],
                        )
                    ]
                ),
            },
        )
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].provider_id, "prov-created")
        self.assertEqual(results[0].resource["identifier"], "resource://pipernet")

    def test_fails_closed_before_binding_when_provider_has_no_sealed_key(self):
        client = upstream_admin()
        with self.assertRaisesRegex(RuntimeError, "no sealed api key"):
            ensure_governed_upstreams(
                client, ZONE, upstreams=[pipernet_upstream(api_key=None)]
            )

        client.resources.create.assert_not_called()
        client.policies.create.assert_not_called()

    def test_converges_empty_set_without_materializing_artifacts(self):
        client = upstream_admin()
        results = ensure_governed_upstreams(client, ZONE, upstreams=[])

        self.assertEqual(results, [])
        client.providers.create.assert_not_called()
        client.resources.create.assert_not_called()
        client.policies.create.assert_not_called()

    def test_threads_caller_policy_and_set_names(self):
        client = upstream_admin()
        ensure_governed_upstreams(
            client,
            ZONE,
            upstreams=[pipernet_upstream()],
            policy_name="pied-piper-grants",
            set_name="pied-piper-grant-policy",
        )

        body = client.policies.create.call_args[0][1]
        self.assertEqual(body["name"], "pied-piper-grants")
        client.policy_sets.create.assert_called_once_with(
            ZONE, "pied-piper-grant-policy"
        )


if __name__ == "__main__":
    unittest.main()
