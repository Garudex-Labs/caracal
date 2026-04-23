"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal Flow Application Controller.

Main application class orchestrating the TUI experience:
- Application lifecycle (start, run, exit)
- State management
- Screen navigation
"""

from typing import Optional

from rich.console import Console

from caracal.flow.state import StatePersistence
from caracal.flow.theme import FLOW_THEME, Colors, Icons
from caracal.flow.screens.welcome import show_welcome, wait_for_action
from caracal.flow.screens.main_menu import show_main_menu, show_submenu
from caracal.flow.screens.onboarding import run_onboarding
from caracal.runtime.host_io import in_container_runtime


class FlowApp:
    """Main Caracal Flow application."""
    
    def __init__(self, console: Optional[Console] = None):
        self._configure_workspace_logging()
        
        self.console = console or Console(theme=FLOW_THEME)
        self.persistence = StatePersistence()
        self.state = self.persistence.load()
        self._running = False

    def _configure_workspace_logging(self) -> None:
        """Configure Flow logging to workspace log files."""
        from caracal.logging_config import get_logger, setup_runtime_logging

        try:
            from caracal.flow.workspace import get_workspace

            ws = get_workspace()
            ws.ensure_dirs()
            # Ensure log files exist so Logs Viewer always has concrete targets.
            ws.log_path.touch(exist_ok=True)
            (ws.logs_dir / "sync.log").touch(exist_ok=True)

            # File-only logging prevents log output from polluting the TUI.
            setup_runtime_logging(log_file=ws.log_path)
            get_logger(__name__).info("flow_logging_configured", workspace=str(ws.root))
        except Exception:
            # Fallback: keep TUI usable even if workspace logging setup fails.
            setup_runtime_logging(requested_level="WARNING", requested_json_format=False)
    
    def start(self) -> None:
        """Start the application."""
        self._running = True
        
        try:
            show_welcome(self.console, compact=self.state.preferences.compact_mode)
            action = wait_for_action(self.console)
            
            if action == "quit":
                self._goodbye()
                return
            
            onboarding_result = run_onboarding(self.console, self.state)
            
            if not onboarding_result.get("workspace_configured", False):
                self.console.print()
                self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Setup incomplete. Workspace configuration is required.[/]")
                self.console.print(f"  [{Colors.INFO}]{Icons.INFO} Please run 'caracal flow' again to set up your workspace.[/]")
                self.console.print()
                self._goodbye()
                return
            
            from caracal.flow.workspace import get_workspace
            try:
                workspace = get_workspace()
                if not workspace.root.exists():
                    self.console.print()
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Workspace directory not found: {workspace.root}[/]")
                    self.console.print()
                    self._goodbye()
                    return
            except Exception as e:
                self.console.print()
                self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Failed to access workspace: {e}[/]")
                self.console.print()
                self._goodbye()
                return

            # Reconfigure logs after onboarding in case workspace changed.
            self._configure_workspace_logging()
            self.state = self.persistence.load()
            
            self._run_main_loop()
            
        except KeyboardInterrupt:
            self._goodbye()
        except Exception as e:
            self.console.print(f"\n  [{Colors.ERROR}]{Icons.ERROR} Unexpected error: {e}[/]")
            raise
        finally:
            self._running = False
            self._save_state()
    
    def _run_main_loop(self) -> None:
        """Run the main application loop."""
        while self._running:
            self.console.clear()
            selection = show_main_menu(self.console)
            
            if selection is None:
                if self._confirm_exit():
                    self._goodbye()
                    break
                continue
            
            self._handle_selection(selection)
    
    def _handle_selection(self, selection: str) -> None:
        """Handle main menu selection."""
        handlers = {
            "principals": self._run_principal_flow,
            "policies": self._run_authority_policy_flow,
            "ledger": self._run_authority_ledger_flow,
            "mandates": self._run_mandate_flow,
            "delegation": self._run_mandate_delegation_flow,
            "deployment": self._run_deployment_flow,
            "enterprise": self._run_enterprise_flow,
            "settings": self._run_settings_flow,
            "help": self._run_help_flow,
        }
        
        handler = handlers.get(selection)
        if handler:
            handler()
    
    def _run_principal_flow(self) -> None:
        """Run principal management flow."""
        from caracal.flow.screens.principal_flow import run_principal_flow
        run_principal_flow(self.console, self.state)
    
    def _run_authority_policy_flow(self) -> None:
        """Run authority policy management flow."""
        from caracal.flow.screens.authority_policy_flow import run_authority_policy_flow
        run_authority_policy_flow(self.console, self.state)
    
    def _run_authority_ledger_flow(self) -> None:
        """Run authority ledger explorer flow."""
        from caracal.flow.screens.authority_ledger_flow import run_authority_ledger_flow
        run_authority_ledger_flow(self.console)
    
    def _run_mandate_flow(self) -> None:
        """Run mandate manager flow."""
        from caracal.flow.screens.mandate_flow import run_mandate_flow
        run_mandate_flow(self.console)
    
    def _run_mandate_delegation_flow(self) -> None:
        """Run mandate delegation center flow."""
        from caracal.flow.screens.mandate_delegation_flow import run_mandate_delegation_flow
        run_mandate_delegation_flow(self.console)
    
    def _run_deployment_flow(self) -> None:
        """Run deployment management flow."""
        while True:
            self.console.clear()
            action = show_submenu("deployment", self.console)
            if action is None:
                break
            
            if action == "dashboard":
                from caracal.flow.screens.deployment_dashboard import show_deployment_dashboard
                show_deployment_dashboard(self.console, self.state)
            elif action == "workspaces":
                from caracal.flow.screens.workspace_manager import show_workspace_manager
                show_workspace_manager(self.console, self.state)
            elif action == "providers":
                from caracal.flow.screens.provider_manager import show_provider_manager
                show_provider_manager(self.console, self.state)
            elif action == "logs":
                from caracal.flow.screens.logs_viewer import show_logs_viewer
                show_logs_viewer(self.console, self.state)
            else:
                self._show_cli_fallback("deployment", action)
    
    def _run_enterprise_flow(self) -> None:
        """Run enterprise features flow."""
        from caracal.flow.screens.enterprise_flow import show_enterprise_flow
        show_enterprise_flow(self.console)
    
    def _run_settings_flow(self) -> None:
        """Run settings flow."""
        while True:
            self.console.clear()
            action = show_submenu("settings", self.console)
            if action is None:
                break
            
            if action == "view":
                self._show_current_config()
            elif action == "edit":
                self._run_edit_config()
            elif action == "config":
                from caracal.flow.screens.config_editor import show_config_editor
                show_config_editor(self.console, self.state)
            elif action == "service-health":
                self._show_service_health()
            elif action == "backup":
                self._run_backup_flow()
            elif action == "restore":
                self._run_restore_flow()
            else:
                self._show_cli_fallback("", action)
    
    def _run_help_flow(self) -> None:
        """Run help flow."""
        while True:
            self.console.clear()
            action = show_submenu("help", self.console)
            if action is None:
                break

            if action == "docs":
                url = "https://docs.garudexlabs.com"
                self.console.print(f"  [{Colors.INFO}]Documentation:[/]")
                self.console.print(f"  [{Colors.HINT}][link={url}]{url}[/]")
                self.console.print()
                self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
                input()
            elif action == "deployment-help":
                from caracal.flow.screens.deployment_help import show_deployment_help
                show_deployment_help(self.console, self.state)
            elif action == "shortcuts":
                self._show_shortcuts()
            elif action == "about":
                self._show_about()
            else:
                self._show_cli_fallback("", action)
    
    def _show_current_config(self) -> None:
        """Display current configuration with enabled services."""
        from rich.panel import Panel
        from rich.table import Table
        
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Current Caracal Configuration[/]",
            title=f"[bold {Colors.INFO}]Settings[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.config import load_config
            
            config = load_config()
            
            # Database
            self.console.print(f"  [{Colors.INFO}]Database:[/]")
            self.console.print(f"    Type: [{Colors.NEUTRAL}]PostgreSQL[/]")
            self.console.print(f"    Host: [{Colors.DIM}]{config.database.host}:{config.database.port}[/]")
            self.console.print(f"    Database: [{Colors.DIM}]{config.database.database}[/]")
            self.console.print()
            
            # Services and version
            from caracal._version import __version__
            
            self.console.print(f"  [{Colors.INFO}]Services:[/]")
            self.console.print(f"    Version: [{Colors.NEUTRAL}]{__version__}[/]")
            
            # Service status table
            svc_table = Table(show_header=False, padding=(0, 2), show_edge=False)
            svc_table.add_column("Service", style=Colors.DIM)
            svc_table.add_column("Status")
            
            redis_on = True
            merkle_on = True
            gateway_on = getattr(config.gateway, 'enabled', False)
            mcp_on = getattr(config.mcp_adapter, 'enabled', False)
            
            def _status(enabled: bool, label: str = "") -> str:
                if enabled:
                    return f"[{Colors.SUCCESS}]{Icons.SUCCESS} Enabled[/]{f' ({label})' if label else ''}"
                return f"[{Colors.DIM}]{Icons.ERROR} Disabled[/]{f' ({label})' if label else ''}"
            
            svc_table.add_row("    PostgreSQL", f"[{Colors.SUCCESS}]{Icons.SUCCESS} Always On[/] (core database — required)")
            svc_table.add_row("    Redis", _status(redis_on, "required — low-latency caching"))
            svc_table.add_row("    Merkle", _status(merkle_on, "required — immutable proof integrity"))
            svc_table.add_row("    Gateway", _status(gateway_on, "deployment — network enforcement proxy"))
            svc_table.add_row("    MCP Adapter", _status(mcp_on, "deployment — MCP protocol bridge"))
            
            self.console.print(svc_table)
            self.console.print()
            
            # Defaults
            self.console.print(f"  [{Colors.INFO}]Defaults:[/]")
            self.console.print(f"    Time Window: [{Colors.NEUTRAL}]{config.defaults.time_window}[/]")
            self.console.print()
            
            # Architecture context
            self.console.print(f"  [{Colors.INFO}]Architecture:[/]")
            self.console.print(f"    [{Colors.DIM}]Core: PostgreSQL (always enabled, cannot be disabled)[/]")
            self.console.print(f"    [{Colors.DIM}]Core services: Redis + Merkle are mandatory and always on[/]")
            self.console.print(f"    [{Colors.DIM}]Deploy: Gateway & MCP Adapter are optional services for network[/]")
            self.console.print(f"    [{Colors.DIM}]  or MCP protocol enforcement. They can run on different hosts.[/]")
            self.console.print()
            
        except Exception as e:
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
        
        self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
        input()
    
    def _show_service_health(self) -> None:
        """Show health status of all enabled services."""
        from rich.panel import Panel
        from rich.table import Table
        import socket
        
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Service Health Check[/]",
            title=f"[bold {Colors.INFO}]Service Health[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.config import load_config
            config = load_config()
        except Exception as e:
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Cannot load config: {e}[/]")
            self.console.print()
            self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
            input()
            return
        
        table = Table(show_header=True, header_style=f"bold {Colors.INFO}", padding=(0, 2))
        table.add_column("Service", style=f"bold {Colors.NEUTRAL}")
        table.add_column("Role", style=Colors.DIM)
        table.add_column("Enabled")
        table.add_column("Status")
        table.add_column("Endpoint", style=Colors.DIM)
        
        # Detect if running inside container runtime
        in_container = in_container_runtime()
        
        def _check_tcp(host: str, port: int) -> bool:
            try:
                sock = socket.create_connection((host, port), timeout=2)
                sock.close()
                return True
            except Exception:
                return False
        
        def _resolve_service_host(config_host: str, docker_service_name: str) -> str:
            """Resolve service host based on container context.
            
            When running inside container: translate localhost -> service name.
            When running on host: keep the configured host.
            """
            if in_container and config_host == 'localhost':
                return docker_service_name
            return config_host
        
        def _enabled_str(val: bool) -> str:
            return f"[{Colors.SUCCESS}]Yes[/]" if val else f"[{Colors.DIM}]No[/]"
        
        def _status_str(reachable: bool) -> str:
            if reachable:
                return f"[{Colors.SUCCESS}]{Icons.SUCCESS} Running[/]"
            return f"[{Colors.ERROR}]{Icons.ERROR} Unreachable[/]"
        
        # Database (always checked — core requirement)
        db_checkhost = _resolve_service_host(config.database.host, 'postgres')
        db_ok = _check_tcp(db_checkhost, config.database.port)
        table.add_row("PostgreSQL", "Core", _enabled_str(True), _status_str(db_ok),
                     f"{config.database.host}:{config.database.port}")
        
        # Redis (required)
        redis_host = getattr(config.redis, 'host', 'localhost')
        redis_port = getattr(config.redis, 'port', 6379)
        redis_checkhost = _resolve_service_host(redis_host, 'redis')
        redis_ok = _check_tcp(redis_checkhost, redis_port)
        table.add_row("Redis", "Core", _enabled_str(True), _status_str(redis_ok),
                     f"{redis_host}:{redis_port}")
        
        # Merkle (required)
        key_path = getattr(config.merkle, 'private_key_path', '')
        from pathlib import Path as _P
        key_exists = bool(key_path) and _P(key_path).exists()
        if key_exists:
            merkle_status = f"[{Colors.SUCCESS}]{Icons.SUCCESS} Ready[/]"
        else:
            merkle_status = f"[{Colors.ERROR}]{Icons.ERROR} Key missing[/]"
        table.add_row("Merkle", "Core", _enabled_str(True), merkle_status,
                     key_path or "—")
        
        # Gateway (deployment artifact — separate network enforcement proxy, can run on different host)
        gateway_on = getattr(config.gateway, 'enabled', False)
        if gateway_on:
            gw_addr = getattr(config.gateway, 'listen_address', '')
            if gw_addr and ':' in gw_addr:
                gw_host, _, gw_port_str = gw_addr.rpartition(':')
                gw_port = int(gw_port_str) if gw_port_str.isdigit() else None
                if gw_port is None:
                    table.add_row("Gateway", "Deploy", _enabled_str(True), f"[{Colors.WARNING}]Address invalid[/]", gw_addr)
                else:
                    gw_check_host = 'localhost' if gw_host == '0.0.0.0' else gw_host
                    gw_ok = _check_tcp(gw_check_host, gw_port)
                    table.add_row("Gateway", "Deploy", _enabled_str(True), _status_str(gw_ok), gw_addr)
            else:
                table.add_row("Gateway", "Deploy", _enabled_str(True), f"[{Colors.WARNING}]URL-managed[/]", "Configured remotely")
        else:
            table.add_row("Gateway", "Deploy", _enabled_str(False), f"[{Colors.DIM}]Separate service[/]", "—")
        
        # MCP Adapter (deployment artifact — protocol bridge for MCP environments, can run on different host)
        mcp_on = getattr(config.mcp_adapter, 'enabled', False)
        if mcp_on:
            mcp_addr = getattr(config.mcp_adapter, 'listen_address', '0.0.0.0:8080')
            mcp_host, _, mcp_port_str = mcp_addr.rpartition(':')
            mcp_port = int(mcp_port_str) if mcp_port_str.isdigit() else 8080
            mcp_check_host = 'localhost' if mcp_host == '0.0.0.0' else mcp_host
            mcp_ok = _check_tcp(mcp_check_host, mcp_port)
            table.add_row("MCP Adapter", "Deploy", _enabled_str(True), _status_str(mcp_ok), mcp_addr)
        else:
            table.add_row("MCP Adapter", "Deploy", _enabled_str(False), f"[{Colors.DIM}]Separate service[/]", "—")
        
        self.console.print(table)
        self.console.print()
        
        # Architecture note
        self.console.print(f"  [{Colors.INFO}]Architecture Notes:[/]")
        self.console.print(f"  [{Colors.DIM}]  • PostgreSQL is required (core database)[/]")
        self.console.print(f"  [{Colors.DIM}]  • Redis is required for cache and rate enforcement[/]")
        self.console.print(f"  [{Colors.DIM}]  • Merkle is required for immutable proof integrity[/]")
        self.console.print(f"  [{Colors.DIM}]  • Gateway & MCP Adapter — deployment services[/]")
        self.console.print()
        self.console.print()
        self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
        input()
    
    def _show_shortcuts(self) -> None:
        """Show keyboard shortcuts."""
        from rich.panel import Panel
        from rich.table import Table
        
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Keyboard Shortcuts[/]",
            title=f"[bold {Colors.INFO}]Help[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
        table.add_column("Key", style=f"bold {Colors.HINT}")
        table.add_column("Action", style=Colors.NEUTRAL)
        
        shortcuts = [
            ("↑ / k", "Move up"),
            ("↓ / j", "Move down"),
            ("Enter", "Select / Confirm"),
            ("Tab", "Auto-complete suggestions"),
            ("Esc / q", "Go back / Cancel"),
            ("Ctrl+C", "Exit immediately"),
        ]
        
        for key, action in shortcuts:
            table.add_row(key, action)
        
        self.console.print(table)
        self.console.print()
        self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
        input()
    
    def _show_about(self) -> None:
        """Show about information."""
        from rich.panel import Panel
        from caracal._version import __version__
        
        self.console.print(Panel(
            f"""[{Colors.NEUTRAL}]Caracal Flow - Interactive CLI for Caracal[/]
[{Colors.INFO}]Version:[/] {__version__}
[{Colors.INFO}]License:[/] Apache-2.0
[{Colors.NEUTRAL}]Caracal is a pre-execution authority enforcement system for AI agents,
providing mandate management, policy enforcement, and authority
ledger capabilities.[/]
[{Colors.DIM}]Website: https://github.com/Garudex-Labs/caracal[/]
""",
            title=f"[bold {Colors.INFO}]About Caracal[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
        input()
    
    def _show_cli_fallback(self, group: str, command: str) -> None:
        """Show CLI fallback for unimplemented features."""
        self.console.print()
        if group:
            self.console.print(f"  [{Colors.HINT}]Use the CLI for this feature:[/]")
            self.console.print(f"  [{Colors.DIM}]$ caracal {group} {command} --help[/]")
        else:
            self.console.print(f"  [{Colors.DIM}]This feature will guide you to use the CLI.[/]")
        self.console.print()
        self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
        input()
    
    def _confirm_exit(self) -> bool:
        """Confirm exit from the application."""
        self.console.print()
        self.console.print(f"  [{Colors.WARNING}]Are you sure you want to exit? (y/N)[/] ", end="")
        try:
            response = input().strip().lower()
            return response in ("y", "yes")
        except (KeyboardInterrupt, EOFError):
            return True
    
    def _goodbye(self) -> None:
        """Show goodbye message."""
        self.console.print()
        self.console.print(f"  [{Colors.INFO}]{Icons.SUCCESS} Goodbye! Use 'caracal flow' to return.[/]")
        self.console.print()
    
    
    def _run_edit_config(self) -> None:
        """Open configuration in system editor."""
        import os
        import shutil
        import subprocess
        from caracal.config.settings import get_default_config_path
        
        config_path = get_default_config_path()
        
        # Determine editor
        editor = os.environ.get("EDITOR", "nano")
        if not shutil.which(editor):
            # Fallback if preferred editor not found
            for fallback in ["nano", "vim", "vi", "notepad"]:
                if shutil.which(fallback):
                    editor = fallback
                    break
        
        self.console.clear()
        self.console.print(f"[{Colors.INFO}]Opening configuration in {editor}...[/]")
        self.console.print(f"[{Colors.DIM}]Path: {config_path}[/]")
        
        try:
            # Suspend rich/curses mode to run editor
            subprocess.call([editor, config_path])
            self.console.print(f"[{Colors.SUCCESS}]{Icons.SUCCESS} Editor closed.[/]")
        except Exception as e:
            self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} Failed to open editor: {e}[/]")
        
        self.console.print()
        self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
        input()

    def _save_state(self) -> None:
        """Save application state."""
        try:
            self.persistence.save(self.state)
        except Exception:
            pass  # Silently fail on state save

    def _run_backup_flow(self) -> None:
        """Run data backup flow using pg_dump."""
        import subprocess
        import datetime
        from caracal.config import load_config
        from caracal.flow.workspace import get_workspace
        
        self.console.clear()
        self.console.print(f"[{Colors.INFO}]Create Data Backup (pg_dump)[/]")
        self.console.print()
        
        config = load_config()
        
        # Create backups directory
        backup_dir = get_workspace().backups_dir
        from caracal.pathing import ensure_source_tree
        ensure_source_tree(backup_dir)
        
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_file = backup_dir / f"caracal_backup_{timestamp}.dump"
        
        # Build pg_dump command
        env = {
            "PGPASSWORD": config.database.password or "",
        }
        cmd = [
            "pg_dump",
            "-h", config.database.host or "localhost",
            "-p", str(config.database.port or 5432),
            "-U", config.database.user or "caracal",
            "-d", config.database.database or "caracal",
            "-f", str(backup_file),
            "--format=custom",
            "--compress=9",
        ]
        # If a schema is set, only dump that schema
        schema = getattr(config.database, 'schema', None)
        if schema:
            cmd.extend(["-n", schema])
        
        self.console.print(f"[{Colors.INFO}]{Icons.INFO} Running pg_dump...[/]")
        
        import os
        full_env = {**os.environ, **env}
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=120, env=full_env)
            if result.returncode == 0:
                try:
                    backup_file.chmod(0o600)
                except Exception:
                    pass
                self.console.print(f"[{Colors.SUCCESS}]{Icons.SUCCESS} Backup created successfully![/]")
                self.console.print(f"[{Colors.DIM}]Location: {backup_file}[/]")
            else:
                self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} pg_dump failed: {result.stderr.strip()}[/]")
        except FileNotFoundError:
            self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} pg_dump not found. Install PostgreSQL client tools.[/]")
        except subprocess.TimeoutExpired:
            self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} pg_dump timed out after 120s.[/]")
        except Exception as e:
            self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} Backup failed: {e}[/]")
        
        self.console.print()
        self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
        input()

    def _run_restore_flow(self) -> None:
        """Run data restore flow using pg_restore/psql depending on dump type."""
        import subprocess
        from pathlib import Path
        from caracal.config import load_config
        from caracal.flow.components.menu import Menu, MenuItem
        from caracal.flow.workspace import get_workspace
        
        config = load_config()

        backup_dir = get_workspace().backups_dir
        if not backup_dir.exists():
             self.console.print(f"[{Colors.WARNING}]No backups directory found.[/]")
             input()
             return
             
        backups = sorted(
            list(backup_dir.glob("*.dump")) + list(backup_dir.glob("*.sql")),
            reverse=True,
        )
        if not backups:
             self.console.print(f"[{Colors.WARNING}]No backup files found.[/]")
             input()
             return

        items = []
        for backup in backups:
            items.append(MenuItem(str(backup), backup.name, f"Size: {backup.stat().st_size / 1024:.1f} KB", Icons.FILE))
            
        items.append(MenuItem("back", "Cancel", "", Icons.ARROW_LEFT))
        
        menu = Menu("Select Backup to Restore", items=items)
        result = menu.run()
        
        if result and result.key != "back":
            backup_file = Path(result.key)
            
            self.console.print()
            self.console.print(f"[{Colors.WARNING}]⚠️  WARNING: This will restore the database from backup![/]")
            self.console.print(f"Backup: {backup_file.name}")
            self.console.print("Are you sure? (type 'restore' to confirm)")
            
            confirm = input("> ").strip()
            if confirm == "restore":
                import os
                env = {**os.environ, "PGPASSWORD": config.database.password or ""}
                if backup_file.suffix == ".dump":
                    cmd = [
                        "pg_restore",
                        "-h", config.database.host or "localhost",
                        "-p", str(config.database.port or 5432),
                        "-U", config.database.user or "caracal",
                        "-d", config.database.database or "caracal",
                        "--clean",
                        "--if-exists",
                        "--no-owner",
                        "--no-privileges",
                        str(backup_file),
                    ]
                else:
                    cmd = [
                        "psql",
                        "-h", config.database.host or "localhost",
                        "-p", str(config.database.port or 5432),
                        "-U", config.database.user or "caracal",
                        "-d", config.database.database or "caracal",
                        "-f", str(backup_file),
                    ]
                try:
                    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120, env=env)
                    if proc.returncode == 0:
                        self.console.print(f"[{Colors.SUCCESS}]{Icons.SUCCESS} Database restored successfully.[/]")
                    else:
                        self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} Restore failed: {proc.stderr.strip()}[/]")
                except FileNotFoundError:
                    self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} PostgreSQL restore tool not found. Install PostgreSQL client tools.[/]")
                except subprocess.TimeoutExpired:
                    self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} psql timed out after 120s.[/]")
                except Exception as e:
                    self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} Restore failed: {e}[/]")
            else:
                self.console.print(f"[{Colors.DIM}]Restore cancelled.[/]")
                
            input()
