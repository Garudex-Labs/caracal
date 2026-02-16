"""
Caracal Flow Application Controller.

Main application class orchestrating the TUI experience:
- Application lifecycle (start, run, exit)
- State management
- Screen navigation
"""

from typing import Optional

from rich.console import Console

from caracal.flow.state import FlowState, StatePersistence
from caracal.flow.theme import FLOW_THEME, Colors, Icons
from caracal.flow.screens.welcome import show_welcome, wait_for_action
from caracal.flow.screens.main_menu import show_main_menu, show_submenu
from caracal.flow.screens.onboarding import run_onboarding


class FlowApp:
    """Main Caracal Flow application."""
    
    def __init__(self, console: Optional[Console] = None):
        # Suppress debug/info log output that pollutes the TUI.
        # Must use setup_logging() because structlog's default config
        # bypasses standard library logging entirely.
        from caracal.logging_config import setup_logging
        setup_logging(level="WARNING", json_format=False)
        
        self.console = console or Console(theme=FLOW_THEME)
        self.persistence = StatePersistence()
        self.state = self.persistence.load()
        self._running = False
    
    def start(self) -> None:
        """Start the application."""
        self._running = True
        
        try:
            # Show welcome screen
            show_welcome(self.console, compact=self.state.preferences.compact_mode)
            
            # Wait for user action
            action = wait_for_action(self.console)
            
            if action == "quit":
                self._goodbye()
                return
            
            # Always run onboarding (starts with workspace selection)
            onboarding_result = run_onboarding(self.console, self.state)
            
            # CRITICAL: Ensure workspace was properly configured before proceeding
            # Without a workspace, there's nowhere to store configuration and data
            if not onboarding_result.get("workspace_configured", False):
                self.console.print()
                self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Setup incomplete. Workspace configuration is required.[/]")
                self.console.print(f"  [{Colors.INFO}]{Icons.INFO} Please run 'caracal-flow' again to set up your workspace.[/]")
                self.console.print()
                self._goodbye()
                return
            
            # Verify workspace is accessible
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
            
            # Main loop
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
            
            # Show main menu
            selection = show_main_menu(self.console)
            
            if selection is None:
                # User quit
                if self._confirm_exit():
                    self._goodbye()
                    break
                continue
            
            # Handle selection
            self._handle_selection(selection)
    
    def _handle_selection(self, selection: str) -> None:
        """Handle main menu selection."""
        handlers = {
            "principals": self._run_principal_flow,
            "policies": self._run_authority_policy_flow,
            "ledger": self._run_authority_ledger_flow,
            "mandates": self._run_mandate_flow,
            "delegation": self._run_mandate_delegation_flow,
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
            elif action == "infra":
                self._run_infra_actions()
            elif action == "db-status":
                self._show_db_status()
            elif action == "kafka-status":
                self._show_kafka_status()
            elif action == "services-status":
                self._show_services_status()
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
            
            if action == "shortcuts":
                self._show_shortcuts()
            elif action == "about":
                self._show_about()
            else:
                self._show_cli_fallback("", action)
    
    def _show_current_config(self) -> None:
        """Display current configuration."""
        from rich.panel import Panel
        
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Current Caracal Configuration[/]",
            title=f"[bold {Colors.INFO}]Settings[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.config import load_config
            
            config = load_config()
            
            self.console.print(f"  [{Colors.INFO}]Storage:[/]")
            self.console.print(f"    Agent Registry: [{Colors.DIM}]{config.storage.agent_registry}[/]")
            self.console.print(f"    Policy Store: [{Colors.DIM}]{config.storage.policy_store}[/]")
            self.console.print(f"    Ledger: [{Colors.DIM}]{config.storage.ledger}[/]")
            self.console.print()
            
            self.console.print(f"  [{Colors.INFO}]Defaults:[/]")
            self.console.print(f"    Time Window: [{Colors.NEUTRAL}]{config.defaults.time_window}[/]")
            self.console.print()
            
        except Exception as e:
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
        
        self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
        input()
    
    def _show_db_status(self) -> None:
        """Show database connection status."""
        from rich.panel import Panel
        import socket
        
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Database Connection Status[/]",
            title=f"[bold {Colors.INFO}]Database[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        try:
            from caracal.config import load_config
            
            config = load_config()
            
            # Check if database is configured (non-default)
            is_configured = config.database and (config.database.password or config.database.host != "localhost")
            
            if is_configured:
                self.console.print(f"  [{Colors.INFO}]Database Type:[/] PostgreSQL")
                self.console.print(f"  [{Colors.INFO}]Host:[/] {config.database.host}:{config.database.port}")
                self.console.print(f"  [{Colors.INFO}]Database:[/] {config.database.database}")
                self.console.print()
                
                # Check TCP connection
                self.console.print(f"  [{Colors.INFO}]Testing connection...[/]")
                try:
                    sock = socket.create_connection((config.database.host, config.database.port), timeout=2)
                    sock.close()
                    self.console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Connection OK[/]")
                except Exception as e:
                    self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Connection Failed: {e}[/]")
                    self.console.print(f"  [{Colors.ERROR}]PostgreSQL is not reachable. Fix the issue or re-run onboarding.[/]")
                    self.console.print(f"  [{Colors.DIM}]Caracal will NOT fall back to SQLite when PostgreSQL is configured.[/]")
            else:
                self.console.print(f"  [{Colors.INFO}]Storage Mode:[/] File-based")
                self.console.print(f"  [{Colors.DIM}]PostgreSQL not configured[/]")
            
        except Exception as e:
            self.console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
        
        self.console.print()
        self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
        input()

    def _show_kafka_status(self) -> None:
        """Show Kafka and Zookeeper connection status."""
        from rich.panel import Panel
        import socket
        
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Kafka Infrastructure Status[/]",
            title=f"[bold {Colors.INFO}]Kafka & Zookeeper[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        services = [
            ("Zookeeper", "localhost", 2181),
            ("Kafka", "localhost", 9092),
        ]
        
        for name, host, port in services:
            try:
                sock = socket.create_connection((host, port), timeout=2)
                sock.close()
                self.console.print(f"  [{Colors.INFO}]{name}:[/] [{Colors.SUCCESS}]{Icons.SUCCESS} Running[/] ({host}:{port})")
            except Exception:
                self.console.print(f"  [{Colors.INFO}]{name}:[/] [{Colors.ERROR}]{Icons.ERROR} Unreachable[/] ({host}:{port})")
        
        self.console.print()
        self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
        input()

    def _show_services_status(self) -> None:
        """Show other services status."""
        from rich.panel import Panel
        import socket
        
        self.console.print(Panel(
            f"[{Colors.NEUTRAL}]Additional Services Status[/]",
            title=f"[bold {Colors.INFO}]Services[/]",
            border_style=Colors.PRIMARY,
        ))
        self.console.print()
        
        services = [
            ("Redis", "localhost", 6379),
            ("Schema Registry", "localhost", 8081),
            ("Gateway", "localhost", 8443),
        ]
        
        for name, host, port in services:
            try:
                sock = socket.create_connection((host, port), timeout=2)
                sock.close()
                self.console.print(f"  [{Colors.INFO}]{name}:[/] [{Colors.SUCCESS}]{Icons.SUCCESS} Running[/] ({host}:{port})")
            except Exception:
                self.console.print(f"  [{Colors.INFO}]{name}:[/] [{Colors.ERROR}]{Icons.ERROR} Unreachable[/] ({host}:{port})")
        
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
[{Colors.INFO}]License:[/] AGPL-3.0
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
        self.console.print(f"  [{Colors.INFO}]{Icons.SUCCESS} Goodbye! Use 'caracal-flow' to return.[/]")
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

    def _run_infra_actions(self) -> None:
        """Run infrastructure management actions."""
        from caracal.flow.components.menu import Menu, MenuItem
        import subprocess
        
        while True:
            self.console.clear()
            
            items = [
                MenuItem("up", "Start All Services", "Start Postgres, Kafka, etc.", ""),
                MenuItem("down", "Stop All Services", "Stop and remove containers", ""),
                MenuItem("postgres", "Start Postgres Only", "Start only database", ""),
                MenuItem("kafka", "Start Kafka Only", "Start only message bus", ""),
                MenuItem("back", "Back to Settings", "", Icons.ARROW_LEFT),
            ]
            
            menu = Menu("Infrastructure Setup", items=items)
            result = menu.run()
            
            if not result or result.key == "back":
                break
            
            # Execute command
            cmd = []
            if result.key == "up":
                cmd = ["docker", "compose", "up", "-d"]
            elif result.key == "down":
                cmd = ["docker", "compose", "down"]
            elif result.key == "postgres":
                cmd = ["docker", "compose", "up", "-d", "postgres"]
            elif result.key == "kafka":
                cmd = ["docker", "compose", "up", "-d", "kafka", "zookeeper"]
            
            self.console.print()
            self.console.print(f"[{Colors.INFO}]Running: {' '.join(cmd)}[/]")
            
            try:
                subprocess.run(cmd, check=True)
                self.console.print(f"[{Colors.SUCCESS}]{Icons.SUCCESS} Command completed successfully.[/]")
            except subprocess.CalledProcessError as e:
                self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} Command failed: {e}[/]")
            except FileNotFoundError:
                self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} 'docker' command not found in PATH.[/]")
            
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
        """Run data backup flow."""
        import shutil
        import datetime
        from pathlib import Path
        from caracal.config import load_config
        
        self.console.clear()
        self.console.print(f"[{Colors.INFO}]Create Data Backup[/]")
        self.console.print()
        
        config = load_config()
        
        if config.database.type != "sqlite":
            self.console.print(f"[{Colors.WARNING}]{Icons.WARNING} Backup is currently optimized for SQLite.[/]")
            self.console.print(f"[{Colors.DIM}]For Docker/Postgres, please use standard docker volume backup tools.[/]")
            self.console.print()
            self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
            input()
            return

        db_path = Path(config.database.file_path)
        if not db_path.exists():
            self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} Database file not found at {db_path}[/]")
            input()
            return
            
        # Create backups directory
        from caracal.flow.workspace import get_workspace
        backup_dir = get_workspace().backups_dir
        backup_dir.mkdir(parents=True, exist_ok=True)
        
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_file = backup_dir / f"caracal_backup_{timestamp}.db"
        
        try:
            shutil.copy2(db_path, backup_file)
            self.console.print(f"[{Colors.SUCCESS}]{Icons.SUCCESS} Backup created successfully![/]")
            self.console.print(f"[{Colors.DIM}]Location: {backup_file}[/]")
        except Exception as e:
             self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} Backup failed: {e}[/]")
             
        self.console.print()
        self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
        input()

    def _run_restore_flow(self) -> None:
        """Run data restore flow."""
        import shutil
        from pathlib import Path
        from caracal.config import load_config
        from caracal.flow.components.menu import Menu, MenuItem
        
        config = load_config()
        if config.database.type != "sqlite":
             self.console.print(f"[{Colors.WARNING}]{Icons.WARNING} Restore is only available for SQLite currently.[/]")
             input()
             return

        from caracal.flow.workspace import get_workspace
        backup_dir = get_workspace().backups_dir
        if not backup_dir.exists():
             self.console.print(f"[{Colors.WARNING}]No backups found directory created.[/]")
             input()
             return
             
        backups = sorted(list(backup_dir.glob("*.db")), reverse=True)
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
            target_file = Path(config.database.file_path)
            
            self.console.print()
            self.console.print(f"[{Colors.WARNING}]⚠️  WARNING: This will overwrite your current database![/]")
            self.console.print(f"Target: {target_file}")
            self.console.print("Are you sure? (type 'restore' to confirm)")
            
            confirm = input("> ").strip()
            if confirm == "restore":
                try:
                    # Create safety backup of current state
                    safety_backup = target_file.with_suffix(".bak")
                    if target_file.exists():
                        shutil.copy2(target_file, safety_backup)
                    
                    shutil.copy2(backup_file, target_file)
                    self.console.print(f"[{Colors.SUCCESS}]{Icons.SUCCESS} Database restored successfully.[/]")
                except Exception as e:
                    self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} Restore failed: {e}[/]")
            else:
                self.console.print("[{Colors.DIM}]Restore cancelled.[/]")
                
            input()
