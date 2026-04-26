"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for host orchestrator entrypoint pure utility functions.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from caracal.runtime.entrypoints import (
    _compose_runtime_image_refs,
    _confirm_purge,
    _delete_path,
    _filter_compose_teardown_stream,
    _is_caracal_managed_container,
    _is_caracal_managed_network,
    _is_caracal_managed_volume,
    _parse_string_dict,
    _print_purge_summary,
    NETWORK_IN_USE_MARKER,
)


@pytest.mark.unit
class TestParseStringDict:
    def test_empty_string_returns_empty(self) -> None:
        assert _parse_string_dict("") == {}

    def test_none_returns_empty(self) -> None:
        assert _parse_string_dict(None) == {}

    def test_null_string_returns_empty(self) -> None:
        assert _parse_string_dict("null") == {}

    def test_valid_json_dict(self) -> None:
        data = json.dumps({"key": "value", "another": "entry"})
        result = _parse_string_dict(data)
        assert result == {"key": "value", "another": "entry"}

    def test_non_dict_json_returns_empty(self) -> None:
        assert _parse_string_dict("[1, 2, 3]") == {}

    def test_invalid_json_returns_empty(self) -> None:
        assert _parse_string_dict("{not valid json}") == {}

    def test_filters_non_string_values(self) -> None:
        data = json.dumps({"ok": "yes", "num": 42})
        result = _parse_string_dict(data)
        assert "ok" in result
        assert "num" not in result


@pytest.mark.unit
class TestFilterComposeTeardownStream:
    def test_none_returns_empty(self) -> None:
        out, in_use = _filter_compose_teardown_stream(None)
        assert out == ""
        assert in_use is False

    def test_empty_string(self) -> None:
        out, in_use = _filter_compose_teardown_stream("")
        assert out == ""
        assert in_use is False

    def test_no_network_lines_passthrough(self) -> None:
        text = "Stopping container\nRemoved volume"
        out, in_use = _filter_compose_teardown_stream(text)
        assert "Stopping container" in out
        assert "Removed volume" in out
        assert in_use is False

    def test_network_in_use_line_filtered(self) -> None:
        text = f"Network my-net {NETWORK_IN_USE_MARKER}\nOther line"
        out, in_use = _filter_compose_teardown_stream(text)
        assert "Network" not in out
        assert "Other line" in out
        assert in_use is True

    def test_non_network_resource_in_use_line_kept(self) -> None:
        text = f"Volume caracal-vol {NETWORK_IN_USE_MARKER}\nOther line"
        out, in_use = _filter_compose_teardown_stream(text)
        assert "Volume caracal-vol" in out
        assert in_use is False

    def test_multiple_network_lines_all_filtered(self) -> None:
        text = f"Network net1 {NETWORK_IN_USE_MARKER}\nNetwork net2 {NETWORK_IN_USE_MARKER}\nDone"
        out, in_use = _filter_compose_teardown_stream(text)
        assert "Network" not in out
        assert "Done" in out
        assert in_use is True


@pytest.mark.unit
class TestIsCaRacalManagedContainer:
    def test_container_name_prefix_match(self) -> None:
        with patch(
            "caracal.runtime.entrypoints._inspect_container_labels",
            return_value={},
        ), patch(
            "caracal.runtime.entrypoints._inspect_container_image",
            return_value="",
        ):
            assert _is_caracal_managed_container("caracal-runtime-1") is True

    def test_non_caracal_name_unrecognised(self) -> None:
        with patch(
            "caracal.runtime.entrypoints._inspect_container_labels",
            return_value={},
        ), patch(
            "caracal.runtime.entrypoints._inspect_container_image",
            return_value="",
        ):
            assert _is_caracal_managed_container("nginx-proxy") is False

    def test_compose_project_label_match(self) -> None:
        with patch(
            "caracal.runtime.entrypoints._inspect_container_labels",
            return_value={"com.docker.compose.project": "caracal"},
        ), patch(
            "caracal.runtime.entrypoints._inspect_container_image",
            return_value="",
        ):
            assert _is_caracal_managed_container("some-container") is True

    def test_caracal_image_ref_match(self) -> None:
        with patch(
            "caracal.runtime.entrypoints._inspect_container_labels",
            return_value={},
        ), patch(
            "caracal.runtime.entrypoints._inspect_container_image",
            return_value="ghcr.io/garudexlabs/caracal:latest",
        ):
            assert _is_caracal_managed_container("some-container") is True


@pytest.mark.unit
class TestIsCaRacalManagedVolume:
    def test_volume_name_prefix(self) -> None:
        with patch(
            "caracal.runtime.entrypoints._inspect_volume_labels",
            return_value={},
        ):
            assert _is_caracal_managed_volume("caracal_data") is True

    def test_non_caracal_volume(self) -> None:
        with patch(
            "caracal.runtime.entrypoints._inspect_volume_labels",
            return_value={},
        ):
            assert _is_caracal_managed_volume("postgres_data") is False

    def test_compose_project_label(self) -> None:
        with patch(
            "caracal.runtime.entrypoints._inspect_volume_labels",
            return_value={"com.docker.compose.project": "caracal-stack"},
        ):
            assert _is_caracal_managed_volume("anyvolume") is True


@pytest.mark.unit
class TestIsCaRacalManagedNetwork:
    def test_reserved_bridge_not_managed(self) -> None:
        assert _is_caracal_managed_network("bridge") is False

    def test_reserved_host_not_managed(self) -> None:
        assert _is_caracal_managed_network("host") is False

    def test_reserved_none_not_managed(self) -> None:
        assert _is_caracal_managed_network("none") is False

    def test_caracal_prefix_match(self) -> None:
        with patch(
            "caracal.runtime.entrypoints._inspect_network_labels",
            return_value={},
        ):
            assert _is_caracal_managed_network("caracal-runtime") is True

    def test_compose_project_label_match(self) -> None:
        with patch(
            "caracal.runtime.entrypoints._inspect_network_labels",
            return_value={"com.docker.compose.project": "caracal"},
        ):
            assert _is_caracal_managed_network("mynet") is True

    def test_unrelated_network_not_managed(self) -> None:
        with patch(
            "caracal.runtime.entrypoints._inspect_network_labels",
            return_value={},
        ):
            assert _is_caracal_managed_network("nginx-net") is False


@pytest.mark.unit
class TestComposeRuntimeImageRefs:
    def test_empty_file_returns_empty(self, tmp_path: Path) -> None:
        f = tmp_path / "compose.yml"
        f.write_text("")
        assert _compose_runtime_image_refs(f) == set()

    def test_missing_file_returns_empty(self, tmp_path: Path) -> None:
        f = tmp_path / "nonexistent.yml"
        assert _compose_runtime_image_refs(f) == set()

    def test_caracal_image_ref_extracted(self, tmp_path: Path) -> None:
        compose = tmp_path / "compose.yml"
        compose.write_text("services:\n  app:\n    image: ghcr.io/caracal:latest\n")
        refs = _compose_runtime_image_refs(compose)
        assert "ghcr.io/caracal:latest" in refs

    def test_non_caracal_image_skipped(self, tmp_path: Path) -> None:
        compose = tmp_path / "compose.yml"
        compose.write_text("services:\n  db:\n    image: postgres:16\n")
        refs = _compose_runtime_image_refs(compose)
        assert len(refs) == 0

    def test_env_var_ref_with_default_extracted(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        compose = tmp_path / "compose.yml"
        compose.write_text(
            "services:\n  runtime:\n    image: ${CARACAL_RUNTIME_IMAGE:-ghcr.io/caracal/runtime:latest}\n"
        )
        monkeypatch.delenv("CARACAL_RUNTIME_IMAGE", raising=False)
        refs = _compose_runtime_image_refs(compose)
        assert "ghcr.io/caracal/runtime:latest" in refs

    def test_env_var_override_used(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        compose = tmp_path / "compose.yml"
        compose.write_text(
            "services:\n  runtime:\n    image: ${CARACAL_RUNTIME_IMAGE:-ghcr.io/caracal/runtime:latest}\n"
        )
        monkeypatch.setenv("CARACAL_RUNTIME_IMAGE", "myregistry/caracal:custom")
        refs = _compose_runtime_image_refs(compose)
        assert "myregistry/caracal:custom" in refs


@pytest.mark.unit
class TestDeletePath:
    def test_nonexistent_path_returns_true(self, tmp_path: Path) -> None:
        result = _delete_path(tmp_path / "does_not_exist")
        assert result is True

    def test_deletes_file(self, tmp_path: Path) -> None:
        f = tmp_path / "myfile.txt"
        f.write_text("hello")
        assert _delete_path(f) is True
        assert not f.exists()

    def test_deletes_directory(self, tmp_path: Path) -> None:
        d = tmp_path / "mydir"
        d.mkdir()
        (d / "child.txt").write_text("x")
        assert _delete_path(d) is True
        assert not d.exists()


@pytest.mark.unit
class TestPrintPurgeSummary:
    def test_no_resources_prints_none_message(self, capsys) -> None:
        _print_purge_summary({})
        captured = capsys.readouterr()
        assert "No Caracal" in captured.out

    def test_containers_listed(self, capsys) -> None:
        _print_purge_summary({"containers": ["ct1", "ct2"]})
        captured = capsys.readouterr()
        assert "ct1" in captured.out
        assert "ct2" in captured.out

    def test_paths_listed(self, capsys) -> None:
        _print_purge_summary({"paths": ["/home/user/.caracal"]})
        captured = capsys.readouterr()
        assert "/home/user/.caracal" in captured.out

    def test_empty_category_not_printed(self, capsys) -> None:
        _print_purge_summary({"containers": [], "volumes": ["vol1"]})
        captured = capsys.readouterr()
        assert "containers" not in captured.out
        assert "vol1" in captured.out


@pytest.mark.unit
class TestConfirmPurge:
    def test_force_true_skips_check(self) -> None:
        result = _confirm_purge(force=True)
        assert result is True

    def test_non_tty_without_force_returns_false(self, capsys) -> None:
        result = _confirm_purge(force=False)
        assert result is False
        captured = capsys.readouterr()
        assert "--force" in captured.err
