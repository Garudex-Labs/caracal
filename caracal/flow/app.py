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
            
            if action == "new" or not self.state.onboarding.completed:
                # Run onboarding
                run_onboarding(self.console, self.state)
            
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
            "agents": self._run_agent_flow,
            "policies": self._run_policy_flow,
            "ledger": self._run_ledger_flow,
            "pricebook": self._run_pricebook_flow,
            "delegation": self._run_delegation_flow,
            "settings": self._run_settings_flow,
            "help": self._run_help_flow,
        }
        
        handler = handlers.get(selection)
        if handler:
            handler()
    
    def _run_agent_flow(self) -> None:
        """Run agent management flow."""
        from caracal.flow.screens.agent_flow import run_agent_flow
        run_agent_flow(self.console, self.state)
    
    def _run_policy_flow(self) -> None:
        """Run policy management flow."""
        from caracal.flow.screens.policy_flow import run_policy_flow
        run_policy_flow(self.console, self.state)
    
    def _run_ledger_flow(self) -> None:
        """Run ledger explorer flow."""
        from caracal.flow.screens.ledger_flow import run_ledger_flow
        run_ledger_flow(self.console)
    
    def _run_pricebook_flow(self) -> None:
        """Run pricebook editor flow."""
        from caracal.flow.screens.pricebook_flow import run_pricebook_flow
        run_pricebook_flow(self.console)
    
    def _run_delegation_flow(self) -> None:
        """Run delegation center flow."""
        from caracal.flow.screens.delegation_flow import run_delegation_flow
        run_delegation_flow(self.console)
    
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
            self.console.print(f"    Currency: [{Colors.NEUTRAL}]{config.defaults.currency}[/]")
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
                    self.console.print(f"  [{Colors.WARNING}]System will auto-fallback to SQLite if Postgres is unavailable.[/]")
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
[{Colors.NEUTRAL}]Caracal is an economic control plane for AI agents,
providing budget enforcement, metering, and ledger
management.[/]
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
