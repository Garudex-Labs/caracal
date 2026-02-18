"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal Flow Onboarding Screen.

First-run setup wizard with:
- Step 1: Configuration path selection
- Step 2: Database setup (optional)
- Step 3: First principal registration
- Step 4: First authority policy creation
- Step 5: Issue first mandate
- Step 6: Validate mandate demo
- Skip options with actionable to-dos
"""

from pathlib import Path
from typing import Any, Optional

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from caracal.flow.components.prompt import FlowPrompt
from caracal.flow.components.wizard import Wizard, WizardStep
from caracal.flow.state import FlowState, StatePersistence, RecentAction
from caracal.flow.theme import Colors, Icons


def _find_env_file() -> Optional[Path]:
    """Find the .env file by searching multiple locations.
    
    Search order:
    1. Current working directory
    2. Project root (walk up from this file to find pyproject.toml/setup.py)
    3. Parent directories of CWD (up to 5 levels)
    
    Returns:
        Path to .env file, or None if not found.
    """
    # 1. Current working directory
    cwd_env = Path.cwd() / ".env"
    if cwd_env.exists():
        return cwd_env
    
    # 2. Project root — walk up from this source file
    try:
        source_dir = Path(__file__).resolve().parent
        for _ in range(10):  # max 10 levels up
            candidate = source_dir / ".env"
            if candidate.exists():
                return candidate
            # Check if this looks like a project root
            if (source_dir / "pyproject.toml").exists() or (source_dir / "setup.py").exists():
                # We're at project root but no .env — stop looking upward
                break
            parent = source_dir.parent
            if parent == source_dir:  # filesystem root
                break
            source_dir = parent
    except Exception:
        pass
    
    # 3. Walk up from CWD (handles running from subdirectories)
    try:
        current = Path.cwd()
        for _ in range(5):
            parent = current.parent
            if parent == current:
                break
            current = parent
            candidate = current / ".env"
            if candidate.exists():
                return candidate
    except Exception:
        pass
    
    return None


def _get_db_config_from_env() -> dict:
    """Load database configuration from .env file.
    
    Searches for .env in CWD, project root, and parent directories.
    Returns defaults for any values not found.
    """
    config = {
        "host": "localhost",
        "port": 5432,
        "database": "caracal",
        "username": "caracal",
        "password": "",
    }
    try:
        env_path = _find_env_file()
        if env_path and env_path.exists():
            import re
            content = env_path.read_text()
            mapping = {
                "host": r"^DB_HOST=(.*)$",
                "port": r"^DB_PORT=(.*)$",
                "database": r"^DB_NAME=(.*)$",
                "username": r"^DB_USER=(.*)$",
                "password": r"^DB_PASSWORD=(.*)$",
            }
            for key, pattern in mapping.items():
                match = re.search(pattern, content, re.MULTILINE)
                if match:
                    val = match.group(1).strip()
                    if key == "port":
                        try:
                            config[key] = int(val)
                        except ValueError:
                            pass
                    else:
                        config[key] = val
            config["_env_path"] = str(env_path)  # Track where we loaded from
    except Exception:
        pass
    return config


def _save_db_config_to_env(config: dict) -> bool:
    """Save database configuration back to .env file."""
    try:
        env_path = _find_env_file()
        if env_path is None:
            # No existing .env found — create one in CWD
            env_path = Path.cwd() / ".env"
        if env_path.exists():
            import re
            content = env_path.read_text()
            mapping = {
                "DB_HOST": config.get("host", "localhost"),
                "DB_PORT": str(config.get("port", 5432)),
                "DB_NAME": config.get("database", "caracal"),
                "DB_USER": config.get("username", "caracal"),
                "DB_PASSWORD": config.get("password", ""),
            }
            for key, val in mapping.items():
                if re.search(f"^{key}=", content, re.MULTILINE):
                    content = re.sub(f"^{key}=.*$", f"{key}={val}", content, flags=re.MULTILINE)
                else:
                    content += f"\n{key}={val}"
            env_path.write_text(content)
            return True
        else:
            # Create a new .env file with database config
            lines = [
                "# Caracal Core - Environment Variables",
                "# Database Configuration",
                f"DB_HOST={config.get('host', 'localhost')}",
                f"DB_PORT={config.get('port', 5432)}",
                f"DB_NAME={config.get('database', 'caracal')}",
                f"DB_USER={config.get('username', 'caracal')}",
                f"DB_PASSWORD={config.get('password', '')}",
                "",
            ]
            env_path.write_text("\n".join(lines))
            return True
    except Exception:
        pass
    return False


def _test_db_connection(config: dict) -> tuple[bool, str]:
    """Test PostgreSQL connection with given config."""
    try:
        import psycopg2
        conn = psycopg2.connect(
            host=config.get("host", "localhost"),
            port=int(config.get("port", 5432)),
            database=config.get("database", "caracal"),
            user=config.get("username", "caracal"),
            password=config.get("password", ""),
            connect_timeout=5
        )
        conn.close()
        return True, ""
    except Exception as e:
        return False, str(e)


def _step_workspace(wizard: Wizard) -> Any:
    """Step 0: Workspace selection/creation/deletion.
    
    CRITICAL: This step cannot be skipped. A workspace must be selected
    or created before proceeding to the main menu, as it defines where
    all configuration and data will be stored.
    
    Returns:
        str: Path to the selected/created workspace
        
    Raises:
        RuntimeError: If no workspace is selected (should never happen)
        KeyboardInterrupt: If user cancels (propagates to caller)
    """
    console = wizard.console
    prompt = FlowPrompt(console)
    
    from caracal.flow.workspace import WorkspaceManager, set_workspace
    
    console.print(f"  [{Colors.NEUTRAL}]Caracal can manage multiple workspaces (organizations).")
    console.print(f"  [{Colors.DIM}]Each workspace has its own configuration, data, and agents.[/]")
    console.print()
    
    # List existing workspaces
    workspaces = WorkspaceManager.list_workspaces()
    
    if workspaces:
        console.print(f"  [{Colors.INFO}]{Icons.INFO} Existing workspaces:[/]")
        console.print()
        
        from rich.table import Table
        table = Table(show_header=True, header_style=f"bold {Colors.PRIMARY}", border_style=Colors.DIM)
        table.add_column("#", style=Colors.NEUTRAL, width=4)
        table.add_column("Name", style=Colors.INFO)
        table.add_column("Path", style=Colors.DIM)
        
        for idx, ws in enumerate(workspaces, 1):
            table.add_row(str(idx), ws["name"], ws["path"])
        
        console.print(table)
        console.print()
    
    # Present options
    choices = []
    if workspaces:
        choices.append("Select existing workspace")
    choices.extend([
        "Create new workspace",
    ])
    if workspaces:
        choices.append("Delete workspace")
    
    action = prompt.select(
        "What would you like to do?",
        choices=choices,
    )
    
    # Handle workspace selection
    if action == "Select existing workspace":
        workspace_names = [ws["name"] for ws in workspaces]
        selected_name = prompt.select(
            "Select workspace",
            choices=workspace_names,
        )
        
        selected_ws = next(ws for ws in workspaces if ws["name"] == selected_name)
        workspace_path = Path(selected_ws["path"])
        
        console.print()
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Selected workspace: {selected_name}[/]")
        console.print(f"  [{Colors.DIM}]Path: {workspace_path}[/]")
        
        # Set the selected workspace as active
        set_workspace(workspace_path)
        wizard.context["workspace_path"] = str(workspace_path)
        wizard.context["workspace_name"] = selected_name
        wizard.context["workspace_existing"] = True
        
        # Check if this workspace was already fully onboarded
        # by reading its flow_state.json — if so, mark it so
        # subsequent steps auto-skip instead of re-prompting.
        state_file = workspace_path / "flow_state.json"
        if state_file.exists():
            try:
                import json as _json
                state_data = _json.loads(state_file.read_text())
                ob = state_data.get("onboarding", {})
                if ob.get("completed", False):
                    wizard.context["previously_onboarded"] = True
                    wizard.context["completed_steps"] = ob.get("steps_completed", [])
            except Exception:
                pass
        
        return str(workspace_path)
    
    elif action == "Create new workspace":
        console.print()
        workspace_name = prompt.text(
            "Workspace name",
            default="my-workspace",
        )
        
        # Generate path from name
        default_base = Path.home() / ".caracal"
        workspace_path = default_base / workspace_name.lower().replace(" ", "-")
        
        custom_path = prompt.confirm(
            f"Use default path ({workspace_path})?",
            default=True,
        )
        
        if not custom_path:
            path_str = prompt.text(
                "Enter workspace directory path",
                default=str(workspace_path),
            )
            workspace_path = Path(path_str).expanduser()
        
        console.print()
        console.print(f"  [{Colors.INFO}]{Icons.INFO} Creating workspace: {workspace_name}[/]")
        console.print(f"  [{Colors.DIM}]Path: {workspace_path}[/]")
        
        # Create directory
        workspace_path.mkdir(parents=True, exist_ok=True)
        
        # Register workspace
        WorkspaceManager.register_workspace(workspace_name, workspace_path)
        
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Workspace created and registered[/]")
        
        # Set the new workspace as active
        set_workspace(workspace_path)
        wizard.context["workspace_path"] = str(workspace_path)
        wizard.context["workspace_name"] = workspace_name
        wizard.context["workspace_existing"] = False
        wizard.context["fresh_start"] = True
        
        return str(workspace_path)
    
    elif action == "Delete workspace":
        workspace_names = [ws["name"] for ws in workspaces]
        selected_name = prompt.select(
            "Select workspace to delete",
            choices=workspace_names,
        )
        
        selected_ws = next(ws for ws in workspaces if ws["name"] == selected_name)
        workspace_path = Path(selected_ws["path"])
        
        console.print()
        console.print(f"  [{Colors.WARNING}]⚠️  WARNING: This will delete workspace '{selected_name}'[/]")
        console.print(f"  [{Colors.DIM}]Path: {workspace_path}[/]")
        console.print()
        
        delete_files = prompt.confirm(
            "Also delete workspace directory from disk?",
            default=False,
        )
        
        confirm = prompt.confirm(
            f"Are you sure you want to delete '{selected_name}'?",
            default=False,
        )
        
        if confirm:
            WorkspaceManager.delete_workspace(
                workspace_path,
                delete_directory=delete_files,
            )
            console.print()
            console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Workspace deleted[/]")
            console.print()
            
            # Restart workspace selection
            return _step_workspace(wizard)
        else:
            console.print()
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Deletion cancelled[/]")
            console.print()
            # Restart workspace selection
            return _step_workspace(wizard)
    
    # This should never be reached, but handle it gracefully
    console.print()
    console.print(f"  [{Colors.ERROR}]{Icons.ERROR} No workspace action selected[/]")
    raise RuntimeError("Workspace selection is required to continue")


def _step_config(wizard: Wizard) -> Any:
    """Step 1: Configuration setup."""
    console = wizard.console
    prompt = FlowPrompt(console)
    
    from caracal.flow.workspace import get_workspace
    
    # If workspace was selected/created in previous step, use that
    workspace_path = wizard.context.get("workspace_path")
    if workspace_path:
        config_path = Path(workspace_path)
    else:
        config_path = get_workspace().root
    
    # If workspace was just created, initialize fresh config
    if wizard.context.get("workspace_existing") is False:
        console.print(f"  [{Colors.INFO}]{Icons.INFO} Initializing new workspace configuration...[/]")
        
        try:
            _initialize_caracal_dir(config_path, wipe=True)
            console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Configuration initialized at {config_path}[/]")
        except Exception as e:
            console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Failed: {e}[/]")
            raise
        
        wizard.context["config_path"] = str(config_path)
        return str(config_path)
    
    # ── Existing workspace: preserve existing configuration silently ──
    if wizard.context.get("workspace_existing") and config_path.exists() and (config_path / "config.yaml").exists():
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Using existing configuration at {config_path}[/]")
        wizard.context["config_path"] = str(config_path)
        return str(config_path)
    
    # ── No config found for existing workspace — initialize ──
    console.print(f"  [{Colors.NEUTRAL}]Caracal stores its configuration and data files in a directory.")
    console.print(f"  [{Colors.DIM}]Location: {config_path}[/]")
    console.print()
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Initializing configuration...[/]")
    
    try:
        _initialize_caracal_dir(config_path, wipe=False)
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Configuration initialized at {config_path}[/]")
        wizard.context["config_path"] = str(config_path)
        return str(config_path)
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Failed to initialize: {e}[/]")
        raise


def _initialize_caracal_dir(path: Path, wipe: bool = False) -> None:
    """Initialize Caracal directory structure."""
    if wipe and path.exists():
        import shutil
        # Wipe data files but keep the directory
        for item in path.iterdir():
            if item.is_file():
                item.unlink()
            elif item.is_dir() and item.name != "backups":
                shutil.rmtree(item)

    # Create directories
    path.mkdir(parents=True, exist_ok=True)
    (path / "backups").mkdir(exist_ok=True)
    
    # Create default config if needed
    config_path = path / "config.yaml"
    if not config_path.exists():
        default_config = f"""# Caracal Core Configuration

storage:
  agent_registry: {path}/agents.json
  policy_store: {path}/policies.json
  ledger: {path}/ledger.jsonl
  backup_dir: {path}/backups
  backup_count: 3

defaults:
  time_window: daily

logging:
  level: INFO
  file: {path}/caracal.log
"""
        config_path.write_text(default_config)
    
    # Create empty data files if needed
    agents_path = path / "agents.json"
    if not agents_path.exists():
        agents_path.write_text("[]")
    
    policies_path = path / "policies.json"
    if not policies_path.exists():
        policies_path.write_text("[]")
    
    ledger_path = path / "ledger.jsonl"
    if not ledger_path.exists():
        ledger_path.write_text("")
    
    # Note: SQLite no longer supported — PostgreSQL only.
    # Legacy .db files are left in place (harmless) for manual cleanup.


def _validate_env_config(config: dict) -> list[str]:
    """Validate that all required PostgreSQL env vars are properly set.
    
    Required: DB_NAME, DB_USER, DB_PASSWORD, DB_PORT (valid range).
    Optional: DB_HOST (defaults to 'localhost' which is fine).
    
    Returns a list of missing/invalid fields. Empty list means all valid.
    """
    issues = []
    # host is optional — defaults to localhost which is valid for local setups
    if not config.get("database"):
        issues.append("DB_NAME is missing or empty")
    if not config.get("username"):
        issues.append("DB_USER is missing or empty")
    if not config.get("password"):
        issues.append("DB_PASSWORD is missing or empty — required for PostgreSQL")
    port = config.get("port")
    if not isinstance(port, int) or port < 1 or port > 65535:
        issues.append(f"DB_PORT has invalid value: {port}")
    return issues


def _start_postgresql(console: Console, method: str = "auto") -> tuple[bool, str]:
    """Attempt to start PostgreSQL automatically.
    
    Tries multiple methods in order:
    1. docker compose up -d postgres  (if docker-compose.yml exists)
    2. systemctl start postgresql     (if systemd is available)
    3. pg_ctl start                   (direct pg_ctl)
    
    Args:
        console: Rich console for output
        method: "auto" tries all, or "docker", "systemctl", "pg_ctl"
    
    Returns:
        (success: bool, message: str)
    """
    import subprocess
    import shutil
    import time
    
    methods_to_try = []
    
    if method == "auto":
        # Check which methods are available
        compose_file = Path.cwd() / "docker-compose.yml"
        if compose_file.exists() and shutil.which("docker"):
            methods_to_try.append("docker")
        if shutil.which("systemctl"):
            methods_to_try.append("systemctl")
        if shutil.which("pg_ctl"):
            methods_to_try.append("pg_ctl")
    else:
        methods_to_try = [method]
    
    if not methods_to_try:
        return False, "No method available to start PostgreSQL (no docker, systemctl, or pg_ctl found)"
    
    for m in methods_to_try:
        if m == "docker":
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Starting PostgreSQL via docker compose...[/]")
            try:
                result = subprocess.run(
                    ["docker", "compose", "up", "-d", "postgres"],
                    capture_output=True, text=True, timeout=60,
                )
                if result.returncode == 0:
                    # Wait for PostgreSQL to become ready
                    console.print(f"  [{Colors.INFO}]{Icons.INFO} Waiting for PostgreSQL to become ready...[/]")
                    for i in range(15):  # wait up to 15 seconds
                        time.sleep(1)
                        check = subprocess.run(
                            ["docker", "compose", "exec", "-T", "postgres",
                             "pg_isready", "-U", "caracal"],
                            capture_output=True, text=True, timeout=5,
                        )
                        if check.returncode == 0:
                            return True, "PostgreSQL started via docker compose"
                    return False, f"Docker container started but PostgreSQL not ready after 15s. Logs:\n{result.stderr}"
                else:
                    console.print(f"  [{Colors.DIM}]docker compose failed: {result.stderr.strip()}[/]")
            except subprocess.TimeoutExpired:
                console.print(f"  [{Colors.DIM}]docker compose timed out[/]")
            except FileNotFoundError:
                pass
        
        elif m == "systemctl":
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Starting PostgreSQL via systemctl...[/]")
            try:
                result = subprocess.run(
                    ["sudo", "systemctl", "start", "postgresql"],
                    capture_output=True, text=True, timeout=30,
                )
                if result.returncode == 0:
                    time.sleep(2)
                    return True, "PostgreSQL started via systemctl"
                else:
                    console.print(f"  [{Colors.DIM}]systemctl failed: {result.stderr.strip()}[/]")
            except (subprocess.TimeoutExpired, FileNotFoundError):
                pass
        
        elif m == "pg_ctl":
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Starting PostgreSQL via pg_ctl...[/]")
            try:
                result = subprocess.run(
                    ["pg_ctl", "start", "-D", "/var/lib/postgresql/data", "-l", "/tmp/pg.log"],
                    capture_output=True, text=True, timeout=30,
                )
                if result.returncode == 0:
                    time.sleep(2)
                    return True, "PostgreSQL started via pg_ctl"
                else:
                    console.print(f"  [{Colors.DIM}]pg_ctl failed: {result.stderr.strip()}[/]")
            except (subprocess.TimeoutExpired, FileNotFoundError):
                pass
    
    return False, "All start methods failed. Please start PostgreSQL manually."


def _load_existing_db_config(wizard: Wizard, console: Console) -> Any:
    """Try to load database config from an existing workspace's config.yaml.
    
    Returns the database context dict if found, or None if no DB config exists
    (so the caller should fall through to the normal setup flow).
    """
    workspace_path = wizard.context.get("workspace_path")
    if not workspace_path:
        return None
    
    config_file = Path(workspace_path) / "config.yaml"
    if not config_file.exists():
        return None
    
    try:
        import yaml
        with open(config_file, "r") as f:
            config_yaml = yaml.safe_load(f) or {}
        
        db_section = config_yaml.get("database")
        if not db_section:
            return None
        
        env_config = {
            "host": db_section.get("host", "localhost"),
            "port": int(db_section.get("port", 5432)),
            "database": db_section.get("database", "caracal"),
            "username": db_section.get("user", "caracal"),
            "password": db_section.get("password", ""),
        }
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Using existing PostgreSQL configuration[/]")
        console.print(f"  [{Colors.DIM}]  Host:     {env_config['host']}:{env_config['port']}[/]")
        console.print(f"  [{Colors.DIM}]  Database: {env_config['database']}[/]")
        console.print(f"  [{Colors.DIM}]  User:     {env_config['username']}[/]")
        wizard.context["database"] = {**env_config, "type": "postgresql"}
        wizard.context["database_auto_configured"] = True
        return wizard.context["database"]
    except Exception:
        return None


def _step_database(wizard: Wizard) -> Any:
    """Step 2: Database setup — PostgreSQL only.
    
    Logic:
    - If existing workspace with database already configured, use it silently.
    - Validate env vars from .env; prompt user to fix if missing
    - Auto-start PostgreSQL if not running
    - Test connection; on failure show clear errors
    - Loop until PostgreSQL works — no fallback
    
    Database is mandatory. This step cannot be skipped.
    """
    console = wizard.console
    prompt = FlowPrompt(console)
    
    # ── Existing workspace: preserve existing database silently ──
    if wizard.context.get("workspace_existing"):
        db_result = _load_existing_db_config(wizard, console)
        if db_result is not None:
            return db_result
    
    console.print()
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Configuring PostgreSQL database...[/]")
    console.print()
    console.print(f"  [{Colors.NEUTRAL}]Caracal uses PostgreSQL as its database backend.[/]")
    console.print(f"  [{Colors.DIM}]Each workspace gets its own isolated PostgreSQL schema.[/]")
    console.print()
    
    # ── PostgreSQL path — must succeed, no fallback ──
    
    while True:
        # 1. Load and validate env config
        env_config = _get_db_config_from_env()
        env_path_used = env_config.pop("_env_path", None)
        env_issues = _validate_env_config(env_config)
        
        if env_path_used:
            console.print(f"  [{Colors.DIM}]Loaded .env from: {env_path_used}[/]")
        else:
            console.print(f"  [{Colors.WARNING}]⚠️  No .env file found in current directory or project root[/]")
        console.print()
        
        if env_issues:
            console.print(f"  [{Colors.ERROR}]{Icons.ERROR} PostgreSQL environment configuration incomplete:[/]")
            for issue in env_issues:
                console.print(f"    [{Colors.WARNING}]• {issue}[/]")
            console.print()
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Please set these variables in your .env file:[/]")
            console.print(f"  [{Colors.DIM}]  DB_HOST=localhost[/]")
            console.print(f"  [{Colors.DIM}]  DB_PORT=5432[/]")
            console.print(f"  [{Colors.DIM}]  DB_NAME=caracal[/]")
            console.print(f"  [{Colors.DIM}]  DB_USER=caracal[/]")
            console.print(f"  [{Colors.DIM}]  DB_PASSWORD=<your_password>[/]")
            console.print()
            
            fix_choice = prompt.select(
                "How would you like to proceed?",
                choices=[
                    "Enter credentials now (saves to .env)",
                    "I've updated .env — retry",
                ],
            )
            
            if fix_choice == "Enter credentials now (saves to .env)":
                console.print()
                pg_host = prompt.text("Host", default=env_config.get("host", "localhost"))
                pg_port = prompt.number("Port", default=env_config.get("port", 5432), min_value=1)
                pg_database = prompt.text("Database name", default=env_config.get("database", "caracal"))
                pg_user = prompt.text("Username", default=env_config.get("username", "caracal"))
                pg_password = prompt.text("Password", default="", hide_input=True)
                
                env_config = {
                    "host": pg_host,
                    "port": int(pg_port),
                    "database": pg_database,
                    "username": pg_user,
                    "password": pg_password,
                }
                
                if _save_db_config_to_env(env_config):
                    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Credentials saved to .env[/]")
                else:
                    console.print(f"  [{Colors.WARNING}]⚠️  Could not save to .env — please update manually[/]")
                console.print()
            else:
                # User says they updated .env — loop to re-read
                console.print()
                continue
            
            # Re-validate after user input
            env_issues = _validate_env_config(env_config)
            if env_issues:
                console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Configuration still incomplete:[/]")
                for issue in env_issues:
                    console.print(f"    [{Colors.WARNING}]• {issue}[/]")
                console.print()
                continue
        
        # 2. Config is valid — show what we'll connect to
        console.print(f"  [{Colors.INFO}]{Icons.INFO} PostgreSQL configuration:[/]")
        console.print(f"  [{Colors.DIM}]  Host:     {env_config['host']}:{env_config['port']}[/]")
        console.print(f"  [{Colors.DIM}]  Database: {env_config['database']}[/]")
        console.print(f"  [{Colors.DIM}]  User:     {env_config['username']}[/]")
        console.print()
        
        # 3. Test connection
        console.print(f"  [{Colors.INFO}]{Icons.INFO} Testing PostgreSQL connection...[/]")
        success, error = _test_db_connection(env_config)
        
        if success:
            console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} PostgreSQL connected successfully![/]")
            console.print(f"  [{Colors.DIM}]Using PostgreSQL for data storage[/]")
            console.print()
            
            wizard.context["database"] = {**env_config, "type": "postgresql"}
            wizard.context["database_auto_configured"] = True
            return wizard.context["database"]
        
        # 4. Connection failed — show clear error and attempt auto-start
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} PostgreSQL connection failed![/]")
        console.print()
        
        _show_connection_error_details(console, error, env_config)
        
        # 5. Try to auto-start PostgreSQL if it looks like a connection issue
        is_connection_issue = any(phrase in error.lower() for phrase in [
            "connection refused", "could not connect", "timeout",
            "no such file or directory", "is the server running",
        ])
        
        if is_connection_issue:
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Attempting to start PostgreSQL automatically...[/]")
            start_ok, start_msg = _start_postgresql(console)
            
            if start_ok:
                console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} {start_msg}[/]")
                console.print(f"  [{Colors.INFO}]{Icons.INFO} Re-testing connection...[/]")
                
                success2, error2 = _test_db_connection(env_config)
                if success2:
                    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} PostgreSQL connected successfully![/]")
                    console.print(f"  [{Colors.DIM}]Using PostgreSQL for data storage[/]")
                    console.print()
                    
                    wizard.context["database"] = {**env_config, "type": "postgresql"}
                    wizard.context["database_auto_configured"] = True
                    return wizard.context["database"]
                else:
                    console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Connection still failing after start: {error2}[/]")
            else:
                console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Auto-start failed: {start_msg}[/]")
            console.print()
        
        # 6. PostgreSQL still not working — loop until resolved
        #    Let user fix the issue and retry
        console.print(f"  [{Colors.WARNING}]⚠️  PostgreSQL must be running to continue.[/]")
        console.print(f"  [{Colors.DIM}]Fix the issue above and retry — database integrity matters.[/]")
        console.print()
        
        action = prompt.select(
            "How would you like to proceed?",
            choices=[
                "Retry connection (after fixing the issue)",
                "Enter different credentials",
                "Start PostgreSQL manually (then retry)",
            ],
        )
        
        if action == "Enter different credentials":
            console.print()
            pg_host = prompt.text("Host", default=env_config.get("host", "localhost"))
            pg_port = prompt.number("Port", default=env_config.get("port", 5432), min_value=1)
            pg_database = prompt.text("Database name", default=env_config.get("database", "caracal"))
            pg_user = prompt.text("Username", default=env_config.get("username", "caracal"))
            pg_password = prompt.text("Password", default="", hide_input=True)
            
            env_config = {
                "host": pg_host,
                "port": int(pg_port),
                "database": pg_database,
                "username": pg_user,
                "password": pg_password,
            }
            
            # Save new creds to .env
            if _save_db_config_to_env(env_config):
                console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Credentials saved to .env[/]")
            console.print()
            
        elif action == "Start PostgreSQL manually (then retry)":
            console.print()
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Common commands to start PostgreSQL:[/]")
            console.print(f"  [{Colors.DIM}]  docker compose up -d postgres[/]")
            console.print(f"  [{Colors.DIM}]  sudo systemctl start postgresql[/]")
            console.print(f"  [{Colors.DIM}]  brew services start postgresql@16[/]")
            console.print()
            console.print(f"  [{Colors.HINT}]Start PostgreSQL in another terminal, then press Enter to retry...[/]")
            input()
        else:
            # "Retry connection" — just loop
            console.print()
        
        # Loop back to retry


def _show_connection_error_details(console: Console, error: str, config: dict) -> None:
    """Show detailed, actionable error messages based on the connection error."""
    error_lower = error.lower()
    
    console.print(f"  [{Colors.DIM}]Error: {error}[/]")
    console.print()
    
    if "password" in error_lower or "authentication" in error_lower:
        console.print(f"  [{Colors.ERROR}]DIAGNOSIS: Authentication failed[/]")
        console.print(f"  [{Colors.DIM}]  → The password for user '{config.get('username')}' is incorrect[/]")
        console.print(f"  [{Colors.DIM}]  → Fix: Update DB_PASSWORD in your .env file[/]")
        console.print(f"  [{Colors.DIM}]  → Or reset: sudo -u postgres psql -c \"ALTER USER {config.get('username')} PASSWORD 'newpass';\"[/]")
    elif "connection refused" in error_lower or "could not connect" in error_lower:
        console.print(f"  [{Colors.ERROR}]DIAGNOSIS: PostgreSQL server is not running or not accepting connections[/]")
        console.print(f"  [{Colors.DIM}]  → Check: sudo systemctl status postgresql[/]")
        console.print(f"  [{Colors.DIM}]  → Start: docker compose up -d postgres[/]")
        console.print(f"  [{Colors.DIM}]  → Verify port {config.get('port')} is not blocked by firewall[/]")
    elif "does not exist" in error_lower and "database" in error_lower:
        console.print(f"  [{Colors.ERROR}]DIAGNOSIS: Database '{config.get('database')}' does not exist[/]")
        console.print(f"  [{Colors.DIM}]  → Create it: sudo -u postgres createdb {config.get('database')}[/]")
        console.print(f"  [{Colors.DIM}]  → Or via psql: CREATE DATABASE {config.get('database')};[/]")
    elif "role" in error_lower and "does not exist" in error_lower:
        console.print(f"  [{Colors.ERROR}]DIAGNOSIS: PostgreSQL user '{config.get('username')}' does not exist[/]")
        console.print(f"  [{Colors.DIM}]  → Create: sudo -u postgres createuser {config.get('username')}[/]")
        console.print(f"  [{Colors.DIM}]  → With password: sudo -u postgres psql -c \"CREATE USER {config.get('username')} WITH PASSWORD 'pass';\"[/]")
    elif "timeout" in error_lower:
        console.print(f"  [{Colors.ERROR}]DIAGNOSIS: Connection timed out[/]")
        console.print(f"  [{Colors.DIM}]  → Host '{config.get('host')}' may be unreachable[/]")
        console.print(f"  [{Colors.DIM}]  → Check network / firewall / VPN settings[/]")
    elif "no such file" in error_lower or "unix" in error_lower:
        console.print(f"  [{Colors.ERROR}]DIAGNOSIS: PostgreSQL socket file not found[/]")
        console.print(f"  [{Colors.DIM}]  → PostgreSQL is likely not installed or not running[/]")
        console.print(f"  [{Colors.DIM}]  → Install: sudo apt install postgresql  (Debian/Ubuntu)[/]")
        console.print(f"  [{Colors.DIM}]  → Or use Docker: docker compose up -d postgres[/]")
    else:
        console.print(f"  [{Colors.ERROR}]DIAGNOSIS: Unexpected error[/]")
        console.print(f"  [{Colors.DIM}]  → Verify PostgreSQL is running and credentials are correct[/]")
        console.print(f"  [{Colors.DIM}]  → Check the full error message above for details[/]")
    
    console.print()



def _step_principal(wizard: Wizard) -> Any:
    """Step 3: Register first principal."""
    console = wizard.console
    prompt = FlowPrompt(console)
    
    # ── Existing workspace that was previously onboarded: skip ──
    if wizard.context.get("previously_onboarded") and "principal" in wizard.context.get("completed_steps", []):
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Principal already registered in this workspace.[/]")
        # Set a placeholder so downstream steps know principal exists
        wizard.context["first_principal"] = {"_existing": True}
        return wizard.context["first_principal"]
    
    # Get system username for better defaults
    import os
    import getpass
    system_user = getpass.getuser()
    default_name = f"{system_user}-admin"
    default_email = f"{system_user}@localhost"
    
    console.print(f"  [{Colors.NEUTRAL}]Let's register your first principal.")
    console.print(f"  [{Colors.DIM}]This will be your admin user account.[/]")
    console.print()
    
    principal_type = prompt.select(
        "Principal type",
        choices=["user", "agent", "service"],
        default="user",
    )
    
    name = prompt.text(
        "Principal name",
        default=default_name,
    )
    
    owner = prompt.text(
        "Owner email",
        default=default_email,
    )
    
    # Store for later
    wizard.context["first_principal"] = {
        "name": name,
        "owner": owner,
        "type": principal_type,
    }
    
    console.print()
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Principal will be registered after setup completes.[/]")
    console.print(f"  [{Colors.DIM}]Name: {name}[/]")
    console.print(f"  [{Colors.DIM}]Owner: {owner}[/]")
    console.print(f"  [{Colors.DIM}]Type: {principal_type}[/]")
    
    return wizard.context["first_principal"]


def _step_policy(wizard: Wizard) -> Any:
    """Step 4: Create first authority policy."""
    console = wizard.console
    prompt = FlowPrompt(console)
    
    # ── Existing workspace that was previously onboarded: skip ──
    if wizard.context.get("previously_onboarded") and "policy" in wizard.context.get("completed_steps", []):
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Authority policy already configured in this workspace.[/]")
        wizard.context["first_policy"] = {"_existing": True}
        return wizard.context["first_policy"]
    
    # Check dependency: principal must be created first
    principal_info = wizard.context.get("first_principal")
    if not principal_info:
        # Silently skip - no need to prompt user since principal wasn't registered
        return None
    
    principal_name = principal_info.get("name", "the principal")
    
    console.print(f"  [{Colors.NEUTRAL}]Now let's create an authority policy for {principal_name}.")
    console.print(f"  [{Colors.DIM}]Policies define how mandates can be issued.[/]")
    console.print()
    
    # Ask whether the user wants to create a policy now or skip
    create_now = prompt.confirm(
        "Create an authority policy now?",
        default=False,
    )

    if not create_now:
        console.print()
        console.print(f"  [{Colors.INFO}]{Icons.INFO} Skipping policy creation. You can create policies later from the main menu.[/]")
        return None

    # Collect realistic inputs (no dummy defaults)
    max_validity = prompt.number(
        "Maximum mandate validity (seconds)",
        default=3600,
        min_value=60,
    )

    resource_input = prompt.text(
        "Resource patterns (comma-separated, e.g. api:read:*,database:query)",
        default="",
    )

    actions_input = prompt.text(
        "Allowed actions (comma-separated, e.g. api_call,database_query)",
        default="",
    )

    resource_patterns = [r.strip() for r in resource_input.split(",") if r.strip()]
    actions = [a.strip() for a in actions_input.split(",") if a.strip()]

    wizard.context["first_policy"] = {
        "max_validity_seconds": int(max_validity),
        "resource_patterns": resource_patterns,
        "actions": actions,
    }

    console.print()
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Policy will be created after setup completes.[/]")
    console.print(f"  [{Colors.DIM}]Max Validity: {int(max_validity)}s[/]")

    return wizard.context["first_policy"]


def _step_mandate(wizard: Wizard) -> Any:
    """Step 5: Issue first mandate."""
    console = wizard.console
    prompt = FlowPrompt(console)
    
    # ── Existing workspace that was previously onboarded: skip ──
    if wizard.context.get("previously_onboarded") and "mandate" in wizard.context.get("completed_steps", []):
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Mandate already issued in this workspace.[/]")
        wizard.context["first_mandate"] = {"_existing": True}
        return wizard.context["first_mandate"]
    
    # Check dependency: policy must be created first
    policy_info = wizard.context.get("first_policy")
    if not policy_info:
        # Silently skip - no need to prompt user since policy wasn't created
        return None
    
    principal_info = wizard.context.get("first_principal", {})
    principal_name = principal_info.get("name", "the principal")
    
    console.print(f"  [{Colors.NEUTRAL}]Let's issue an execution mandate for {principal_name}.")
    console.print(f"  [{Colors.DIM}]Mandates grant specific execution rights for a limited time.[/]")
    console.print()
    
    # Ask whether the user wants to issue a mandate now or skip
    issue_now = prompt.confirm(
        "Issue a mandate now?",
        default=False,
    )

    if not issue_now:
        console.print()
        console.print(f"  [{Colors.INFO}]{Icons.INFO} Skipping mandate issuance. You can issue mandates later from the main menu.[/]")
        return None

    validity = prompt.number(
        "Mandate validity (seconds)",
        default=1800,
        min_value=60,
    )

    resource_input = prompt.text(
        "Resource scope (comma-separated patterns, e.g. api:service:*,database:*)",
        default="",
    )

    action_input = prompt.text(
        "Action scope (comma-separated, e.g. api_call,database_query)",
        default="",
    )

    resource_scope = [r.strip() for r in resource_input.split(",") if r.strip()]
    action_scope = [a.strip() for a in action_input.split(",") if a.strip()]

    wizard.context["first_mandate"] = {
        "validity_seconds": int(validity),
        "resource_scope": resource_scope,
        "action_scope": action_scope,
    }

    console.print()
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Mandate will be issued after setup completes.[/]")
    console.print(f"  [{Colors.DIM}]Validity: {int(validity)}s[/]")

    return wizard.context["first_mandate"]


def _step_validate(wizard: Wizard) -> Any:
    """Step 6: Validate mandate demo."""
    console = wizard.console
    prompt = FlowPrompt(console)
    
    # ── Existing workspace that was previously onboarded: skip ──
    if wizard.context.get("previously_onboarded") and "validate" in wizard.context.get("completed_steps", []):
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Validation already completed in this workspace.[/]")
        wizard.context["validate_demo"] = False
        return True
    
    # Check dependency: mandate must be issued first
    mandate_info = wizard.context.get("first_mandate")
    if not mandate_info:
        # Silently skip - no need to prompt user since mandate wasn't issued
        wizard.context["validate_demo"] = False
        return None
    
    console.print(f"  [{Colors.NEUTRAL}]Finally, we'll demonstrate mandate validation.")
    console.print(f"  [{Colors.DIM}]This shows how authority is checked before execution.[/]")
    console.print()

    run_demo = prompt.confirm(
        "Run the validation demo now?",
        default=False,
    )

    if not run_demo:
        console.print()
        console.print(f"  [{Colors.INFO}]{Icons.INFO} Skipping validation demo. You can run validation from the main menu later.[/]")
        wizard.context["validate_demo"] = False
        return False

    console.print(f"  [{Colors.INFO}]{Icons.INFO} Validation demo will run after setup completes.[/]")
    wizard.context["validate_demo"] = True
    return True


def run_onboarding(
    console: Optional[Console] = None,
    state: Optional[FlowState] = None,
) -> dict[str, Any]:
    """
    Run the onboarding wizard.
    
    Args:
        console: Rich console
        state: Application state
    
    Returns:
        Dictionary of collected information
    """
    console = console or Console()
    
    # Define wizard steps
    steps = [
        WizardStep(
            key="workspace",
            title="Workspace Setup",
            description="Select, create, or delete a workspace",
            action=_step_workspace,
            skippable=False,
        ),
        WizardStep(
            key="config",
            title="Configuration Setup",
            description="Set up Caracal's configuration directory and files",
            action=_step_config,
            skippable=False,
        ),
        WizardStep(
            key="database",
            title="Database Setup",
            description="Automatic database configuration with fail-safe fallback",
            action=_step_database,
            skippable=False,
        ),
        WizardStep(
            key="principal",
            title="Register First Principal",
            description="Create your first principal identity",
            action=_step_principal,
            skippable=True,
            skip_message="You can register principals later from the main menu",
        ),
        WizardStep(
            key="policy",
            title="Create First Authority Policy",
            description="Set up an authority policy for your principal",
            action=_step_policy,
            skippable=True,
            skip_message="You can create policies later from the main menu",
        ),
        WizardStep(
            key="mandate",
            title="Issue First Mandate",
            description="Create an execution mandate",
            action=_step_mandate,
            skippable=True,
            skip_message="You can issue mandates later from the main menu",
        ),
        WizardStep(
            key="validate",
            title="Validate Mandate Demo",
            description="Demonstrate mandate validation",
            action=_step_validate,
            skippable=True,
            skip_message="You can validate mandates later from the main menu",
        ),
    ]
    
    # Run wizard
    wizard = Wizard(
        title="Welcome to Caracal Flow",
        steps=steps,
        console=console,
    )
    
    results = wizard.run()
    
    # Validate that workspace was selected (critical requirement)
    if not wizard.context.get("workspace_path"):
        console.print()
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} No workspace selected. Cannot proceed without a workspace.[/]")
        console.print(f"  [{Colors.INFO}]{Icons.INFO} A workspace is required to store your configuration and data.[/]")
        console.print()
        results["workspace_configured"] = False
        return results
    
    results["workspace_configured"] = True
    
    # Show summary
    wizard.show_summary()
    
    # Persist changes
    try:
        from pathlib import Path
        from caracal.config import load_config
        from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager, get_db_manager
        from caracal.db.models import Principal, AuthorityPolicy
        from datetime import datetime
        from uuid import uuid4
        from caracal.flow.workspace import get_workspace
        
        # Load fresh config (in case it was just initialized)
        config = load_config()
        
        # Save database configuration if provided
        db_config_data = results.get("database")
        workspace_name = wizard.context.get("workspace_name", "default")
        # Derive a safe PostgreSQL schema name from the workspace name
        import re as _re
        workspace_schema = "ws_" + _re.sub(r"[^a-z0-9_]", "_", workspace_name.lower())
        
        if db_config_data and isinstance(db_config_data, dict) and db_config_data.get("type") == "postgresql":
            console.print()
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Saving database configuration...[/]")
            
            # Update config file with database settings
            import yaml
            
            config_path = wizard.context.get("config_path", get_workspace().root)
            config_file = Path(config_path) / "config.yaml"
            
            if config_file.exists():
                with open(config_file, 'r') as f:
                    config_yaml = yaml.safe_load(f) or {}
                
                # Update database section — include schema for workspace isolation
                config_yaml['database'] = {
                    'type': 'postgres',
                    'host': db_config_data['host'],
                    'port': db_config_data['port'],
                    'database': db_config_data['database'],
                    'user': db_config_data['username'],
                    'password': db_config_data['password'],
                    'schema': workspace_schema,
                }
                
                with open(config_file, 'w') as f:
                    yaml.dump(config_yaml, f, default_flow_style=False)
                
                console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} PostgreSQL configuration saved to config.yaml[/]")
                console.print(f"  [{Colors.DIM}]Schema: {workspace_schema}[/]")
                
                # Reload config
                config = load_config()
        
        # Setup database connection — PostgreSQL only
        if isinstance(db_config_data, dict) and db_config_data.get("type") == "postgresql":
            # PostgreSQL was successfully configured in wizard
            db_config = DatabaseConfig(
                host=db_config_data.get('host', 'localhost'),
                port=int(db_config_data.get('port', 5432)),
                database=db_config_data.get('database', 'caracal'),
                user=db_config_data.get('username', 'caracal'),
                password=db_config_data.get('password', ''),
                schema=workspace_schema,
            )
        elif hasattr(config, 'database') and config.database:
            # Fall back to existing config if wizard didn't produce new data
            db_config = DatabaseConfig(
                host=getattr(config.database, 'host', 'localhost'),
                port=getattr(config.database, 'port', 5432),
                database=getattr(config.database, 'database', 'caracal'),
                user=getattr(config.database, 'user', 'caracal'),
                password=getattr(config.database, 'password', ''),
                schema=getattr(config.database, 'schema', workspace_schema),
            )
        else:
            # Use env-var-based defaults via get_db_manager()
            db_config = DatabaseConfig(schema=workspace_schema)
        
        # Initialize database — try to connect, auto-start PostgreSQL if needed
        db_manager = None
        max_attempts = 2
        for attempt in range(1, max_attempts + 1):
            try:
                db_manager = DatabaseConnectionManager(db_config)
                db_manager.initialize()
                console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Database initialized successfully[/]")
                break
            except Exception as e:
                err_str = str(e).lower()
                is_connection_error = (
                    "connection refused" in err_str
                    or "could not connect" in err_str
                    or "no password supplied" in err_str
                    or "operationalerror" in err_str
                )
                
                if is_connection_error and attempt < max_attempts:
                    console.print()
                    console.print(f"  [{Colors.WARNING}]{Icons.WARNING} PostgreSQL is not reachable. Attempting to start it automatically...[/]")
                    start_ok, start_msg = _start_postgresql(console)
                    if start_ok:
                        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} {start_msg}[/]")
                        console.print(f"  [{Colors.INFO}]{Icons.INFO} Retrying database connection...[/]")
                        continue
                    else:
                        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Could not auto-start PostgreSQL: {start_msg}[/]")
                
                # Final failure — show a clean error, not a massive traceback
                console.print()
                console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Database initialization failed.[/]")
                console.print()
                
                # Show helpful diagnostics
                if "connection refused" in err_str:
                    console.print(f"  [{Colors.INFO}]PostgreSQL is not running. Start it with:[/]")
                    console.print(f"    [{Colors.DIM}]docker compose up -d postgres[/]")
                    console.print(f"    [{Colors.DIM}]sudo systemctl start postgresql[/]")
                elif "password" in err_str or "authentication" in err_str:
                    console.print(f"  [{Colors.INFO}]Authentication failed. Check your .env credentials:[/]")
                    console.print(f"    [{Colors.DIM}]DB_USER, DB_PASSWORD in .env[/]")
                elif "does not exist" in err_str:
                    console.print(f"  [{Colors.INFO}]Database or role missing. Create them with:[/]")
                    console.print(f"    [{Colors.DIM}]createdb caracal && createuser caracal[/]")
                else:
                    console.print(f"  [{Colors.DIM}]Error: {e}[/]")
                
                console.print()
                console.print(f"  [{Colors.HINT}]Fix the issue and re-run onboarding.[/]")
                console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
                input()
                return results
        
        # Only clean database if explicitly requested or if it's a new workspace with fresh start
        # Do NOT clean database if it was auto-configured from .env without user confirmation
        should_clean = (
            wizard.context.get("fresh_start") and 
            not wizard.context.get("database_auto_configured")
        )
        
        if should_clean:
            try:
                console.print()
                console.print(f"  [{Colors.INFO}]{Icons.INFO} Cleaning database for fresh start...[/]")
                # Use the clear_database method for a clean wipe
                db_manager.clear_database()
                console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Database cleaned - starting with empty tables[/]")
            except Exception as e:
                console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Failed to clean database: {e}[/]")
                console.print(f"  [{Colors.DIM}]Continuing with existing data...[/]")
        
        # Handle Principal Registration
        principal_data = results.get("principal")
        principal_id = None
        
        if principal_data and not principal_data.get("_existing"):
            console.print()
            console.print(f"  [{Colors.INFO}]{Icons.INFO} Finalizing setup...[/]")
            
            try:
                with db_manager.session_scope() as db_session:
                    # Check if principal already exists
                    existing = db_session.query(Principal).filter_by(
                        name=principal_data["name"]
                    ).first()
                    
                    if existing:
                        principal_id = existing.principal_id
                        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Principal already exists, reusing.[/]")
                        console.print(f"  [{Colors.DIM}]Principal ID: {principal_id}[/]")
                    else:
                        # Generate ECDSA P-256 key pair for the principal
                        from cryptography.hazmat.primitives.asymmetric import ec
                        from cryptography.hazmat.primitives import serialization
                        from cryptography.hazmat.backends import default_backend
                        
                        console.print(f"  [{Colors.INFO}]{Icons.INFO} Generating cryptographic keys...[/]")
                        
                        private_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
                        
                        # Serialize private key to PEM format
                        private_key_pem = private_key.private_bytes(
                            encoding=serialization.Encoding.PEM,
                            format=serialization.PrivateFormat.PKCS8,
                            encryption_algorithm=serialization.NoEncryption()
                        ).decode('utf-8')
                        
                        # Extract public key and serialize to PEM format
                        public_key = private_key.public_key()
                        public_key_pem = public_key.public_bytes(
                            encoding=serialization.Encoding.PEM,
                            format=serialization.PublicFormat.SubjectPublicKeyInfo
                        ).decode('utf-8')
                        
                        principal = Principal(
                            name=principal_data["name"],
                            principal_type=principal_data["type"],
                            owner=principal_data["owner"],
                            public_key_pem=public_key_pem,
                            private_key_pem=private_key_pem,
                            created_at=datetime.utcnow(),
                        )
                        
                        db_session.add(principal)
                        db_session.flush()
                        
                        principal_id = principal.principal_id
                        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Principal registered successfully.[/]")
                        console.print(f"  [{Colors.DIM}]Principal ID: {principal_id}[/]")
            except Exception as e:
                console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Failed to register principal: {e}[/]")
        
        # Handle Authority Policy Creation
        policy_data = results.get("policy")
        if policy_data and not policy_data.get("_existing") and principal_id:
            try:
                with db_manager.session_scope() as db_session:
                    # Check if a policy already exists for this principal
                    existing_policy = db_session.query(AuthorityPolicy).filter_by(
                        principal_id=principal_id,
                        active=True,
                    ).first()
                    
                    if existing_policy:
                        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Authority policy already exists, skipping.[/]")
                    else:
                        policy = AuthorityPolicy(
                            policy_id=uuid4(),
                            principal_id=principal_id,
                            max_validity_seconds=policy_data["max_validity_seconds"],
                            allowed_resource_patterns=policy_data["resource_patterns"],
                            allowed_actions=policy_data["actions"],
                            allow_delegation=True,
                            max_delegation_depth=3,
                            created_at=datetime.utcnow(),
                            created_by=principal_data["owner"] if principal_data else "system",
                            active=True,
                        )
                        
                        db_session.add(policy)
                        
                        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Authority policy created successfully.[/]")
            except Exception as e:
                console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Failed to create policy: {e}[/]")
        
        # Issue first mandate if requested (create mandate record in DB)
        mandate_data = results.get("mandate")
        if mandate_data and not mandate_data.get("_existing") and principal_id:
            try:
                console.print()
                console.print(f"  [{Colors.INFO}]{Icons.INFO} Issuing first mandate for {principal_data['name']}...[/]")
                from caracal.core.mandate import MandateManager

                with db_manager.session_scope() as db_session:
                    mandate_manager = MandateManager(db_session)

                    # Use provided scopes or fall back to policy defaults
                    resource_scope = mandate_data.get("resource_scope") or policy_data.get("resource_patterns", [])
                    action_scope = mandate_data.get("action_scope") or policy_data.get("actions", [])
                    validity_seconds = int(mandate_data.get("validity_seconds", 900))

                    mandate = mandate_manager.issue_mandate(
                        issuer_id=principal_id,
                        subject_id=principal_id,
                        resource_scope=resource_scope,
                        action_scope=action_scope,
                        validity_seconds=validity_seconds,
                    )

                    # Record mandate id in results/context for visibility
                    results["mandate_id"] = str(mandate.mandate_id)
                    wizard.context["first_mandate"]["mandate_id"] = str(mandate.mandate_id)

                    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Mandate issued successfully.[/]")
                    console.print(f"  [{Colors.DIM}]Mandate ID: {mandate.mandate_id}[/]")

            except Exception as e:
                console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Failed to issue mandate: {e}[/]")

        # Close database connection
        if db_manager:
            db_manager.close()
                
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error during configuration: {e}[/]")
        import logging
        logging.getLogger(__name__).debug("Onboarding config error", exc_info=True)

    # Update state
    if state:
        state.onboarding.mark_complete()
        for step in steps:
            if step.status.value == "completed":
                state.onboarding.mark_step_complete(step.key)
            elif step.status.value == "skipped":
                state.onboarding.mark_step_skipped(step.key)
        
        # Save state
        persistence = StatePersistence()
        persistence.save(state)
    
    # Show next steps
    _show_next_steps(console, results, wizard.context)
    
    return results


def _show_next_steps(console: Console, results: dict, context: dict) -> None:
    """Show actionable next steps after onboarding."""
    console.print()
    console.print(f"  [{Colors.INFO}]{Icons.INFO} Next Steps:[/]")
    console.print()
    
    todos = []
    
    # Check what was skipped
    if results.get("principal") is None:
        todos.append(("Register a principal", "caracal authority register --name my-principal --owner user@example.com"))
    
    if results.get("policy") is None:
        todos.append(("Create an authority policy", "caracal authority-policy create --principal-id <uuid> --max-validity 3600"))
    
    if results.get("mandate") is None:
        todos.append(("Issue an execution mandate", "caracal authority issue --issuer-id <uuid> --subject-id <uuid>"))
    
    # Always suggest viewing the ledger
    todos.append(("Explore your authority ledger", "caracal authority-ledger query"))
    
    for i, (title, cmd) in enumerate(todos, 1):
        console.print(f"  [{Colors.NEUTRAL}]{i}. {title}[/]")
        console.print(f"     [{Colors.DIM}]{cmd}[/]")
        console.print()
    
    console.print(f"  [{Colors.HINT}]Press Enter to continue to the main menu...[/]")
    input()
