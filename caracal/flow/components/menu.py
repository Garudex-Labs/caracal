"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal Flow Menu Component.

Interactive menu with arrow-key navigation:
- Vertical menu layouts
- Selection highlighting
- Keyboard navigation (↑/↓ to navigate, Enter to select, q to quit)
"""

from dataclasses import dataclass
from typing import Any, Callable, Optional

from prompt_toolkit import Application
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.layout import HSplit, Layout, Window
from prompt_toolkit.layout.controls import FormattedTextControl
from prompt_toolkit.formatted_text import FormattedText
from rich.console import Console

from caracal.flow.theme import Colors, Icons


@dataclass
class MenuItem:
    """A single menu item."""
    
    key: str                              # Unique identifier
    label: str                            # Display text
    description: str = ""                 # Optional description
    icon: str = ""                        # Optional icon
    action: Optional[Callable] = None     # Callback when selected
    disabled: bool = False                # Whether item is selectable
    data: Any = None                      # Optional associated data
    
    def display_text(self, selected: bool = False) -> str:
        """Get formatted display text."""
        icon_part = f"{self.icon} " if self.icon else ""
        prefix = f"{Icons.ARROW_SELECT} " if selected else "  "
        return f"{prefix}{icon_part}{self.label}"


class Menu:
    """Interactive menu with arrow-key navigation."""
    
    def __init__(
        self,
        title: str,
        items: list[MenuItem],
        subtitle: str = "",
        show_hints: bool = True,
    ):
        self.title = title
        self.subtitle = subtitle
        self.items = items
        self.show_hints = show_hints
        self.selected_index = 0
        self._result: Optional[MenuItem] = None
        self._cancelled = False
        
        # Skip to first non-disabled item
        self._move_to_next_enabled()
    
    def _get_selectable_items(self) -> list[tuple[int, MenuItem]]:
        """Get list of (index, item) for selectable items."""
        return [(i, item) for i, item in enumerate(self.items) if not item.disabled]
    
    def _move_to_next_enabled(self) -> None:
        """Move selection to next enabled item."""
        selectable = self._get_selectable_items()
        if not selectable:
            return
        
        # Find next enabled item at or after current index
        for idx, _ in selectable:
            if idx >= self.selected_index:
                self.selected_index = idx
                return
        
        # Wrap to first
        self.selected_index = selectable[0][0]
    
    def _move_to_prev_enabled(self) -> None:
        """Move selection to previous enabled item."""
        selectable = self._get_selectable_items()
        if not selectable:
            return
        
        # Find previous enabled item before current index
        for idx, _ in reversed(selectable):
            if idx <= self.selected_index:
                self.selected_index = idx
                return
        
        # Wrap to last
        self.selected_index = selectable[-1][0]
    
    def _move_up(self) -> None:
        """Move selection up."""
        selectable = self._get_selectable_items()
        if not selectable:
            return
        
        # Find previous selectable item
        for idx, _ in reversed(selectable):
            if idx < self.selected_index:
                self.selected_index = idx
                return
        
        # Wrap to last
        self.selected_index = selectable[-1][0]
    
    def _move_down(self) -> None:
        """Move selection down."""
        selectable = self._get_selectable_items()
        if not selectable:
            return
        
        # Find next selectable item
        for idx, _ in selectable:
            if idx > self.selected_index:
                self.selected_index = idx
                return
        
        # Wrap to first
        self.selected_index = selectable[0][0]
    
    def _get_menu_text(self) -> FormattedText:
        """Generate formatted menu text."""
        lines = []
        
        # Title (skip if empty to avoid extra gap)
        if self.title:
            lines.append((f"bold {Colors.INFO}", f"\n  {self.title}\n"))
        
        # Subtitle
        if self.subtitle:
            lines.append((Colors.DIM, f"  {self.subtitle}\n"))
        
        if self.title or self.subtitle:
            lines.append(("", "\n"))
        
        # Menu items
        for i, item in enumerate(self.items):
            is_selected = i == self.selected_index
            
            if item.disabled:
                style = Colors.DIM
                prefix = "  "
            elif is_selected:
                style = f"bold {Colors.PRIMARY}"
                prefix = f"  {Icons.ARROW_SELECT} "
            else:
                style = Colors.NEUTRAL
                prefix = "    "
            
            icon_part = f"{item.icon} " if item.icon else ""
            lines.append((style, f"{prefix}{icon_part}{item.label}"))
            
            # Description on same line for selected
            if is_selected and item.description:
                lines.append((Colors.DIM, f"  — {item.description}"))
            
            lines.append(("", "\n"))
        
        # Hints
        if self.show_hints:
            lines.append(("", "\n"))
            lines.append((Colors.HINT, f"  {Icons.ARROW_UP}{Icons.ARROW_DOWN} navigate  "))
            lines.append((Colors.HINT, "Enter select  "))
            lines.append((Colors.HINT, "q quit\n"))
        
        return FormattedText(lines)
    
    def run(self) -> Optional[MenuItem]:
        """Run the menu and return selected item, or None if cancelled."""
        kb = KeyBindings()
        
        @kb.add('up')
        @kb.add('k')  # vim style
        def _up(event):
            self._move_up()
        
        @kb.add('down')
        @kb.add('j')  # vim style
        def _down(event):
            self._move_down()
        
        @kb.add('enter')
        def _select(event):
            item = self.items[self.selected_index]
            if not item.disabled:
                self._result = item
                event.app.exit()
        
        @kb.add('q')
        @kb.add('escape')
        def _quit(event):
            self._cancelled = True
            event.app.exit()
        
        @kb.add('c-c')
        def _interrupt(event):
            self._cancelled = True
            event.app.exit()
        
        # Create layout
        layout = Layout(
            Window(
                content=FormattedTextControl(
                    text=self._get_menu_text,
                ),
            )
        )
        
        # Run application
        app = Application(
            layout=layout,
            key_bindings=kb,
            full_screen=False,
            mouse_support=True,
        )
        
        app.run()
        
        return self._result


def show_menu(
    title: str,
    items: list[tuple[str, str, str]],  # (key, label, description)
    subtitle: str = "",
) -> Optional[str]:
    """
    Convenience function to show a simple menu.
    
    Returns the key of the selected item, or None if cancelled.
    """
    menu_items = [
        MenuItem(key=key, label=label, description=desc)
        for key, label, desc in items
    ]
    
    menu = Menu(title=title, items=menu_items, subtitle=subtitle)
    result = menu.run()
    
    return result.key if result else None
