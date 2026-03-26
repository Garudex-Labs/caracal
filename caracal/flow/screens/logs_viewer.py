"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Logs Viewer Screen.

Provides log viewing:
- View application logs
- View sync logs
- Filter by level
- Search logs
- Tail logs in real-time
"""

from typing import Optional
from pathlib import Path
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.prompt import Prompt
from rich.syntax import Syntax

from caracal.flow.theme import Colors, Icons
from caracal.flow.state import FlowState
from caracal.flow.components.menu import Menu, MenuItem
from caracal.flow.workspace import get_workspace


def _candidate_log_paths(filename: str) -> list[Path]:
    """Return likely log file locations in priority order."""
    candidates: list[Path] = []

    # Primary: active workspace log directory.
    try:
        candidates.append(get_workspace().logs_dir / filename)
    except Exception:
        pass

    # Configured app log path (typically caracal.log).
    if filename == "caracal.log":
        try:
            from caracal.config import load_config

            config = load_config()
            configured = Path(config.logging.file).expanduser()
            candidates.append(configured)
        except Exception:
            pass

    # Legacy/global locations from older layouts.
    home = Path.home()
    candidates.append(home / ".caracal" / "logs" / filename)
    candidates.append(home / ".caracal" / filename)

    # De-duplicate while preserving order.
    deduped: list[Path] = []
    seen: set[str] = set()
    for path in candidates:
        key = str(path.expanduser())
        if key in seen:
            continue
        seen.add(key)
        deduped.append(Path(key))

    return deduped


def _resolve_log_path(filename: str) -> Optional[Path]:
    """Return the first existing log file path, if any."""
    for path in _candidate_log_paths(filename):
        if path.exists() and path.is_file():
            return path
    return None


def show_logs_viewer(console: Console, state: FlowState) -> None:
    """
    Display logs viewer interface.
    
    CLI Equivalent: tail -f ~/.caracal/workspaces/<workspace>/logs/*.log
    """
    while True:
        console.clear()
        
        # Show header
        console.print(Panel(
            f"[{Colors.PRIMARY}]Logs Viewer[/]",
            subtitle=f"[{Colors.HINT}]View application and sync logs[/]",
            border_style=Colors.INFO,
        ))
        console.print()
        
        # Build menu
        items = [
            MenuItem("app", "Application Logs", "View caracal.log", Icons.FILE),
            MenuItem("sync", "Sync Logs", "View sync.log", Icons.SYNC),
            MenuItem("search", "Search Logs", "Search for specific entries", Icons.SEARCH),
            MenuItem("tail", "Tail Logs", "Follow logs in real-time", Icons.STREAM),
            MenuItem("back", "Back to Menu", "", Icons.ARROW_LEFT),
        ]
        
        menu = Menu("Log Options", items=items)
        result = menu.run()
        
        if not result or result.key == "back":
            break
        
        # Handle selection
        if result.key == "app":
            _view_log_file(console, "caracal.log", "Application Logs")
        elif result.key == "sync":
            _view_log_file(console, "sync.log", "Sync Logs")
        elif result.key == "search":
            _search_logs(console, state)
        elif result.key == "tail":
            _tail_logs(console, state)


def _view_log_file(console: Console, filename: str, title: str) -> None:
    """View a log file."""
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]{title}[/]",
        subtitle=f"[{Colors.HINT}]Showing last 50 lines[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        # Resolve log path from active workspace and known fallback locations.
        log_path = _resolve_log_path(filename)
        
        if log_path is None:
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No {filename} file found yet.[/]")
            console.print(f"  [{Colors.DIM}]Checked:[/]")
            for candidate in _candidate_log_paths(filename):
                console.print(f"    [{Colors.DIM}]- {candidate}[/]")
            console.print()
            console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
            input()
            return
        
        # Read last 50 lines
        with open(log_path, 'r') as f:
            lines = f.readlines()
            last_lines = lines[-50:] if len(lines) > 50 else lines

        if not last_lines:
            console.print(f"  [{Colors.DIM}]No log entries yet in {log_path}[/]")
            console.print()
            console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
            input()
            return
        
        # Color code by log level
        for line in last_lines:
            if 'ERROR' in line:
                console.print(f"[{Colors.ERROR}]{line.rstrip()}[/]")
            elif 'WARNING' in line:
                console.print(f"[{Colors.WARNING}]{line.rstrip()}[/]")
            elif 'INFO' in line:
                console.print(f"[{Colors.INFO}]{line.rstrip()}[/]")
            elif 'DEBUG' in line:
                console.print(f"[{Colors.DIM}]{line.rstrip()}[/]")
            else:
                console.print(f"[{Colors.NEUTRAL}]{line.rstrip()}[/]")
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error reading log file: {e}[/]")
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _search_logs(console: Console, state: FlowState) -> None:
    """Search logs for specific entries."""
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Search Logs[/]",
        subtitle=f"[{Colors.HINT}]Search application and sync logs[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        # Prompt for search term
        search_term = Prompt.ask(f"[{Colors.INFO}]Search term[/]")
        
        if not search_term:
            return
        
        # Search in both log files
        log_dir = get_workspace().logs_dir
        results = []
        
        for log_file in log_dir.glob("*.log"):
            try:
                with open(log_file, 'r') as f:
                    for line_num, line in enumerate(f, 1):
                        if search_term.lower() in line.lower():
                            results.append((log_file.name, line_num, line.rstrip()))
            except Exception:
                pass
        
        console.print()
        if not results:
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No matches found for: {search_term}[/]")
        else:
            console.print(f"  [{Colors.SUCCESS}]Found {len(results)} matches:[/]")
            console.print()
            
            # Show first 20 results
            for log_file, line_num, line in results[:20]:
                console.print(f"  [{Colors.DIM}]{log_file}:{line_num}[/]")
                
                # Highlight search term
                highlighted = line.replace(
                    search_term,
                    f"[{Colors.PRIMARY}]{search_term}[/]"
                )
                console.print(f"    {highlighted}")
                console.print()
            
            if len(results) > 20:
                console.print(f"  [{Colors.DIM}]... and {len(results) - 20} more matches[/]")
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _tail_logs(console: Console, state: FlowState) -> None:
    """Tail logs in real-time."""
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Tail Logs[/]",
        subtitle=f"[{Colors.HINT}]Press Ctrl+C to stop[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    console.print(f"  [{Colors.INFO}]Select log file:[/]")
    console.print(f"    1. Application logs (caracal.log)")
    console.print(f"    2. Sync logs (sync.log)")
    console.print()
    
    choice = Prompt.ask(
        f"[{Colors.INFO}]Log file[/]",
        choices=["1", "2"],
        default="1"
    )
    
    filename = "caracal.log" if choice == "1" else "sync.log"
    log_path = _resolve_log_path(filename)
    
    if log_path is None:
        console.print()
        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No {filename} file found yet.[/]")
        console.print(f"  [{Colors.DIM}]Checked:[/]")
        for candidate in _candidate_log_paths(filename):
            console.print(f"    [{Colors.DIM}]- {candidate}[/]")
        console.print()
        console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
        input()
        return
    
    console.print()
    console.print(f"  [{Colors.INFO}]Tailing {filename}...[/]")
    console.print()
    
    try:
        import time
        
        # Open file and seek to end
        with open(log_path, 'r') as f:
            # Go to end of file
            f.seek(0, 2)
            
            # Read new lines as they appear
            while True:
                line = f.readline()
                if line:
                    # Color code by log level
                    if 'ERROR' in line:
                        console.print(f"[{Colors.ERROR}]{line.rstrip()}[/]")
                    elif 'WARNING' in line:
                        console.print(f"[{Colors.WARNING}]{line.rstrip()}[/]")
                    elif 'INFO' in line:
                        console.print(f"[{Colors.INFO}]{line.rstrip()}[/]")
                    elif 'DEBUG' in line:
                        console.print(f"[{Colors.DIM}]{line.rstrip()}[/]")
                    else:
                        console.print(f"[{Colors.NEUTRAL}]{line.rstrip()}[/]")
                else:
                    time.sleep(0.1)
    except KeyboardInterrupt:
        console.print()
        console.print(f"  [{Colors.INFO}]Stopped tailing logs[/]")
        console.print()
        console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
        input()
    except Exception as e:
        console.print()
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
        console.print()
        console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
        input()
