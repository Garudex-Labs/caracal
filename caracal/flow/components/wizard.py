"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal Flow Wizard Component.

Step-by-step wizard with:
- Progress indicator
- Step navigation
- Skip/back functionality
"""

from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Optional

from rich.console import Console
from rich.panel import Panel
from rich.progress import Progress, BarColumn, TextColumn
from rich.table import Table
from rich.text import Text

from caracal.flow.theme import Colors, Icons, Styles


class StepStatus(Enum):
    """Status of a wizard step."""
    PENDING = "pending"
    CURRENT = "current"
    COMPLETED = "completed"
    SKIPPED = "skipped"


@dataclass
class WizardStep:
    """A single wizard step."""
    
    key: str                                    # Unique identifier
    title: str                                  # Step title
    description: str                            # Step description
    action: Callable[["Wizard"], Any]           # Step action
    skippable: bool = True                      # Can be skipped
    skip_message: str = ""                      # Message when skipped
    status: StepStatus = StepStatus.PENDING
    result: Any = None                          # Result from action


class Wizard:
    """Multi-step wizard with progress tracking."""
    
    def __init__(
        self,
        title: str,
        steps: list[WizardStep],
        console: Optional[Console] = None,
    ):
        self.title = title
        self.steps = steps
        self.console = console or Console()
        self.current_step_index = 0
        self.context: dict[str, Any] = {}  # Shared context between steps
        self._cancelled = False
    
    @property
    def current_step(self) -> Optional[WizardStep]:
        """Get current step."""
        if 0 <= self.current_step_index < len(self.steps):
            return self.steps[self.current_step_index]
        return None
    
    @property
    def progress_fraction(self) -> float:
        """Get progress as fraction 0-1."""
        completed = sum(1 for s in self.steps if s.status in (StepStatus.COMPLETED, StepStatus.SKIPPED))
        return completed / len(self.steps) if self.steps else 0
    
    def render_progress(self) -> None:
        """Render progress bar and step indicators."""
        self.console.print()
        
        # Title
        self.console.print(f"  [bold {Colors.INFO}]{self.title}[/]")
        self.console.print()
        
        # Step indicators
        for i, step in enumerate(self.steps):
            if step.status == StepStatus.COMPLETED:
                icon = f"[{Colors.SUCCESS}]{Icons.COMPLETE}[/]"
                style = Colors.SUCCESS
            elif step.status == StepStatus.SKIPPED:
                icon = f"[{Colors.DIM}]{Icons.PENDING}[/]"
                style = Colors.DIM
            elif step.status == StepStatus.CURRENT:
                icon = f"[{Colors.PRIMARY}]{Icons.ARROW_SELECT}[/]"
                style = Colors.PRIMARY
            else:  # PENDING
                icon = f"[{Colors.DIM}]{Icons.PENDING}[/]"
                style = Colors.DIM
            
            step_num = i + 1
            self.console.print(f"  {icon} [{style}]{step_num}. {step.title}[/]")
        
        self.console.print()
        
        # Progress bar
        completed = sum(1 for s in self.steps if s.status in (StepStatus.COMPLETED, StepStatus.SKIPPED))
        total = len(self.steps)
        bar_width = 40
        filled = int(bar_width * completed / total) if total else 0
        bar = f"[{Colors.SUCCESS}]{'━' * filled}[/][{Colors.DIM}]{'─' * (bar_width - filled)}[/]"
        self.console.print(f"  {bar} {completed}/{total}")
        self.console.print()
    
    def render_step_header(self) -> None:
        """Render current step header."""
        step = self.current_step
        if not step:
            return
        
        step_num = self.current_step_index + 1
        total = len(self.steps)
        
        self.console.print(
            Panel(
                f"[{Colors.NEUTRAL}]{step.description}[/]",
                title=f"[bold {Colors.INFO}]Step {step_num}/{total}: {step.title}[/]",
                border_style=Colors.PRIMARY,
                padding=(1, 2),
            )
        )
        self.console.print()
    
    def skip_current_step(self) -> None:
        """Skip the current step."""
        step = self.current_step
        if step and step.skippable:
            step.status = StepStatus.SKIPPED
            if step.skip_message:
                self.console.print(f"  [{Colors.DIM}]{Icons.INFO} {step.skip_message}[/]")
            self.current_step_index += 1
    
    def complete_current_step(self, result: Any = None) -> None:
        """Mark current step as complete."""
        step = self.current_step
        if step:
            step.status = StepStatus.COMPLETED
            step.result = result
            self.current_step_index += 1
    
    def go_back(self) -> bool:
        """Go back to previous step. Returns True if possible."""
        if self.current_step_index > 0:
            self.current_step_index -= 1
            step = self.current_step
            if step:
                step.status = StepStatus.CURRENT
            return True
        return False
    
    def cancel(self) -> None:
        """Cancel the wizard."""
        self._cancelled = True
    
    def run(self) -> dict[str, Any]:
        """
        Run the wizard through all steps.
        
        Returns:
            Dictionary mapping step keys to their results
        """
        self.console.clear()
        
        while self.current_step_index < len(self.steps) and not self._cancelled:
            step = self.current_step
            if not step:
                break
            
            step.status = StepStatus.CURRENT
            
            # Render progress and header
            self.console.clear()
            self.render_progress()
            self.render_step_header()
            
            try:
                # Run step action
                result = step.action(self)
                
                # If action returns False, it handled navigation itself
                if result is False:
                    continue
                
                # Otherwise mark complete
                self.complete_current_step(result)
                
            except KeyboardInterrupt:
                self.console.print(f"\n  [{Colors.WARNING}]{Icons.WARNING} Interrupted[/]")
                self.cancel()
                break
            except Exception as e:
                self.console.print(f"\n  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
                # Allow retry or skip
                if step.skippable:
                    self.console.print(f"  [{Colors.DIM}]Press Enter to retry, 's' to skip, 'q' to quit[/]")
                    choice = input("  > ").strip().lower()
                    if choice == 's':
                        self.skip_current_step()
                    elif choice == 'q':
                        self.cancel()
                else:
                    self.console.print(f"  [{Colors.DIM}]Press Enter to retry, 'q' to quit[/]")
                    choice = input("  > ").strip().lower()
                    if choice == 'q':
                        self.cancel()
        
        # Collect results
        results = {}
        for step in self.steps:
            results[step.key] = step.result
        
        return results
    
    def show_summary(self) -> None:
        """Show wizard completion summary."""
        self.console.print()
        
        if self._cancelled:
            self.console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Wizard cancelled[/]")
        else:
            self.console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Setup complete![/]")
        
        self.console.print()
        
        # Summary table
        table = Table(show_header=False, box=None, padding=(0, 2))
        table.add_column("Status", style=Colors.DIM)
        table.add_column("Step")
        
        for step in self.steps:
            if step.status == StepStatus.COMPLETED:
                status = f"[{Colors.SUCCESS}]{Icons.SUCCESS}[/]"
            elif step.status == StepStatus.SKIPPED:
                status = f"[{Colors.DIM}]skipped[/]"
            else:
                status = f"[{Colors.DIM}]{Icons.PENDING}[/]"
            
            table.add_row(status, step.title)
        
        self.console.print(table)
        self.console.print()
