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
            elif action == "configure-services":
                self._configure_services()
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
            self.console.print(f"    Type: [{Colors.NEUTRAL}]PostgreSQL[/]")
            self.console.print(f"    Host: [{Colors.DIM}]{config.database.host}:{config.database.port}[/]")
            self.console.print(f"    Database: [{Colors.DIM}]{config.database.database}[/]")
            self.console.print()
            
            # Services and version
            from pathlib import Path as P
            version = "unknown"
            for vf in [
                P(__file__).resolve().parent.parent.parent / "VERSION",
                P.cwd() / "VERSION",
            ]:
                if vf.exists():
                    version = vf.read_text().strip()
                    break
            
            self.console.print(f"  [{Colors.INFO}]Services:[/]")
            self.console.print(f"    Version: [{Colors.NEUTRAL}]{version}[/]")
            
            # Service status table
            svc_table = Table(show_header=False, padding=(0, 2), show_edge=False)
            svc_table.add_column("Service", style=Colors.DIM)
            svc_table.add_column("Status")
            
            # Read raw config.yaml to get what the user actually set,
            # not the post-validation state (which may auto-disable merkle)
            _raw_merkle_on = False
            try:
                import yaml as _yaml
                from caracal.config.settings import get_default_config_path
                with open(P(get_default_config_path()), 'r') as _cf:
                    _raw = _yaml.safe_load(_cf) or {}
                _raw_merkle_on = _raw.get('compatibility', {}).get('enable_merkle', False)
            except Exception:
                pass

            redis_on = getattr(config.compatibility, 'enable_redis', False)
            merkle_on = _raw_merkle_on and getattr(config.compatibility, 'enable_merkle', False)
            merkle_pending = _raw_merkle_on and not merkle_on
            gateway_on = getattr(config.gateway, 'enabled', False)
            mcp_on = getattr(config.mcp_adapter, 'enabled', False)
            
            def _status(enabled: bool, label: str = "") -> str:
                if enabled:
                    return f"[{Colors.SUCCESS}]{Icons.SUCCESS} Enabled[/]{f' ({label})' if label else ''}"
                return f"[{Colors.DIM}]{Icons.ERROR} Disabled[/]{f' ({label})' if label else ''}"
            
            svc_table.add_row("    PostgreSQL", f"[{Colors.SUCCESS}]{Icons.SUCCESS} Always On[/] (core database — required)")
            svc_table.add_row("    Redis", _status(redis_on, "optional — caching (recommended)"))
            if merkle_pending:
                svc_table.add_row("    Merkle", f"[{Colors.WARNING}]{Icons.WARNING} Pending[/] (enabled — key not configured)")
            else:
                svc_table.add_row("    Merkle", _status(merkle_on, "optional — cryptographic audit"))
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
            self.console.print(f"    [{Colors.DIM}]Optional: Redis (caching), Merkle (audit) - toggle in 'Configure Services'[/]")
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
        db_ok = _check_tcp(config.database.host, config.database.port)
        table.add_row("PostgreSQL", "Core", _enabled_str(True), _status_str(db_ok),
                     f"{config.database.host}:{config.database.port}")
        
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
        
        # Merkle (optional — cryptographic audit trails)
        # Read raw config to see if user intended merkle to be on
        import yaml as _yaml_health
        _raw_merkle_on = False
        try:
            from caracal.config.settings import get_default_config_path
            with open(get_default_config_path(), 'r') as _cf:
                _raw_cfg = _yaml_health.safe_load(_cf) or {}
            _raw_merkle_on = _raw_cfg.get('compatibility', {}).get('enable_merkle', False)
        except Exception:
            pass
        
        merkle_on = getattr(config.compatibility, 'enable_merkle', False)
        if merkle_on:
            key_path = getattr(config.merkle, 'private_key_path', '')
            from pathlib import Path as _P
            key_exists = bool(key_path) and _P(key_path).exists()
            if key_exists:
                merkle_status = f"[{Colors.SUCCESS}]{Icons.SUCCESS} Ready[/]"
            else:
                merkle_status = f"[{Colors.WARNING}]{Icons.WARNING} Key missing[/]"
            table.add_row("Merkle", "Optional", _enabled_str(True), merkle_status,
                         key_path or "—")
        elif _raw_merkle_on:
            table.add_row("Merkle", "Optional", f"[{Colors.WARNING}]Pending[/]",
                         f"[{Colors.WARNING}]{Icons.WARNING} Key not configured[/]", "—")
        else:
            table.add_row("Merkle", "Optional", _enabled_str(False), f"[{Colors.DIM}]Skipped[/]", "—")
        
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
        self.console.print(f"  [{Colors.DIM}]  • PostgreSQL is required (core database)[/]")
        self.console.print(f"  [{Colors.DIM}]  • Redis (optional) — caching for performance[/]")
        self.console.print(f"  [{Colors.DIM}]  • Merkle (optional) — cryptographic audit trails[/]")
        self.console.print(f"  [{Colors.DIM}]  • Gateway & MCP Adapter — deployment services[/]")
        self.console.print()
        self.console.print(f"  [{Colors.HINT}]Toggle services in Settings → Configure Services[/]")
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

    def _configure_services(self) -> None:
        """Interactive menu to enable/disable optional services."""
        from caracal.flow.components.menu import Menu, MenuItem
        from caracal.config.settings import get_default_config_path
        import yaml
        from pathlib import Path
        
        config_path = Path(get_default_config_path())
        
        while True:
            self.console.clear()
            self.console.print(f"[{Colors.INFO}]Configure Optional Services[/]")
            self.console.print()
            self.console.print(f"  [{Colors.DIM}]PostgreSQL is always required and cannot be disabled.[/]")
            self.console.print(f"  [{Colors.DIM}]Toggle optional services below:[/]")
            self.console.print()
            
            # Load current config
            try:
                with open(config_path, 'r') as f:
                    config_data = yaml.safe_load(f) or {}
            except FileNotFoundError:
                config_data = {}
            
            # Get current service states
            compatibility = config_data.get('compatibility', {})
            redis_enabled = compatibility.get('enable_redis', False)
            merkle_enabled = compatibility.get('enable_merkle', False)
            
            # Check if merkle key exists
            merkle_cfg = config_data.get('merkle', {})
            merkle_key_path = merkle_cfg.get('private_key_path', '')
            merkle_has_key = bool(merkle_key_path) and Path(merkle_key_path).exists()
            
            # Merkle label
            if merkle_enabled and merkle_has_key:
                merkle_label = "[green]Enabled[/]"
            elif merkle_enabled and not merkle_has_key:
                merkle_label = f"[{Colors.WARNING}]Pending (key missing)[/]"
            else:
                merkle_label = "[dim]Disabled[/]"
            
            # Build menu
            items = [
                MenuItem(
                    "redis", 
                    f"Redis: {'[green]Enabled[/]' if redis_enabled else '[dim]Disabled[/]'}", 
                    "Toggle Redis (caching & rate limiting)", 
                    ""
                ),
                MenuItem(
                    "merkle", 
                    f"Merkle Tree: {merkle_label}", 
                    "Toggle Merkle cryptographic audit", 
                    ""
                ),
                MenuItem("back", "Back to Settings", "", Icons.ARROW_LEFT),
            ]
            
            menu = Menu("Optional Services", items=items)
            result = menu.run()
            
            if not result or result.key == "back":
                break
            
            # Toggle the selected service
            if result.key == "redis":
                compatibility['enable_redis'] = not redis_enabled
                status = "enabled" if not redis_enabled else "disabled"
                self.console.print(f"[{Colors.SUCCESS}]{Icons.SUCCESS} Redis {status}[/]")
            elif result.key == "merkle":
                new_merkle = not merkle_enabled
                compatibility['enable_merkle'] = new_merkle
                
                if new_merkle:
                    # Auto-generate signing key if not present
                    key_ok = self._ensure_merkle_key(config_data, config_path)
                    if key_ok:
                        self.console.print(f"[{Colors.SUCCESS}]{Icons.SUCCESS} Merkle Tree enabled[/]")
                    else:
                        self.console.print(f"[{Colors.WARNING}]{Icons.WARNING} Merkle enabled but key generation failed[/]")
                else:
                    self.console.print(f"[{Colors.SUCCESS}]{Icons.SUCCESS} Merkle Tree disabled[/]")
            
            # Save updated config
            config_data['compatibility'] = compatibility
            try:
                config_path.parent.mkdir(parents=True, exist_ok=True)
                with open(config_path, 'w') as f:
                    yaml.dump(config_data, f, default_flow_style=False, sort_keys=False)
                self.console.print(f"[{Colors.SUCCESS}]Configuration saved to {config_path}[/]")
            except Exception as e:
                self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} Failed to save config: {e}[/]")
            
            self.console.print()
            self.console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
            input()

    def _ensure_merkle_key(self, config_data: dict, config_path) -> bool:
        """Generate an EC P-256 signing key for Merkle if one doesn't exist."""
        from pathlib import Path
        
        merkle_cfg = config_data.setdefault('merkle', {})
        key_path_str = merkle_cfg.get('private_key_path', '')
        
        if key_path_str and Path(key_path_str).exists():
            return True  # Key already exists
        
        try:
            from cryptography.hazmat.primitives.asymmetric import ec
            from cryptography.hazmat.primitives import serialization
        except ImportError:
            # Fallback: use openssl CLI
            return self._ensure_merkle_key_openssl(merkle_cfg, config_path)
        
        # Determine key storage path
        keys_dir = config_path.parent / "keys"
        keys_dir.mkdir(parents=True, exist_ok=True)
        key_file = keys_dir / "merkle_signing_key.pem"
        
        try:
            private_key = ec.generate_private_key(ec.SECP256R1())
            pem = private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption(),
            )
            key_file.write_bytes(pem)
            key_file.chmod(0o600)
            
            merkle_cfg['private_key_path'] = str(key_file)
            merkle_cfg.setdefault('signing_backend', 'software')
            merkle_cfg.setdefault('signing_algorithm', 'ES256')
            
            self.console.print(f"[{Colors.SUCCESS}]{Icons.SUCCESS} Generated signing key: {key_file}[/]")
            return True
        except Exception as e:
            self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} Key generation failed: {e}[/]")
            return False

    def _ensure_merkle_key_openssl(self, merkle_cfg: dict, config_path) -> bool:
        """Fallback: generate merkle key using openssl CLI."""
        import subprocess
        from pathlib import Path
        
        keys_dir = config_path.parent / "keys"
        keys_dir.mkdir(parents=True, exist_ok=True)
        key_file = keys_dir / "merkle_signing_key.pem"
        
        try:
            subprocess.run(
                ["openssl", "ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", str(key_file)],
                check=True, capture_output=True, timeout=10,
            )
            key_file.chmod(0o600)
            
            merkle_cfg['private_key_path'] = str(key_file)
            merkle_cfg.setdefault('signing_backend', 'software')
            merkle_cfg.setdefault('signing_algorithm', 'ES256')
            
            self.console.print(f"[{Colors.SUCCESS}]{Icons.SUCCESS} Generated signing key (openssl): {key_file}[/]")
            return True
        except Exception as e:
            self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} openssl key generation failed: {e}[/]")
            return False

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
        from pathlib import Path
        from caracal.config import load_config
        from caracal.flow.workspace import get_workspace
        
        self.console.clear()
        self.console.print(f"[{Colors.INFO}]Create Data Backup (pg_dump)[/]")
        self.console.print()
        
        config = load_config()
        
        # Create backups directory
        backup_dir = get_workspace().backups_dir
        backup_dir.mkdir(parents=True, exist_ok=True)
        
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_file = backup_dir / f"caracal_backup_{timestamp}.sql"
        
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
            "--format=plain",
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
        """Run data restore flow using psql."""
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
             
        backups = sorted(list(backup_dir.glob("*.sql")), reverse=True)
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
                    self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} psql not found. Install PostgreSQL client tools.[/]")
                except subprocess.TimeoutExpired:
                    self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} psql timed out after 120s.[/]")
                except Exception as e:
                    self.console.print(f"[{Colors.ERROR}]{Icons.ERROR} Restore failed: {e}[/]")
            else:
                self.console.print(f"[{Colors.DIM}]Restore cancelled.[/]")
                
            input()
