"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for helper utilities in cli/bootstrap.py and cli/backup.py.
"""

import os
import pytest
from pathlib import Path
from unittest.mock import MagicMock, patch

pytestmark = pytest.mark.unit


class TestBootstrapHelpers:
    def test_runtime_env_path_uses_config_dir(self, monkeypatch, tmp_path):
        from caracal.cli.bootstrap import _runtime_env_path
        monkeypatch.setenv("CCL_CFG_DIR", str(tmp_path))
        monkeypatch.delenv("CCL_HOME", raising=False)
        result = _runtime_env_path()
        assert result == tmp_path / "runtime" / ".env"

    def test_runtime_env_path_uses_home(self, monkeypatch, tmp_path):
        from caracal.cli.bootstrap import _runtime_env_path
        monkeypatch.delenv("CCL_CFG_DIR", raising=False)
        monkeypatch.delenv("CCL_RUNTIME_IN_CONTAINER", raising=False)
        monkeypatch.setenv("CCL_HOME", str(tmp_path))
        result = _runtime_env_path()
        assert result == tmp_path / "runtime" / ".env"

    def test_runtime_env_path_uses_home_directly_in_container(self, monkeypatch, tmp_path):
        from caracal.cli.bootstrap import _runtime_env_path
        monkeypatch.delenv("CCL_CFG_DIR", raising=False)
        monkeypatch.setenv("CCL_RUNTIME_IN_CONTAINER", "1")
        monkeypatch.setenv("CCL_HOME", str(tmp_path))
        result = _runtime_env_path()
        assert result == tmp_path / ".env"

    def test_runtime_env_path_defaults_to_home_dot_caracal(self, monkeypatch):
        from caracal.cli.bootstrap import _runtime_env_path
        monkeypatch.delenv("CCL_CFG_DIR", raising=False)
        monkeypatch.delenv("CCL_HOME", raising=False)
        result = _runtime_env_path()
        assert ".caracal" in str(result)
        assert result.name == ".env"

    def test_write_env_vars_creates_file(self, tmp_path):
        from caracal.cli.bootstrap import _write_env_vars
        env_path = tmp_path / "runtime" / ".env"
        _write_env_vars(env_path, {"FOO": "bar"})
        assert env_path.exists()
        content = env_path.read_text()
        assert "FOO=bar" in content

    def test_write_env_vars_updates_existing_key(self, tmp_path):
        from caracal.cli.bootstrap import _write_env_vars
        env_path = tmp_path / ".env"
        env_path.write_text("FOO=old\nBAR=baz\n")
        _write_env_vars(env_path, {"FOO": "new"})
        content = env_path.read_text()
        assert "FOO=new" in content
        assert "FOO=old" not in content
        assert "BAR=baz" in content

    def test_write_env_vars_appends_new_key(self, tmp_path):
        from caracal.cli.bootstrap import _write_env_vars
        env_path = tmp_path / ".env"
        env_path.write_text("EXISTING=yes\n")
        _write_env_vars(env_path, {"NEWKEY": "newval"})
        content = env_path.read_text()
        assert "NEWKEY=newval" in content
        assert "EXISTING=yes" in content

    def test_read_env_var_reads_key(self, tmp_path):
        from caracal.cli.bootstrap import _read_env_var
        env_path = tmp_path / ".env"
        env_path.write_text("MY_KEY=my_value\n")
        result = _read_env_var(env_path, "MY_KEY")
        assert result == "my_value"

    def test_read_env_var_returns_none_when_missing(self, tmp_path):
        from caracal.cli.bootstrap import _read_env_var
        env_path = tmp_path / ".env"
        env_path.write_text("OTHER=val\n")
        result = _read_env_var(env_path, "MISSING")
        assert result is None

    def test_read_env_var_returns_none_when_file_absent(self, tmp_path):
        from caracal.cli.bootstrap import _read_env_var
        result = _read_env_var(tmp_path / "nonexistent.env", "KEY")
        assert result is None

    def test_mint_api_key_has_prefix(self):
        from caracal.cli.bootstrap import _mint_api_key
        key = _mint_api_key()
        assert key.startswith("cark_")

    def test_mint_api_key_is_unique(self):
        from caracal.cli.bootstrap import _mint_api_key
        keys = {_mint_api_key() for _ in range(10)}
        assert len(keys) == 10


class TestBackupHelpers:
    def test_pg_env_includes_pgpassword_when_set(self):
        from caracal.cli.backup import _pg_env
        config = MagicMock()
        config.database.password = "secret"
        result = _pg_env(config)
        assert result["PGPASSWORD"] == "secret"

    def test_pg_env_no_pgpassword_when_none(self):
        from caracal.cli.backup import _pg_env
        config = MagicMock()
        config.database.password = None
        result = _pg_env(config)
        assert "PGPASSWORD" not in result or result.get("PGPASSWORD") is None

    def test_get_backup_dir_returns_path(self, tmp_path):
        from caracal.cli.backup import get_backup_dir
        config = MagicMock()
        config.storage.backup_dir = str(tmp_path / "backups")
        result = get_backup_dir(config)
        assert isinstance(result, Path)
        assert result.exists()

    def test_get_config_raises_when_no_context(self):
        from caracal.cli.backup import get_config
        from caracal.exceptions import CaracalError
        ctx = MagicMock()
        ctx.find_object.return_value = None
        with pytest.raises(CaracalError):
            get_config(ctx)

    def test_get_config_raises_when_no_config(self):
        from caracal.cli.backup import get_config
        from caracal.exceptions import CaracalError
        ctx = MagicMock()
        cli_ctx = MagicMock()
        cli_ctx.config = None
        ctx.find_object.return_value = cli_ctx
        with pytest.raises(CaracalError):
            get_config(ctx)

    def test_get_config_returns_config(self):
        from caracal.cli.backup import get_config
        ctx = MagicMock()
        cli_ctx = MagicMock()
        cli_ctx.config = {"key": "val"}
        ctx.find_object.return_value = cli_ctx
        result = get_config(ctx)
        assert result == {"key": "val"}

    def test_run_pg_dump_raises_on_nonzero_exit(self, tmp_path):
        from caracal.cli.backup import _run_pg_dump
        from caracal.exceptions import CaracalError
        config = MagicMock()
        config.database.host = "localhost"
        config.database.port = 5432
        config.database.user = "user"
        config.database.database = "db"
        config.database.password = None
        config.database.schema = ""
        output_file = tmp_path / "dump.pgc"
        with patch("subprocess.run") as mock_run:
            mock_run.return_value.returncode = 1
            mock_run.return_value.stderr = "connection refused"
            mock_run.return_value.stdout = ""
            with pytest.raises(CaracalError, match="pg_dump failed"):
                _run_pg_dump(config, output_file)
