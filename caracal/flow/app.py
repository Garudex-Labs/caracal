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
            
            if action == "shortcuts":
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
            
            # Storage paths
            self.console.print(f"  [{Colors.INFO}]Storage:[/]")
            self.console.print(f"    Agent Registry: [{Colors.DIM}]{config.storage.agent_registry}[/]")
            self.console.print(f"    Policy Store: [{Colors.DIM}]{config.storage.policy_store}[/]")
            self.console.print(f"    Ledger: [{Colors.DIM}]{config.storage.ledger}[/]")
            self.console.print()
            
            # Database
            self.console.print(f"  [{Colors.INFO}]Database:[/]")
            if config.database.type == "sqlite":
                self.console.print(f"    Type: [{Colors.NEUTRAL}]SQLite (file-based)[/]")
                if config.database.file_path:
                    self.console.print(f"    Path: [{Colors.DIM}]{config.database.file_path}[/]")
            else:
                self.console.print(f"    Type: [{Colors.NEUTRAL}]PostgreSQL[/]")
                self.console.print(f"    Host: [{Colors.DIM}]{config.database.host}:{config.database.port}[/]")
                self.console.print(f"    Database: [{Colors.DIM}]{config.database.database}[/]")
            self.console.print()
            
            # Compatibility mode and enabled services
            self.console.print(f"  [{Colors.INFO}]Services (via compatibility config):[/]")
            mode = getattr(config.compatibility, 'mode', 'v0.3')
            self.console.print(f"    Mode: [{Colors.NEUTRAL}]{mode}[/]")
            
            # Service status table
            svc_table = Table(show_header=False, padding=(0, 2), show_edge=False)
            svc_table.add_column("Service", style=Colors.DIM)
            svc_table.add_column("Status")
            
            kafka_on = getattr(config.compatibility, 'enable_kafka', True)
            redis_on = getattr(config.compatibility, 'enable_redis', True)
            merkle_on = getattr(config.compatibility, 'enable_merkle', False)
            gateway_on = getattr(config.gateway, 'enabled', False)
            mcp_on = getattr(config.mcp_adapter, 'enabled', False)
            
            def _status(enabled: bool, label: str = "") -> str:
                if enabled:
                    return f"[{Colors.SUCCESS}]{Icons.SUCCESS} Enabled[/]{f' ({label})' if label else ''}"
                return f"[{Colors.DIM}]{Icons.ERROR} Disabled[/]{f' ({label})' if label else ''}"
            
            svc_table.add_row("    Kafka", _status(kafka_on, "optional — async event streaming"))
            svc_table.add_row("    Redis", _status(redis_on, "optional — mandate cache & rate limiting"))
            svc_table.add_row("    Merkle", _status(merkle_on, "optional — tamper-proof audit batches"))
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
            self.console.print(f"    [{Colors.DIM}]Core: PostgreSQL (or SQLite) is the only required infrastructure.[/]")
            self.console.print(f"    [{Colors.DIM}]Optional: Kafka, Redis, Merkle enhance performance & audit.[/]")
            self.console.print(f"    [{Colors.DIM}]Deploy: Gateway & MCP Adapter are separate services that wrap[/]")
            self.console.print(f"    [{Colors.DIM}]  core authority logic for network or MCP protocol enforcement.[/]")
            self.console.print(f"    [{Colors.DIM}]  They can run on different hosts / containers.[/]")
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
        
        def _check_tcp(host: str, port: int) -> bool:
            try:
                sock = socket.create_connection((host, port), timeout=2)
                sock.close()
                return True
            except Exception:
                return False
        
        def _enabled_str(val: bool) -> str:
            return f"[{Colors.SUCCESS}]Yes[/]" if val else f"[{Colors.DIM}]No[/]"
        
        def _status_str(reachable: bool) -> str:
            if reachable:
                return f"[{Colors.SUCCESS}]{Icons.SUCCESS} Running[/]"
            return f"[{Colors.ERROR}]{Icons.ERROR} Unreachable[/]"
        
        # Database (always checked — core requirement)
        if config.database.type == "sqlite":
            table.add_row("PostgreSQL", "Core", _enabled_str(False), f"[{Colors.DIM}]N/A (using SQLite)[/]", "—")
        else:
            db_ok = _check_tcp(config.database.host, config.database.port)
            table.add_row("PostgreSQL", "Core", _enabled_str(True), _status_str(db_ok),
                         f"{config.database.host}:{config.database.port}")
        
        # Kafka (optional — async event streaming, core works without it)
        kafka_on = getattr(config.compatibility, 'enable_kafka', True)
        if kafka_on:
            brokers = getattr(config.kafka, 'brokers', ['localhost:9092'])
            broker = brokers[0] if brokers else 'localhost:9092'
            host, _, port_str = broker.rpartition(':')
            port = int(port_str) if port_str.isdigit() else 9092
            host = host or 'localhost'
            kafka_ok = _check_tcp(host, port)
            table.add_row("Kafka", "Optional", _enabled_str(True), _status_str(kafka_ok), broker)
        else:
            table.add_row("Kafka", "Optional", _enabled_str(False), f"[{Colors.DIM}]Skipped[/]", "—")
        
        # Redis (optional — mandate caching and rate limiting, falls back to PostgreSQL)
        redis_on = getattr(config.compatibility, 'enable_redis', True)
        if redis_on:
            redis_host = getattr(config.redis, 'host', 'localhost')
            redis_port = getattr(config.redis, 'port', 6379)
            redis_ok = _check_tcp(redis_host, redis_port)
            table.add_row("Redis", "Optional", _enabled_str(True), _status_str(redis_ok),
                         f"{redis_host}:{redis_port}")
        else:
            table.add_row("Redis", "Optional", _enabled_str(False), f"[{Colors.DIM}]Skipped[/]", "—")
        
        # Gateway (deployment artifact — separate network enforcement proxy, can run on different host)
        gateway_on = getattr(config.gateway, 'enabled', False)
        if gateway_on:
            gw_addr = getattr(config.gateway, 'listen_address', '0.0.0.0:8443')
            gw_host, _, gw_port_str = gw_addr.rpartition(':')
            gw_port = int(gw_port_str) if gw_port_str.isdigit() else 8443
            gw_check_host = 'localhost' if gw_host == '0.0.0.0' else gw_host
            gw_ok = _check_tcp(gw_check_host, gw_port)
            table.add_row("Gateway", "Deploy", _enabled_str(True), _status_str(gw_ok), gw_addr)
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
        self.console.print(f"  [{Colors.DIM}]  • PostgreSQL is the only required service for core authority enforcement[/]")
        self.console.print(f"  [{Colors.DIM}]  • Kafka, Redis, Merkle are optional enhancements (disable in config.yaml → compatibility section)[/]")
        self.console.print(f"  [{Colors.DIM}]  • Gateway & MCP Adapter are separate deployment services — they wrap core logic[/]")
        self.console.print(f"  [{Colors.DIM}]    for network-layer or MCP-protocol enforcement and can run on different hosts[/]")
        self.console.print()
        self.console.print(f"  [{Colors.HINT}]Edit config.yaml to enable/disable services:[/]")
        self.console.print(f"  [{Colors.DIM}]  compatibility.enable_kafka, compatibility.enable_redis, compatibility.enable_merkle[/]")
        self.console.print(f"  [{Colors.DIM}]  gateway.enabled, mcp_adapter.enabled[/]")
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
        from pathlib import Path
        
        # Locate the docker-compose file
        compose_file = None
        for candidate in [
            Path.cwd() / "docker-compose.yml",
            Path(__file__).resolve().parent.parent.parent / "docker-compose.yml",
        ]:
            if candidate.exists():
                compose_file = candidate
                break
        
        while True:
            self.console.clear()
            
            if compose_file:
                self.console.print(f"  [{Colors.DIM}]Compose file: {compose_file}[/]")
            else:
                self.console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No docker-compose.yml found[/]")
            self.console.print()
            
            # Determine which optional services are enabled
            kafka_enabled = False
            redis_enabled = False
            try:
                from caracal.config import load_config
                config = load_config()
                kafka_enabled = getattr(config.compatibility, 'enable_kafka', True)
                redis_enabled = getattr(config.compatibility, 'enable_redis', True)
            except Exception:
                pass
            
            # Core infrastructure
            items = [
                MenuItem("postgres", "Start PostgreSQL", "Core database (required)", ""),
            ]
            
            # Optional services — only shown if enabled in config
            if redis_enabled:
                items.append(MenuItem("redis", "Start Redis", "Optional: mandate caching & rate limiting", ""))
            if kafka_enabled:
                items.append(MenuItem("kafka-stack", "Start Kafka Stack",
                                     "Optional: event streaming (kafka + zookeeper + schema-registry)", ""))
            
            items.extend([
                MenuItem("core-stack", "Start Core Stack",
                         "PostgreSQL" + (", Redis" if redis_enabled else "") + " (what's enabled)", ""),
                MenuItem("down", "Stop All Services", "Stop and remove all containers", ""),
                MenuItem("back", "Back to Settings", "", Icons.ARROW_LEFT),
            ])
            
            menu = Menu("Infrastructure Setup", items=items)
            result = menu.run()
            
            if not result or result.key == "back":
                break
            
            # Build docker compose command
            base_cmd = ["docker", "compose"]
            if compose_file:
                base_cmd = ["docker", "compose", "-f", str(compose_file)]
            
            services = []
            if result.key == "postgres":
                services = ["postgres"]
            elif result.key == "redis":
                services = ["redis"]
            elif result.key == "kafka-stack":
                services = ["zookeeper", "kafka", "schema-registry"]
            elif result.key == "core-stack":
                services = ["postgres"]
                if redis_enabled:
                    services.append("redis")
            elif result.key == "down":
                cmd = base_cmd + ["down"]
                self.console.print()
                self.console.print(f"[{Colors.INFO}]Running: {' '.join(cmd)}[/]")
                try:
                    subprocess.run(cmd, check=True)
                    self.console.print(f"[{Colors.SUCCESS}]{Icons.SUCCESS} All services stopped.[/]")
                except subprocess.CalledProcessError as e:
                    self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} Command failed: {e}[/]")
                except FileNotFoundError:
                    self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} 'docker' not found in PATH.[/]")
                self.console.print()
                self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
                input()
                continue
            
            if services:
                cmd = base_cmd + ["up", "-d"] + services
                self.console.print()
                self.console.print(f"[{Colors.INFO}]Running: {' '.join(cmd)}[/]")
                try:
                    subprocess.run(cmd, check=True)
                    self.console.print(f"[{Colors.SUCCESS}]{Icons.SUCCESS} Services started: {', '.join(services)}[/]")
                except subprocess.CalledProcessError as e:
                    self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} Command failed: {e}[/]")
                    self.console.print(f"  [{Colors.HINT}]Make sure Docker is running and the compose file defines these services.[/]")
                except FileNotFoundError:
                    self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} 'docker' not found in PATH. Install Docker first.[/]")
            
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
