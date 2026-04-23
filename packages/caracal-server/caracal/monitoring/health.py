"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Health check module for Caracal Core.

Provides comprehensive health checks for:
- Gateway proxy
- Database connectivity
- Redis connectivity

"""

import time
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Dict, Any, Optional, List

from sqlalchemy.pool import QueuePool

from caracal._version import __version__
from caracal.db.connection import DatabaseConnectionManager
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class HealthStatus(str, Enum):
    """Health status values."""
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNHEALTHY = "unhealthy"


@dataclass
class HealthCheckResult:
    """
    Result of a health check.
    
    Attributes:
        name: Name of the check
        status: Health status (healthy, degraded, unhealthy)
        message: Optional message describing the status
        details: Optional additional details
        checked_at: Timestamp when check was performed
        duration_ms: Duration of the check in milliseconds
    """
    name: str
    status: HealthStatus
    message: Optional[str] = None
    details: Optional[Dict[str, Any]] = None
    checked_at: Optional[datetime] = None
    duration_ms: Optional[float] = None
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result: Dict[str, Any] = {
            "name": self.name,
            "status": self.status.value,
        }
        
        if self.message:
            result["message"] = self.message
        
        if self.details:
            result["details"] = self.details
        
        if self.checked_at:
            result["checked_at"] = self.checked_at.isoformat()
        
        if self.duration_ms is not None:
            result["duration_ms"] = round(self.duration_ms, 2)
        
        return result


@dataclass
class OverallHealthResult:
    """
    Overall health result combining multiple checks.
    
    Attributes:
        status: Overall health status
        service: Service name
        version: Service version
        checks: List of individual health check results
        checked_at: Timestamp when checks were performed
    """
    status: HealthStatus
    service: str
    version: str
    checks: List[HealthCheckResult]
    checked_at: datetime
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "status": self.status.value,
            "service": self.service,
            "version": self.version,
            "checked_at": self.checked_at.isoformat(),
            "checks": {check.name: check.to_dict() for check in self.checks}
        }


class HealthChecker:
    """
    Health checker for Caracal Core components.
    
    Provides health checks for:
    - PostgreSQL database
    - Redis cache
    - Component-specific checks
    
    """
    
    def __init__(
        self,
        service_name: str,
        service_version: Optional[str] = None,
        db_connection_manager: Optional[DatabaseConnectionManager] = None,
        redis_client: Optional[Any] = None,
    ):
        """
        Initialize health checker.
        
        Args:
            service_name: Name of the service
            service_version: Version of the service (defaults to package version)
            db_connection_manager: Optional database connection manager
            redis_client: Optional Redis client
        """
        self.service_name = service_name
        self.service_version = service_version if service_version is not None else __version__
        self.db_connection_manager = db_connection_manager
        self.redis_client = redis_client
        
        logger.info(f"Initialized HealthChecker for {service_name} v{self.service_version}")
    
    async def check_health(self) -> OverallHealthResult:
        """
        Perform all health checks.
        
        Returns:
            OverallHealthResult with status and individual check results
        """
        checked_at = datetime.utcnow()
        checks = []
        
        # Check database
        if self.db_connection_manager:
            checks.append(await self._check_database())
        
        # Check Redis
        if self.redis_client:
            checks.append(await self._check_redis())
        
        # Determine overall status
        overall_status = self._determine_overall_status(checks)
        
        return OverallHealthResult(
            status=overall_status,
            service=self.service_name,
            version=self.service_version,
            checks=checks,
            checked_at=checked_at
        )
    
    async def _check_database(self) -> HealthCheckResult:
        """
        Check PostgreSQL database connectivity.
        
        Returns:
            HealthCheckResult for database
        """
        start_time = time.time()
        checked_at = datetime.utcnow()
        
        db = self.db_connection_manager
        if db is None:
            raise RuntimeError("_check_database requires db_connection_manager")

        try:
            # Try to execute a simple query
            is_healthy = db.health_check()
            
            duration_ms = (time.time() - start_time) * 1000
            
            if is_healthy:
                # Get connection pool stats if available
                details: Dict[str, Any] = {}
                try:
                    pool = db.get_engine().pool
                    if isinstance(pool, QueuePool):
                        details = {
                            "pool_size": pool.size(),
                            "checked_out": pool.checkedout(),
                            "overflow": pool.overflow(),
                        }
                except Exception:
                    pass
                
                return HealthCheckResult(
                    name="database",
                    status=HealthStatus.HEALTHY,
                    message="PostgreSQL connection successful",
                    details=details,
                    checked_at=checked_at,
                    duration_ms=duration_ms
                )
            else:
                return HealthCheckResult(
                    name="database",
                    status=HealthStatus.UNHEALTHY,
                    message="PostgreSQL health check failed",
                    checked_at=checked_at,
                    duration_ms=duration_ms
                )
        
        except Exception as e:
            duration_ms = (time.time() - start_time) * 1000
            logger.error(f"Database health check failed: {e}", exc_info=True)
            
            return HealthCheckResult(
                name="database",
                status=HealthStatus.UNHEALTHY,
                message=f"PostgreSQL connection failed: {type(e).__name__}",
                details={"error": str(e)},
                checked_at=checked_at,
                duration_ms=duration_ms
            )
    
    async def _check_redis(self) -> HealthCheckResult:
        """
        Check Redis connectivity.
        
        Returns:
            HealthCheckResult for Redis
        """
        start_time = time.time()
        checked_at = datetime.utcnow()
        
        redis = self.redis_client
        if redis is None:
            raise RuntimeError("_check_redis requires redis_client")

        try:
            # Try to ping Redis
            if hasattr(redis, 'ping'):
                await redis.ping()
            elif hasattr(redis, 'client') and hasattr(redis.client, 'ping'):
                await redis.client.ping()
            else:
                # Assume healthy if we can't ping
                logger.warning("Redis client doesn't have ping method, assuming healthy")
            
            duration_ms = (time.time() - start_time) * 1000
            
            # Get Redis info if available
            details = {}
            try:
                if hasattr(redis, 'info'):
                    info = await redis.info()
                    details = {
                        "version": info.get("redis_version"),
                        "connected_clients": info.get("connected_clients"),
                        "used_memory_human": info.get("used_memory_human"),
                    }
                elif hasattr(redis, 'client') and hasattr(redis.client, 'info'):
                    info = await redis.client.info()
                    details = {
                        "version": info.get("redis_version"),
                        "connected_clients": info.get("connected_clients"),
                        "used_memory_human": info.get("used_memory_human"),
                    }
            except Exception:
                pass
            
            return HealthCheckResult(
                name="redis",
                status=HealthStatus.HEALTHY,
                message="Redis connection successful",
                details=details,
                checked_at=checked_at,
                duration_ms=duration_ms
            )
        
        except Exception as e:
            duration_ms = (time.time() - start_time) * 1000
            logger.error(f"Redis health check failed: {e}", exc_info=True)
            
            return HealthCheckResult(
                name="redis",
                status=HealthStatus.UNHEALTHY,
                message=f"Redis connection failed: {type(e).__name__}",
                details={"error": str(e)},
                checked_at=checked_at,
                duration_ms=duration_ms
            )
    
    def _determine_overall_status(self, checks: List[HealthCheckResult]) -> HealthStatus:
        """
        Determine overall health status from individual checks.
        
        Rules:
        - If any check is UNHEALTHY, overall is UNHEALTHY
        - If any check is DEGRADED, overall is DEGRADED
        - Otherwise, overall is HEALTHY
        
        Args:
            checks: List of health check results
        
        Returns:
            Overall health status
        """
        if not checks:
            return HealthStatus.HEALTHY
        
        # Check for unhealthy
        if any(check.status == HealthStatus.UNHEALTHY for check in checks):
            return HealthStatus.UNHEALTHY
        
        # Check for degraded
        if any(check.status == HealthStatus.DEGRADED for check in checks):
            return HealthStatus.DEGRADED
        
        return HealthStatus.HEALTHY


async def check_database_health(
    db_connection_manager: DatabaseConnectionManager,
) -> HealthCheckResult:
    """
    Standalone function to check database health.
    
    Args:
        db_connection_manager: Database connection manager
    
    Returns:
        HealthCheckResult for database
    """
    checker = HealthChecker(
        service_name="database-check",
        db_connection_manager=db_connection_manager
    )
    return await checker._check_database()


async def check_redis_health(redis_client: Any) -> HealthCheckResult:
    """
    Standalone function to check Redis health.
    
    Args:
        redis_client: Redis client
    
    Returns:
        HealthCheckResult for Redis
    """
    checker = HealthChecker(
        service_name="redis-check",
        redis_client=redis_client
    )
    return await checker._check_redis()
