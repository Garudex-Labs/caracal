from pathlib import Path

import pytest

from caracal.runtime.host_io import (
    StorageLayoutError,
    host_io_root,
    in_container_runtime,
    path_scope_label,
    resolve_caracal_home,
    resolve_workspace_transfer_path,
)


_RUNTIME_ENV_VARS = (
    "CCL_CFG_DIR",
    "CCL_HOME",
    "CCL_HOST_IO_ROOT",
    "CCL_RUNTIME_IN_CONTAINER",
)


@pytest.fixture(autouse=True)
def clean_runtime_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in _RUNTIME_ENV_VARS:
        monkeypatch.delenv(name, raising=False)


def test_resolve_caracal_home_accepts_ccl_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime_home = tmp_path / "runtime"
    monkeypatch.setenv("CCL_HOME", str(runtime_home))

    assert resolve_caracal_home(require_explicit=True) == runtime_home.resolve(strict=False)


def test_resolve_caracal_home_prefers_canonical_ccl_values(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    canonical_config_dir = tmp_path / "canonical-config"
    canonical_home = tmp_path / "canonical-home"
    monkeypatch.setenv("CCL_CFG_DIR", str(canonical_config_dir))
    monkeypatch.setenv("CCL_HOME", str(canonical_home))

    assert resolve_caracal_home() == canonical_config_dir.resolve(strict=False)


def test_resolve_caracal_home_requires_ccl_home() -> None:
    with pytest.raises(StorageLayoutError, match="CCL_HOME is required"):
        resolve_caracal_home(require_explicit=True)


def test_host_io_root_accepts_ccl_host_io_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    compat_root = tmp_path / "compat-host-io"
    monkeypatch.setenv("CCL_HOST_IO_ROOT", str(compat_root))

    assert host_io_root() == compat_root.resolve(strict=False)


def test_host_io_root_prefers_canonical_ccl_host_io_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    canonical_root = tmp_path / "canonical-host-io"
    monkeypatch.setenv("CCL_HOST_IO_ROOT", str(canonical_root))

    assert host_io_root() == canonical_root.resolve(strict=False)


def test_container_path_resolution_uses_ccl_compose_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    compat_root = tmp_path / "host-io"
    monkeypatch.setenv("CCL_RUNTIME_IN_CONTAINER", "1")
    monkeypatch.setenv("CCL_HOST_IO_ROOT", str(compat_root))

    assert in_container_runtime() is True
    assert path_scope_label(compat_root / "workspace.caracal") == (
        "container path (host-shared mount)"
    )
    assert resolve_workspace_transfer_path("workspace.caracal") == (
        compat_root / "workspace.caracal"
    ).resolve(strict=False)


def test_container_flag_uses_canonical_runtime_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CCL_RUNTIME_IN_CONTAINER", "1")

    assert in_container_runtime() is True
