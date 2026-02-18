"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Intent handling for authority enforcement.

This module provides the Intent data class and IntentHandler for parsing,
validating, and managing intents in the authority enforcement system.
"""

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from uuid import UUID, uuid4


@dataclass
class Intent:
    """
    Structured declaration of what an agent wants to do.
    
    An intent represents a specific action an agent wants to perform on a
    specific resource, with optional parameters and context. Intents are used
    to request authority and validate that actions are within mandate scope.
    
    Attributes:
        intent_id: Unique identifier for the intent
        action: The action type (e.g., "api_call", "database_query", "file_read")
        resource: The target resource identifier (e.g., "api:openai:gpt-4")
        parameters: Optional parameters for the action
        context: Optional context information
    """
    
    intent_id: UUID = field(default_factory=uuid4)
    action: str = ""
    resource: str = ""
    parameters: Dict[str, Any] = field(default_factory=dict)
    context: Dict[str, Any] = field(default_factory=dict)
    
    def validate(self) -> None:
        """
        Validate intent structure.
        
        Raises:
            ValueError: If intent structure is invalid
        """
        if not self.action:
            raise ValueError("Intent must have an action")
        
        if not self.resource:
            raise ValueError("Intent must have a resource")
        
        if not isinstance(self.action, str):
            raise ValueError("Intent action must be a string")
        
        if not isinstance(self.resource, str):
            raise ValueError("Intent resource must be a string")
        
        if not isinstance(self.parameters, dict):
            raise ValueError("Intent parameters must be a dictionary")
        
        if not isinstance(self.context, dict):
            raise ValueError("Intent context must be a dictionary")
    
    def generate_hash(self) -> str:
        """
        Generate SHA-256 hash of intent for binding to mandates.
        
        The hash is computed over the action, resource, and parameters
        (but not context or intent_id) to create a stable identifier
        for the intent's semantic content.
        
        Returns:
            Hex-encoded SHA-256 hash string
        """
        # Create a stable representation of the intent
        intent_data = {
            "action": self.action,
            "resource": self.resource,
            "parameters": self.parameters
        }
        
        # Sort keys for deterministic serialization
        intent_json = json.dumps(intent_data, sort_keys=True)
        
        # Compute SHA-256 hash
        hash_obj = hashlib.sha256(intent_json.encode('utf-8'))
        return hash_obj.hexdigest()
    
    def to_dict(self) -> Dict[str, Any]:
        """
        Convert intent to dictionary representation.
        
        Returns:
            Dictionary with all intent fields
        """
        return {
            "intent_id": str(self.intent_id),
            "action": self.action,
            "resource": self.resource,
            "parameters": self.parameters,
            "context": self.context
        }


class IntentHandler:
    """
    Handles intent parsing and validation.
    
    Intents are structured declarations of what an agent wants to do.
    The IntentHandler parses intent data, validates structure, and manages
    intent-based mandate requests.
    """
    
    def parse_intent(self, intent_data: Dict[str, Any]) -> Intent:
        """
        Parse and validate intent structure.
        
        Extracts action type, resource identifiers, parameters, and context
        from the provided dictionary. Validates that required fields are present
        and have valid types.
        
        Args:
            intent_data: Dictionary containing intent information
        
        Returns:
            Validated Intent object
        
        Raises:
            ValueError: If intent structure is invalid or missing required fields
        """
        # Validate input type
        if not isinstance(intent_data, dict):
            raise ValueError("Intent data must be a dictionary")
        
        # Extract required fields
        action = intent_data.get("action")
        resource = intent_data.get("resource")
        
        # Validate required fields
        if not action:
            raise ValueError("Intent must have an 'action' field")
        
        if not resource:
            raise ValueError("Intent must have a 'resource' field")
        
        # Extract optional fields
        parameters = intent_data.get("parameters", {})
        context = intent_data.get("context", {})
        
        # Validate optional field types
        if not isinstance(parameters, dict):
            raise ValueError("Intent 'parameters' must be a dictionary")
        
        if not isinstance(context, dict):
            raise ValueError("Intent 'context' must be a dictionary")
        
        # Create intent object
        intent = Intent(
            action=action,
            resource=resource,
            parameters=parameters,
            context=context
        )
        
        # Validate the intent
        intent.validate()
        
        return intent

    def validate_intent_against_mandate(
        self,
        intent: Intent,
        mandate: Any  # ExecutionMandate from caracal.db.models
    ) -> bool:
        """
        Validate that intent is within mandate scope.
        
        Checks that:
        1. Intent action is in mandate action scope
        2. Intent resource matches mandate resource patterns
        3. Intent can only narrow, never expand scope
        
        Args:
            intent: The intent to validate
            mandate: The execution mandate to validate against
        
        Returns:
            True if intent is valid within mandate scope, False otherwise
        """
        # Validate intent structure first
        try:
            intent.validate()
        except ValueError:
            return False
        
        # Check if intent action is in mandate action scope
        if intent.action not in mandate.action_scope:
            return False
        
        # Check if intent resource matches any pattern in mandate resource scope
        resource_match = self._match_resource_pattern(
            intent.resource,
            mandate.resource_scope
        )
        
        if not resource_match:
            return False
        
        # Intent is valid - it narrows the mandate scope to a specific action/resource
        return True
    
    def _match_resource_pattern(
        self,
        resource: str,
        resource_patterns: List[str]
    ) -> bool:
        """
        Check if resource matches any pattern in the list.
        
        Supports:
        - Exact matches: "api:openai:gpt-4" matches "api:openai:gpt-4"
        - Wildcard matches: "api:openai:gpt-4" matches "api:openai:*"
        - Prefix matches: "database:users:read" matches "database:users:*"
        
        Args:
            resource: The resource identifier to match
            resource_patterns: List of resource patterns from mandate
        
        Returns:
            True if resource matches any pattern, False otherwise
        """
        for pattern in resource_patterns:
            # Exact match
            if resource == pattern:
                return True
            
            # Wildcard match - convert glob pattern to simple matching
            if '*' in pattern:
                # Replace * with .* for regex-like matching
                import re
                regex_pattern = pattern.replace('*', '.*')
                regex_pattern = f"^{regex_pattern}$"
                if re.match(regex_pattern, resource):
                    return True
        
        return False

    def request_mandate_for_intent(
        self,
        intent: Intent,
        subject_id: UUID,
        issuer_id: UUID,
        mandate_manager: Any = None  # MandateManager from caracal.core.mandate
    ) -> Any:  # Returns ExecutionMandate
        """
        Request a mandate constrained by an intent.
        
        Creates a mandate with scope limited to the intent. The intent hash
        is stored in the mandate for verification. This ensures the mandate
        can only be used for the specific intent it was requested for.
        
        Args:
            intent: The intent to create a mandate for
            subject_id: The principal ID that will hold the mandate
            issuer_id: The principal ID issuing the mandate
            mandate_manager: MandateManager instance (will be injected)
        
        Returns:
            ExecutionMandate with scope limited to the intent
        
        Raises:
            ValueError: If intent is invalid or mandate_manager is not provided
            RuntimeError: If mandate issuance fails
        """
        # Validate intent structure
        intent.validate()
        
        # Check that mandate_manager is provided
        if mandate_manager is None:
            raise ValueError(
                "mandate_manager must be provided. "
                "This will be implemented when MandateManager is available."
            )
        
        # Generate intent hash for binding
        intent_hash = intent.generate_hash()
        
        # Create mandate with scope limited to intent
        # The resource scope contains only the specific resource from the intent
        # The action scope contains only the specific action from the intent
        resource_scope = [intent.resource]
        action_scope = [intent.action]
        
        # Request mandate from MandateManager
        # Note: This will call MandateManager.issue_mandate() which will be
        # implemented in task 4.2
        try:
            mandate = mandate_manager.issue_mandate(
                issuer_id=issuer_id,
                subject_id=subject_id,
                resource_scope=resource_scope,
                action_scope=action_scope,
                validity_seconds=3600,  # Default 1 hour validity
                intent=intent,
                parent_mandate_id=None
            )
            
            return mandate
            
        except Exception as e:
            raise RuntimeError(f"Failed to issue mandate for intent: {str(e)}")
