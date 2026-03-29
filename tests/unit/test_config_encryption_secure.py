"""Tests for keystore-backed configuration encryption."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from caracal.config.encryption import (
    MasterKeyError,
    decrypt_value,
    encrypt_value,
    get_key_status,
    rotate_master_key,
)


@pytest.fixture
def isolated_home(tmp_path, monkeypatch):
    home = tmp_path / "caracal-home"
    monkeypatch.setenv("CARACAL_HOME", str(home))
    return home


def test_encrypt_bootstrap_creates_keystore_files(isolated_home):
    encrypted = encrypt_value("top-secret")
    assert encrypted.startswith("ENC[v2:")
    assert decrypt_value(encrypted) == "top-secret"

    status = get_key_status()
    assert status["master_key_present"] is True
    assert status["salt_present"] is True
    assert status["dek_count"] == 1


def test_missing_master_key_fails_when_encrypted_state_exists(isolated_home):
    encrypted = encrypt_value("value")

    master_key_path = Path(isolated_home) / "keystore" / "master_key"
    master_key_path.unlink()

    with pytest.raises(MasterKeyError):
        decrypt_value(encrypted)


def test_rotate_master_key_rewraps_deks_and_preserves_decryption(isolated_home):
    encrypted_first = encrypt_value("alpha")
    encrypted_second = encrypt_value("beta")

    summary = rotate_master_key(actor="test")

    assert summary.rewrapped_deks == 1
    assert decrypt_value(encrypted_first) == "alpha"
    assert decrypt_value(encrypted_second) == "beta"

    audit_path = Path(isolated_home) / "ledger" / "audit_logs" / "key_events.jsonl"
    events = [json.loads(line) for line in audit_path.read_text(encoding="utf-8").splitlines()]
    assert any(event["event_type"] == "master_key_rotated" for event in events)
