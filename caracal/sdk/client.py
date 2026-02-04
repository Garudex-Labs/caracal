"""
SDK client for Caracal Core.

Provides developer-friendly API for budget checks and metering event emission.
Implements fail-closed semantics for connection errors.
"""

from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional

from caracal.config.settings import CaracalConfig, load_config
from caracal.core.identity import AgentRegistry
from caracal.core.ledger import LedgerQuery, LedgerWriter
from caracal.core.metering import MeteringCollector, MeteringEvent
from caracal.core.policy import PolicyEvaluator, PolicyStore
from caracal.core.pricebook import Pricebook
from caracal.exceptions import (
    BudgetExceededError,
    ConnectionError,
    PolicyEvaluationError,
    SDKConfigurationError,
)
from caracal.logging_config import get_logger

# Import context manager (avoid circular import with TYPE_CHECKING)
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from caracal.sdk.context import BudgetCheckContext

logger = get_logger(__name__)


class CaracalClient:
    """
    SDK client for interacting with Caracal Core.
    
    Provides methods for:
    - Emitting metering events
    - Checking budgets (via context manager in separate module)
    
    Implements fail-closed semantics: on connection or initialization errors,
    the client will raise exceptions to prevent unchecked spending.
    """

    def __init__(self, config_path: Optional[str] = None):
        """
        Initialize Caracal SDK client.
        
        Loads configuration and initializes all core components:
        - Agent Registry
        - Policy Store
        - Pricebook
        - Ledger Writer
        - Ledger Query
        - Policy Evaluator
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
            
            # Check if using file-based storage (v0.1) and emit deprecation warning
            self._check_for_deprecated_features()
            
            # Initialize core components
            self._initialize_components()
            
            logger.info("Caracal SDK client initialized successfully")
            
        except Exception as e:
            # Fail closed: if we can't initialize, raise error
            logger.error(f"Failed to initialize Caracal SDK client: {e}", exc_info=True)
            raise ConnectionError(
                f"Failed to initialize Caracal SDK client: {e}. "
                "Failing closed to prevent unchecked spending."
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
            
            # Initialize Policy Store (with agent registry for validation)
            self.policy_store = PolicyStore(
                policy_path=self.config.storage.policy_store,
                agent_registry=self.agent_registry,
                backup_count=self.config.storage.backup_count,
            )
            logger.debug("Initialized Policy Store")
            
            # Initialize Pricebook
            self.pricebook = Pricebook(
                csv_path=self.config.storage.pricebook,
                backup_count=self.config.storage.backup_count,
            )
            logger.debug("Initialized Pricebook")
            
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
            
            # Initialize Policy Evaluator
            self.policy_evaluator = PolicyEvaluator(
                policy_store=self.policy_store,
                ledger_query=self.ledger_query,
            )
            logger.debug("Initialized Policy Evaluator")
            
            # Initialize Metering Collector
            self.metering_collector = MeteringCollector(
                pricebook=self.pricebook,
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
                "See migration guide: https://caracal.dev/docs/migration/v0.1-to-v0.2",
                DeprecationWarning,
                stacklevel=3
            )
            logger.warning(
                "Using deprecated file-based agent registry. "
                "This feature will be removed in v0.3. "
                "Please migrate to PostgreSQL."
            )
        
        # Check if policy_store points to a .json file (file-based)
        if self.config.storage.policy_store.endswith('.json'):
            warnings.warn(
                "File-based storage for policy store is deprecated and will be removed in v0.3. "
                "Please migrate to PostgreSQL backend. "
                "See migration guide: https://caracal.dev/docs/migration/v0.1-to-v0.2",
                DeprecationWarning,
                stacklevel=3
            )
            logger.warning(
                "Using deprecated file-based policy store. "
                "This feature will be removed in v0.3. "
                "Please migrate to PostgreSQL."
            )
        
        # Check if ledger points to a .jsonl file (file-based)
        if self.config.storage.ledger.endswith('.jsonl'):
            warnings.warn(
                "File-based storage for ledger is deprecated and will be removed in v0.3. "
                "Please migrate to PostgreSQL backend. "
                "See migration guide: https://caracal.dev/docs/migration/v0.1-to-v0.2",
                DeprecationWarning,
                stacklevel=3
            )
            logger.warning(
                "Using deprecated file-based ledger. "
                "This feature will be removed in v0.3. "
                "Please migrate to PostgreSQL."
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
        MeteringCollector for cost calculation and ledger writing.
        
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
            
            # Collect event (validates, calculates cost, writes to ledger)
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

    def check_budget(self, agent_id: str) -> bool:
        """
        Check if an agent is within budget.
        
        This is a simple budget check that returns True if the agent
        is within budget, False otherwise.
        
        Implements fail-closed semantics: if budget check fails,
        returns False to deny the action.
        
        Args:
            agent_id: Agent identifier
            
        Returns:
            True if agent is within budget, False otherwise
            
        Example:
            >>> client = CaracalClient()
            >>> if client.check_budget("my-agent-id"):
            ...     # Proceed with expensive operation
            ...     result = call_expensive_api()
        """
        try:
            decision = self.policy_evaluator.check_budget(agent_id)
            
            if decision.allowed:
                logger.info(
                    f"Budget check passed for agent {agent_id}: "
                    f"remaining={decision.remaining_budget}"
                )
            else:
                logger.warning(
                    f"Budget check failed for agent {agent_id}: {decision.reason}"
                )
            
            return decision.allowed
            
        except PolicyEvaluationError as e:
            # Fail closed: log and return False
            logger.error(
                f"Budget check failed for agent {agent_id}: {e}",
                exc_info=True
            )
            return False
        except Exception as e:
            # Fail closed: log and return False
            logger.error(
                f"Unexpected error during budget check for agent {agent_id}: {e}",
                exc_info=True
            )
            return False

    def get_remaining_budget(self, agent_id: str) -> Optional[Decimal]:
        """
        Get the remaining budget for an agent.
        
        Returns None if no policy exists or budget check fails (fail-closed).
        
        Args:
            agent_id: Agent identifier
            
        Returns:
            Remaining budget as Decimal, or None if no policy or check fails
            
        Example:
            >>> client = CaracalClient()
            >>> remaining = client.get_remaining_budget("my-agent-id")
            >>> if remaining and remaining > Decimal("10.00"):
            ...     # Proceed with operation
            ...     result = call_api()
        """
        try:
            decision = self.policy_evaluator.check_budget(agent_id)
            
            if decision.allowed:
                logger.debug(
                    f"Remaining budget for agent {agent_id}: {decision.remaining_budget}"
                )
                return decision.remaining_budget
            else:
                # No policy or budget exceeded - return None (fail-closed)
                logger.debug(
                    f"Agent {agent_id} budget check denied: {decision.reason}"
                )
                return None
            
        except Exception as e:
            # Fail closed: log and return None
            logger.error(
                f"Failed to get remaining budget for agent {agent_id}: {e}",
                exc_info=True
            )
            return None

    def budget_check(self, agent_id: str) -> "BudgetCheckContext":
        """
        Create a budget check context manager.
        
        This context manager checks the agent's budget on entry and
        raises BudgetExceededError if the budget is exceeded.
        
        Implements fail-closed semantics: raises BudgetExceededError
        if budget check fails for any reason.
        
        Args:
            agent_id: Agent identifier
            
        Returns:
            BudgetCheckContext instance
            
        Raises:
            BudgetExceededError: If budget is exceeded or check fails
            
        Example:
            >>> client = CaracalClient()
            >>> with client.budget_check(agent_id="my-agent"):
            ...     # Code that incurs costs
            ...     result = call_expensive_api()
            ...     # Emit metering event manually
            ...     client.emit_event(
            ...         agent_id="my-agent",
            ...         resource_type="openai.gpt4.input_tokens",
            ...         quantity=Decimal("1000")
            ...     )
        """
        # Import here to avoid circular import
        from caracal.sdk.context import BudgetCheckContext
        
        return BudgetCheckContext(self, agent_id)

    def create_child_agent(
        self,
        parent_agent_id: str,
        child_name: str,
        child_owner: str,
        delegated_budget: Optional[Decimal] = None,
        budget_currency: str = "USD",
        budget_time_window: str = "daily",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Create a child agent with optional delegated budget.
        
        This method creates a new agent as a child of the specified parent agent
        and optionally creates a delegated budget policy for the child. If a
        delegated budget is specified, a delegation token is also generated.
        
        This is a v0.2 feature that enables hierarchical agent organizations.
        
        Args:
            parent_agent_id: Parent agent identifier
            child_name: Name for the child agent (must be unique)
            child_owner: Owner identifier for the child agent
            delegated_budget: Optional budget amount to delegate to child
            budget_currency: Currency code for budget (default: "USD")
            budget_time_window: Time window for budget (default: "daily")
            metadata: Optional metadata for the child agent
            
        Returns:
            Dictionary containing:
            - agent_id: Child agent ID
            - name: Child agent name
            - owner: Child agent owner
            - parent_agent_id: Parent agent ID
            - delegation_token: JWT token (if delegated_budget provided)
            - policy_id: Budget policy ID (if delegated_budget provided)
            
        Raises:
            ConnectionError: If agent creation fails (fail-closed)
            
        Requirements: 20.4
            
        Example:
            >>> client = CaracalClient()
            >>> child = client.create_child_agent(
            ...     parent_agent_id="parent-uuid",
            ...     child_name="child-agent-1",
            ...     child_owner="team@example.com",
            ...     delegated_budget=Decimal("100.00"),
            ...     budget_currency="USD",
            ...     budget_time_window="daily"
            ... )
            >>> print(f"Created child agent: {child['agent_id']}")
            >>> print(f"Delegation token: {child['delegation_token']}")
        """
        try:
            logger.info(
                f"Creating child agent: parent={parent_agent_id}, "
                f"name={child_name}, budget={delegated_budget}"
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
            
            # Create delegated budget policy if budget specified
            if delegated_budget is not None:
                logger.debug(
                    f"Creating delegated budget policy for child {child_agent.agent_id}: "
                    f"{delegated_budget} {budget_currency}"
                )
                
                # Create policy with delegation tracking
                policy = self.policy_store.create_policy(
                    agent_id=child_agent.agent_id,
                    limit_amount=delegated_budget,
                    time_window=budget_time_window,
                    currency=budget_currency,
                    delegated_from_agent_id=parent_agent_id
                )
                
                result["policy_id"] = policy.policy_id
                result["delegated_budget"] = str(delegated_budget)
                result["budget_currency"] = budget_currency
                result["budget_time_window"] = budget_time_window
                
                # Generate delegation token
                delegation_token = self.agent_registry.generate_delegation_token(
                    parent_agent_id=parent_agent_id,
                    child_agent_id=child_agent.agent_id,
                    spending_limit=float(delegated_budget),
                    currency=budget_currency,
                    expiration_seconds=86400,  # 24 hours
                    allowed_operations=["api_call", "mcp_tool"]
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
        spending_limit: Decimal,
        currency: str = "USD",
        expiration_seconds: int = 86400,
        allowed_operations: Optional[List[str]] = None,
    ) -> Optional[str]:
        """
        Generate a delegation token for an existing child agent.
        
        This method generates an ASE v1.0.8 delegation token that allows a child
        agent to prove authorization cryptographically. The token is signed with
        the parent agent's private key and includes spending limits and expiration.
        
        This is a v0.2 feature for delegation token management.
        
        Args:
            parent_agent_id: Parent agent identifier (issuer)
            child_agent_id: Child agent identifier (subject)
            spending_limit: Maximum spending allowed
            currency: Currency code (default: "USD")
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
            ...     spending_limit=Decimal("50.00"),
            ...     currency="USD",
            ...     expiration_seconds=3600  # 1 hour
            ... )
            >>> print(f"Delegation token: {token}")
        """
        try:
            logger.info(
                f"Generating delegation token: parent={parent_agent_id}, "
                f"child={child_agent_id}, limit={spending_limit} {currency}"
            )
            
            # Generate delegation token
            token = self.agent_registry.generate_delegation_token(
                parent_agent_id=parent_agent_id,
                child_agent_id=child_agent_id,
                spending_limit=float(spending_limit),
                currency=currency,
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

    def query_spending_with_children(
        self,
        agent_id: str,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
        include_breakdown: bool = False,
    ) -> Dict[str, Any]:
        """
        Query spending for an agent including all child agents.
        
        This method aggregates spending across a parent agent and all its descendants
        (children, grandchildren, etc.). It can return either a simple total or a
        detailed hierarchical breakdown.
        
        This is a v0.2 feature for hierarchical spending rollup.
        
        Args:
            agent_id: Parent agent identifier
            start_time: Start of time window (defaults to beginning of current day)
            end_time: End of time window (defaults to current time)
            include_breakdown: If True, return hierarchical breakdown; if False, return totals only
            
        Returns:
            Dictionary containing:
            - agent_id: Parent agent ID
            - start_time: Query start time (ISO format)
            - end_time: Query end time (ISO format)
            - own_spending: Parent's own spending
            - total_spending: Total spending including all descendants
            - children_spending: Total spending by all descendants
            - breakdown: Hierarchical breakdown (if include_breakdown=True)
            
        Raises:
            ConnectionError: If query fails (fail-closed)
            
        Requirements: 20.5
            
        Example:
            >>> from datetime import datetime, timedelta
            >>> client = CaracalClient()
            >>> 
            >>> # Query last 24 hours with breakdown
            >>> end = datetime.utcnow()
            >>> start = end - timedelta(days=1)
            >>> result = client.query_spending_with_children(
            ...     agent_id="parent-uuid",
            ...     start_time=start,
            ...     end_time=end,
            ...     include_breakdown=True
            ... )
            >>> print(f"Total spending: {result['total_spending']}")
            >>> print(f"Parent spending: {result['own_spending']}")
            >>> print(f"Children spending: {result['children_spending']}")
        """
        try:
            # Import datetime here to avoid circular imports
            from datetime import datetime, timedelta
            
            # Default time window: current day
            if end_time is None:
                end_time = datetime.utcnow()
            
            if start_time is None:
                # Start of current day
                start_time = end_time.replace(hour=0, minute=0, second=0, microsecond=0)
            
            logger.info(
                f"Querying spending with children: agent={agent_id}, "
                f"start={start_time.isoformat()}, end={end_time.isoformat()}, "
                f"breakdown={include_breakdown}"
            )
            
            # Get spending breakdown by agent
            spending_by_agent = self.ledger_query.sum_spending_with_children(
                agent_id=agent_id,
                start_time=start_time,
                end_time=end_time,
                agent_registry=self.agent_registry
            )
            
            # Calculate totals
            own_spending = spending_by_agent.get(agent_id, Decimal('0'))
            total_spending = sum(spending_by_agent.values())
            children_spending = total_spending - own_spending
            
            result = {
                "agent_id": agent_id,
                "start_time": start_time.isoformat() + "Z",
                "end_time": end_time.isoformat() + "Z",
                "own_spending": str(own_spending),
                "children_spending": str(children_spending),
                "total_spending": str(total_spending),
                "agent_count": len(spending_by_agent),
            }
            
            # Add hierarchical breakdown if requested
            if include_breakdown:
                breakdown = self.ledger_query.get_spending_breakdown(
                    agent_id=agent_id,
                    start_time=start_time,
                    end_time=end_time,
                    agent_registry=self.agent_registry
                )
                
                # Convert Decimal values to strings for JSON serialization
                def convert_decimals(obj):
                    if isinstance(obj, dict):
                        return {k: convert_decimals(v) for k, v in obj.items()}
                    elif isinstance(obj, list):
                        return [convert_decimals(item) for item in obj]
                    elif isinstance(obj, Decimal):
                        return str(obj)
                    else:
                        return obj
                
                result["breakdown"] = convert_decimals(breakdown)
            
            logger.info(
                f"Spending query complete: agent={agent_id}, "
                f"total={total_spending}, own={own_spending}, "
                f"children={children_spending}, agents={len(spending_by_agent)}"
            )
            
            return result
            
        except Exception as e:
            # Fail closed: log and re-raise
            logger.error(
                f"Failed to query spending with children for agent {agent_id}: {e}",
                exc_info=True
            )
            raise ConnectionError(
                f"Failed to query spending with children: {e}. "
                "Failing closed to prevent incorrect budget calculations."
            ) from e
