"""Mock provider implementations for testing."""
from typing import Dict, Any, List, Optional


class MockProvider:
    """Mock provider for testing."""
    
    def __init__(self, name: str, provider_type: str = "generic"):
        """Initialize mock provider."""
        self.name = name
        self.provider_type = provider_type
        self.scopes: List[str] = []
        self.config: Dict[str, Any] = {}
        self._initialized = False
    
    def initialize(self, config: Dict[str, Any]):
        """Mock provider initialization."""
        self.config = config
        self._initialized = True
    
    def is_initialized(self) -> bool:
        """Check if initialized."""
        return self._initialized
    
    def get_scopes(self) -> List[str]:
        """Get provider scopes."""
        return self.scopes
    
    def add_scope(self, scope: str):
        """Add a scope."""
        if scope not in self.scopes:
            self.scopes.append(scope)
    
    def execute(self, action: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """Mock execute action."""
        return {
            "provider": self.name,
            "action": action,
            "params": params,
            "status": "success",
        }


class MockProviderCatalog:
    """Mock provider catalog for testing."""
    
    def __init__(self):
        """Initialize mock catalog."""
        self._providers: Dict[str, MockProvider] = {}
    
    def register(self, provider: MockProvider):
        """Register a provider."""
        self._providers[provider.name] = provider
    
    def get(self, name: str) -> Optional[MockProvider]:
        """Get a provider by name."""
        return self._providers.get(name)

    def list(self) -> List[MockProvider]:
        """List all providers."""
        return list(self._providers.values())
    
    def unregister(self, name: str) -> bool:
        """Unregister a provider."""
        if name in self._providers:
            del self._providers[name]
            return True
        return False
    
    def reset(self):
        """Reset catalog."""
        self._providers.clear()
