"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for SyncResult, EnterpriseSyncClient, and _get_json_with_retry.
"""

from __future__ import annotations

import urllib.error
from unittest.mock import MagicMock, patch

import pytest

from caracal.deployment.enterprise_sync import (
    EnterpriseSyncClient,
    SyncResult,
    _get_json_with_retry,
)


def _make_client(api_url="https://api.example.com", sync_api_key="sk-test"):
    with patch("caracal.deployment.enterprise_sync.load_enterprise_config", return_value={}):
        with patch("caracal.deployment.enterprise_sync._resolve_api_url", return_value=api_url):
            with patch("caracal.deployment.enterprise_sync._get_or_create_client_instance_id", return_value="inst-1"):
                return EnterpriseSyncClient(api_url=api_url, sync_api_key=sync_api_key)


@pytest.mark.unit
class TestSyncResultToDict:
    def test_success(self):
        r = SyncResult(success=True, message="OK", synced_counts={"tools": 5}, errors=[])
        d = r.to_dict()
        assert d["success"] is True
        assert d["message"] == "OK"
        assert d["synced_counts"] == {"tools": 5}
        assert d["errors"] == []

    def test_failure(self):
        r = SyncResult(success=False, message="Failed", errors=["err1"])
        d = r.to_dict()
        assert d["success"] is False
        assert d["errors"] == ["err1"]

    def test_defaults(self):
        r = SyncResult(success=True, message="x")
        d = r.to_dict()
        assert d["synced_counts"] == {}
        assert d["errors"] == []


@pytest.mark.unit
class TestEnterpriseSyncClientIsConfigured:
    def test_configured_with_key(self):
        client = _make_client(sync_api_key="sk-test")
        assert client.is_configured is True

    def test_not_configured_without_key(self):
        client = _make_client(sync_api_key=None)
        assert client.is_configured is False


@pytest.mark.unit
class TestEnterpriseSyncClientResolveHeaders:
    def test_raises_without_key(self):
        client = _make_client(sync_api_key=None)
        with pytest.raises(RuntimeError, match="sync API key"):
            client._resolve_enterprise_auth_headers()

    def test_returns_headers_with_key(self):
        client = _make_client(sync_api_key="sk-test")
        headers = client._resolve_enterprise_auth_headers()
        assert headers["X-Sync-Api-Key"] == "sk-test"
        assert headers["X-Caracal-Client-Id"] == "inst-1"


@pytest.mark.unit
class TestEnterpriseSyncClientUploadPayload:
    def test_not_configured_returns_failure(self):
        client = _make_client(sync_api_key=None)
        result = client.upload_payload({"data": "x"})
        assert result.success is False
        assert "not configured" in result.message

    def test_no_api_url_returns_failure(self):
        client = _make_client(api_url=None, sync_api_key="sk-test")
        result = client.upload_payload({"data": "x"})
        assert result.success is False
        assert "URL" in result.message

    def test_url_error_returns_failure(self):
        client = _make_client()
        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("refused")):
            with patch("caracal.deployment.enterprise_sync._build_client_metadata", return_value={}):
                result = client.upload_payload({"data": "x"})
        assert result.success is False
        assert "refused" in result.message or "reach" in result.message.lower()

    def test_successful_upload(self):
        client = _make_client()
        mock_resp = MagicMock()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_resp.read.return_value = b'{"success": true, "message": "Synced", "synced_counts": {"tools": 2}}'

        with patch("urllib.request.urlopen", return_value=mock_resp):
            with patch("caracal.deployment.enterprise_sync._build_client_metadata", return_value={}):
                with patch("caracal.deployment.enterprise_sync.load_enterprise_config", return_value={}):
                    with patch("caracal.deployment.enterprise_sync.save_enterprise_config"):
                        result = client.upload_payload({"data": "x"})
        assert result.success is True
        assert result.synced_counts == {"tools": 2}

    def test_http_error_returns_failure(self):
        client = _make_client()
        exc = urllib.error.HTTPError(url="http://x", code=400, msg="Bad Request", hdrs={}, fp=None)
        with patch("urllib.request.urlopen", side_effect=exc):
            with patch("caracal.deployment.enterprise_sync._build_client_metadata", return_value={}):
                result = client.upload_payload({"data": "x"})
        assert result.success is False

    def test_unexpected_exception_returns_failure(self):
        client = _make_client()
        with patch("urllib.request.urlopen", side_effect=RuntimeError("unexpected")):
            with patch("caracal.deployment.enterprise_sync._build_client_metadata", return_value={}):
                result = client.upload_payload({"data": "x"})
        assert result.success is False
        assert "unexpected" in result.message.lower()


@pytest.mark.unit
class TestEnterpriseSyncClientGetSyncStatus:
    def test_not_configured_returns_error(self):
        client = _make_client(sync_api_key=None)
        result = client.get_sync_status()
        assert "error" in result

    def test_returns_api_response(self):
        client = _make_client()
        with patch("caracal.deployment.enterprise_sync._get_json", return_value={"status": "active"}):
            result = client.get_sync_status()
        assert result == {"status": "active"}

    def test_exception_returns_error_dict(self):
        client = _make_client()
        with patch("caracal.deployment.enterprise_sync._get_json", side_effect=RuntimeError("timeout")):
            result = client.get_sync_status()
        assert "error" in result


@pytest.mark.unit
class TestEnterpriseSyncClientTestConnection:
    def test_not_configured_returns_false(self):
        client = _make_client(sync_api_key=None)
        assert client.test_connection() is False

    def test_http_error_returns_true(self):
        client = _make_client()
        exc = urllib.error.HTTPError(url="http://x", code=401, msg="Unauthorized", hdrs={}, fp=None)
        with patch("urllib.request.urlopen", side_effect=exc):
            assert client.test_connection() is True

    def test_all_probes_fail_returns_false(self):
        client = _make_client()
        with patch("urllib.request.urlopen", side_effect=Exception("refused")):
            assert client.test_connection() is False

    def test_successful_probe_returns_true(self):
        client = _make_client()
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = lambda s: s
        mock_ctx.__exit__ = MagicMock(return_value=False)
        with patch("urllib.request.urlopen", return_value=mock_ctx):
            assert client.test_connection() is True


@pytest.mark.unit
class TestGetJsonWithRetry:
    def test_succeeds_on_first_attempt(self):
        with patch("caracal.deployment.enterprise_sync._get_json", return_value={"ok": True}):
            result = _get_json_with_retry("http://x")
        assert result == {"ok": True}

    def test_raises_on_4xx(self):
        exc = urllib.error.HTTPError("http://x", 404, "Not Found", {}, None)
        with patch("caracal.deployment.enterprise_sync._get_json", side_effect=exc):
            with pytest.raises(urllib.error.HTTPError):
                _get_json_with_retry("http://x", max_attempts=2)

    def test_retries_and_raises_on_5xx(self):
        exc = urllib.error.HTTPError("http://x", 503, "Service Unavailable", {}, None)
        with patch("caracal.deployment.enterprise_sync._get_json", side_effect=exc):
            with patch("time.sleep"):
                with pytest.raises(urllib.error.HTTPError):
                    _get_json_with_retry("http://x", max_attempts=2)

    def test_retries_url_error_and_raises(self):
        exc = urllib.error.URLError("Connection refused")
        with patch("caracal.deployment.enterprise_sync._get_json", side_effect=exc):
            with patch("time.sleep"):
                with pytest.raises(urllib.error.URLError):
                    _get_json_with_retry("http://x", max_attempts=2)

    def test_succeeds_after_retry(self):
        exc = urllib.error.HTTPError("http://x", 503, "Service Unavailable", {}, None)
        call_count = [0]
        def side_effect(url, headers=None):
            call_count[0] += 1
            if call_count[0] < 2:
                raise exc
            return {"ok": True}
        with patch("caracal.deployment.enterprise_sync._get_json", side_effect=side_effect):
            with patch("time.sleep"):
                result = _get_json_with_retry("http://x", max_attempts=3)
        assert result == {"ok": True}
