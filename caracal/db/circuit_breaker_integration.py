"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Circuit breaker integration for database operations.

This module provides circuit breaker protection for database operations
to prevent cascading failures when the database is unavailable.

Requirements: 23.5, 23.6
"""

from contextlib import contextmanager
from typing import Optional, TypeVar, Callable, Any

from sqlalchemy.orm import Session
from sqlalchemy.exc import OperationalError, DatabaseError, InterfaceError, InternalError

from caracal.core.circuit_breaker import (
    CircuitBreaker,
    CircuitBreakerConfig,
    CircuitBreakerError,
    get_circuit_breaker,
)
from caracal.db.connection import DatabaseConnectionManager
from caracal.logging_config import get_logger

logger = get_logger(__name__)

T = TypeVar('T')


class DatabaseCircuitBreakerManager:
    """
    Manages circuit breaker for database operations.
    
    Wraps database connection manager with circuit breaker protection
    to fail fast when database is unavailable.
    
    Requirements: 23.5, 23.6
    """
    
    def __init__(
        self,
        connection_manager: DatabaseConnectionManager,
        circuit_breaker_config: Optional[CircuitBreakerConfig] = None
    ):
        """
        Initialize database circuit breaker manager.
        
        Args:
            connection_manager: Database connection manager to protect
            circuit_breaker_config: Circuit breaker configuration (uses defaults if not provided)
        """
        self.connection_manager = connection_manager
        self._circuit_breaker: Optional[CircuitBreaker] = None
        self._config = circuit_breaker_config or CircuitBreakerConfig(
            failure_threshold=5,
            success_threshold=2,
            timeout_seconds=60.0,
        )
        
        logger.info(
            "Database circuit breaker manager initialized",
            extra={
                "failure_threshold": self._config.failure_threshold,
                "success_threshold": self._config.success_threshold,
                "timeout_seconds": self._config.timeout_seconds,
            }
        )
    
    async def _get_circuit_breaker(self) -> CircuitBreaker:
        """Get or create circuit breaker for database operations."""
        if self._circuit_breaker is None:
            self._circuit_breaker = await get_circuit_breaker("database", self._config)
        return self._circuit_breaker
    
    async def get_session(self) -> Session:
        """
        Get database session protected by circuit breaker.
        
        Returns:
            SQLAlchemy Session
        
        Raises:
            CircuitBreakerError: If circuit breaker is open
            Exception: Any database connection error
        """
        breaker = await self._get_circuit_breaker()
        
        try:
            session = await breaker.call(self.connection_manager.get_session)
            return session
        except CircuitBreakerError:
            logger.error(
                "Database circuit breaker is open, failing fast",
                extra={"circuit_breaker": "database", "state": "open"}
            )
            raise
        except (OperationalError, DatabaseError, InterfaceError, InternalError) as e:
            logger.error(
                f"Database connection error: {type(e).__name__}: {e}",
                extra={
                    "exception_type": type(e).__name__,
                    "exception_message": str(e),
                }
            )
            raise
    
    @contextmanager
    async def session_scope(self):
        """
        Provide a transactional scope protected by circuit breaker.
        
        Usage:
            async with db_circuit_breaker.session_scope() as session:
                # Perform database operations
                session.add(obj)
        
        Yields:
            SQLAlchemy Session
        
        Raises:
            CircuitBreakerError: If circuit breaker is open
        """
        breaker = await self._get_circuit_breaker()
        
        async def get_session_scope():
            with self.connection_manager.session_scope() as session:
                yield session
        
        try:
            async with breaker.call(get_session_scope) as session:
                yield session
        except CircuitBreakerError:
            logger.error(
                "Database circuit breaker is open, failing fast",
                extra={"circuit_breaker": "database", "state": "open"}
            )
            raise
    
    async def health_check(self) -> bool:
        """
        Perform health check protected by circuit breaker.
        
        Returns:
            True if database is healthy, False otherwise
        """
        breaker = await self._get_circuit_breaker()
        
        try:
            return await breaker.call(self.connection_manager.health_check)
        except CircuitBreakerError:
            logger.warning(
                "Database circuit breaker is open, health check failed",
                extra={"circuit_breaker": "database", "state": "open"}
            )
            return False
        except Exception as e:
            logger.error(f"Health check failed: {e}")
            return False
    
    async def execute_with_circuit_breaker(
        self,
        operation: Callable[[Session], T],
        operation_name: str = "database_operation"
    ) -> T:
        """
        Execute a database operation protected by circuit breaker.
        
        Args:
            operation: Function that takes a Session and returns a result
            operation_name: Name of the operation for logging
        
        Returns:
            Result of the operation
        
        Raises:
            CircuitBreakerError: If circuit breaker is open
            Exception: Any exception raised by the operation
        
        Example:
            result = await db_circuit_breaker.execute_with_circuit_breaker(
                lambda session: session.query(Agent).filter_by(id=agent_id).first(),
                "query_agent"
            )
        """
        breaker = await self._get_circuit_breaker()
        
        async def wrapped_operation():
            with self.connection_manager.session_scope() as session:
                return operation(session)
        
        try:
            return await breaker.call(wrapped_operation)
        except CircuitBreakerError:
            logger.error(
                f"Database circuit breaker is open, {operation_name} failed fast",
                extra={
                    "circuit_breaker": "database",
                    "state": "open",
                    "operation": operation_name,
                }
            )
            raise
        except Exception as e:
            logger.error(
                f"Database operation '{operation_name}' failed: {type(e).__name__}: {e}",
                extra={
                    "operation": operation_name,
                    "exception_type": type(e).__name__,
                    "exception_message": str(e),
                }
            )
            raise


def create_database_circuit_breaker(
    connection_manager: DatabaseConnectionManager,
    config: Optional[CircuitBreakerConfig] = None
) -> DatabaseCircuitBreakerManager:
    """
    Create a database circuit breaker manager.
    
    Args:
        connection_manager: Database connection manager to protect
        config: Circuit breaker configuration (uses defaults if not provided)
    
    Returns:
        DatabaseCircuitBreakerManager instance
    """
    return DatabaseCircuitBreakerManager(connection_manager, config)
