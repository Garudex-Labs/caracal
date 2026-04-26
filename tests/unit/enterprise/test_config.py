"""Unit tests for enterprise runtime config persistence helpers."""

from __future__ import annotations

from contextlib import contextmanager

import pytest

import caracal.deployment.enterprise_runtime as enterprise_runtime
from caracal.db.models import EnterpriseRuntimeConfig


class _FakeQuery:
    def __init__(self, session: "_FakeSession"):
        self._session = session

    def filter_by(self, **kwargs):
        self._session.filter_kwargs = kwargs
        return self

    def first(self):
        return self._session.row


class _FakeSession:
    def __init__(self, row: EnterpriseRuntimeConfig | None):
        self.row = row
        self.queried_model = None
        self.filter_kwargs = None
        self.added = []
        self.deleted = None

    def query(self, model):
        self.queried_model = model
        return _FakeQuery(self)

    def add(self, value):
        self.added.append(value)
        self.row = value

    def flush(self):
        return None

    def delete(self, value):
        self.deleted = value
        self.row = None


class _FakeDbManager:
    def __init__(self, session: _FakeSession):
        self._session = session
        self.closed = False

    @contextmanager
    def session_scope(self):
        yield self._session

    def close(self):
        self.closed = True


def _patch_runtime_db(monkeypatch: pytest.MonkeyPatch, session: _FakeSession) -> _FakeDbManager:
    manager = _FakeDbManager(session)
    monkeypatch.setattr("caracal.config.load_config", lambda: {"db": "cfg"})
    monkeypatch.setattr("caracal.db.connection.get_db_manager", lambda _cfg: manager)
    return manager


@pytest.mark.unit
def test_load_enterprise_config_reads_enterprise_runtime_table(monkeypatch: pytest.MonkeyPatch) -> None:
    stored = EnterpriseRuntimeConfig(
        runtime_key="__enterprise_runtime__",
        config_data={"license_key": "ent-token", "valid": True},
    )
    session = _FakeSession(stored)
    manager = _patch_runtime_db(monkeypatch, session)

    result = enterprise_runtime.load_enterprise_config()

    assert result == {"license_key": "ent-token", "valid": True}
    assert session.queried_model is EnterpriseRuntimeConfig
    assert session.filter_kwargs == {"runtime_key": "__enterprise_runtime__"}
    assert manager.closed is True


@pytest.mark.unit
def test_save_enterprise_config_creates_runtime_row_when_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _FakeSession(None)
    manager = _patch_runtime_db(monkeypatch, session)

    enterprise_runtime.save_enterprise_config({"enterprise_api_url": "https://enterprise.example", "valid": True})

    assert len(session.added) == 1
    inserted = session.added[0]
    assert isinstance(inserted, EnterpriseRuntimeConfig)
    assert inserted.runtime_key == "__enterprise_runtime__"
    assert inserted.config_data["enterprise_api_url"] == "https://enterprise.example"
    assert session.queried_model is EnterpriseRuntimeConfig
    assert manager.closed is True


@pytest.mark.unit
def test_save_enterprise_config_updates_existing_runtime_row(monkeypatch: pytest.MonkeyPatch) -> None:
    existing = EnterpriseRuntimeConfig(
        runtime_key="__enterprise_runtime__",
        config_data={"license_key": "old-token", "valid": False},
    )
    session = _FakeSession(existing)
    manager = _patch_runtime_db(monkeypatch, session)

    enterprise_runtime.save_enterprise_config({"license_key": "new-token", "valid": True})

    assert existing.config_data == {"license_key": "new-token", "valid": True}
    assert session.queried_model is EnterpriseRuntimeConfig
    assert manager.closed is True


@pytest.mark.unit
def test_clear_enterprise_config_deletes_runtime_row(monkeypatch: pytest.MonkeyPatch) -> None:
    existing = EnterpriseRuntimeConfig(
        runtime_key="__enterprise_runtime__",
        config_data={"license_key": "ent-token", "valid": True},
    )
    session = _FakeSession(existing)
    manager = _patch_runtime_db(monkeypatch, session)

    enterprise_runtime.clear_enterprise_config()

    assert session.deleted is existing
    assert session.queried_model is EnterpriseRuntimeConfig
    assert manager.closed is True
