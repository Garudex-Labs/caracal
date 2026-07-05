"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for provider and resource identifier helpers.
"""

from __future__ import annotations

import unittest

from caracalai_admin import (
    is_provider_identifier,
    is_resource_identifier,
    provider_identifier,
    resource_identifier,
)


class ProviderIdentifierTests(unittest.TestCase):
    def test_slugs_display_names(self):
        self.assertEqual(provider_identifier("Hooli OIDC"), "provider://hooli-oidc")
        self.assertEqual(
            provider_identifier("  Raviga Capital OAuth  "),
            "provider://raviga-capital-oauth",
        )

    def test_preserves_existing_prefix(self):
        self.assertEqual(
            provider_identifier("provider://hooli-oidc"), "provider://hooli-oidc"
        )

    def test_falls_back_when_no_slug_characters(self):
        self.assertEqual(provider_identifier("!!!"), "provider://provider")

    def test_is_provider_identifier(self):
        self.assertTrue(is_provider_identifier("provider://hooli-oidc"))
        self.assertFalse(is_provider_identifier("provider://Hooli"))
        self.assertFalse(is_provider_identifier("resource://pipernet"))
        self.assertFalse(is_provider_identifier("provider://-bad"))


class ResourceIdentifierTests(unittest.TestCase):
    def test_preserves_absolute_uris(self):
        self.assertEqual(
            resource_identifier("resource://pipernet"), "resource://pipernet"
        )
        self.assertEqual(
            resource_identifier("https://api.pipernet.example"),
            "https://api.pipernet.example",
        )

    def test_slugs_plain_names(self):
        self.assertEqual(resource_identifier("Not Hotdog"), "resource://not-hotdog")

    def test_falls_back_when_no_slug_characters(self):
        self.assertEqual(resource_identifier("!!!"), "resource://resource")

    def test_is_resource_identifier(self):
        self.assertTrue(is_resource_identifier("resource://pipernet"))
        self.assertTrue(is_resource_identifier("https://api.pipernet.example"))
        self.assertFalse(is_resource_identifier("provider://hooli-oidc"))
        self.assertFalse(is_resource_identifier("plain name"))
        self.assertFalse(
            is_resource_identifier("https://richard:secret@api.pipernet.example")
        )

    def test_control_audience_short_circuits(self):
        self.assertTrue(is_resource_identifier("caracal-control", "caracal-control"))
        self.assertFalse(is_resource_identifier("caracal-control", "other"))


if __name__ == "__main__":
    unittest.main()
