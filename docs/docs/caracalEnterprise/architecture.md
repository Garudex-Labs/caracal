# Architecture

Caracal Enterprise Edition is built on a modular and scalable architecture designed to handle high-throughput agentic workflows while maintaining strict security and isolation.

## High-Level Overview

The Enterprise architecture consists of several key components:

1.  **Enterprise Control Plane**: The central management layer that handles API requests, policy management, and agent orchestration.
2.  **Data Layer**: A robust storage layer using PostgreSQL for persistent data and Redis for caching and real-time state management.
3.  **Agent Gateway**: A secure gateway that manages connections from Caracal Core instances and external agents.
4.  **Audit Service**: A dedicated service for collecting and storing audit logs.

## Multi-Tenancy and Isolation

Caracal Enterprise uses a multi-tenant architecture where each customer's data is logically isolated within "Workspaces".

-   **Workspaces**: Containers for resources (agents, policies, configurations) that belong to a specific team or project.
-   **Data Isolation**: All database queries are scoped to the tenant's workspace to prevent data leakage.
-   **Resource Quotas**: Limits can be set per workspace to ensure fair usage of system resources.

## Enterprise Sync

One of the core features of the Enterprise Edition is **Enterprise Sync**. This allows distributed Caracal Core instances to synchronize their local state with the central Enterprise Control Plane.

-   **Policy Sync**: Policies defined in the Enterprise dashboard are pushed to connected Core instances.
-   **Telemetry Sync**: Metrics and logs from Core instances are aggregated in the Enterprise platform for centralized monitoring.
