"""
Caracal Flow Prompt Component.

Enhanced input prompts with:
- Auto-completion
- Inline validation
- Rich formatting
"""

from typing import Any, Callable, Optional

from prompt_toolkit import prompt as pt_prompt
from prompt_toolkit.completion import Completer, Completion, WordCompleter
from prompt_toolkit.validation import ValidationError, Validator
from prompt_toolkit.formatted_text import FormattedText
from rich.console import Console

from caracal.flow.theme import Colors, Icons


class FlowValidator(Validator):
    """Validator that wraps a validation function."""
    
    def __init__(self, validate_fn: Callable[[str], tuple[bool, str]]):
        """
        Args:
            validate_fn: Function that returns (is_valid, error_message)
        """
        self.validate_fn = validate_fn
    
    def validate(self, document):
        text = document.text
        is_valid, error_msg = self.validate_fn(text)
        if not is_valid:
            raise ValidationError(message=error_msg)


class UUIDCompleter(Completer):
    """Completer for UUID values with descriptions."""
    
    def __init__(self, items: list[tuple[str, str]]):
        """
        Args:
            items: List of (uuid, description) tuples
        """
        self.items = items
    
    def get_completions(self, document, complete_event):
        text = document.text_before_cursor.lower()
        
        for uuid, desc in self.items:
            if text in uuid.lower() or text in desc.lower():
                yield Completion(
                    uuid,
                    start_position=-len(document.text_before_cursor),
                    display=f"{uuid[:8]}... - {desc}",
                    display_meta=desc[:30],
                )


class FlowPrompt:
    """Enhanced prompt with validation and completion."""
    
    def __init__(self, console: Optional[Console] = None):
        self.console = console or Console()
    
    def text(
        self,
        message: str,
        default: str = "",
        validator: Optional[Callable[[str], tuple[bool, str]]] = None,
        completer: Optional[Completer] = None,
        required: bool = True,
    ) -> str:
        """
        Prompt for text input.
        
        Args:
            message: Prompt message
            default: Default value
            validator: Optional validation function
            completer: Optional completer
            required: Whether input is required
        
        Returns:
            User input string
        """
        prompt_text = FormattedText([
            (Colors.HINT, f"  {Icons.ARROW_RIGHT} "),
            (Colors.NEUTRAL, message),
            ("", ": "),
        ])
        
        # Build validator
        flow_validator = None
        if validator:
            flow_validator = FlowValidator(validator)
        elif required:
            flow_validator = FlowValidator(
                lambda x: (bool(x.strip()), "This field is required")
            )
        
        result = pt_prompt(
            prompt_text,
            default=default,
            validator=flow_validator,
            validate_while_typing=False,
            completer=completer,
        )
        
        return result.strip()
    
    def confirm(
        self,
        message: str,
        default: bool = False,
    ) -> bool:
        """
        Prompt for yes/no confirmation.
        
        Args:
            message: Confirmation message
            default: Default value
        
        Returns:
            True if confirmed, False otherwise
        """
        hint = "(Y/n)" if default else "(y/N)"
        prompt_text = FormattedText([
            (Colors.HINT, f"  {Icons.ARROW_RIGHT} "),
            (Colors.NEUTRAL, message),
            (Colors.DIM, f" {hint}"),
            ("", ": "),
        ])
        
        result = pt_prompt(prompt_text, default="")
        
        if not result:
            return default
        
        return result.lower() in ("y", "yes", "true", "1")
    
    def select(
        self,
        message: str,
        choices: list[str],
        default: Optional[str] = None,
    ) -> str:
        """
        Prompt for selection from choices with autocomplete.
        
        Args:
            message: Prompt message
            choices: List of valid choices
            default: Default choice
        
        Returns:
            Selected choice
        """
        completer = WordCompleter(choices, ignore_case=True)
        
        def validate_choice(value: str) -> tuple[bool, str]:
            if value in choices:
                return True, ""
            return False, f"Must be one of: {', '.join(choices)}"
        
        return self.text(
            message=message,
            default=default or "",
            validator=validate_choice,
            completer=completer,
        )
    
    def uuid(
        self,
        message: str,
        items: list[tuple[str, str]],  # (uuid, description)
        required: bool = True,
    ) -> str:
        """
        Prompt for UUID with autocomplete.
        
        Args:
            message: Prompt message
            items: List of (uuid, description) tuples
            required: Whether selection is required
        
        Returns:
            Selected UUID
        """
        completer = UUIDCompleter(items)
        uuids = [uuid for uuid, _ in items]
        
        def validate_uuid(value: str) -> tuple[bool, str]:
            if not required and not value:
                return True, ""
            if value in uuids:
                return True, ""
            # Check for partial match (first 8 chars)
            for uuid in uuids:
                if uuid.startswith(value):
                    return True, ""
            return False, "Invalid UUID. Use Tab for suggestions."
        
        result = self.text(
            message=message,
            validator=validate_uuid,
            completer=completer,
            required=required,
        )
        
        # Expand partial UUIDs
        for uuid in uuids:
            if uuid.startswith(result):
                return uuid
        
        return result
    
    def number(
        self,
        message: str,
        default: Optional[float] = None,
        min_value: Optional[float] = None,
        max_value: Optional[float] = None,
    ) -> float:
        """
        Prompt for a number.
        
        Args:
            message: Prompt message
            default: Default value
            min_value: Minimum allowed value
            max_value: Maximum allowed value
        
        Returns:
            The entered number
        """
        def validate_number(value: str) -> tuple[bool, str]:
            try:
                num = float(value)
                if min_value is not None and num < min_value:
                    return False, f"Must be at least {min_value}"
                if max_value is not None and num > max_value:
                    return False, f"Must be at most {max_value}"
                return True, ""
            except ValueError:
                return False, "Must be a valid number"
        
        result = self.text(
            message=message,
            default=str(default) if default is not None else "",
            validator=validate_number,
        )
        
        return float(result)
    def password(self, message: str) -> str:
        """
        Prompt for a password with visibility toggle.
        
        Args:
            message: Prompt message
            
        Returns:
            The entered password
        """
        from prompt_toolkit.filters import Condition
        from prompt_toolkit.key_binding import KeyBindings
        
        # Variable to track visibility state (Hidden by default)
        hidden = [True]
        
        @Condition
        def is_hidden():
            return hidden[0]
            
        # Key bindings to toggle visibility
        bindings = KeyBindings()
        
        @bindings.add('f2')
        def _(event):
            hidden[0] = not hidden[0]
            
        prompt_text = FormattedText([
            (Colors.HINT, f"  {Icons.ARROW_RIGHT} "),
            (Colors.NEUTRAL, message),
            ("", ": "),
        ])
        
        # Bottom toolbar to show instructions
        def get_toolbar():
            if hidden[0]:
                return FormattedText([("", "Press F2 to show password")])
            else:
                return FormattedText([("", "Press F2 to hide password")])
            
        result = pt_prompt(
            prompt_text,
            is_password=is_hidden,
            key_bindings=bindings,
            bottom_toolbar=get_toolbar,
        )
        
        return result
