"""
SDK client for Caracal Core.

Provides developer-friendly API for budget checks and metering event emission.
Implements fail-closed semantics for connection errors.
"""

from decimal import Decimal
from typing import Any, Dict, Optional

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
            # Initialize Agent Registry
            self.agent_registry = AgentRegistry(
                registry_path=self.config.storage.agent_registry,
                backup_count=self.config.storage.backup_count,
            )
            logger.debug("Initialized Agent Registry")
            
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
            resource_type: Type of resource consumed (e.g., "openai.gpt4.input_tokens")
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
            # Create metering event
            event = MeteringEvent(
                agent_id=agent_id,
                resource_type=resource_type,
                quantity=quantity,
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
