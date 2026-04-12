"""
Response Matcher

Matches requests (prompts, tool calls) to mock responses using pattern matching.
Supports regex, exact, and substring matching strategies.
"""

import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from .config_loader import PromptPattern, ToolResponse


@dataclass
class MatchResult:
    """Result of a pattern match operation."""
    matched: bool
    response: Optional[str] = None
    variables: Dict[str, Any] = None
    confidence: float = 0.0
    pattern_used: Optional[str] = None
    
    def __post_init__(self):
        if self.variables is None:
            self.variables = {}


class ResponseMatcher:
    """
    Matches requests to mock responses using various matching strategies.
    
    Supports:
    - Regex pattern matching for flexible prompt matching
    - Exact string matching for precise matches
    - Substring matching for simple contains checks
    - Variable substitution in response templates
    """
    
    def __init__(self):
        """Initialize the response matcher."""
        self._compiled_patterns: Dict[str, re.Pattern] = {}
    
    def match_prompt(
        self,
        prompt: str,
        patterns: List[PromptPattern],
        default_response: Optional[str] = None
    ) -> MatchResult:
        """
        Match a prompt against a list of patterns and return the best match.
        
        Args:
            prompt: The prompt text to match
            patterns: List of PromptPattern objects to match against
            default_response: Default response if no pattern matches
            
        Returns:
            MatchResult with the matched response and metadata
        """
        if not patterns:
            return MatchResult(
                matched=False,
                response=default_response
            )
        
        best_match: Optional[MatchResult] = None
        best_confidence = 0.0
        
        for pattern in patterns:
            match_result = self._match_single_pattern(prompt, pattern)
            
            if match_result.matched and match_result.confidence > best_confidence:
                best_match = match_result
                best_confidence = match_result.confidence
                
                # If we have a perfect match (exact), stop searching
                if pattern.match_type == "exact" and match_result.confidence == 1.0:
                    break
        
        if best_match is None:
            return MatchResult(
                matched=False,
                response=default_response
            )
        
        return best_match
    
    def _match_single_pattern(
        self,
        prompt: str,
        pattern: PromptPattern
    ) -> MatchResult:
        """
        Match a prompt against a single pattern.
        
        Args:
            prompt: The prompt text to match
            pattern: The PromptPattern to match against
            
        Returns:
            MatchResult indicating if the pattern matched
        """
        if pattern.match_type == "exact":
            return self._match_exact(prompt, pattern)
        elif pattern.match_type == "contains":
            return self._match_contains(prompt, pattern)
        else:  # regex (default)
            return self._match_regex(prompt, pattern)
    
    def _match_exact(self, prompt: str, pattern: PromptPattern) -> MatchResult:
        """Match using exact string comparison."""
        matched = prompt.strip() == pattern.pattern.strip()
        
        if matched:
            response = self._substitute_variables(
                pattern.response_template,
                pattern.variables
            )
            return MatchResult(
                matched=True,
                response=response,
                variables=pattern.variables,
                confidence=1.0,
                pattern_used=pattern.pattern
            )
        
        return MatchResult(matched=False)
    
    def _match_contains(self, prompt: str, pattern: PromptPattern) -> MatchResult:
        """Match using substring search."""
        matched = pattern.pattern.lower() in prompt.lower()
        
        if matched:
            response = self._substitute_variables(
                pattern.response_template,
                pattern.variables
            )
            # Confidence based on how much of the prompt is covered by the pattern
            confidence = len(pattern.pattern) / len(prompt) if len(prompt) > 0 else 0.0
            confidence = min(confidence, 0.9)  # Cap at 0.9 for contains matches
            
            return MatchResult(
                matched=True,
                response=response,
                variables=pattern.variables,
                confidence=confidence,
                pattern_used=pattern.pattern
            )
        
        return MatchResult(matched=False)
    
    def _match_regex(self, prompt: str, pattern: PromptPattern) -> MatchResult:
        """Match using regular expression."""
        # Compile and cache regex patterns
        if pattern.pattern not in self._compiled_patterns:
            try:
                self._compiled_patterns[pattern.pattern] = re.compile(
                    pattern.pattern,
                    re.IGNORECASE | re.DOTALL
                )
            except re.error as e:
                # Invalid regex pattern, skip it
                return MatchResult(matched=False)
        
        regex = self._compiled_patterns[pattern.pattern]
        match = regex.search(prompt)
        
        if match:
            # Extract captured groups as variables
            captured_vars = pattern.variables.copy()
            captured_vars.update(match.groupdict())
            
            response = self._substitute_variables(
                pattern.response_template,
                captured_vars
            )
            
            # Confidence based on match span coverage
            match_span = match.end() - match.start()
            confidence = match_span / len(prompt) if len(prompt) > 0 else 0.0
            confidence = min(confidence, 0.95)  # Cap at 0.95 for regex matches
            
            return MatchResult(
                matched=True,
                response=response,
                variables=captured_vars,
                confidence=confidence,
                pattern_used=pattern.pattern
            )
        
        return MatchResult(matched=False)
    
    def _substitute_variables(
        self,
        template: str,
        variables: Dict[str, Any]
    ) -> str:
        """
        Substitute variables in a response template.
        
        Supports:
        - Simple substitution: {variable_name}
        - List formatting: {list_var} -> "item1, item2, item3"
        - Dict formatting: {dict_var} -> JSON representation
        
        Args:
            template: Response template with {variable} placeholders
            variables: Dictionary of variable values
            
        Returns:
            Template with variables substituted
        """
        result = template
        
        for key, value in variables.items():
            placeholder = f"{{{key}}}"
            
            if placeholder in result:
                # Format the value based on its type
                if isinstance(value, list):
                    formatted_value = ", ".join(str(v) for v in value)
                elif isinstance(value, dict):
                    # Simple dict formatting (not full JSON)
                    formatted_value = ", ".join(
                        f"{k}: {v}" for k, v in value.items()
                    )
                else:
                    formatted_value = str(value)
                
                result = result.replace(placeholder, formatted_value)
        
        return result
    
    def match_tool_call(
        self,
        tool_id: str,
        tool_args: Dict[str, Any],
        tool_responses: Dict[str, ToolResponse]
    ) -> Optional[ToolResponse]:
        """
        Match a tool call to a mock response.
        
        Args:
            tool_id: Tool identifier
            tool_args: Tool call arguments
            tool_responses: Dictionary of available tool responses
            
        Returns:
            ToolResponse if found, None otherwise
        """
        # Direct lookup by tool_id
        if tool_id in tool_responses:
            return tool_responses[tool_id]
        
        # Try pattern matching on tool_id (e.g., "finance.*" matches "finance_data")
        for pattern, response in tool_responses.items():
            if self._match_tool_pattern(tool_id, pattern):
                return response
        
        return None
    
    def _match_tool_pattern(self, tool_id: str, pattern: str) -> bool:
        """
        Match a tool ID against a pattern.
        
        Supports:
        - Exact match: "finance_data"
        - Wildcard: "finance_*" or "finance.*"
        - Regex: if pattern contains regex special chars
        
        Args:
            tool_id: Tool identifier to match
            pattern: Pattern to match against
            
        Returns:
            True if the tool_id matches the pattern
        """
        # Exact match
        if tool_id == pattern:
            return True
        
        # Wildcard match (convert * to .*)
        if "*" in pattern:
            regex_pattern = pattern.replace("*", ".*")
            try:
                return bool(re.match(f"^{regex_pattern}$", tool_id))
            except re.error:
                return False
        
        # Try as regex
        try:
            return bool(re.match(pattern, tool_id))
        except re.error:
            return False
    
    def clear_cache(self):
        """Clear the compiled regex pattern cache."""
        self._compiled_patterns.clear()
