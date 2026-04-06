"""Unit tests for explicit enterprise sync payload construction."""

from __future__ import annotations

import pytest

from caracal.deployment import enterprise_sync_payload as payload_module


@pytest.mark.unit
def test_build_enterprise_sync_payload_collects_explicit_local_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(payload_module, "_load_local_principals", lambda: [{"principal_id": "p-1"}])
    monkeypatch.setattr(payload_module, "_load_local_policies", lambda: [{"policy_id": "pol-1"}])
    monkeypatch.setattr(payload_module, "_load_local_mandates", lambda: [{"mandate_id": "m-1"}])
    monkeypatch.setattr(payload_module, "_load_local_ledger", lambda: [{"event_id": 1}])
    monkeypatch.setattr(payload_module, "_load_local_delegation", lambda: [{"edge_id": "e-1"}])
    monkeypatch.setattr(
        payload_module,
        "_build_client_metadata",
        lambda: {"source": "caracal-cli", "hostname": "host-1", "platform": "linux"},
    )

    payload = payload_module.build_enterprise_sync_payload(client_instance_id="client-1")

    assert payload == {
        "client_instance_id": "client-1",
        "client_metadata": {
            "source": "caracal-cli",
            "hostname": "host-1",
            "platform": "linux",
        },
        "principals": [{"principal_id": "p-1"}],
        "policies": [{"policy_id": "pol-1"}],
        "mandates": [{"mandate_id": "m-1"}],
        "ledger_entries": [{"event_id": 1}],
        "delegation_edges": [{"edge_id": "e-1"}],
    }


@pytest.mark.unit
def test_build_enterprise_sync_payload_preserves_explicit_client_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(payload_module, "_load_local_principals", lambda: [])
    monkeypatch.setattr(payload_module, "_load_local_policies", lambda: [])
    monkeypatch.setattr(payload_module, "_load_local_mandates", lambda: [])
    monkeypatch.setattr(payload_module, "_load_local_ledger", lambda: [])
    monkeypatch.setattr(payload_module, "_load_local_delegation", lambda: [])

    payload = payload_module.build_enterprise_sync_payload(
        client_instance_id="client-2",
        client_metadata={"source": "manual", "hostname": "host-2"},
    )

    assert payload["client_metadata"] == {"source": "manual", "hostname": "host-2"}
