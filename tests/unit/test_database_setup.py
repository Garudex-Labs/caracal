"""
Comprehensive tests for database setup logic in Caracal.

Tests the complete database setup flow including:
- PostgreSQL vs SQLite choice (no silent fallback)
- Environment variable validation and prompting
- PostgreSQL auto-start logic
- Connection testing and error diagnostics
- Clear failure messages on every error path
- Post-onboarding database initialization (no SQLite fallback for PG)

These tests verify the core contract:
  - If user chooses PostgreSQL: NEVER fall back to SQLite silently
  - If user chooses SQLite: use file-based storage
  - Missing env vars: prompt user with clear instructions
  - Connection failures: show actionable diagnostics
"""

import os
import re
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch, PropertyMock, call

import pytest

# Import the functions under test
from caracal.flow.screens.onboarding import (
    _find_env_file,
    _get_db_config_from_env,
    _save_db_config_to_env,
    _test_db_connection,
    _validate_env_config,
    _start_postgresql,
    _step_database,
    _setup_sqlite,
    _show_connection_error_details,
)
from caracal.flow.theme import Colors, Icons


# =============================================================================
# Fixtures
# =============================================================================

@pytest.fixture
def env_file(tmp_path):
    """Create a temporary .env file with database configuration."""
    env_content = """
DB_HOST=localhost
DB_PORT=5432
DB_NAME=caracal
DB_USER=caracal
DB_PASSWORD=Test@Caracal12345
"""
    env_path = tmp_path / ".env"
    env_path.write_text(env_content)
    return env_path


@pytest.fixture
def env_file_missing_password(tmp_path):
    """Create a .env file with missing password."""
    env_content = """
DB_HOST=localhost
DB_PORT=5432
DB_NAME=caracal
DB_USER=caracal
"""
    env_path = tmp_path / ".env"
    env_path.write_text(env_content)
    return env_path


@pytest.fixture
def env_file_empty(tmp_path):
    """Create an empty .env file."""
    env_path = tmp_path / ".env"
    env_path.write_text("")
    return env_path


@pytest.fixture
def mock_console():
    """Create a mock Rich console."""
    console = MagicMock()
    return console


@pytest.fixture
def mock_wizard():
    """Create a mock Wizard object with console and context."""
    wizard = MagicMock()
    wizard.console = MagicMock()
    wizard.context = {}
    return wizard


@pytest.fixture
def mock_prompt():
    """Create a mock FlowPrompt."""
    return MagicMock()


# =============================================================================
# Test _find_env_file
# =============================================================================

class TestFindEnvFile:
    """Tests for .env file discovery across multiple locations."""
    
    def test_finds_env_in_cwd(self, tmp_path):
        """Finds .env in current working directory first."""
        env_path = tmp_path / ".env"
        env_path.write_text("DB_NAME=test\n")
        
        with patch("caracal.flow.screens.onboarding.Path") as mock_path_cls:
            mock_cwd_env = MagicMock()
            mock_cwd_env.exists.return_value = True
            # CWD / ".env" exists
            mock_cwd = MagicMock()
            mock_cwd.__truediv__ = MagicMock(return_value=env_path)
            mock_path_cls.cwd.return_value = mock_cwd
            # Prevent __file__ path from being used
            mock_file_path = MagicMock()
            mock_file_path.resolve.return_value = mock_file_path
            mock_file_path.parent = mock_file_path
            mock_path_cls.return_value = mock_file_path
            
            result = _find_env_file()
            assert result == env_path
    
    def test_returns_none_when_no_env_anywhere(self, tmp_path):
        """Returns None when no .env file can be found."""
        empty_dir = tmp_path / "empty"
        empty_dir.mkdir()
        
        with patch("caracal.flow.screens.onboarding.Path") as mock_path_cls:
            # CWD has no .env
            mock_cwd = MagicMock()
            mock_cwd_env = MagicMock()
            mock_cwd_env.exists.return_value = False
            mock_cwd.__truediv__ = MagicMock(return_value=mock_cwd_env)
            mock_path_cls.cwd.return_value = mock_cwd
            
            # __file__ path has no .env
            mock_file = MagicMock()
            mock_file.resolve.return_value = mock_file
            mock_file.parent = mock_file
            mock_file_env = MagicMock()
            mock_file_env.exists.return_value = False
            mock_file.__truediv__ = MagicMock(return_value=mock_file_env)
            mock_path_cls.return_value = mock_file
            
            # Parent directories have no .env
            mock_cwd.parent = mock_cwd  # Same dir = stop iteration
            
            result = _find_env_file()
            assert result is None


# =============================================================================
# Test _get_db_config_from_env
# =============================================================================

class TestGetDbConfigFromEnv:
    """Tests for loading database config from .env file."""
    
    def test_loads_complete_config(self, env_file):
        """All DB_* vars are correctly parsed from .env."""
        with patch("caracal.flow.screens.onboarding._find_env_file", return_value=env_file):
            config = _get_db_config_from_env()
            
            assert config["host"] == "localhost"
            assert config["port"] == 5432
            assert config["database"] == "caracal"
            assert config["username"] == "caracal"
            assert config["password"] == "Test@Caracal12345"
    
    def test_defaults_when_no_env_file(self):
        """Returns sensible defaults when .env file doesn't exist."""
        with patch("caracal.flow.screens.onboarding._find_env_file", return_value=None):
            config = _get_db_config_from_env()
            
            assert config["host"] == "localhost"
            assert config["port"] == 5432
            assert config["database"] == "caracal"
            assert config["username"] == "caracal"
            assert config["password"] == ""
    
    def test_missing_password_returns_empty(self, env_file_missing_password):
        """Missing DB_PASSWORD returns empty string (not None)."""
        with patch("caracal.flow.screens.onboarding._find_env_file", return_value=env_file_missing_password):
            config = _get_db_config_from_env()
            
            assert config["password"] == ""
    
    def test_invalid_port_keeps_default(self, tmp_path):
        """Non-numeric DB_PORT keeps default 5432."""
        env_path = tmp_path / ".env"
        env_path.write_text("DB_PORT=not_a_number\n")
        
        with patch("caracal.flow.screens.onboarding._find_env_file", return_value=env_path):
            config = _get_db_config_from_env()
            
            assert config["port"] == 5432
    
    def test_exception_returns_defaults(self):
        """Any exception during parsing returns defaults gracefully."""
        mock_path = MagicMock()
        mock_path.exists.side_effect = PermissionError("access denied")
        
        with patch("caracal.flow.screens.onboarding._find_env_file", return_value=mock_path):
            config = _get_db_config_from_env()
            
            assert config["host"] == "localhost"
            assert config["port"] == 5432
            assert config["password"] == ""
    
    def test_tracks_env_path(self, env_file):
        """Config includes _env_path when .env is found."""
        with patch("caracal.flow.screens.onboarding._find_env_file", return_value=env_file):
            config = _get_db_config_from_env()
            
            assert "_env_path" in config
            assert config["_env_path"] == str(env_file)
    
    def test_no_env_path_when_not_found(self):
        """Config has no _env_path when .env is not found."""
        with patch("caracal.flow.screens.onboarding._find_env_file", return_value=None):
            config = _get_db_config_from_env()
            
            assert "_env_path" not in config


# =============================================================================
# Test _validate_env_config
# =============================================================================

class TestValidateEnvConfig:
    """Tests for PostgreSQL environment variable validation."""
    
    def test_valid_config_returns_empty_list(self):
        """Fully valid config has no issues."""
        config = {
            "host": "localhost",
            "port": 5432,
            "database": "caracal",
            "username": "caracal",
            "password": "secret123",
        }
        issues = _validate_env_config(config)
        assert issues == []
    
    def test_missing_password_is_flagged(self):
        """Missing/empty password is reported."""
        config = {
            "host": "localhost",
            "port": 5432,
            "database": "caracal",
            "username": "caracal",
            "password": "",
        }
        issues = _validate_env_config(config)
        assert any("DB_PASSWORD" in i for i in issues)
    
    def test_missing_database_is_flagged(self):
        """Missing/empty database name is reported."""
        config = {
            "host": "localhost",
            "port": 5432,
            "database": "",
            "username": "caracal",
            "password": "secret",
        }
        issues = _validate_env_config(config)
        assert any("DB_NAME" in i for i in issues)
    
    def test_missing_username_is_flagged(self):
        """Missing/empty username is reported."""
        config = {
            "host": "localhost",
            "port": 5432,
            "database": "caracal",
            "username": "",
            "password": "secret",
        }
        issues = _validate_env_config(config)
        assert any("DB_USER" in i for i in issues)
    
    def test_invalid_port_is_flagged(self):
        """Invalid port numbers are reported."""
        config = {
            "host": "localhost",
            "port": 0,
            "database": "caracal",
            "username": "caracal",
            "password": "secret",
        }
        issues = _validate_env_config(config)
        assert any("DB_PORT" in i for i in issues)
    
    def test_port_too_high_is_flagged(self):
        """Port > 65535 is reported."""
        config = {
            "host": "localhost",
            "port": 70000,
            "database": "caracal",
            "username": "caracal",
            "password": "secret",
        }
        issues = _validate_env_config(config)
        assert any("DB_PORT" in i for i in issues)
    
    def test_non_integer_port_is_flagged(self):
        """Non-integer port is reported."""
        config = {
            "host": "localhost",
            "port": "abc",
            "database": "caracal",
            "username": "caracal",
            "password": "secret",
        }
        issues = _validate_env_config(config)
        assert any("DB_PORT" in i for i in issues)
    
    def test_missing_host_not_flagged(self):
        """Empty host is NOT flagged — localhost is a valid default."""
        config = {
            "host": "",
            "port": 5432,
            "database": "caracal",
            "username": "caracal",
            "password": "secret",
        }
        issues = _validate_env_config(config)
        assert not any("DB_HOST" in i for i in issues)
    
    def test_multiple_issues_all_reported(self):
        """All issues are reported at once, not just the first."""
        config = {
            "host": "",
            "port": -1,
            "database": "",
            "username": "",
            "password": "",
        }
        issues = _validate_env_config(config)
        assert len(issues) >= 3  # port, database, username, password


# =============================================================================
# Test _save_db_config_to_env
# =============================================================================

class TestSaveDbConfigToEnv:
    """Tests for saving database config to .env file."""
    
    def test_saves_all_fields(self, tmp_path):
        """All DB fields are written to .env."""
        env_path = tmp_path / ".env"
        env_path.write_text("# existing content\n")
        
        config = {
            "host": "192.168.1.10",
            "port": 5433,
            "database": "mydb",
            "username": "admin",
            "password": "s3cret!",
        }
        
        with patch("caracal.flow.screens.onboarding._find_env_file", return_value=env_path):
            result = _save_db_config_to_env(config)
        
        assert result is True
        content = env_path.read_text()
        assert "DB_HOST=192.168.1.10" in content
        assert "DB_PORT=5433" in content
        assert "DB_NAME=mydb" in content
        assert "DB_USER=admin" in content
        assert "DB_PASSWORD=s3cret!" in content
    
    def test_updates_existing_values(self, env_file):
        """Existing DB_* values are updated in-place."""
        config = {
            "host": "newhost",
            "port": 5433,
            "database": "newdb",
            "username": "newuser",
            "password": "newpass",
        }
        
        with patch("caracal.flow.screens.onboarding._find_env_file", return_value=env_file):
            result = _save_db_config_to_env(config)
        
        assert result is True
        content = env_file.read_text()
        assert "DB_HOST=newhost" in content
        assert "DB_NAME=newdb" in content


# =============================================================================
# Test _test_db_connection
# =============================================================================

class TestTestDbConnection:
    """Tests for PostgreSQL connection testing."""
    
    @patch("caracal.flow.screens.onboarding.psycopg2", create=True)
    def test_successful_connection(self, mock_psycopg2):
        """Returns (True, '') on successful connection."""
        import importlib
        with patch.dict("sys.modules", {"psycopg2": mock_psycopg2}):
            mock_conn = MagicMock()
            mock_psycopg2.connect.return_value = mock_conn
            
            success, error = _test_db_connection({
                "host": "localhost",
                "port": 5432,
                "database": "caracal",
                "username": "caracal",
                "password": "secret",
            })
            
            assert success is True
            assert error == ""
            mock_conn.close.assert_called_once()
    
    def test_connection_refused_shows_error(self):
        """Connection refused returns (False, error_string)."""
        config = {
            "host": "localhost",
            "port": 59999,  # unlikely to have anything here
            "database": "nonexistent",
            "username": "nope",
            "password": "nope",
        }
        success, error = _test_db_connection(config)
        
        assert success is False
        assert len(error) > 0
    
    def test_missing_psycopg2_returns_error(self):
        """If psycopg2 is not installed, returns clear error."""
        with patch.dict("sys.modules", {"psycopg2": None}):
            config = {
                "host": "localhost",
                "port": 5432,
                "database": "test",
                "username": "test",
                "password": "test",
            }
            success, error = _test_db_connection(config)
            
            assert success is False
            assert len(error) > 0


# =============================================================================
# Test _show_connection_error_details
# =============================================================================

class TestShowConnectionErrorDetails:
    """Tests for actionable error diagnostics."""
    
    def test_auth_failure_shows_password_hint(self, mock_console):
        """Authentication errors mention DB_PASSWORD."""
        _show_connection_error_details(
            mock_console,
            "password authentication failed for user 'caracal'",
            {"host": "localhost", "port": 5432, "database": "caracal", "username": "caracal"},
        )
        output = " ".join(str(c) for c in mock_console.print.call_args_list)
        assert "Authentication" in output or "authentication" in output
    
    def test_connection_refused_shows_start_hint(self, mock_console):
        """Connection refused errors mention starting PostgreSQL."""
        _show_connection_error_details(
            mock_console,
            "could not connect to server: Connection refused",
            {"host": "localhost", "port": 5432, "database": "caracal", "username": "caracal"},
        )
        output = " ".join(str(c) for c in mock_console.print.call_args_list)
        assert "not running" in output or "Connection" in output
    
    def test_database_not_exist_shows_create_hint(self, mock_console):
        """Missing database errors mention createdb."""
        _show_connection_error_details(
            mock_console,
            'database "mydb" does not exist',
            {"host": "localhost", "port": 5432, "database": "mydb", "username": "caracal"},
        )
        output = " ".join(str(c) for c in mock_console.print.call_args_list)
        assert "does not exist" in output or "createdb" in output
    
    def test_role_not_exist_shows_createuser_hint(self, mock_console):
        """Missing role errors mention createuser."""
        _show_connection_error_details(
            mock_console,
            'role "baduser" does not exist',
            {"host": "localhost", "port": 5432, "database": "caracal", "username": "baduser"},
        )
        output = " ".join(str(c) for c in mock_console.print.call_args_list)
        assert "does not exist" in output
    
    def test_timeout_shows_network_hint(self, mock_console):
        """Timeout errors mention network/firewall."""
        _show_connection_error_details(
            mock_console,
            "connection timed out",
            {"host": "remote-host", "port": 5432, "database": "caracal", "username": "caracal"},
        )
        output = " ".join(str(c) for c in mock_console.print.call_args_list)
        assert "timeout" in output.lower() or "timed out" in output.lower()
    
    def test_unknown_error_shows_generic_hint(self, mock_console):
        """Unknown errors still produce useful output."""
        _show_connection_error_details(
            mock_console,
            "something completely unexpected happened",
            {"host": "localhost", "port": 5432, "database": "caracal", "username": "caracal"},
        )
        output = " ".join(str(c) for c in mock_console.print.call_args_list)
        assert "Unexpected" in output or "error" in output.lower()


# =============================================================================
# Test _start_postgresql  
# =============================================================================

class TestStartPostgresql:
    """Tests for PostgreSQL auto-start logic."""
    
    @patch("subprocess.run")
    @patch("shutil.which")
    def test_docker_compose_start_success(self, mock_which, mock_run, mock_console):
        """Docker compose start succeeds when container becomes ready."""
        mock_which.return_value = "/usr/bin/docker"
        
        # docker compose up succeeds
        mock_run.side_effect = [
            MagicMock(returncode=0, stderr=""),  # docker compose up
            MagicMock(returncode=0),  # pg_isready check
        ]
        
        # Create docker-compose.yml in cwd
        compose_path = Path.cwd() / "docker-compose.yml"
        compose_exists = compose_path.exists()
        
        with patch.object(Path, "exists", return_value=True):
            with patch("time.sleep"):
                success, msg = _start_postgresql(mock_console, method="docker")
        
        assert success is True
        assert "docker compose" in msg.lower()
    
    @patch("subprocess.run")
    @patch("shutil.which")
    def test_docker_compose_start_failure(self, mock_which, mock_run, mock_console):
        """Docker compose start fails gracefully."""
        mock_which.return_value = "/usr/bin/docker"
        
        mock_run.return_value = MagicMock(returncode=1, stderr="image not found")
        
        with patch.object(Path, "exists", return_value=True):
            success, msg = _start_postgresql(mock_console, method="docker")
        
        assert success is False
    
    @patch("subprocess.run")
    @patch("shutil.which")
    def test_systemctl_start_success(self, mock_which, mock_run, mock_console):
        """systemctl start succeeds."""
        mock_which.return_value = "/usr/bin/systemctl"
        mock_run.return_value = MagicMock(returncode=0)
        
        with patch("time.sleep"):
            success, msg = _start_postgresql(mock_console, method="systemctl")
        
        assert success is True
        assert "systemctl" in msg.lower()
    
    @patch("subprocess.run")
    @patch("shutil.which")
    def test_systemctl_start_failure(self, mock_which, mock_run, mock_console):
        """systemctl start fails gracefully."""
        mock_which.return_value = "/usr/bin/systemctl"
        mock_run.return_value = MagicMock(returncode=1, stderr="permission denied")
        
        success, msg = _start_postgresql(mock_console, method="systemctl")
        
        assert success is False
    
    @patch("shutil.which")
    def test_no_methods_available(self, mock_which, mock_console):
        """Returns failure if no start method is available."""
        mock_which.return_value = None
        
        with patch.object(Path, "exists", return_value=False):
            success, msg = _start_postgresql(mock_console, method="auto")
        
        assert success is False
        assert "No method available" in msg


# =============================================================================
# Test _step_database — The Core Database Setup Flow
# =============================================================================

class TestStepDatabase:
    """Tests for the main database setup wizard step."""
    
    @patch("caracal.flow.screens.onboarding.FlowPrompt")
    @patch("caracal.flow.screens.onboarding._get_db_config_from_env")
    @patch("caracal.flow.screens.onboarding._test_db_connection")
    def test_postgres_yes_connection_succeeds(self, mock_test_conn, mock_env, mock_prompt_cls, mock_wizard):
        """User says Y to PostgreSQL, connection succeeds → PostgreSQL used."""
        mock_prompt = MagicMock()
        mock_prompt_cls.return_value = mock_prompt
        
        # User says YES to PostgreSQL
        mock_prompt.confirm.return_value = True
        
        # Env config is valid
        mock_env.return_value = {
            "host": "localhost",
            "port": 5432,
            "database": "caracal",
            "username": "caracal",
            "password": "secret",
        }
        
        # Connection succeeds
        mock_test_conn.return_value = (True, "")
        
        result = _step_database(mock_wizard)
        
        assert result["type"] == "postgresql"
        assert mock_wizard.context["database"]["type"] == "postgresql"
    
    @patch("caracal.flow.screens.onboarding.FlowPrompt")
    @patch("caracal.flow.screens.onboarding._setup_sqlite")
    def test_postgres_no_uses_sqlite(self, mock_setup_sqlite, mock_prompt_cls, mock_wizard):
        """User says N to PostgreSQL → SQLite used."""
        mock_prompt = MagicMock()
        mock_prompt_cls.return_value = mock_prompt
        
        # User says NO to PostgreSQL
        mock_prompt.confirm.return_value = False
        
        mock_setup_sqlite.return_value = "file"
        
        result = _step_database(mock_wizard)
        
        mock_setup_sqlite.assert_called_once()
    
    @patch("caracal.flow.screens.onboarding.FlowPrompt")
    @patch("caracal.flow.screens.onboarding._get_db_config_from_env")
    @patch("caracal.flow.screens.onboarding._validate_env_config")
    def test_postgres_yes_missing_env_prompts_user(self, mock_validate, mock_env, mock_prompt_cls, mock_wizard):
        """User says Y but env vars are missing → prompts to fix."""
        mock_prompt = MagicMock()
        mock_prompt_cls.return_value = mock_prompt
        
        # User says YES to PostgreSQL
        mock_prompt.confirm.return_value = True
        
        # First env read has issues
        mock_env.return_value = {
            "host": "localhost",
            "port": 5432,
            "database": "caracal",
            "username": "caracal",
            "password": "",
        }
        
        # Validation shows issues first, then passes after user input
        mock_validate.side_effect = [
            ["DB_PASSWORD is missing or empty — required for PostgreSQL"],
            [],  # Valid after user enters credentials
        ]
        
        # User chooses to enter credentials
        mock_prompt.select.side_effect = [
            "Enter credentials now (saves to .env)",
        ]
        mock_prompt.text.side_effect = ["localhost", "caracal", "caracal", "newsecret"]
        mock_prompt.number.return_value = 5432
        
        # Save to env works
        with patch("caracal.flow.screens.onboarding._save_db_config_to_env", return_value=True):
            with patch("caracal.flow.screens.onboarding._test_db_connection", return_value=(True, "")):
                result = _step_database(mock_wizard)
        
        assert result["type"] == "postgresql"
    
    @patch("caracal.flow.screens.onboarding.FlowPrompt")
    @patch("caracal.flow.screens.onboarding._get_db_config_from_env")
    @patch("caracal.flow.screens.onboarding._test_db_connection")
    @patch("caracal.flow.screens.onboarding._start_postgresql")
    def test_postgres_yes_conn_fails_autostart_fixes(
        self, mock_start, mock_test_conn, mock_env, mock_prompt_cls, mock_wizard
    ):
        """PostgreSQL fails → auto-start fixes it → success."""
        mock_prompt = MagicMock()
        mock_prompt_cls.return_value = mock_prompt
        mock_prompt.confirm.return_value = True
        
        mock_env.return_value = {
            "host": "localhost",
            "port": 5432,
            "database": "caracal",
            "username": "caracal",
            "password": "secret",
        }
        
        # First connection fails (connection refused), second succeeds (after auto-start)
        mock_test_conn.side_effect = [
            (False, "could not connect to server: Connection refused"),
            (True, ""),
        ]
        
        # Auto-start succeeds
        mock_start.return_value = (True, "PostgreSQL started via docker compose")
        
        result = _step_database(mock_wizard)
        
        assert result["type"] == "postgresql"
        mock_start.assert_called_once()
    
    @patch("caracal.flow.screens.onboarding.FlowPrompt")
    @patch("caracal.flow.screens.onboarding._get_db_config_from_env")
    @patch("caracal.flow.screens.onboarding._test_db_connection")
    @patch("caracal.flow.screens.onboarding._start_postgresql")
    def test_postgres_never_falls_back_to_sqlite(
        self, mock_start, mock_test_conn, mock_env, mock_prompt_cls, mock_wizard
    ):
        """PostgreSQL chosen but keeps failing → loops, NEVER falls back to SQLite.
        
        This is the CRITICAL test: the old behavior was to silently fall back
        to SQLite after max_attempts. The new behavior loops indefinitely
        until the user fixes the issue or Ctrl+C.
        
        We simulate: fail → retry → fail → user enters creds → success
        """
        mock_prompt = MagicMock()
        mock_prompt_cls.return_value = mock_prompt
        mock_prompt.confirm.return_value = True
        
        mock_env.return_value = {
            "host": "localhost",
            "port": 5432,
            "database": "caracal",
            "username": "caracal",
            "password": "secret",
        }
        
        # Connection fails 3 times (auth error, not connection issue), then succeeds
        mock_test_conn.side_effect = [
            (False, "password authentication failed for user 'caracal'"),
            (False, "password authentication failed for user 'caracal'"),
            (True, ""),  # Success after entering new creds
        ]
        
        # Auto-start is NOT triggered (auth error, not connection error)
        mock_start.return_value = (False, "not needed")
        
        # User flow: retry once, then enter different credentials
        mock_prompt.select.side_effect = [
            "Retry connection (after fixing the issue)",  # First loop iteration
            "Enter different credentials",  # Second loop iteration
        ]
        
        # When entering new credentials
        mock_prompt.text.side_effect = ["localhost", "caracal", "caracal", "correct_password"]
        mock_prompt.number.return_value = 5432
        
        with patch("caracal.flow.screens.onboarding._save_db_config_to_env", return_value=True):
            result = _step_database(mock_wizard)
        
        assert result["type"] == "postgresql"
        # Verify SQLite was NEVER set
        assert mock_wizard.context.get("database", {}).get("type") != "file"
        assert mock_wizard.context.get("database") != "file"


# =============================================================================
# Test _setup_sqlite
# =============================================================================

class TestSetupSqlite:
    """Tests for SQLite setup."""
    
    def test_sqlite_configures_correctly(self, mock_wizard, tmp_path):
        """SQLite setup creates correct context entries."""
        mock_ws = MagicMock()
        mock_ws.db_path = tmp_path / "caracal.db"
        mock_ws.db_path.parent.mkdir(parents=True, exist_ok=True)
        
        with patch("caracal.flow.workspace.get_workspace", return_value=mock_ws):
            result = _setup_sqlite(mock_wizard, mock_wizard.console)
        
        assert result == "file"
        assert mock_wizard.context["database"] == "file"
        assert mock_wizard.context["database_file_path"] == str(tmp_path / "caracal.db")


# =============================================================================
# Test Post-Onboarding Database Initialization (No SQLite Fallback for PG)
# =============================================================================

class TestPostOnboardingDbInit:
    """Tests that post-onboarding code respects the no-fallback contract."""
    
    def test_postgresql_init_failure_raises_not_fallback(self):
        """When PostgreSQL is selected and init fails, it MUST raise, not fallback to SQLite."""
        from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
        
        # Create a PostgreSQL config that will fail
        db_config = DatabaseConfig(
            type='postgresql',
            host='localhost',
            port=59999,  # wrong port
            database='nonexistent',
            user='nope',
            password='nope',
        )
        
        # The DatabaseConnectionManager should raise RuntimeError, not fall back
        manager = DatabaseConnectionManager(db_config)
        
        with pytest.raises((RuntimeError, Exception)):
            manager.initialize()
    
    def test_sqlite_init_succeeds(self, tmp_path):
        """SQLite initialization always works with a valid path."""
        from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
        
        db_path = str(tmp_path / "test.db")
        db_config = DatabaseConfig(
            type='sqlite',
            file_path=db_path,
        )
        
        manager = DatabaseConnectionManager(db_config)
        manager.initialize()
        
        assert manager.health_check() is True
        manager.close()
    
    def test_sqlite_memory_init_succeeds(self):
        """SQLite :memory: database initializes correctly."""
        from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
        
        db_config = DatabaseConfig(
            type='sqlite',
            file_path=':memory:',
        )
        
        manager = DatabaseConnectionManager(db_config)
        manager.initialize()
        
        assert manager.health_check() is True
        manager.close()


# =============================================================================
# Test DatabaseConfig
# =============================================================================

class TestDatabaseConfig:
    """Tests for DatabaseConfig connection URL generation."""
    
    def test_postgres_url(self):
        """PostgreSQL URL is correctly formatted."""
        from caracal.db.connection import DatabaseConfig
        
        config = DatabaseConfig(
            type="postgres",
            host="myhost",
            port=5433,
            database="mydb",
            user="admin",
            password="p@ss!",
        )
        url = config.get_connection_url()
        
        assert url.startswith("postgresql://")
        assert "admin" in url
        assert "myhost" in url
        assert "5433" in url
        assert "mydb" in url
    
    def test_sqlite_url(self):
        """SQLite URL is correctly formatted."""
        from caracal.db.connection import DatabaseConfig
        
        config = DatabaseConfig(
            type="sqlite",
            file_path="/tmp/test.db",
        )
        url = config.get_connection_url()
        
        assert url == "sqlite:////tmp/test.db"
    
    def test_postgres_url_escapes_special_chars(self):
        """Special characters in password are URL-encoded."""
        from caracal.db.connection import DatabaseConfig
        
        config = DatabaseConfig(
            type="postgres",
            host="localhost",
            port=5432,
            database="db",
            user="user",
            password="p@ss w0rd!",
        )
        url = config.get_connection_url()
        
        # @ and space should be encoded
        assert "p%40ss" in url or "p@ss" not in url.split("@")[0]


# =============================================================================
# Test DatabaseConnectionManager
# =============================================================================

class TestDatabaseConnectionManager:
    """Tests for DatabaseConnectionManager lifecycle."""
    
    def test_double_initialize_warns(self, tmp_path):
        """Calling initialize() twice logs a warning but doesn't crash."""
        from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
        
        config = DatabaseConfig(type="sqlite", file_path=str(tmp_path / "test.db"))
        manager = DatabaseConnectionManager(config)
        
        manager.initialize()
        manager.initialize()  # Should warn, not crash
        
        assert manager.health_check() is True
        manager.close()
    
    def test_get_session_before_init_raises(self):
        """get_session() before initialize() raises RuntimeError."""
        from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
        
        config = DatabaseConfig(type="sqlite", file_path=":memory:")
        manager = DatabaseConnectionManager(config)
        
        with pytest.raises(RuntimeError, match="not initialized"):
            manager.get_session()
    
    def test_close_cleans_up(self, tmp_path):
        """close() disposes engine and resets state."""
        from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
        
        config = DatabaseConfig(type="sqlite", file_path=str(tmp_path / "test.db"))
        manager = DatabaseConnectionManager(config)
        manager.initialize()
        manager.close()
        
        assert manager._engine is None
        assert manager._session_factory is None
        assert manager._initialized is False
    
    def test_health_check_before_init_returns_false(self):
        """health_check() before initialize() returns False."""
        from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
        
        config = DatabaseConfig(type="sqlite", file_path=":memory:")
        manager = DatabaseConnectionManager(config)
        
        assert manager.health_check() is False
    
    def test_session_scope_commits_on_success(self, tmp_path):
        """session_scope() commits transaction on success."""
        from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
        
        config = DatabaseConfig(type="sqlite", file_path=str(tmp_path / "test.db"))
        manager = DatabaseConnectionManager(config)
        manager.initialize()
        
        with manager.session_scope() as session:
            from sqlalchemy import text
            session.execute(text("SELECT 1"))
        
        manager.close()
    
    def test_session_scope_rolls_back_on_error(self, tmp_path):
        """session_scope() rolls back transaction on exception."""
        from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
        
        config = DatabaseConfig(type="sqlite", file_path=str(tmp_path / "test.db"))
        manager = DatabaseConnectionManager(config)
        manager.initialize()
        
        with pytest.raises(ValueError):
            with manager.session_scope() as session:
                raise ValueError("test error")
        
        manager.close()
    
    def test_pool_status_before_init(self):
        """get_pool_status() before init returns zeros."""
        from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
        
        config = DatabaseConfig(type="sqlite", file_path=":memory:")
        manager = DatabaseConnectionManager(config)
        
        status = manager.get_pool_status()
        assert status["size"] == 0
        assert status["total"] == 0
    
    def test_clear_database(self, tmp_path):
        """clear_database() drops and recreates all tables."""
        from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
        
        config = DatabaseConfig(type="sqlite", file_path=str(tmp_path / "test.db"))
        manager = DatabaseConnectionManager(config)
        manager.initialize()
        
        # This should not raise
        manager.clear_database()
        
        # Health check still passes after clear
        assert manager.health_check() is True
        manager.close()


# =============================================================================
# Test Global Connection Manager Functions
# =============================================================================

class TestGlobalConnectionManager:
    """Tests for module-level connection manager functions."""
    
    def test_get_connection_manager_before_init_raises(self):
        """get_connection_manager() raises if not initialized."""
        from caracal.db.connection import get_connection_manager, close_connection_manager
        
        # Ensure clean state
        close_connection_manager()
        
        with pytest.raises(RuntimeError, match="not initialized"):
            get_connection_manager()
    
    def test_initialize_and_get(self, tmp_path):
        """initialize_connection_manager() then get_connection_manager() works."""
        from caracal.db.connection import (
            DatabaseConfig,
            initialize_connection_manager,
            get_connection_manager,
            close_connection_manager,
        )
        
        config = DatabaseConfig(type="sqlite", file_path=str(tmp_path / "test.db"))
        
        try:
            initialize_connection_manager(config)
            manager = get_connection_manager()
            assert manager.health_check() is True
        finally:
            close_connection_manager()
    
    def test_reinitialize_closes_old(self, tmp_path):
        """Re-calling initialize_connection_manager() closes the old one."""
        from caracal.db.connection import (
            DatabaseConfig,
            initialize_connection_manager,
            close_connection_manager,
        )
        
        config1 = DatabaseConfig(type="sqlite", file_path=str(tmp_path / "test1.db"))
        config2 = DatabaseConfig(type="sqlite", file_path=str(tmp_path / "test2.db"))
        
        try:
            manager1 = initialize_connection_manager(config1)
            manager2 = initialize_connection_manager(config2)
            
            # Old manager should be closed
            assert manager1._engine is None
            assert manager2.health_check() is True
        finally:
            close_connection_manager()


# =============================================================================
# Test Env Config Integration
# =============================================================================

class TestEnvConfigIntegration:
    """Integration tests for database config from .env → connection."""
    
    def test_full_sqlite_path(self, tmp_path):
        """SQLite with full path works end-to-end."""
        from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
        
        db_path = str(tmp_path / "integration_test.db")
        config = DatabaseConfig(type="sqlite", file_path=db_path)
        
        manager = DatabaseConnectionManager(config)
        manager.initialize()
        
        assert manager.health_check() is True
        assert Path(db_path).exists()
        
        manager.close()
    
    def test_postgres_config_from_settings(self):
        """DatabaseConfig from settings module has correct defaults."""
        from caracal.config.settings import DatabaseConfig as SettingsDbConfig
        
        config = SettingsDbConfig()
        url = config.get_connection_url()
        
        assert url.startswith("postgresql://")
        assert "localhost" in url
        assert "5432" in url
        assert "caracal" in url
