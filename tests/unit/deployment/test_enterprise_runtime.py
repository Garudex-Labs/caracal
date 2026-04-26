"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for enterprise_runtime pure helper functions.
"""
import pytest

from caracal.deployment.enterprise_runtime import (
    _is_allowed_enterprise_host,
    _normalize_enterprise_url,
)


@pytest.mark.unit
class TestIsAllowedEnterpriseHost:
    def test_empty_string_rejected(self):
        assert _is_allowed_enterprise_host("") is False

    def test_whitespace_only_rejected(self):
        assert _is_allowed_enterprise_host("   ") is False

    def test_localhost_allowed(self):
        assert _is_allowed_enterprise_host("localhost") is True

    def test_localhost_uppercase_allowed(self):
        assert _is_allowed_enterprise_host("LOCALHOST") is True

    def test_garudexlabs_allowed(self):
        assert _is_allowed_enterprise_host("garudexlabs.com") is True

    def test_www_garudexlabs_allowed(self):
        assert _is_allowed_enterprise_host("www.garudexlabs.com") is True

    def test_loopback_ipv4_allowed(self):
        assert _is_allowed_enterprise_host("127.0.0.1") is True

    def test_loopback_ipv6_allowed(self):
        assert _is_allowed_enterprise_host("::1") is True

    def test_docker_internal_allowed(self):
        assert _is_allowed_enterprise_host("host.docker.internal") is True

    def test_containers_internal_allowed(self):
        assert _is_allowed_enterprise_host("host.containers.internal") is True

    def test_private_class_a_allowed(self):
        assert _is_allowed_enterprise_host("10.0.0.1") is True

    def test_private_class_b_allowed(self):
        assert _is_allowed_enterprise_host("172.16.5.5") is True

    def test_private_class_c_allowed(self):
        assert _is_allowed_enterprise_host("192.168.1.100") is True

    def test_public_ip_rejected(self):
        assert _is_allowed_enterprise_host("8.8.8.8") is False

    def test_external_hostname_rejected(self):
        assert _is_allowed_enterprise_host("example.com") is False

    def test_unknown_subdomain_rejected(self):
        assert _is_allowed_enterprise_host("evil.garudexlabs.com") is False

    def test_leading_trailing_whitespace_stripped(self):
        assert _is_allowed_enterprise_host("  localhost  ") is True

    def test_loopback_other_octets(self):
        assert _is_allowed_enterprise_host("127.255.255.255") is True


@pytest.mark.unit
class TestNormalizeEnterpriseUrl:
    def test_none_returns_none(self):
        assert _normalize_enterprise_url(None) is None

    def test_empty_string_returns_none(self):
        assert _normalize_enterprise_url("") is None

    def test_whitespace_returns_none(self):
        assert _normalize_enterprise_url("   ") is None

    def test_bare_parentheses_returns_none(self):
        assert _normalize_enterprise_url("()") is None

    def test_disallowed_host_returns_none(self):
        assert _normalize_enterprise_url("https://evil.com") is None

    def test_valid_http_url_unchanged(self):
        result = _normalize_enterprise_url("http://localhost:8080")
        assert result == "http://localhost:8080"

    def test_valid_https_url_unchanged(self):
        result = _normalize_enterprise_url("https://garudexlabs.com/path")
        assert result == "https://garudexlabs.com/path"

    def test_trailing_slash_stripped(self):
        result = _normalize_enterprise_url("http://localhost/")
        assert result == "http://localhost"

    def test_no_scheme_prepends_http(self):
        result = _normalize_enterprise_url("localhost:8080")
        assert result is not None
        assert result.startswith("http://")

    def test_whitespace_stripped(self):
        result = _normalize_enterprise_url("  http://localhost  ")
        assert result == "http://localhost"

    def test_private_ip_allowed(self):
        result = _normalize_enterprise_url("http://192.168.1.5:9000")
        assert result == "http://192.168.1.5:9000"

    def test_public_ip_returns_none(self):
        assert _normalize_enterprise_url("http://8.8.8.8") is None

    def test_garudexlabs_url_allowed(self):
        result = _normalize_enterprise_url("https://www.garudexlabs.com")
        assert result == "https://www.garudexlabs.com"

    def test_paren_wrapped_value_stripped(self):
        result = _normalize_enterprise_url("(http://localhost)")
        assert result == "http://localhost"
