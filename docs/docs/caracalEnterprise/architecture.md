# Architecture

Caracal Enterprise Edition is built on a modular, multi-tenant architecture for high-throughput authority enforcement workflows.

---

## High-Level Overview

```
+---------------------------------------------------------------------+
|                     CARACAL ENTERPRISE                               |
+---------------------------------------------------------------------+
|                                                                     |
|  +-------------------+    +------------------+    +---------------+ |
|  | Enterprise API    |    | Dashboard UI     |    | Audit Service | |
|  | (Control Plane)   |    | (Web Console)    |    | (Event Store) | |
|  +--------+----------+    +--------+---------+    +-------+-------+ |
|           |                        |                      |         |
|           +------------+-----------+----------------------+         |
|                        |                                            |
|              +---------+----------+                                 |
|              |                    |                                  |
|       +------+------+     +------+------+                           |
|       | PostgreSQL  |     |    Redis    |                           |
|       | (Persistent)|     | (Cache)    |                           |
|       +-------------+     +------------+                           |
+---------------------------------------------------------------------+
              |                           |
     +--------+--------+        +--------+--------+
     |  Caracal Core   |        |  Caracal Core   |
     |  Instance 1     |        |  Instance 2     |
     +-----------------+        +-----------------+
```

---

## Core Components

| Component | Description |
|-----------|-------------|
| Enterprise API | Central management layer for policies, principals, and mandates |
| Dashboard UI | Web-based console for administrators |
| Audit Service | Collects and stores authority event logs |
| Agent Gateway | Manages connections from distributed Core instances |

---

## Multi-Tenancy and Isolation

| Concept | Description |
|---------|-------------|
| **Workspaces** | Containers for resources (principals, policies, mandates) scoped to a team or project |
| **Data Isolation** | All queries are scoped to the tenant's workspace |
| **Resource Quotas** | Per-workspace limits for fair resource usage |

---

## Enterprise Sync

Enterprise Sync keeps distributed Caracal Core instances in alignment with the central control plane.

- **Policy Sync** -- Policies defined in the Dashboard are pushed to connected Core instances.
- **Telemetry Sync** -- Authority events from Core instances are aggregated for centralized monitoring.
- **Offline Mode** -- If connectivity to Enterprise is lost, Core continues to enforce cached policies (fail-closed if cache expires).

---

## Contact Sales

[Book a Call](https://cal.com/rawx18/caracal-enterprise-sales) to discuss Enterprise deployment for your organization.
