"""Tests for authentication helper CLI commands."""

from __future__ import annotations

import json

import pytest
from click.testing import CliRunner

from caracal.cli import auth as auth_cli


class _FakeAISResponse:
    status_code = 200
    text = ""

    def json(self):
        return {
            "access_token": "access-token-123",
            "access_expires_at": "2026-04-28T00:00:00",
            "session_id": "sess-123",
            "refresh_token": "refresh-token-123",
        }


class _FakeAISClient:
    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def post(self, url, *, json, headers):
        self.url = url
        self.payload = json
        self.headers = headers
        return _FakeAISResponse()


@pytest.mark.unit
def test_auth_token_env_format_emits_ccl_sess_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth_cli.httpx, "Client", _FakeAISClient)
    monkeypatch.setenv("CCL_AIS_UNIX_SOCKET_PATH", "/tmp/caracal-ais.sock")

    result = CliRunner().invoke(
        auth_cli.auth,
        [
            "token",
            "--principal-id",
            "11111111-1111-1111-1111-111111111111",
            "--workspace-id",
            "default",
            "--tenant-id",
            "default",
            "--session-kind",
            "automation",
            "--format",
            "env",
        ],
    )

    assert result.exit_code == 0
    assert result.output == "CCL_SESS_TOKEN=access-token-123\n"


@pytest.mark.unit
def test_auth_token_json_format_emits_token_json_without_prose(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth_cli.httpx, "Client", _FakeAISClient)
    monkeypatch.setenv("CCL_AIS_UNIX_SOCKET_PATH", "/tmp/caracal-ais.sock")

    result = CliRunner().invoke(
        auth_cli.auth,
        [
            "token",
            "--principal-id",
            "11111111-1111-1111-1111-111111111111",
            "--format",
            "json",
            "--quiet",
        ],
    )

    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["access_token"] == "access-token-123"
    assert "AIS session token minted" not in result.output
