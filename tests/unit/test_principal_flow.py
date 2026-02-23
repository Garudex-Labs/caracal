"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for PrincipalFlow key lifecycle behaviour:
- Keypair generated automatically on principal registration
- _generate_and_store_keypair writes the PEM file with correct permissions
- _write_audit_log inserts an AuthorityLedgerEvent row
- rotate_key: option 1 revokes all active mandates
- rotate_key: option 2 preserves mandates until expiry
- rotate_key: aborts if the principal has no existing keypair
"""

import os
import stat
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional
from unittest.mock import MagicMock, call, patch, PropertyMock

import pytest


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------

def _make_principal(
    name: str = "test-agent",
    principal_type: str = "agent",
    owner: str = "owner@example.com",
    public_key_pem: Optional[str] = None,
) -> MagicMock:
    """Build a lightweight mock Principal."""
    p = MagicMock()
    p.principal_id = uuid.uuid4()
    p.name = name
    p.principal_type = principal_type
    p.owner = owner
    p.public_key_pem = public_key_pem
    return p


def _make_mandate(revoked: bool = False) -> MagicMock:
    m = MagicMock()
    m.mandate_id = uuid.uuid4()
    m.revoked = revoked
    m.revoked_at = None
    m.revocation_reason = None
    return m


@pytest.fixture()
def flow(tmp_path):
    """Return a PrincipalFlow instance with keystore redirected to tmp_path."""
    from caracal.flow.screens import principal_flow as pf_module

    # Redirect keystore to tmp directory
    original = pf_module._KEYSTORE_DIR
    pf_module._KEYSTORE_DIR = tmp_path / "keystore"
    yield _flow_from_module(pf_module)
    pf_module._KEYSTORE_DIR = original


def _flow_from_module(pf_module):
    """Instantiate PrincipalFlow with a mocked Console and no FlowState."""
    console = MagicMock()
    flow = pf_module.PrincipalFlow(console=console, state=None)
    flow.prompt = MagicMock()
    return flow


# ---------------------------------------------------------------------------
# _generate_and_store_keypair
# ---------------------------------------------------------------------------

class TestGenerateAndStoreKeypair:
    """Tests for PrincipalFlow._generate_and_store_keypair."""

    def test_sets_public_key_pem_on_principal(self, flow, tmp_path):
        """public_key_pem must be populated after the call."""
        principal = _make_principal()
        db_session = MagicMock()

        flow._generate_and_store_keypair(principal, db_session)

        assert principal.public_key_pem is not None
        assert "BEGIN PUBLIC KEY" in principal.public_key_pem

    def test_writes_private_key_file(self, flow, tmp_path):
        """A .key file must be written to the keystore directory."""
        from caracal.flow.screens import principal_flow as pf_module

        principal = _make_principal()
        db_session = MagicMock()

        flow._generate_and_store_keypair(principal, db_session)

        expected = pf_module._KEYSTORE_DIR / f"{principal.principal_id}.key"
        assert expected.exists(), "Private key file was not created"
        content = expected.read_text()
        assert "BEGIN PRIVATE KEY" in content or "BEGIN EC PRIVATE KEY" in content

    def test_private_key_file_has_restricted_permissions(self, flow):
        """Private key file must be chmod 600."""
        from caracal.flow.screens import principal_flow as pf_module

        principal = _make_principal()
        db_session = MagicMock()

        flow._generate_and_store_keypair(principal, db_session)

        key_file = pf_module._KEYSTORE_DIR / f"{principal.principal_id}.key"
        file_stat = key_file.stat()
        # Only owner read/write (0o600)
        assert stat.S_IMODE(file_stat.st_mode) == 0o600

    def test_writes_audit_log_entry(self, flow):
        """An AuthorityLedgerEvent with event_type='key_generated' must be flushed."""
        principal = _make_principal()
        db_session = MagicMock()
        added_entries = []
        db_session.add.side_effect = lambda x: added_entries.append(x)

        with patch(
            "caracal.flow.screens.principal_flow.AuthorityLedgerEvent", autospec=False
        ) as MockALE:
            mock_entry = MagicMock()
            MockALE.return_value = mock_entry
            flow._generate_and_store_keypair(principal, db_session)

        MockALE.assert_called_once()
        call_kwargs = MockALE.call_args.kwargs
        assert call_kwargs["event_type"] == "key_generated"
        assert call_kwargs["principal_id"] == principal.principal_id
        db_session.flush.assert_called()

    def test_returns_key_file_path(self, flow):
        """Return value must be the absolute path to the key file."""
        from caracal.flow.screens import principal_flow as pf_module

        principal = _make_principal()
        db_session = MagicMock()

        result = flow._generate_and_store_keypair(principal, db_session)

        expected = str(pf_module._KEYSTORE_DIR / f"{principal.principal_id}.key")
        assert result == expected


# ---------------------------------------------------------------------------
# _write_audit_log
# ---------------------------------------------------------------------------

class TestWriteAuditLog:
    """Tests for PrincipalFlow._write_audit_log."""

    def test_creates_authority_ledger_event_row(self, flow):
        db_session = MagicMock()
        pid = uuid.uuid4()

        with patch(
            "caracal.flow.screens.principal_flow.AuthorityLedgerEvent", autospec=False
        ) as MockALE:
            mock_entry = MagicMock()
            MockALE.return_value = mock_entry
            flow._write_audit_log(db_session, "key_rotated", pid, "some detail")

        MockALE.assert_called_once()
        kwargs = MockALE.call_args.kwargs
        assert kwargs["event_type"] == "key_rotated"
        assert kwargs["principal_id"] == pid
        db_session.add.assert_called_with(mock_entry)
        db_session.flush.assert_called_once()

    def test_includes_operator_tui_in_metadata(self, flow):
        db_session = MagicMock()
        pid = uuid.uuid4()
        captured = {}

        with patch(
            "caracal.flow.screens.principal_flow.AuthorityLedgerEvent",
            side_effect=lambda **kw: captured.update(kw) or MagicMock(),
        ):
            flow._write_audit_log(db_session, "key_generated", pid, "detail text")

        assert captured["event_metadata"]["operator"] == "tui"
        assert captured["event_metadata"]["details"] == "detail text"

    def test_optional_mandate_id_passed_through(self, flow):
        db_session = MagicMock()
        pid = uuid.uuid4()
        mid = uuid.uuid4()
        captured = {}

        with patch(
            "caracal.flow.screens.principal_flow.AuthorityLedgerEvent",
            side_effect=lambda **kw: captured.update(kw) or MagicMock(),
        ):
            flow._write_audit_log(db_session, "mandate_revoked_by_rotation", pid, "x", mandate_id=mid)

        assert captured["mandate_id"] == mid


# ---------------------------------------------------------------------------
# _revoke_mandates_for_principal
# ---------------------------------------------------------------------------

class TestRevokeMandatesForPrincipal:
    """Tests for PrincipalFlow._revoke_mandates_for_principal."""

    def test_revokes_all_active_mandates(self, flow):
        db_session = MagicMock()
        pid = uuid.uuid4()
        active = [_make_mandate(revoked=False) for _ in range(3)]

        db_session.query.return_value.filter.return_value.all.return_value = active

        with patch("caracal.flow.screens.principal_flow.AuthorityLedgerEvent"):
            count = flow._revoke_mandates_for_principal(pid, db_session, "key_rotation")

        assert count == 3
        for m in active:
            assert m.revoked is True
            assert m.revocation_reason == "key_rotation"
            assert m.revoked_at is not None

    def test_returns_zero_when_no_active_mandates(self, flow):
        db_session = MagicMock()
        db_session.query.return_value.filter.return_value.all.return_value = []

        with patch("caracal.flow.screens.principal_flow.AuthorityLedgerEvent"):
            count = flow._revoke_mandates_for_principal(uuid.uuid4(), db_session, "key_rotation")

        assert count == 0

    def test_writes_audit_entry_per_revoked_mandate(self, flow):
        db_session = MagicMock()
        pid = uuid.uuid4()
        active = [_make_mandate(revoked=False) for _ in range(2)]
        db_session.query.return_value.filter.return_value.all.return_value = active

        added = []
        with patch(
            "caracal.flow.screens.principal_flow.AuthorityLedgerEvent",
            side_effect=lambda **kw: added.append(kw) or MagicMock(),
        ):
            flow._revoke_mandates_for_principal(pid, db_session, "key_rotation")

        rotation_events = [e for e in added if e.get("event_type") == "mandate_revoked_by_rotation"]
        assert len(rotation_events) == 2


# ---------------------------------------------------------------------------
# rotate_key – option 2 (leave until expiry)
# ---------------------------------------------------------------------------

class TestRotateKeyLeaveUntilExpiry:
    """rotate_key with mandate disposition = 2 (leave until expiry)."""

    def _run_rotate_leave(self, flow, principal, active_mandate_count: int = 2):
        """Wire up all the mocks needed to exercise rotate_key with option 2."""
        db_manager = MagicMock()
        db_session = MagicMock()
        db_manager.session_scope.return_value.__enter__ = lambda s: db_session
        db_manager.session_scope.return_value.__exit__ = MagicMock(return_value=False)

        # principal query
        db_session.query.return_value.all.return_value = [principal]
        db_session.query.return_value.filter_by.return_value.first.return_value = principal
        # mandate count query
        db_session.query.return_value.filter.return_value.count.return_value = active_mandate_count

        flow.prompt.uuid.return_value = str(principal.principal_id)
        flow.prompt.confirm.return_value = True   # confirm rotation
        flow.prompt.text.return_value = "2"       # leave until expiry

        with (
            patch("caracal.flow.screens.principal_flow.get_db_manager", return_value=db_manager),
            patch.object(flow, "_generate_and_store_keypair", return_value="/tmp/new.key"),
            patch.object(flow, "_write_audit_log") as mock_audit,
            patch("caracal.flow.screens.principal_flow.AuthorityLedgerEvent"),
        ):
            flow.rotate_key()
            return mock_audit

    def test_does_not_revoke_any_mandates(self, flow):
        principal = _make_principal(public_key_pem="---BEGIN PUBLIC KEY---")

        with patch.object(flow, "_revoke_mandates_for_principal") as mock_revoke:
            self._run_rotate_leave(flow, principal)
            mock_revoke.assert_not_called()

    def test_writes_mandates_preserved_audit_entry(self, flow):
        principal = _make_principal(public_key_pem="---BEGIN PUBLIC KEY---")
        mock_audit = self._run_rotate_leave(flow, principal, active_mandate_count=3)

        types = [
            c.kwargs.get("event_type") if len(c.args) <= 1 else c.args[1]
            for c in mock_audit.call_args_list
        ]
        assert "key_rotated_mandates_preserved" in types

    def test_writes_key_rotated_audit_entry(self, flow):
        principal = _make_principal(public_key_pem="---BEGIN PUBLIC KEY---")
        mock_audit = self._run_rotate_leave(flow, principal)

        types = [
            c.kwargs.get("event_type") if len(c.args) <= 1 else c.args[1]
            for c in mock_audit.call_args_list
        ]
        assert "key_rotated" in types


# ---------------------------------------------------------------------------
# rotate_key – option 1 (revoke all)
# ---------------------------------------------------------------------------

class TestRotateKeyRevokeAll:
    """rotate_key with mandate disposition = 1 (revoke all immediately)."""

    def _run_rotate_revoke(self, flow, principal, active_mandate_count: int = 3):
        db_manager = MagicMock()
        db_session = MagicMock()
        db_manager.session_scope.return_value.__enter__ = lambda s: db_session
        db_manager.session_scope.return_value.__exit__ = MagicMock(return_value=False)

        db_session.query.return_value.all.return_value = [principal]
        db_session.query.return_value.filter_by.return_value.first.return_value = principal
        db_session.query.return_value.filter.return_value.count.return_value = active_mandate_count

        flow.prompt.uuid.return_value = str(principal.principal_id)
        # First confirm = rotation confirmation; second = revoke confirmation
        flow.prompt.confirm.side_effect = [True, True]
        flow.prompt.text.return_value = "1"       # revoke all

        with (
            patch("caracal.flow.screens.principal_flow.get_db_manager", return_value=db_manager),
            patch.object(flow, "_generate_and_store_keypair", return_value="/tmp/new.key"),
            patch.object(flow, "_write_audit_log"),
            patch.object(flow, "_revoke_mandates_for_principal", return_value=active_mandate_count) as mock_revoke,
            patch("caracal.flow.screens.principal_flow.AuthorityLedgerEvent"),
        ):
            flow.rotate_key()
            return mock_revoke

    def test_calls_revoke_mandates(self, flow):
        principal = _make_principal(public_key_pem="---BEGIN PUBLIC KEY---")
        mock_revoke = self._run_rotate_revoke(flow, principal, active_mandate_count=3)
        mock_revoke.assert_called_once()
        _, kwargs = mock_revoke.call_args
        assert kwargs.get("reason") == "key_rotation" or mock_revoke.call_args.kwargs.get("reason") == "key_rotation" or "key_rotation" in str(mock_revoke.call_args)

    def test_skips_revoke_when_no_active_mandates(self, flow):
        principal = _make_principal(public_key_pem="---BEGIN PUBLIC KEY---")

        db_manager = MagicMock()
        db_session = MagicMock()
        db_manager.session_scope.return_value.__enter__ = lambda s: db_session
        db_manager.session_scope.return_value.__exit__ = MagicMock(return_value=False)
        db_session.query.return_value.all.return_value = [principal]
        db_session.query.return_value.filter_by.return_value.first.return_value = principal
        db_session.query.return_value.filter.return_value.count.return_value = 0  # no mandates

        flow.prompt.uuid.return_value = str(principal.principal_id)
        flow.prompt.confirm.return_value = True
        flow.prompt.text.return_value = "1"

        with (
            patch("caracal.flow.screens.principal_flow.get_db_manager", return_value=db_manager),
            patch.object(flow, "_generate_and_store_keypair", return_value="/tmp/new.key"),
            patch.object(flow, "_write_audit_log"),
            patch.object(flow, "_revoke_mandates_for_principal") as mock_revoke,
            patch("caracal.flow.screens.principal_flow.AuthorityLedgerEvent"),
        ):
            flow.rotate_key()
            mock_revoke.assert_not_called()


# ---------------------------------------------------------------------------
# rotate_key – guard: no existing keypair
# ---------------------------------------------------------------------------

class TestRotateKeyGuards:
    """Edge-case guards in rotate_key."""

    def test_aborts_when_principal_has_no_public_key(self, flow):
        """rotate_key must exit early (with an error message) if public_key_pem is None."""
        principal = _make_principal(public_key_pem=None)

        db_manager = MagicMock()
        db_session = MagicMock()
        db_manager.session_scope.return_value.__enter__ = lambda s: db_session
        db_manager.session_scope.return_value.__exit__ = MagicMock(return_value=False)
        db_session.query.return_value.all.return_value = [principal]
        db_session.query.return_value.filter_by.return_value.first.return_value = principal

        flow.prompt.uuid.return_value = str(principal.principal_id)

        with (
            patch("caracal.flow.screens.principal_flow.get_db_manager", return_value=db_manager),
            patch.object(flow, "_generate_and_store_keypair") as mock_gen,
        ):
            flow.rotate_key()
            mock_gen.assert_not_called()

    def test_aborts_on_operator_cancel(self, flow):
        """rotate_key must exit early if the operator declines the confirmation."""
        principal = _make_principal(public_key_pem="---BEGIN PUBLIC KEY---")

        db_manager = MagicMock()
        db_session = MagicMock()
        db_manager.session_scope.return_value.__enter__ = lambda s: db_session
        db_manager.session_scope.return_value.__exit__ = MagicMock(return_value=False)
        db_session.query.return_value.all.return_value = [principal]
        db_session.query.return_value.filter_by.return_value.first.return_value = principal

        flow.prompt.uuid.return_value = str(principal.principal_id)
        flow.prompt.confirm.return_value = False  # operator says no

        with (
            patch("caracal.flow.screens.principal_flow.get_db_manager", return_value=db_manager),
            patch.object(flow, "_generate_and_store_keypair") as mock_gen,
        ):
            flow.rotate_key()
            mock_gen.assert_not_called()
