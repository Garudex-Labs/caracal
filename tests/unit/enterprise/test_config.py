"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for Enterprise runtime config persistence helpers.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import caracal.deployment.enterprise_runtime as enterprise_runtime


def _patch_runtime_dir(monkeypatch: pytest.MonkeyPatch, tmp_path):
    metadata_dir = tmp_path / "metadata"
    monkeypatch.setattr(
        enterprise_runtime,
        "get_caracal_layout",
        lambda require_explicit=False: SimpleNamespace(metadata_dir=metadata_dir),
    )
    return metadata_dir


@pytest.mark.unit
def test_load_enterprise_config_reads_runtime_file(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    metadata_dir = _patch_runtime_dir(monkeypatch, tmp_path)
    metadata_dir.mkdir(parents=True)
    (metadata_dir / "enterprise_runtime.json").write_text(
        '{"license_key": "ent-token", "valid": true}',
        encoding="utf-8",
    )

    result = enterprise_runtime.load_enterprise_config()

    assert result == {"license_key": "ent-token", "valid": True}


@pytest.mark.unit
def test_save_enterprise_config_writes_runtime_file(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    metadata_dir = _patch_runtime_dir(monkeypatch, tmp_path)

    enterprise_runtime.save_enterprise_config(
        {"enterprise_api_url": "https://enterprise.example", "valid": True}
    )

    payload = (metadata_dir / "enterprise_runtime.json").read_text(encoding="utf-8")
    assert '"enterprise_api_url": "https://enterprise.example"' in payload
    assert '"valid": true' in payload


@pytest.mark.unit
def test_save_enterprise_config_replaces_runtime_file(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    metadata_dir = _patch_runtime_dir(monkeypatch, tmp_path)
    metadata_dir.mkdir(parents=True)
    (metadata_dir / "enterprise_runtime.json").write_text(
        '{"license_key": "old-token", "valid": false}',
        encoding="utf-8",
    )

    enterprise_runtime.save_enterprise_config({"license_key": "new-token", "valid": True})

    assert enterprise_runtime.load_enterprise_config() == {"license_key": "new-token", "valid": True}


@pytest.mark.unit
def test_clear_enterprise_config_deletes_runtime_file(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    metadata_dir = _patch_runtime_dir(monkeypatch, tmp_path)
    metadata_dir.mkdir(parents=True)
    path = metadata_dir / "enterprise_runtime.json"
    path.write_text('{"license_key": "ent-token", "valid": true}', encoding="utf-8")

    enterprise_runtime.clear_enterprise_config()

    assert not path.exists()