"""Unit tests for strict-zero hard-cut forbidden marker scanner behavior."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys


_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCANNER_PATH = _REPO_ROOT / "scripts" / "hardcut_forbidden_marker_scan.py"


def _load_scanner_module():
    module_name = "hardcut_forbidden_marker_scan_testmodule"
    spec = importlib.util.spec_from_file_location(module_name, _SCANNER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load scanner module from {_SCANNER_PATH}")

    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _build_report(module, *, opensource_count: int = 0, enterprise_count: int = 0) -> dict:
    marker_items = []
    for marker in module.MARKER_DEFINITIONS:
        marker_items.append(
            {
                "key": marker.key,
                "description": marker.description,
                "pattern": marker.pattern,
                "owner_phase": marker.owner_phase,
                "repos": {
                    "opensource": {
                        "count": opensource_count,
                        "file_count": 1 if opensource_count else 0,
                        "file_hits": (
                            [{"path": "caracal/sample.py", "count": opensource_count}]
                            if opensource_count
                            else []
                        ),
                    },
                    "enterprise": {
                        "count": enterprise_count,
                        "file_count": 1 if enterprise_count else 0,
                        "file_hits": (
                            [{"path": "services/sample.py", "count": enterprise_count}]
                            if enterprise_count
                            else []
                        ),
                    },
                },
                "total_count": opensource_count + enterprise_count,
            }
        )

    return {
        "schema_version": 2,
        "generated_at_utc": "2026-01-01T00:00:00+00:00",
        "roots": {
            "opensource": str(_REPO_ROOT),
            "enterprise": str(_REPO_ROOT.parent / "caracalEnterprise"),
        },
        "markers": marker_items,
        "totals": {
            "opensource": opensource_count * len(module.MARKER_DEFINITIONS),
            "enterprise": enterprise_count * len(module.MARKER_DEFINITIONS),
            "all": (opensource_count + enterprise_count) * len(module.MARKER_DEFINITIONS),
        },
    }


def test_strict_zero_violations_empty_when_all_counts_are_zero() -> None:
    module = _load_scanner_module()
    report = _build_report(module)

    violations = module._gate_strict_zero_violations(report)

    assert violations == []


def test_strict_zero_violations_include_marker_and_repo_details() -> None:
    module = _load_scanner_module()
    report = _build_report(module, opensource_count=2)

    violations = module._gate_strict_zero_violations(report)

    assert len(violations) == len(module.MARKER_DEFINITIONS)
    first_marker_key = module.MARKER_DEFINITIONS[0].key
    assert any(first_marker_key in item for item in violations)
    assert all("opensource" in item for item in violations)


def test_gate_mode_does_not_require_baseline_file(monkeypatch, tmp_path: Path) -> None:
    module = _load_scanner_module()
    report = _build_report(module)

    monkeypatch.setattr(module, "_discover_roots", lambda: (tmp_path, tmp_path, tmp_path))
    monkeypatch.setattr(module, "_build_report", lambda **_: report)
    monkeypatch.setattr(module, "_print_summary", lambda _report: None)

    exit_code = module.main(
        [
            "--mode",
            "gate",
            "--baseline-file",
            str(tmp_path / "forbidden-marker-baseline.json"),
        ]
    )

    assert exit_code == 0


def test_gate_mode_fails_when_any_marker_count_is_non_zero(
    monkeypatch,
    tmp_path: Path,
    capsys,
) -> None:
    module = _load_scanner_module()
    report = _build_report(module, enterprise_count=1)

    monkeypatch.setattr(module, "_discover_roots", lambda: (tmp_path, tmp_path, tmp_path))
    monkeypatch.setattr(module, "_build_report", lambda **_: report)
    monkeypatch.setattr(module, "_print_summary", lambda _report: None)

    exit_code = module.main(["--mode", "gate"])
    captured = capsys.readouterr()

    assert exit_code == 1
    assert "strict-zero mode" in captured.err


def test_marker_catalog_covers_phase_13_expansion_categories() -> None:
    module = _load_scanner_module()
    marker_keys = {marker.key for marker in module.MARKER_DEFINITIONS}

    assert "legacy_sync_auth_surfaces" in marker_keys
    assert "compatibility_env_aliases" in marker_keys
    assert "enterprise_logic_leakage" in marker_keys
    assert "combined_onboarding_setup_helpers" in marker_keys
    assert "stale_removed_surface_names" in marker_keys
    assert "fallback_gateway_env_aliases" in marker_keys
    assert "split_mode_markers" in marker_keys
    assert "single_lineage_residuals" in marker_keys
    assert "transitional_architecture_markers" in marker_keys
    assert "vault_legacy_infisical_secret_endpoints" in marker_keys


def test_gate_mode_requires_both_repositories_to_be_present(
    monkeypatch,
    tmp_path: Path,
    capsys,
) -> None:
    module = _load_scanner_module()
    report = _build_report(module)
    report["roots"]["enterprise"] = None

    monkeypatch.setattr(module, "_discover_roots", lambda: (tmp_path, tmp_path, None))
    monkeypatch.setattr(module, "_build_report", lambda **_: report)
    monkeypatch.setattr(module, "_print_summary", lambda _report: None)

    exit_code = module.main(["--mode", "gate"])
    captured = capsys.readouterr()

    assert exit_code == 1
    assert "enterprise repository root is unavailable" in captured.err


def test_report_includes_owner_phase_for_each_marker() -> None:
    module = _load_scanner_module()
    report = _build_report(module)

    assert report["schema_version"] == 2
    assert report["markers"]
    owner_phases = {marker["key"]: marker["owner_phase"] for marker in report["markers"]}

    assert all(isinstance(phase, str) and phase for phase in owner_phases.values())
    assert owner_phases["provider_legacy_contract_fields"] == "Phase 7"
    assert owner_phases["provider_legacy_secret_ref_schema_alias"] == "Phase 7"
    assert owner_phases["provider_configmanager_secret_usage"] == "Phase 7"
    assert owner_phases["vault_legacy_infisical_secret_endpoints"] == "Phase 7"


def test_provider_phase7_marker_counts_are_zero() -> None:
    module = _load_scanner_module()
    report = _build_report(module)
    markers = {marker["key"]: marker for marker in report["markers"]}

    for marker_key in (
        "provider_legacy_contract_fields",
        "provider_legacy_secret_ref_schema_alias",
        "provider_configmanager_secret_usage",
        "vault_legacy_infisical_secret_endpoints",
    ):
        marker = markers[marker_key]
        for repo_entry in marker["repos"].values():
            assert repo_entry["count"] == 0
