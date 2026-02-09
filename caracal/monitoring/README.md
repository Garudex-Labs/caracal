# Caracal Core Monitoring

This module provides comprehensive Prometheus metrics for monitoring Caracal Core v0.2 in production.

## Overview

The monitoring module instruments all major components of Caracal Core:

- **Gateway Proxy**: Request metrics, authentication failures, replay protection
- **Policy Evaluator**: Policy evaluation metrics, cache statistics
- **Database**: Query metrics, connection pool statistics

- **Circuit Breakers**: State tracking, failure/success counts

## Requirements

- Requirements: 17.7, 22.1

## Installation

The `prometheus-client` package is included in Caracal Core dependencies:

```bash
pip install caracal-core
```

## Quick Start

### Initialize Metrics Registry

```python
from caracal.monitoring import initialize_metrics_registry, get_metrics_registry

# Initialize global metrics registry
metrics = initialize_metrics_registry()

# Later, get the registry from anywhere
metrics = get_metrics_registry()
```

### Expose Metrics Endpoint

Add a `/metrics` endpoint to your FastAPI application:

```python
from fastapi import FastAPI, Response
from caracal.monitoring import get_metrics_registry

app = FastAPI()

@app.get("/metrics")
async def metrics():
    """Prometheus metrics endpoint."""
    metrics_registry = get_metrics_registry()
    return Response(
        content=metrics_registry.generate_metrics(),
        media_type=metrics_registry.get_content_type()
    )
```

### Record Metrics

```python
from caracal.monitoring import get_metrics_registry, PolicyDecisionType

metrics = get_metrics_registry()

# Record a gateway request
metrics.record_gateway_request(
    method="GET",
    status_code=200,
    auth_method="jwt",
    duration_seconds=0.05
)

# Record a policy evaluation
metrics.record_policy_evaluation(
    decision=PolicyDecisionType.ALLOWED,
    agent_id="agent-123",
    duration_seconds=0.01
)
```

## Available Metrics

### Gateway Request Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `caracal_gateway_requests_total` | Counter | Total number of gateway requests | method, status_code, auth_method |
| `caracal_gateway_request_duration_seconds` | Histogram | Gateway request duration | method, status_code |
| `caracal_gateway_requests_in_flight` | Gauge | Number of requests currently being processed | - |
| `caracal_gateway_auth_failures_total` | Counter | Total authentication failures | auth_method, reason |
| `caracal_gateway_replay_blocks_total` | Counter | Total requests blocked by replay protection | reason |
| `caracal_gateway_degraded_mode_requests_total` | Counter | Total requests processed in degraded mode | - |

### Policy Evaluation Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `caracal_policy_evaluations_total` | Counter | Total policy evaluations | decision, agent_id |
| `caracal_policy_evaluation_duration_seconds` | Histogram | Policy evaluation duration | decision |
| `caracal_policy_cache_hits_total` | Counter | Total policy cache hits | - |
| `caracal_policy_cache_misses_total` | Counter | Total policy cache misses | - |
| `caracal_policy_cache_size` | Gauge | Current number of policies in cache | - |
| `caracal_policy_cache_evictions_total` | Counter | Total policy cache evictions | - |

### Database Query Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `caracal_database_queries_total` | Counter | Total database queries | operation, table, status |
| `caracal_database_query_duration_seconds` | Histogram | Database query duration | operation, table |
| `caracal_database_connection_pool_size` | Gauge | Current connection pool size | - |
| `caracal_database_connection_pool_checked_out` | Gauge | Number of connections checked out | - |
| `caracal_database_connection_pool_overflow` | Gauge | Number of overflow connections | - |
| `caracal_database_connection_errors_total` | Counter | Total database connection errors | error_type |


### Circuit Breaker Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `caracal_circuit_breaker_state` | Gauge | Circuit breaker state (0=closed, 1=open, 2=half_open) | name |
| `caracal_circuit_breaker_failures_total` | Counter | Total circuit breaker failures | name |
| `caracal_circuit_breaker_successes_total` | Counter | Total circuit breaker successes | name |
| `caracal_circuit_breaker_state_changes_total` | Counter | Total circuit breaker state changes | name, from_state, to_state |

## Context Managers

The metrics module provides context managers for timing operations:

### Track In-Flight Requests

```python
with metrics.track_gateway_request_in_flight():
    # Process request
    response = await handle_request()
```

### Time Policy Evaluations

```python
with metrics.time_policy_evaluation(PolicyDecisionType.ALLOWED, agent_id):
    # Evaluate policy
    decision = policy_evaluator.check_budget(agent_id, cost)
```

### Time Database Queries

```python
with metrics.time_database_query(DatabaseOperationType.SELECT, "agent_identities"):
    # Execute query
    result = session.execute(query)
```


## Prometheus Configuration

Configure Prometheus to scrape Caracal Core metrics:

```yaml
scrape_configs:
  - job_name: 'caracal-gateway'
    static_configs:
      - targets: ['localhost:8443']
    metrics_path: '/metrics'
    scrape_interval: 15s
    scrape_timeout: 10s
```

## Grafana Dashboards

### Key Metrics to Monitor

1. **Gateway Performance**
   - Request rate: `rate(caracal_gateway_requests_total[5m])`
   - Request duration (p99): `histogram_quantile(0.99, rate(caracal_gateway_request_duration_seconds_bucket[5m]))`
   - Error rate: `rate(caracal_gateway_requests_total{status_code=~"5.."}[5m])`

2. **Policy Evaluation**
   - Evaluation rate: `rate(caracal_policy_evaluations_total[5m])`
   - Denial rate: `rate(caracal_policy_evaluations_total{decision="denied"}[5m])`
   - Cache hit rate: `rate(caracal_policy_cache_hits_total[5m]) / (rate(caracal_policy_cache_hits_total[5m]) + rate(caracal_policy_cache_misses_total[5m]))`

3. **Database Performance**
   - Query rate: `rate(caracal_database_queries_total[5m])`
   - Query duration (p99): `histogram_quantile(0.99, rate(caracal_database_query_duration_seconds_bucket[5m]))`
   - Connection pool utilization: `caracal_database_connection_pool_checked_out / caracal_database_connection_pool_size`


5. **Circuit Breakers**
   - Circuit breaker state: `caracal_circuit_breaker_state`
   - Failure rate: `rate(caracal_circuit_breaker_failures_total[5m])`

## Alerting Rules

Example Prometheus alerting rules:

```yaml
groups:
  - name: caracal_alerts
    rules:
      # High error rate
      - alert: HighGatewayErrorRate
        expr: rate(caracal_gateway_requests_total{status_code=~"5.."}[5m]) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High gateway error rate"
          description: "Gateway error rate is {{ $value }} errors/sec"
      
      # High policy denial rate
      - alert: HighPolicyDenialRate
        expr: rate(caracal_policy_evaluations_total{decision="denied"}[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High policy denial rate"
          description: "Policy denial rate is {{ $value }} denials/sec"
      
      # Database connection pool exhaustion
      - alert: DatabaseConnectionPoolExhausted
        expr: caracal_database_connection_pool_checked_out / caracal_database_connection_pool_size > 0.9
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Database connection pool nearly exhausted"
          description: "Connection pool utilization is {{ $value | humanizePercentage }}"
      
      # Circuit breaker open
      - alert: CircuitBreakerOpen
        expr: caracal_circuit_breaker_state == 1
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Circuit breaker {{ $labels.name }} is open"
          description: "Circuit breaker {{ $labels.name }} has been open for 1 minute"
      
```

## Best Practices

1. **Initialize Early**: Initialize the metrics registry during application startup
2. **Use Context Managers**: Use context managers for automatic timing and cleanup
3. **Label Cardinality**: Be careful with high-cardinality labels (e.g., agent_id)
4. **Scrape Interval**: Use 15-30 second scrape intervals for production
5. **Retention**: Configure appropriate retention periods in Prometheus
6. **Dashboards**: Create dashboards for key metrics before going to production
7. **Alerts**: Set up alerts for critical metrics (error rates, circuit breakers)

## Examples

See `examples/metrics_demo.py` for a complete demonstration of all metrics functionality.

## Architecture

The metrics module follows these design principles:

- **Singleton Pattern**: Global metrics registry for easy access
- **Context Managers**: Automatic timing and error handling
- **Type Safety**: Enums for metric labels to prevent typos
- **Performance**: Minimal overhead (<1ms per metric operation)
- **Thread Safety**: All operations are thread-safe via Prometheus client

## Performance Impact

Metrics collection has minimal performance impact:

- Counter increment: ~0.1μs
- Histogram observation: ~0.5μs
- Gauge set: ~0.1μs
- Context manager overhead: ~1μs

Total overhead per request: <10μs (negligible compared to request processing time)

## Troubleshooting

### Metrics Not Appearing

1. Check that metrics registry is initialized:
   ```python
   from caracal.monitoring import get_metrics_registry
   try:
       metrics = get_metrics_registry()
       print("Metrics initialized")
   except RuntimeError:
       print("Metrics not initialized - call initialize_metrics_registry()")
   ```

2. Verify `/metrics` endpoint is accessible:
   ```bash
   curl http://localhost:8443/metrics
   ```

3. Check Prometheus scrape configuration and targets

### High Cardinality Issues

If you see high memory usage, check for high-cardinality labels:

```python
# Bad: agent_id can have thousands of values
metrics.record_policy_evaluation(decision, agent_id="agent-123", ...)

# Good: Use aggregated metrics or limit label values
metrics.record_policy_evaluation(decision, agent_id="aggregated", ...)
```

### Missing Metrics

Ensure you're recording metrics in all code paths:

```python
try:
    result = operation()
    metrics.record_success()
except Exception as e:
    metrics.record_error()
    raise
```

## References

- [Prometheus Documentation](https://prometheus.io/docs/)
- [Prometheus Python Client](https://github.com/prometheus/client_python)
- [Grafana Documentation](https://grafana.com/docs/)
- [Prometheus Best Practices](https://prometheus.io/docs/practices/)
