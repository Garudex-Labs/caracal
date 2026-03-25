"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal Flow Theme - Color semantics and styling definitions.

Color System:
- Green (#00d787): Success, confirmed, healthy
- Blue (#5f87ff): Primary, interactive, selectable
- Yellow (#ffd700): Warning, attention, pending
- Red (#ff5f5f): Error, critical, exceeded
- White (#ffffff): Neutral text
- Magenta (#d787ff): Info, headers, decorative
- Cyan (#5fd7ff): Navigation hints, shortcuts
- Dim (#808080): Disabled, secondary, optional
"""

from rich.style import Style
from rich.theme import Theme


# Color constants with semantic meaning
class Colors:
    """Semantic color definitions."""
    
    # Core semantic colors
    SUCCESS = "#00d787"      # Green - completed, healthy
    PRIMARY = "#5f87ff"      # Blue - interactive, selectable
    WARNING = "#ffd700"      # Yellow - attention needed
    ERROR = "#ff5f5f"        # Red - failures, critical
    NEUTRAL = "#ffffff"      # White - regular content
    INFO = "#d787ff"         # Magenta - headers, decorative
    HINT = "#5fd7ff"         # Cyan - shortcuts, tips
    DIM = "#808080"          # Gray - disabled, secondary
    
    # Additional semantic colors
    TEXT = NEUTRAL           # Regular text (alias for NEUTRAL)
    LINK = HINT              # Hyperlinks (cyan for visibility)
    BORDER = DIM             # Borders and separators
    
    # Background colors
    BG_DARK = "#1a1a2e"      # Dark background
    BG_SELECTED = "#2d2d44"  # Selected item background
    BG_HIGHLIGHT = "#3d3d5c" # Highlighted background
    
    # Status colors
    MANDATE_ACTIVE = SUCCESS
    MANDATE_REVOKED = ERROR
    MANDATE_EXPIRED = WARNING
    
    # Authority status
    AUTHORITY_GRANTED = SUCCESS
    AUTHORITY_DENIED = ERROR
    AUTHORITY_PENDING = WARNING
    
    # Principal status
    PRINCIPAL_ACTIVE = SUCCESS
    PRINCIPAL_INACTIVE = DIM


class Styles:
    """Rich style definitions using semantic colors."""
    
    # Text styles
    TITLE = Style(color=Colors.INFO, bold=True)
    SUBTITLE = Style(color=Colors.HINT)
    BODY = Style(color=Colors.NEUTRAL)
    MUTED = Style(color=Colors.DIM)
    
    # Interactive elements
    MENU_ITEM = Style(color=Colors.PRIMARY)
    MENU_SELECTED = Style(color=Colors.PRIMARY, bold=True, reverse=True)
    MENU_DISABLED = Style(color=Colors.DIM)
    
    # Status indicators
    STATUS_SUCCESS = Style(color=Colors.SUCCESS, bold=True)
    STATUS_WARNING = Style(color=Colors.WARNING, bold=True)
    STATUS_ERROR = Style(color=Colors.ERROR, bold=True)
    STATUS_INFO = Style(color=Colors.INFO)
    
    # Input elements
    PROMPT = Style(color=Colors.HINT, bold=True)
    INPUT = Style(color=Colors.NEUTRAL)
    PLACEHOLDER = Style(color=Colors.DIM, italic=True)
    VALIDATION_ERROR = Style(color=Colors.ERROR)
    VALIDATION_OK = Style(color=Colors.SUCCESS)
    
    # Table styles
    TABLE_HEADER = Style(color=Colors.INFO, bold=True)
    TABLE_ROW = Style(color=Colors.NEUTRAL)
    TABLE_ROW_ALT = Style(color=Colors.NEUTRAL, dim=True)
    
    # Progress indicators
    PROGRESS_COMPLETE = Style(color=Colors.SUCCESS)
    PROGRESS_INCOMPLETE = Style(color=Colors.DIM)
    PROGRESS_CURRENT = Style(color=Colors.PRIMARY, bold=True)
    
    # Hints and shortcuts
    SHORTCUT = Style(color=Colors.HINT, bold=True)
    HINT_TEXT = Style(color=Colors.DIM, italic=True)


# Rich theme for console
FLOW_THEME = Theme({
    # Text
    "title": str(Styles.TITLE),
    "subtitle": str(Styles.SUBTITLE),
    "body": str(Styles.BODY),
    "muted": str(Styles.MUTED),
    
    # Status
    "success": str(Styles.STATUS_SUCCESS),
    "warning": str(Styles.STATUS_WARNING),
    "error": str(Styles.STATUS_ERROR),
    "info": str(Styles.STATUS_INFO),
    
    # Interactive
    "menu.item": str(Styles.MENU_ITEM),
    "menu.selected": str(Styles.MENU_SELECTED),
    "menu.disabled": str(Styles.MENU_DISABLED),
    
    # Input
    "prompt": str(Styles.PROMPT),
    "input": str(Styles.INPUT),
    "placeholder": str(Styles.PLACEHOLDER),
    
    # Table
    "table.header": str(Styles.TABLE_HEADER),
    "table.row": str(Styles.TABLE_ROW),
    
    # Hints
    "shortcut": str(Styles.SHORTCUT),
    "hint": str(Styles.HINT_TEXT),
})


# ASCII Art Banner
BANNER = r"""
╔═══════════════════════════════════════════════════════════════════╗
║                                                                   ║
║     ██████╗ █████╗ ██████╗  █████╗  ██████╗ █████╗ ██╗            ║
║    ██╔════╝██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗██║            ║
║    ██║     ███████║██████╔╝███████║██║     ███████║██║            ║
║    ██║     ██╔══██║██╔══██╗██╔══██║██║     ██╔══██║██║            ║
║    ╚██████╗██║  ██║██║  ██║██║  ██║╚██████╗██║  ██║███████╗       ║
║     ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝╚══════╝       ║
║                                                                   ║
║                   C A R A C A L  F L O W                          ║
║         Pre-Execution Authority Enforcement System                ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
"""

# Compact banner for smaller terminals
BANNER_COMPACT = r"""
┌───────────────────────────────────────────┐
│  CARACAL FLOW                             │
│  Pre-Execution Authority Enforcement      │
└───────────────────────────────────────────┘
"""


# Status icons
class Icons:
    """Unicode icons for status and navigation."""
    
    # Status
    SUCCESS = "✓"
    ERROR = "✗"
    WARNING = "⚠"
    INFO = "ℹ"
    PENDING = "○"
    COMPLETE = "●"
    
    # Navigation
    ARROW_RIGHT = "→"
    ARROW_LEFT = "←"
    ARROW_UP = "↑"
    ARROW_DOWN = "↓"
    ARROW_SELECT = "▶"
    
    # Progress
    PROGRESS_DONE = "━"
    PROGRESS_TODO = "─"
    SPINNER = ["◐", "◓", "◑", "◒"]
    
    # Content
    FOLDER = "📁"
    FILE = "📄"
    AGENT = "👾"
    PRINCIPAL = "👤"
    POLICY = "📋"
    LEDGER = "📜"
    MANDATE = "🎫"
    AUTHORITY = "🔐"
    MONEY = "🪙 "
    SETTINGS = "⚙️ "
    HELP = "❓"
    
    # Deployment specific
    WORKSPACE = "🗂️ "
    SYNC = "🔄"
    DATABASE = "🗄️ "
    PROVIDER = "🔌"
    LIST = "📋"
    ADD = "➕"
    DELETE = "🗑️ "
    EXPORT = "📤"
    IMPORT = "📥"
    CONNECT = "🔗"
    DISCONNECT = "⛓️‍💥"
    TEST = "🧪"
    CHART = "📊"
    SEARCH = "🔍"
    STREAM = "📡"
    GUIDE = "📖"
    ARCHITECTURE = "🏗️ "
    SWITCH = "🔀"
    
    # Decorative
    BULLET = "•"
    DASH = "─"
    VERTICAL = "│"
    CORNER_TL = "┌"
    CORNER_TR = "┐"
    CORNER_BL = "└"
    CORNER_BR = "┘"
