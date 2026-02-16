"""
SDK client for Caracal Core.

Provides developer-friendly API for metering event emission and agent management.
Implements fail-closed semantics for connection errors.
"""

from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional

from caracal.config.settings import CaracalConfig, load_config
from caracal.core.identity import AgentRegistry
from caracal.core.ledger import LedgerQuery, LedgerWriter
from caracal.core.metering import MeteringCollector, MeteringEvent
from caracal.exceptions import (
    ConnectionError,
    SDKConfigurationError,
)
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class CaracalClient:
    """
    SDK client for interacting with Caracal Core.
    
    Provides methods for:
    - Emitting metering events
    - Managing agents and delegation tokens
    
    Implements fail-closed semantics: on connection or initialization errors,
    the client will raise exceptions.
    """

    def __init__(self, config_path: Optional[str] = None):
        """
        Initialize Caracal SDK client.
        
        Loads configuration and initializes all core components:
        - Agent Registry
        - Ledger Writer
        - Ledger Query
        - Metering Collector
        
        Args:
            config_path: Path to configuration file. If None, uses default path.
            
        Raises:
            SDKConfigurationError: If configuration loading fails
            ConnectionError: If component initialization fails (fail-closed)
        """
        try:
            # Load configuration
            logger.info("Initializing Caracal SDK client")
            self.config = load_config(config_path)
            logger.debug(f"Loaded configuration from {config_path or 'default path'}")
            
            # Check for deprecated features
            self._check_for_deprecated_features()
            
            # Initialize core components
            self._initialize_components()
            
            logger.info("Caracal SDK client initialized successfully")
            
        except Exception as e:
            # Fail closed: if we can't initialize, raise error
            logger.error(f"Failed to initialize Caracal SDK client: {e}", exc_info=True)
            raise ConnectionError(
                f"Failed to initialize Caracal SDK client: {e}. "
                "Failing closed to prevent unchecked operations."
            ) from e

    def _initialize_components(self) -> None:
        """
        Initialize all Caracal Core components.
        
        Raises:
            ConnectionError: If any component fails to initialize
        """
        try:
            # Initialize DelegationTokenManager first (needed by AgentRegistry)
            from caracal.core.delegation import DelegationTokenManager
            
            # Create a temporary agent registry without delegation token manager
            # This is needed because DelegationTokenManager needs AgentRegistry
            # and AgentRegistry needs DelegationTokenManager (circular dependency)
            self.agent_registry = AgentRegistry(
                registry_path=self.config.storage.agent_registry,
                backup_count=self.config.storage.backup_count,
                delegation_token_manager=None  # Will be set after creation
            )
            logger.debug("Initialized Agent Registry")
            
            # Now create DelegationTokenManager with the agent registry
            self.delegation_token_manager = DelegationTokenManager(
                agent_registry=self.agent_registry
            )
            logger.debug("Initialized Delegation Token Manager")
            
            # Set the delegation token manager in the agent registry
            self.agent_registry.delegation_token_manager = self.delegation_token_manager
            
            # Initialize Ledger Writer
            self.ledger_writer = LedgerWriter(
                ledger_path=self.config.storage.ledger,
                backup_count=self.config.storage.backup_count,
            )
            logger.debug("Initialized Ledger Writer")
            
            # Initialize Ledger Query
            self.ledger_query = LedgerQuery(
                ledger_path=self.config.storage.ledger,
            )
            logger.debug("Initialized Ledger Query")
            
            # Initialize Metering Collector
            self.metering_collector = MeteringCollector(
                ledger_writer=self.ledger_writer,
            )
            logger.debug("Initialized Metering Collector")
            
        except Exception as e:
            raise ConnectionError(
                f"Failed to initialize Caracal Core components: {e}"
            ) from e

    def _check_for_deprecated_features(self) -> None:
        """
        Check for deprecated v0.1 features and emit warnings.
        
        This method checks if the configuration uses file-based storage
        (v0.1 feature) and emits deprecation warnings for features that
        will be removed in v0.3.
        
        Requirements: 20.7
        """
        import warnings
        
        # Check if using file-based storage (v0.1)
        # In v0.2, PostgreSQL is the recommended backend
        # File-based storage will be deprecated in v0.3
        
        # Check if agent_registry points to a .json file (file-based)
        if self.config.storage.agent_registry.endswith('.json'):
            warnings.warn(
                "File-based storage for agent registry is deprecated and will be removed in v0.3. "
                "Please migrate to PostgreSQL backend. "
                "See migration guide: https://garudexlabs.com/docs/migration/v0.1-to-v0.2",
                DeprecationWarning,
                stacklevel=3
            )
        
        # Check if ledger points to a .jsonl file (file-based)
        if self.config.storage.ledger.endswith('.jsonl'):
            warnings.warn(
                "File-based storage for ledger is deprecated and will be removed in v0.3. "
                "Please migrate to PostgreSQL backend. "
                "See migration guide: https://garudexlabs.com/docs/migration/v0.1-to-v0.2",
                DeprecationWarning,
                stacklevel=3
            )

    def emit_event(
        self,
        agent_id: str,
        resource_type: str,
        quantity: Decimal,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Emit a metering event directly.
        
        This method creates a metering event and passes it to the
        MeteringCollector for ledger writing.
        
        Implements fail-closed semantics: if event emission fails,
        raises an exception to alert the caller.
        
        Args:
            agent_id: Agent identifier
            resource_type: Type of resource consumed (e.g., "openai.gpt-5.2.input_tokens")
            quantity: Amount of resource consumed
            metadata: Optional additional context
            
        Raises:
            ConnectionError: If event emission fails (fail-closed)
            
        Example:
            >>> client = CaracalClient()
            >>> client.emit_event(
            ...     agent_id="my-agent-id",
            ...     resource_type="openai.gpt4.input_tokens",
            ...     quantity=Decimal("1000"),
            ...     metadata={"model": "gpt-4", "request_id": "req_123"}
            ... )
        """
        try:
            # Import datetime here to avoid circular imports
            from datetime import datetime
            
            # Create metering event with timestamp
            event = MeteringEvent(
                agent_id=agent_id,
                resource_type=resource_type,
                quantity=quantity,
                timestamp=datetime.utcnow(),
                metadata=metadata,
            )
            
            # Collect event (validates and writes to ledger)
            self.metering_collector.collect_event(event)
            
            logger.info(
                f"Emitted metering event: agent_id={agent_id}, "
                f"resource={resource_type}, quantity={quantity}"
            )
            
        except Exception as e:
            # Fail closed: log and re-raise
            logger.error(
                f"Failed to emit metering event for agent {agent_id}: {e}",
                exc_info=True
            )
            raise ConnectionError(
                f"Failed to emit metering event: {e}. "
                "Failing closed to ensure event is not lost."
            ) from e

    def create_child_agent(
        self,
        parent_agent_id: str,
        child_name: str,
        child_owner: str,
        generate_token: bool = False,
        token_expiration_seconds: int = 86400,
        allowed_operations: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Create a child agent.
        
        This method creates a new agent as a child of the specified parent agent.
        Optionally generates a delegation token for the child.
        
        This is a v0.2 feature that enables hierarchical agent organizations.
        
        Args:
            parent_agent_id: Parent agent identifier
            child_name: Name for the child agent (must be unique)
            child_owner: Owner identifier for the child agent
            generate_token: Whether to generate a delegation token (default: False)
            token_expiration_seconds: Expiration for generated token (default: 86400)
            allowed_operations: Allowed operations for the token (if generated)
            metadata: Optional metadata for the child agent
            
        Returns:
            Dictionary containing:
            - agent_id: Child agent ID
            - name: Child agent name
            - owner: Child agent owner
            - parent_agent_id: Parent agent ID
            - delegation_token: JWT token (if generate_token=True)
            
        Raises:
            ConnectionError: If agent creation fails (fail-closed)
            
        Requirements: 20.4
            
        Example:
            >>> client = CaracalClient()
            >>> child = client.create_child_agent(
            ...     parent_agent_id="parent-uuid",
            ...     child_name="child-agent-1",
            ...     child_owner="team@example.com",
            ...     generate_token=True
            ... )
            >>> print(f"Created child agent: {child['agent_id']}")
            >>> print(f"Delegation token: {child['delegation_token']}")
        """
        try:
            logger.info(
                f"Creating child agent: parent={parent_agent_id}, "
                f"name={child_name}"
            )
            
            # Register child agent with parent relationship
            child_agent = self.agent_registry.register_agent(
                name=child_name,
                owner=child_owner,
                metadata=metadata,
                parent_agent_id=parent_agent_id,
                generate_keys=True  # Generate keys for delegation tokens
            )
            
            result = {
                "agent_id": child_agent.agent_id,
                "name": child_agent.name,
                "owner": child_agent.owner,
                "parent_agent_id": child_agent.parent_agent_id,
                "created_at": child_agent.created_at,
            }
            
            # Generate delegation token if requested
            if generate_token:
                logger.debug(f"Generating delegation token for child {child_agent.agent_id}")
                
                delegation_token = self.agent_registry.generate_delegation_token(
                    parent_agent_id=parent_agent_id,
                    child_agent_id=child_agent.agent_id,
                    expiration_seconds=token_expiration_seconds,
                    allowed_operations=allowed_operations
                )
                
                if delegation_token:
                    result["delegation_token"] = delegation_token
                    logger.debug(f"Generated delegation token for child {child_agent.agent_id}")
                else:
                    logger.warning(
                        f"Failed to generate delegation token for child {child_agent.agent_id}"
                    )
            
            logger.info(
                f"Successfully created child agent: {child_agent.agent_id} "
                f"(parent: {parent_agent_id})"
            )
            
            return result
            
        except Exception as e:
            # Fail closed: log and re-raise
            logger.error(
                f"Failed to create child agent for parent {parent_agent_id}: {e}",
                exc_info=True
            )
            raise ConnectionError(
                f"Failed to create child agent: {e}. "
                "Failing closed to prevent inconsistent state."
            ) from e

    def get_delegation_token(
        self,
        parent_agent_id: str,
        child_agent_id: str,
        expiration_seconds: int = 86400,
        allowed_operations: Optional[List[str]] = None,
    ) -> Optional[str]:
        """
        Generate a delegation token for an existing child agent.
        
        This method generates an ASE v1.0.8 delegation token that allows a child
        agent to prove authorization cryptographically. The token is signed with
        the parent agent's private key.
        
        This is a v0.2 feature for delegation token management.
        
        Args:
            parent_agent_id: Parent agent identifier (issuer)
            child_agent_id: Child agent identifier (subject)
            expiration_seconds: Token validity duration in seconds (default: 86400 = 24 hours)
            allowed_operations: List of allowed operations (default: ["api_call", "mcp_tool"])
            
        Returns:
            JWT delegation token string, or None if token generation fails
            
        Raises:
            ConnectionError: If token generation fails (fail-closed)
            
        Requirements: 20.5
            
        Example:
            >>> client = CaracalClient()
            >>> token = client.get_delegation_token(
            ...     parent_agent_id="parent-uuid",
            ...     child_agent_id="child-uuid",
            ...     expiration_seconds=3600  # 1 hour
            ... )
            >>> print(f"Delegation token: {token}")
        """
        try:
            logger.info(
                f"Generating delegation token: parent={parent_agent_id}, "
                f"child={child_agent_id}"
            )
            
            # Generate delegation token
            token = self.agent_registry.generate_delegation_token(
                parent_agent_id=parent_agent_id,
                child_agent_id=child_agent_id,
                expiration_seconds=expiration_seconds,
                allowed_operations=allowed_operations
            )
            
            if token:
                logger.info(
                    f"Successfully generated delegation token for child {child_agent_id}"
                )
            else:
                logger.warning(
                    f"Failed to generate delegation token for child {child_agent_id}: "
                    "DelegationTokenManager not available"
                )
            
            return token
            
        except Exception as e:
            # Fail closed: log and re-raise
            logger.error(
                f"Failed to generate delegation token for child {child_agent_id}: {e}",
                exc_info=True
            )
            raise ConnectionError(
                f"Failed to generate delegation token: {e}. "
                "Failing closed to prevent unauthorized access."
            ) from e

