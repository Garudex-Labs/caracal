"""Static guards for explicit sync and gateway transport behavior."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.mock.source import caracal_path


class _CaracalView:
    def __init__(self, parts: tuple[str, ...] = ()) -> None:
        self._parts = parts

    def __truediv__(self, child) -> "_CaracalView":
        return _CaracalView(self._parts + (str(child),))

    def read_text(self, *args, **kwargs):
        return caracal_path(*self._parts).read_text(*args, **kwargs)

    def exists(self) -> bool:
        from tests.mock.source import caracal_source_roots
        return any(root.joinpath(*self._parts).exists() for root in caracal_source_roots())


class _CaracalRoot:
    def __truediv__(self, child):
        if str(child) == "caracal":
            return _CaracalView()
        raise TypeError(f"unexpected path child: {child!r}")


_CARACAL_ROOT = _CaracalRoot()


def test_enterprise_sync_modules_have_no_candidate_url_fallbacks() -> None:
    runtime_payload = (_CARACAL_ROOT / "caracal" / "deployment" / "enterprise_runtime.py").read_text(encoding="utf-8")
    sync_payload = (_CARACAL_ROOT / "caracal" / "deployment" / "enterprise_sync.py").read_text(encoding="utf-8")
    gateway_payload = (_CARACAL_ROOT / "caracal" / "flow" / "screens" / "gateway_flow.py").read_text(encoding="utf-8")

    assert "_candidate_api_urls" not in runtime_payload
    assert "_candidate_api_urls" not in sync_payload
    assert "_candidate_api_urls" not in gateway_payload


def test_sync_status_and_gateway_flow_have_no_hidden_transport_fallback_state() -> None:
    sync_payload = (_CARACAL_ROOT / "caracal" / "deployment" / "enterprise_sync.py").read_text(encoding="utf-8")
    gateway_payload = (_CARACAL_ROOT / "caracal" / "flow" / "screens" / "gateway_flow.py").read_text(encoding="utf-8")

    assert '"source": "cache"' not in sync_payload
    assert "_persist_resolved_gateway_endpoint" not in gateway_payload


def test_enterprise_sync_transport_is_thin_and_local_collection_lives_outside_package() -> None:
    sync_payload = (_CARACAL_ROOT / "caracal" / "deployment" / "enterprise_sync.py").read_text(encoding="utf-8")
    builder_payload = (_CARACAL_ROOT / "caracal" / "deployment" / "enterprise_sync_payload.py").read_text(encoding="utf-8")

    assert "def sync(" not in sync_payload
    assert "def upload_payload(" in sync_payload
    assert "def _load_local_principals(" not in sync_payload
    assert "def _load_local_policies(" not in sync_payload
    assert "def _load_local_mandates(" not in sync_payload
    assert "def _load_local_ledger(" not in sync_payload
    assert "def _load_local_delegation(" not in sync_payload
    assert "def build_enterprise_sync_payload(" in builder_payload


def test_retired_enterprise_package_clients_are_deleted() -> None:
    assert not (_CARACAL_ROOT / "caracal" / "enterprise" / "license.py").exists()
    assert not (_CARACAL_ROOT / "caracal" / "enterprise" / "sync.py").exists()
