-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
-- SPDX-License-Identifier: Apache-2.0

-- Data-skipping indexes for organization-scoped audit and security queries.
-- Each index accelerates an equality predicate that is ANDed onto the scope
-- filter, so ClickHouse can prune granules instead of scanning the table:
--   * security_events.target_id  - organization scope (target_id = {org_id})
--   * security_events.actor_email - actor filter
--   * audit_log.actor_email       - actor filter
-- The audit organization scope (resource_id = {org_id} OR http_path LIKE ...)
-- is an OR over a non-indexable LIKE, so no single index can prune it; that
-- path relies on month partition pruning from the pagination cursor instead.
--
-- ADD INDEX applies to parts written after this migration. Existing parts keep
-- their current (unindexed) read path until merged, so there is no regression
-- and no blocking mutation at startup.

ALTER TABLE security_events ADD INDEX IF NOT EXISTS idx_se_target_id target_id TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE security_events ADD INDEX IF NOT EXISTS idx_se_actor_email actor_email TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE audit_log ADD INDEX IF NOT EXISTS idx_al_actor_email actor_email TYPE bloom_filter(0.01) GRANULARITY 1;
