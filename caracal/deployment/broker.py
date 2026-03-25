"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Broker for Open-Source Edition.

Handles direct communication with AI providers.
"""

from dataclasses import dataclass
from typing import Any, Dict, Optional


@dataclass
class ProviderRequest:
    """Provider request data model."""
    provider: str
    method: str
    params: Dict[str, Any]


@dataclass
class ProviderResponse:
    """Provider response data model."""
    status_code: int
    data: Dict[str, Any]
    error: Optional[str] = None


@dataclass
class ProviderConfig:
    """Provider configuration data model."""
    name: str
    provider_type: str
    api_key_ref: str
    base_url: Optional[str] = None
    timeout_seconds: int = 30
    max_retries: int = 3


class Broker:
    """
    Broker for Open-Source Edition.
    
    Handles direct communication with AI providers.
    """
    
    def __init__(self):
        """Initialize the broker."""
        pass
    
    def call_provider(self, provider: str, request: ProviderRequest) -> ProviderResponse:
        """
        Makes direct API call to provider with retry logic.
        
        Args:
            provider: Provider name
            request: Provider request
            
        Returns:
            Provider response
        """
        raise NotImplementedError("To be implemented in task 8.1")
