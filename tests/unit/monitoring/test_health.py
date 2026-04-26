"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for HealthCheckResult, OverallHealthResult, and HealthChecker in health.py.
"""

from __future__ import annotations

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from caracal.monitoring.health import (
    HealthCheckResult,
    HealthChecker,
    HealthStatus,
    OverallHealthResult,
    check_database_health,
    check_redis_health,
)


@pytest.mark.unit
class TestHealthCheckResultToDict:
    def test_minimal(self):
        r = HealthCheckResult(name="db", status=HealthStatus.HEALTHY)
        d = r.to_dict()
        assert d["name"] == "db"
        assert d["status"] == "healthy"
        assert "message" not in d
        assert "details" not in d
        assert "checked_at" not in d
        assert "duration_ms" not in d

    def test_full_result(self):
        now = datetime.utcnow()
        r = HealthCheckResult(
            name="db",
            status=HealthStatus.UNHEALTHY,
            message="Connection failed",
            details={"error": "timeout"},
            checked_at=now,
            duration_ms=50.123456,
        )
        d = r.to_dict()
        assert d["message"] == "Connection failed"
        assert d["details"] == {"error": "timeout"}
        assert d["checked_at"] == now.isoformat()
        assert d["duration_ms"] == 50.12

    def test_degraded_status(self):
        r = HealthCheckResult(name="redis", status=HealthStatus.DEGRADED)
        assert r.to_dict()["status"] == "degraded"

    def test_zero_duration_ms(self):
        r = HealthCheckResult(name="db", status=HealthStatus.HEALTHY, duration_ms=0.0)
        assert r.to_dict()["duration_ms"] == 0.0


@pytest.mark.unit
class TestOverallHealthResultToDict:
    def test_returns_checks_as_dict(self):
        now = datetime.utcnow()
        check = HealthCheckResult(name="db", status=HealthStatus.HEALTHY)
        result = OverallHealthResult(
            status=HealthStatus.HEALTHY,
            service="test-service",
            version="1.0.0",
            checks=[check],
            checked_at=now,
        )
        d = result.to_dict()
        assert d["status"] == "healthy"
        assert d["service"] == "test-service"
        assert d["version"] == "1.0.0"
        assert d["checked_at"] == now.isoformat()
        assert "db" in d["checks"]

    def test_empty_checks(self):
        now = datetime.utcnow()
        result = OverallHealthResult(
            status=HealthStatus.HEALTHY,
            service="svc",
            version="1.0",
            checks=[],
            checked_at=now,
        )
        d = result.to_dict()
        assert d["checks"] == {}


@pytest.mark.unit
class TestHealthCheckerDetermineOverallStatus:
    def setup_method(self):
        self.checker = HealthChecker(service_name="test")

    def test_no_checks_returns_healthy(self):
        assert self.checker._determine_overall_status([]) == HealthStatus.HEALTHY

    def test_all_healthy_returns_healthy(self):
        checks = [
            HealthCheckResult(name="a", status=HealthStatus.HEALTHY),
            HealthCheckResult(name="b", status=HealthStatus.HEALTHY),
        ]
        assert self.checker._determine_overall_status(checks) == HealthStatus.HEALTHY

    def test_any_unhealthy_returns_unhealthy(self):
        checks = [
            HealthCheckResult(name="a", status=HealthStatus.HEALTHY),
            HealthCheckResult(name="b", status=HealthStatus.UNHEALTHY),
        ]
        assert self.checker._determine_overall_status(checks) == HealthStatus.UNHEALTHY

    def test_any_degraded_returns_degraded(self):
        checks = [
            HealthCheckResult(name="a", status=HealthStatus.HEALTHY),
            HealthCheckResult(name="b", status=HealthStatus.DEGRADED),
        ]
        assert self.checker._determine_overall_status(checks) == HealthStatus.DEGRADED

    def test_unhealthy_beats_degraded(self):
        checks = [
            HealthCheckResult(name="a", status=HealthStatus.DEGRADED),
            HealthCheckResult(name="b", status=HealthStatus.UNHEALTHY),
        ]
        assert self.checker._determine_overall_status(checks) == HealthStatus.UNHEALTHY


@pytest.mark.unit
class TestHealthCheckerCheckHealth:
    @pytest.mark.asyncio
    async def test_no_resources_returns_healthy(self):
        checker = HealthChecker(service_name="test", service_version="1.0")
        result = await checker.check_health()
        assert result.status == HealthStatus.HEALTHY
        assert result.service == "test"
        assert result.version == "1.0"
        assert result.checks == []

    @pytest.mark.asyncio
    async def test_with_healthy_db(self):
        db = MagicMock()
        db.health_check.return_value = True
        db.get_engine.return_value.pool = MagicMock()
        db.get_engine.return_value.pool.__class__ = object  # not QueuePool

        checker = HealthChecker(service_name="test", db_connection_manager=db)
        result = await checker.check_health()
        assert any(c.name == "database" for c in result.checks)

    @pytest.mark.asyncio
    async def test_with_healthy_redis(self):
        redis = MagicMock()
        redis.ping = AsyncMock(return_value=True)

        checker = HealthChecker(service_name="test", redis_client=redis)
        result = await checker.check_health()
        assert any(c.name == "redis" for c in result.checks)


@pytest.mark.unit
class TestHealthCheckerCheckDatabase:
    @pytest.mark.asyncio
    async def test_healthy_db(self):
        db = MagicMock()
        db.health_check.return_value = True
        db.get_engine.return_value.pool = MagicMock()
        db.get_engine.return_value.pool.__class__ = object

        checker = HealthChecker(service_name="test", db_connection_manager=db)
        result = await checker._check_database()
        assert result.status == HealthStatus.HEALTHY
        assert result.name == "database"

    @pytest.mark.asyncio
    async def test_unhealthy_db(self):
        db = MagicMock()
        db.health_check.return_value = False

        checker = HealthChecker(service_name="test", db_connection_manager=db)
        result = await checker._check_database()
        assert result.status == HealthStatus.UNHEALTHY

    @pytest.mark.asyncio
    async def test_db_exception_returns_unhealthy(self):
        db = MagicMock()
        db.health_check.side_effect = RuntimeError("connection refused")

        checker = HealthChecker(service_name="test", db_connection_manager=db)
        result = await checker._check_database()
        assert result.status == HealthStatus.UNHEALTHY
        assert "connection refused" in result.message or "RuntimeError" in result.message

    @pytest.mark.asyncio
    async def test_healthy_db_with_queue_pool_stats(self):
        from sqlalchemy.pool import QueuePool
        db = MagicMock()
        db.health_check.return_value = True
        pool = MagicMock(spec=QueuePool)
        pool.size.return_value = 5
        pool.checkedout.return_value = 2
        pool.overflow.return_value = 0
        db.get_engine.return_value.pool = pool

        checker = HealthChecker(service_name="test", db_connection_manager=db)
        result = await checker._check_database()
        assert result.status == HealthStatus.HEALTHY
        assert result.details is not None


@pytest.mark.unit
class TestHealthCheckerCheckRedis:
    @pytest.mark.asyncio
    async def test_healthy_redis_with_ping(self):
        redis = MagicMock()
        redis.ping = AsyncMock(return_value=True)

        checker = HealthChecker(service_name="test", redis_client=redis)
        result = await checker._check_redis()
        assert result.status == HealthStatus.HEALTHY
        assert result.name == "redis"

    @pytest.mark.asyncio
    async def test_healthy_redis_client_ping(self):
        redis = MagicMock(spec=[])
        redis.client = MagicMock()
        redis.client.ping = AsyncMock(return_value=True)

        checker = HealthChecker(service_name="test", redis_client=redis)
        result = await checker._check_redis()
        assert result.status == HealthStatus.HEALTHY

    @pytest.mark.asyncio
    async def test_redis_no_ping_assumes_healthy(self):
        redis = MagicMock(spec=[])

        checker = HealthChecker(service_name="test", redis_client=redis)
        result = await checker._check_redis()
        assert result.status == HealthStatus.HEALTHY

    @pytest.mark.asyncio
    async def test_redis_ping_raises(self):
        redis = MagicMock()
        redis.ping = AsyncMock(side_effect=ConnectionError("refused"))

        checker = HealthChecker(service_name="test", redis_client=redis)
        result = await checker._check_redis()
        assert result.status == HealthStatus.UNHEALTHY


@pytest.mark.unit
class TestStandaloneHealthFunctions:
    @pytest.mark.asyncio
    async def test_check_database_health(self):
        db = MagicMock()
        db.health_check.return_value = True
        db.get_engine.return_value.pool = MagicMock()
        db.get_engine.return_value.pool.__class__ = object

        result = await check_database_health(db)
        assert result.name == "database"
        assert result.status == HealthStatus.HEALTHY

    @pytest.mark.asyncio
    async def test_check_redis_health(self):
        redis = MagicMock()
        redis.ping = AsyncMock(return_value=True)

        result = await check_redis_health(redis)
        assert result.name == "redis"
        assert result.status == HealthStatus.HEALTHY
