-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
-- SPDX-License-Identifier: Apache-2.0
-- Complete PostgreSQL schema for a fresh database at version 001_baseline.



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;



COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';



CREATE TYPE public.agentstatus AS ENUM (
    'draft',
    'pending',
    'approved',
    'rejected',
    'archived'
);



CREATE TYPE public.inbox_kind AS ENUM (
    'review_requested',
    'review_approved',
    'review_rejected',
    'review_comment',
    'change_requested',
    'team_join_requested',
    'team_join_decided',
    'team_created_pending',
    'ownership_transfer',
    'update_available',
    'insight_ready',
    'system_notice'
);



CREATE TYPE public.inbox_state AS ENUM (
    'open',
    'done',
    'dismissed'
);



CREATE TYPE public.insight_report_status AS ENUM (
    'pending',
    'running',
    'completed',
    'failed'
);



CREATE TYPE public.listingstatus AS ENUM (
    'draft',
    'pending',
    'approved',
    'rejected',
    'archived'
);



CREATE TYPE public.migration_operation AS ENUM (
    'export',
    'import_',
    'validate'
);



CREATE TYPE public.migration_scope AS ENUM (
    'postgres',
    'clickhouse',
    'both'
);



CREATE TYPE public.migration_status AS ENUM (
    'queued',
    'running',
    'completed',
    'failed'
);



CREATE TYPE public.organization_role AS ENUM (
    'owner',
    'admin',
    'member'
);



CREATE TYPE public.project_role AS ENUM (
    'lead',
    'user'
);



CREATE TYPE public.review_issue_status AS ENUM (
    'open',
    'resolved'
);



CREATE TYPE public.team_join_request_status AS ENUM (
    'pending',
    'approved',
    'rejected',
    'cancelled'
);



CREATE TYPE public.teamrole AS ENUM (
    'owner',
    'reviewer',
    'member'
);



CREATE TYPE public.userrole AS ENUM (
    'operator',
    'reviewer',
    'user'
);


SET default_tablespace = '';

SET default_table_access_method = heap;


CREATE TABLE public.agent_components (
    id uuid NOT NULL,
    agent_version_id uuid NOT NULL,
    component_type character varying(50) NOT NULL,
    component_id uuid NOT NULL,
    component_name character varying(255) NOT NULL,
    resolved_version character varying(50) NOT NULL,
    order_index integer NOT NULL,
    config_override json,
    created_at timestamp with time zone NOT NULL
);



CREATE TABLE public.agent_download_records (
    id uuid NOT NULL,
    agent_id uuid NOT NULL,
    user_id uuid,
    fingerprint text,
    source character varying(50) NOT NULL,
    harness character varying(50),
    installed_at timestamp with time zone NOT NULL
);



CREATE TABLE public.agent_versions (
    id uuid NOT NULL,
    agent_id uuid NOT NULL,
    version character varying(50) NOT NULL,
    description text NOT NULL,
    prompt text NOT NULL,
    model_name character varying(100) NOT NULL,
    model_config_json json NOT NULL,
    models_by_harness json NOT NULL,
    external_mcps json NOT NULL,
    supported_harnesses json NOT NULL,
    required_capabilities json NOT NULL,
    inferred_supported_harnesses json NOT NULL,
    yaml_snapshot text,
    harness_configs json,
    lock_snapshot text,
    status public.agentstatus NOT NULL,
    is_prerelease boolean NOT NULL,
    promoted_from uuid,
    rejection_reason text,
    download_count integer NOT NULL,
    released_by uuid NOT NULL,
    released_at timestamp with time zone NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    is_editing boolean NOT NULL,
    editing_since timestamp with time zone,
    editing_by uuid,
    gaming_flags json,
    success_criteria json
);



CREATE TABLE public.agents (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    namespace character varying(32) NOT NULL,
    slug character varying(64) NOT NULL,
    owner character varying(255) NOT NULL,
    is_private boolean NOT NULL,
    ownership_scope character varying(16) DEFAULT 'team'::character varying NOT NULL,
    team_id uuid,
    project_id uuid,
    co_authors json NOT NULL,
    latest_version_id uuid,
    category character varying(100),
    created_by uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT ck_agents_private_scope CHECK ((((ownership_scope)::text <> 'private'::text) OR (is_private AND (team_id IS NULL)))),
    CONSTRAINT ck_agents_scope_valid CHECK (((ownership_scope)::text = ANY (ARRAY[('private'::character varying)::text, ('team'::character varying)::text])))
);



CREATE TABLE public.alembic_version (
    version_num character varying(32) NOT NULL
);



CREATE TABLE public.component_bundles (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text NOT NULL,
    submitted_by uuid NOT NULL,
    created_at timestamp with time zone NOT NULL
);



CREATE TABLE public.component_download_records (
    id uuid NOT NULL,
    component_type character varying(50) NOT NULL,
    component_id uuid NOT NULL,
    version_ref text NOT NULL,
    agent_id uuid NOT NULL,
    source character varying(50) NOT NULL,
    downloaded_at timestamp with time zone NOT NULL
);



CREATE TABLE public.component_sources (
    id uuid NOT NULL,
    url text NOT NULL,
    provider character varying(50) NOT NULL,
    component_type character varying(50) NOT NULL,
    is_public boolean NOT NULL,
    team_id uuid,
    project_id uuid,
    auto_sync_interval interval,
    last_synced_at timestamp with time zone,
    sync_status character varying(20),
    sync_error text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);



CREATE TABLE public.enterprise_config (
    id uuid NOT NULL,
    key character varying(255) NOT NULL,
    value text NOT NULL,
    updated_at timestamp with time zone NOT NULL
);



CREATE TABLE public.exec_dashboard_config (
    id uuid NOT NULL,
    hourly_dev_cost numeric(10,2) NOT NULL,
    pre_ai_baselines json NOT NULL,
    department_budgets json NOT NULL,
    target_adoption_pct integer NOT NULL,
    target_adoption_date date,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);



CREATE TABLE public.exporter_configs (
    id uuid NOT NULL,
    exporter_type character varying(50) NOT NULL,
    enabled boolean NOT NULL,
    config json NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);



CREATE TABLE public.hook_downloads (
    id uuid NOT NULL,
    listing_id uuid NOT NULL,
    user_id uuid NOT NULL,
    harness character varying(50) NOT NULL,
    downloaded_at timestamp with time zone NOT NULL
);



CREATE TABLE public.hook_listings (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    namespace character varying(32) NOT NULL,
    slug character varying(64) NOT NULL,
    owner character varying(255) NOT NULL,
    is_private boolean NOT NULL,
    ownership_scope character varying(16) DEFAULT 'team'::character varying NOT NULL,
    team_id uuid,
    project_id uuid,
    bundle_id uuid,
    submitted_by uuid NOT NULL,
    co_authors json NOT NULL,
    unique_agents integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    latest_version_id uuid,
    CONSTRAINT ck_hook_listings_private_scope CHECK ((((ownership_scope)::text <> 'private'::text) OR (is_private AND (team_id IS NULL)))),
    CONSTRAINT ck_hook_listings_scope_valid CHECK (((ownership_scope)::text = ANY (ARRAY[('private'::character varying)::text, ('team'::character varying)::text])))
);



CREATE TABLE public.hook_versions (
    id uuid NOT NULL,
    listing_id uuid NOT NULL,
    version character varying(50) NOT NULL,
    description text NOT NULL,
    changelog text,
    status public.listingstatus NOT NULL,
    rejection_reason text,
    download_count integer NOT NULL,
    released_by uuid NOT NULL,
    released_at timestamp with time zone NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    supported_harnesses json NOT NULL,
    event character varying(50) NOT NULL,
    execution_mode character varying(10) NOT NULL,
    priority integer NOT NULL,
    handler_type character varying(20) NOT NULL,
    handler_config json NOT NULL,
    scope character varying(20) NOT NULL,
    tool_filter json,
    source_url character varying(500),
    source_ref character varying(255),
    source_path character varying(500),
    resolved_sha character varying(40),
    script_content text,
    script_filename character varying(255),
    requirements json,
    is_editing boolean NOT NULL,
    editing_since timestamp with time zone,
    editing_by uuid
);



CREATE TABLE public.inbox_item_events (
    id uuid NOT NULL,
    item_id uuid NOT NULL,
    event character varying(32) NOT NULL,
    actor_id uuid,
    detail text,
    created_at timestamp with time zone NOT NULL
);



CREATE TABLE public.inbox_items (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    kind public.inbox_kind NOT NULL,
    state public.inbox_state NOT NULL,
    read_at timestamp with time zone,
    action_required boolean NOT NULL,
    title character varying(255) NOT NULL,
    body text,
    subject_type character varying(32) NOT NULL,
    subject_id uuid,
    subject_namespace character varying(64),
    subject_slug character varying(64),
    action_url character varying(500),
    action_command character varying(500),
    actor_id uuid,
    team_id uuid,
    is_private_subject boolean NOT NULL,
    dedupe_key character varying(255) NOT NULL,
    payload json NOT NULL,
    created_at timestamp with time zone NOT NULL,
    resolved_at timestamp with time zone
);



CREATE TABLE public.insight_meta_cache (
    id uuid NOT NULL,
    agent_id uuid NOT NULL,
    period_start character varying(30) NOT NULL,
    period_end character varying(30) NOT NULL,
    session_metas json NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);



CREATE TABLE public.insight_reports (
    id uuid NOT NULL,
    agent_id uuid NOT NULL,
    triggered_by uuid,
    status public.insight_report_status NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    agent_version_id uuid,
    agent_version character varying(50),
    version_scope character varying(50),
    comparison_agent_version_id uuid,
    comparison_agent_version character varying(50),
    metrics json,
    narrative json,
    sessions_analyzed integer NOT NULL,
    llm_model_used character varying(255),
    error_message text,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    previous_report_id uuid,
    aggregated_data json,
    report_version integer NOT NULL,
    applied_at timestamp with time zone,
    applied_items json,
    progress_phase character varying(50),
    progress_current integer NOT NULL,
    progress_total integer NOT NULL,
    progress_percent integer NOT NULL,
    progress_message text,
    progress_updated_at timestamp with time zone
);



CREATE TABLE public.insight_session_facets (
    id uuid NOT NULL,
    agent_id uuid NOT NULL,
    session_id text NOT NULL,
    extracted_at timestamp with time zone NOT NULL,
    model_used character varying(255),
    facets json NOT NULL
);



CREATE TABLE public.insight_session_meta (
    id uuid NOT NULL,
    agent_id uuid NOT NULL,
    session_id text NOT NULL,
    computed_at timestamp with time zone NOT NULL,
    meta json NOT NULL
);



CREATE TABLE public.mcp_downloads (
    id uuid NOT NULL,
    listing_id uuid NOT NULL,
    user_id uuid NOT NULL,
    harness character varying(50) NOT NULL,
    downloaded_at timestamp with time zone NOT NULL
);



CREATE TABLE public.mcp_listings (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    namespace character varying(32) NOT NULL,
    slug character varying(64) NOT NULL,
    category character varying(100) NOT NULL,
    owner character varying(255) NOT NULL,
    is_private boolean NOT NULL,
    ownership_scope character varying(16) DEFAULT 'team'::character varying NOT NULL,
    team_id uuid,
    project_id uuid,
    bundle_id uuid,
    submitted_by uuid NOT NULL,
    co_authors json NOT NULL,
    unique_agents integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    latest_version_id uuid,
    CONSTRAINT ck_mcp_listings_private_scope CHECK ((((ownership_scope)::text <> 'private'::text) OR (is_private AND (team_id IS NULL)))),
    CONSTRAINT ck_mcp_listings_scope_valid CHECK (((ownership_scope)::text = ANY (ARRAY[('private'::character varying)::text, ('team'::character varying)::text])))
);



CREATE TABLE public.mcp_validation_results (
    id uuid NOT NULL,
    listing_id uuid NOT NULL,
    stage character varying(100) NOT NULL,
    passed boolean NOT NULL,
    details text,
    run_at timestamp with time zone NOT NULL
);



CREATE TABLE public.mcp_versions (
    id uuid NOT NULL,
    listing_id uuid NOT NULL,
    version character varying(50) NOT NULL,
    description text NOT NULL,
    changelog text,
    transport character varying(20),
    framework character varying(100),
    docker_image character varying(500),
    command character varying(500),
    args json,
    url character varying(1000),
    headers json,
    auto_approve json,
    mcp_validated boolean NOT NULL,
    tools_schema json,
    environment_variables json,
    supported_harnesses json NOT NULL,
    setup_instructions text,
    source_url character varying(500),
    source_ref character varying(255),
    resolved_sha character varying(40),
    status public.listingstatus NOT NULL,
    rejection_reason text,
    download_count integer NOT NULL,
    released_by uuid NOT NULL,
    released_at timestamp with time zone NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    is_editing boolean NOT NULL,
    editing_since timestamp with time zone,
    editing_by uuid
);



CREATE TABLE public.migration_jobs (
    id uuid NOT NULL,
    operation_type public.migration_operation NOT NULL,
    data_scope public.migration_scope NOT NULL,
    status public.migration_status NOT NULL,
    progress_phase character varying(50),
    progress_pct integer NOT NULL,
    progress_message text,
    progress_updated_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    error_message text,
    result_json json,
    artifacts_json json,
    artifact_dir text,
    schema_version character varying(64)
);



CREATE TABLE public.organization_memberships (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role public.organization_role NOT NULL,
    created_at timestamp with time zone NOT NULL
);



CREATE TABLE public.organizations (
    id uuid NOT NULL,
    slug character varying(32) NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    created_by uuid,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);



CREATE TABLE public.project_memberships (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role public.project_role NOT NULL,
    created_at timestamp with time zone NOT NULL
);



CREATE TABLE public.projects (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    slug character varying(64) NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    created_by uuid,
    legacy_team_id uuid,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);



CREATE TABLE public.prompt_downloads (
    id uuid NOT NULL,
    listing_id uuid NOT NULL,
    user_id uuid NOT NULL,
    harness character varying(50) NOT NULL,
    downloaded_at timestamp with time zone NOT NULL
);



CREATE TABLE public.prompt_listings (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    namespace character varying(32) NOT NULL,
    slug character varying(64) NOT NULL,
    owner character varying(255) NOT NULL,
    is_private boolean NOT NULL,
    ownership_scope character varying(16) DEFAULT 'team'::character varying NOT NULL,
    team_id uuid,
    project_id uuid,
    bundle_id uuid,
    submitted_by uuid NOT NULL,
    co_authors json NOT NULL,
    unique_agents integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    latest_version_id uuid,
    CONSTRAINT ck_prompt_listings_private_scope CHECK ((((ownership_scope)::text <> 'private'::text) OR (is_private AND (team_id IS NULL)))),
    CONSTRAINT ck_prompt_listings_scope_valid CHECK (((ownership_scope)::text = ANY (ARRAY[('private'::character varying)::text, ('team'::character varying)::text])))
);



CREATE TABLE public.prompt_versions (
    id uuid NOT NULL,
    listing_id uuid NOT NULL,
    version character varying(50) NOT NULL,
    description text NOT NULL,
    changelog text,
    status public.listingstatus NOT NULL,
    rejection_reason text,
    download_count integer NOT NULL,
    released_by uuid NOT NULL,
    released_at timestamp with time zone NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    supported_harnesses json NOT NULL,
    category character varying(100) NOT NULL,
    template text NOT NULL,
    variables json NOT NULL,
    model_hints json,
    tags json NOT NULL,
    is_editing boolean NOT NULL,
    editing_since timestamp with time zone,
    editing_by uuid
);



CREATE TABLE public.recommendation_feedback (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    component_type character varying(50) NOT NULL,
    component_id uuid NOT NULL,
    action character varying(30) NOT NULL,
    created_at timestamp with time zone NOT NULL
);



CREATE TABLE public.review_issue_comments (
    id uuid NOT NULL,
    issue_id uuid NOT NULL,
    author_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone NOT NULL
);



CREATE TABLE public.review_issues (
    id uuid NOT NULL,
    subject_type character varying(16) NOT NULL,
    subject_id uuid NOT NULL,
    version_id uuid,
    context character varying(255),
    title character varying(255) NOT NULL,
    body text,
    status public.review_issue_status NOT NULL,
    author_id uuid NOT NULL,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT ck_review_issues_subject_type CHECK (((subject_type)::text = ANY (ARRAY[('agent'::character varying)::text, ('mcp'::character varying)::text, ('skill'::character varying)::text, ('hook'::character varying)::text, ('prompt'::character varying)::text, ('sandbox'::character varying)::text])))
);



CREATE TABLE public.sandbox_downloads (
    id uuid NOT NULL,
    listing_id uuid NOT NULL,
    user_id uuid NOT NULL,
    harness character varying(50) NOT NULL,
    downloaded_at timestamp with time zone NOT NULL
);



CREATE TABLE public.sandbox_listings (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    namespace character varying(32) NOT NULL,
    slug character varying(64) NOT NULL,
    owner character varying(255) NOT NULL,
    is_private boolean NOT NULL,
    ownership_scope character varying(16) DEFAULT 'team'::character varying NOT NULL,
    team_id uuid,
    project_id uuid,
    bundle_id uuid,
    submitted_by uuid NOT NULL,
    co_authors json NOT NULL,
    unique_agents integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    latest_version_id uuid,
    CONSTRAINT ck_sandbox_listings_private_scope CHECK ((((ownership_scope)::text <> 'private'::text) OR (is_private AND (team_id IS NULL)))),
    CONSTRAINT ck_sandbox_listings_scope_valid CHECK (((ownership_scope)::text = ANY (ARRAY[('private'::character varying)::text, ('team'::character varying)::text])))
);



CREATE TABLE public.sandbox_versions (
    id uuid NOT NULL,
    listing_id uuid NOT NULL,
    version character varying(50) NOT NULL,
    description text NOT NULL,
    changelog text,
    source_url character varying(500),
    source_ref character varying(255),
    resolved_sha character varying(40),
    status public.listingstatus NOT NULL,
    rejection_reason text,
    download_count integer NOT NULL,
    released_by uuid NOT NULL,
    released_at timestamp with time zone NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    supported_harnesses json NOT NULL,
    runtime_type character varying(20) NOT NULL,
    image character varying(500) NOT NULL,
    resource_limits json NOT NULL,
    network_policy character varying(20) NOT NULL,
    entrypoint character varying(500),
    runtime_config json NOT NULL,
    sandbox_path character varying(500),
    validated_at timestamp with time zone,
    is_editing boolean NOT NULL,
    editing_since timestamp with time zone,
    editing_by uuid
);



CREATE TABLE public.skill_downloads (
    id uuid NOT NULL,
    listing_id uuid NOT NULL,
    user_id uuid NOT NULL,
    harness character varying(50) NOT NULL,
    downloaded_at timestamp with time zone NOT NULL
);



CREATE TABLE public.skill_listings (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    namespace character varying(32) NOT NULL,
    slug character varying(64) NOT NULL,
    owner character varying(255) NOT NULL,
    is_private boolean NOT NULL,
    ownership_scope character varying(16) DEFAULT 'team'::character varying NOT NULL,
    team_id uuid,
    project_id uuid,
    bundle_id uuid,
    submitted_by uuid NOT NULL,
    co_authors json NOT NULL,
    unique_agents integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    latest_version_id uuid,
    CONSTRAINT ck_skill_listings_private_scope CHECK ((((ownership_scope)::text <> 'private'::text) OR (is_private AND (team_id IS NULL)))),
    CONSTRAINT ck_skill_listings_scope_valid CHECK (((ownership_scope)::text = ANY (ARRAY[('private'::character varying)::text, ('team'::character varying)::text])))
);



CREATE TABLE public.skill_versions (
    id uuid NOT NULL,
    listing_id uuid NOT NULL,
    version character varying(50) NOT NULL,
    description text NOT NULL,
    changelog text,
    status public.listingstatus NOT NULL,
    rejection_reason text,
    download_count integer NOT NULL,
    released_by uuid NOT NULL,
    released_at timestamp with time zone NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    supported_harnesses json NOT NULL,
    skill_path character varying(500) NOT NULL,
    git_url character varying(500),
    git_ref character varying(255),
    skill_md_content text,
    delivery_mode character varying(20) DEFAULT 'git_fetch'::character varying NOT NULL,
    script_content text,
    script_filename character varying(255),
    validated boolean NOT NULL,
    target_agents json NOT NULL,
    task_type character varying(100) NOT NULL,
    slash_command character varying(100),
    is_editing boolean NOT NULL,
    editing_since timestamp with time zone,
    editing_by uuid
);



CREATE TABLE public.submissions (
    id uuid NOT NULL,
    listing_type character varying(50) NOT NULL,
    listing_id uuid NOT NULL,
    status public.listingstatus NOT NULL,
    rejection_reason text,
    submitted_by uuid NOT NULL,
    reviewed_by uuid,
    created_at timestamp with time zone NOT NULL,
    reviewed_at timestamp with time zone
);



CREATE TABLE public.team_invites (
    id uuid NOT NULL,
    token_hash character varying(64) NOT NULL,
    token_encrypted text,
    name character varying(100) NOT NULL,
    team_id uuid NOT NULL,
    invited_by uuid,
    max_uses integer,
    use_count integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL
);



CREATE TABLE public.team_membership_requests (
    id uuid NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid NOT NULL,
    invite_id uuid,
    status public.team_join_request_status NOT NULL,
    message character varying(500),
    decided_by uuid,
    decided_at timestamp with time zone,
    decision_reason character varying(500),
    created_at timestamp with time zone NOT NULL
);



CREATE TABLE public.team_memberships (
    id uuid NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role public.teamrole NOT NULL,
    created_at timestamp with time zone NOT NULL
);



CREATE TABLE public.teams (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    handle character varying(32) NOT NULL,
    description text,
    is_private boolean DEFAULT false NOT NULL,
    is_personal boolean DEFAULT false NOT NULL,
    visibility_request_status character varying(16),
    visibility_requested_by uuid,
    visibility_requested_at timestamp with time zone,
    visibility_reviewed_by uuid,
    visibility_reviewed_at timestamp with time zone,
    visibility_rejection_reason character varying(500),
    created_by uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT ck_teams_pending_visibility_private CHECK ((((visibility_request_status)::text <> 'pending'::text) OR is_private)),
    CONSTRAINT ck_teams_pending_visibility_requested_at CHECK ((((visibility_request_status)::text <> 'pending'::text) OR (visibility_requested_at IS NOT NULL))),
    CONSTRAINT ck_teams_personal_private CHECK (((NOT is_personal) OR is_private)),
    CONSTRAINT ck_teams_visibility_request_status CHECK (((visibility_request_status IS NULL) OR ((visibility_request_status)::text = ANY (ARRAY[('pending'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text]))))
);



CREATE TABLE public.user_groups (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    group_name character varying(255) NOT NULL,
    synced_at timestamp with time zone NOT NULL
);



CREATE TABLE public.user_work_profiles (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    computed_at timestamp with time zone NOT NULL,
    session_count integer NOT NULL,
    profile json NOT NULL
);



CREATE TABLE public.users (
    id uuid NOT NULL,
    email character varying(255) NOT NULL,
    username character varying(32) NOT NULL,
    name character varying(255) NOT NULL,
    role public.userrole NOT NULL,
    auth_subject_id character varying(64),
    is_demo boolean DEFAULT false NOT NULL,
    auth_provider character varying(50) DEFAULT 'local'::character varying NOT NULL,
    avatar_url text,
    department character varying(255),
    created_at timestamp with time zone NOT NULL
);



ALTER TABLE ONLY public.agent_components
    ADD CONSTRAINT agent_components_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.agent_download_records
    ADD CONSTRAINT agent_download_records_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.alembic_version
    ADD CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num);



ALTER TABLE ONLY public.component_bundles
    ADD CONSTRAINT component_bundles_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.component_download_records
    ADD CONSTRAINT component_download_records_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.component_sources
    ADD CONSTRAINT component_sources_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.enterprise_config
    ADD CONSTRAINT enterprise_config_key_key UNIQUE (key);



ALTER TABLE ONLY public.enterprise_config
    ADD CONSTRAINT enterprise_config_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.exec_dashboard_config
    ADD CONSTRAINT exec_dashboard_config_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.exporter_configs
    ADD CONSTRAINT exporter_configs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.hook_downloads
    ADD CONSTRAINT hook_downloads_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.hook_listings
    ADD CONSTRAINT hook_listings_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.hook_versions
    ADD CONSTRAINT hook_versions_listing_id_version_key UNIQUE (listing_id, version);



ALTER TABLE ONLY public.hook_versions
    ADD CONSTRAINT hook_versions_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.inbox_item_events
    ADD CONSTRAINT inbox_item_events_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.inbox_items
    ADD CONSTRAINT inbox_items_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.insight_meta_cache
    ADD CONSTRAINT insight_meta_cache_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.insight_reports
    ADD CONSTRAINT insight_reports_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.insight_session_facets
    ADD CONSTRAINT insight_session_facets_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.insight_session_meta
    ADD CONSTRAINT insight_session_meta_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.mcp_downloads
    ADD CONSTRAINT mcp_downloads_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.mcp_listings
    ADD CONSTRAINT mcp_listings_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.mcp_validation_results
    ADD CONSTRAINT mcp_validation_results_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.mcp_versions
    ADD CONSTRAINT mcp_versions_listing_id_version_key UNIQUE (listing_id, version);



ALTER TABLE ONLY public.mcp_versions
    ADD CONSTRAINT mcp_versions_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.migration_jobs
    ADD CONSTRAINT migration_jobs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.organization_memberships
    ADD CONSTRAINT organization_memberships_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.project_memberships
    ADD CONSTRAINT project_memberships_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_legacy_team_id_key UNIQUE (legacy_team_id);



ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.prompt_downloads
    ADD CONSTRAINT prompt_downloads_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.prompt_listings
    ADD CONSTRAINT prompt_listings_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.prompt_versions
    ADD CONSTRAINT prompt_versions_listing_id_version_key UNIQUE (listing_id, version);



ALTER TABLE ONLY public.prompt_versions
    ADD CONSTRAINT prompt_versions_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.recommendation_feedback
    ADD CONSTRAINT recommendation_feedback_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.review_issue_comments
    ADD CONSTRAINT review_issue_comments_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.review_issues
    ADD CONSTRAINT review_issues_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.sandbox_downloads
    ADD CONSTRAINT sandbox_downloads_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.sandbox_listings
    ADD CONSTRAINT sandbox_listings_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.sandbox_versions
    ADD CONSTRAINT sandbox_versions_listing_id_version_key UNIQUE (listing_id, version);



ALTER TABLE ONLY public.sandbox_versions
    ADD CONSTRAINT sandbox_versions_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.skill_downloads
    ADD CONSTRAINT skill_downloads_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.skill_listings
    ADD CONSTRAINT skill_listings_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.skill_versions
    ADD CONSTRAINT skill_versions_listing_id_version_key UNIQUE (listing_id, version);



ALTER TABLE ONLY public.skill_versions
    ADD CONSTRAINT skill_versions_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT submissions_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.team_membership_requests
    ADD CONSTRAINT team_membership_requests_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.team_memberships
    ADD CONSTRAINT team_memberships_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.agent_components
    ADD CONSTRAINT uq_agent_components_version_type_component UNIQUE (agent_version_id, component_type, component_id);



ALTER TABLE ONLY public.agent_download_records
    ADD CONSTRAINT uq_agent_downloads_agent_fingerprint UNIQUE (agent_id, fingerprint);



ALTER TABLE ONLY public.agent_download_records
    ADD CONSTRAINT uq_agent_downloads_agent_user UNIQUE (agent_id, user_id);



ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT uq_agent_versions_agent_version UNIQUE (agent_id, version);



ALTER TABLE ONLY public.component_sources
    ADD CONSTRAINT uq_component_sources_url_type UNIQUE (url, component_type);



ALTER TABLE ONLY public.exporter_configs
    ADD CONSTRAINT uq_exporter_configs_type UNIQUE (exporter_type);



ALTER TABLE ONLY public.hook_listings
    ADD CONSTRAINT uq_hook_listings_namespace_slug UNIQUE (namespace, slug);



ALTER TABLE ONLY public.inbox_items
    ADD CONSTRAINT uq_inbox_items_user_dedupe UNIQUE (user_id, dedupe_key);



ALTER TABLE ONLY public.mcp_listings
    ADD CONSTRAINT uq_mcp_listings_namespace_slug UNIQUE (namespace, slug);



ALTER TABLE ONLY public.insight_meta_cache
    ADD CONSTRAINT uq_meta_cache_agent_period UNIQUE (agent_id, period_start, period_end);



ALTER TABLE ONLY public.organization_memberships
    ADD CONSTRAINT uq_org_memberships_org_user UNIQUE (organization_id, user_id);



ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT uq_organizations_slug UNIQUE (slug);



ALTER TABLE ONLY public.project_memberships
    ADD CONSTRAINT uq_project_memberships_project_user UNIQUE (project_id, user_id);



ALTER TABLE ONLY public.projects
    ADD CONSTRAINT uq_projects_id_org UNIQUE (id, organization_id);



ALTER TABLE ONLY public.projects
    ADD CONSTRAINT uq_projects_org_slug UNIQUE (organization_id, slug);



ALTER TABLE ONLY public.prompt_listings
    ADD CONSTRAINT uq_prompt_listings_namespace_slug UNIQUE (namespace, slug);



ALTER TABLE ONLY public.recommendation_feedback
    ADD CONSTRAINT uq_recommendation_feedback_user_component UNIQUE (user_id, component_type, component_id);



ALTER TABLE ONLY public.sandbox_listings
    ADD CONSTRAINT uq_sandbox_listings_namespace_slug UNIQUE (namespace, slug);



ALTER TABLE ONLY public.insight_session_facets
    ADD CONSTRAINT uq_session_facets_agent_session UNIQUE (agent_id, session_id);



ALTER TABLE ONLY public.insight_session_meta
    ADD CONSTRAINT uq_session_meta_agent_session UNIQUE (agent_id, session_id);



ALTER TABLE ONLY public.skill_listings
    ADD CONSTRAINT uq_skill_listings_namespace_slug UNIQUE (namespace, slug);



ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT uq_team_invites_token_hash UNIQUE (token_hash);



ALTER TABLE ONLY public.team_memberships
    ADD CONSTRAINT uq_team_memberships_team_user UNIQUE (team_id, user_id);



ALTER TABLE ONLY public.teams
    ADD CONSTRAINT uq_teams_handle UNIQUE (handle);



ALTER TABLE ONLY public.user_groups
    ADD CONSTRAINT uq_user_groups_user_group UNIQUE (user_id, group_name);



ALTER TABLE ONLY public.user_work_profiles
    ADD CONSTRAINT uq_user_work_profiles_user UNIQUE (user_id);



ALTER TABLE ONLY public.user_groups
    ADD CONSTRAINT user_groups_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.user_work_profiles
    ADD CONSTRAINT user_work_profiles_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_auth_subject_id_key UNIQUE (auth_subject_id);



ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);



ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);



CREATE INDEX ix_agent_versions_agent_id ON public.agent_versions USING btree (agent_id);



CREATE INDEX ix_agent_versions_status ON public.agent_versions USING btree (status);



CREATE INDEX ix_agents_project_id ON public.agents USING btree (project_id);



CREATE INDEX ix_agents_team_id ON public.agents USING btree (team_id);



CREATE INDEX ix_component_sources_project_id ON public.component_sources USING btree (project_id);



CREATE INDEX ix_component_sources_team_id ON public.component_sources USING btree (team_id);



CREATE INDEX ix_hook_listings_namespace ON public.hook_listings USING btree (namespace);



CREATE INDEX ix_hook_listings_project_id ON public.hook_listings USING btree (project_id);



CREATE INDEX ix_hook_listings_submitted_by ON public.hook_listings USING btree (submitted_by);



CREATE INDEX ix_hook_listings_team_id ON public.hook_listings USING btree (team_id);



CREATE INDEX ix_hook_versions_listing_id ON public.hook_versions USING btree (listing_id);



CREATE INDEX ix_hook_versions_status ON public.hook_versions USING btree (status);



CREATE INDEX ix_inbox_item_events_item ON public.inbox_item_events USING btree (item_id);



CREATE INDEX ix_inbox_items_user_action_state ON public.inbox_items USING btree (user_id, action_required, state);



CREATE INDEX ix_inbox_items_user_read ON public.inbox_items USING btree (user_id, read_at);



CREATE INDEX ix_inbox_items_user_state_created ON public.inbox_items USING btree (user_id, state, created_at);



CREATE INDEX ix_insight_reports_agent_id ON public.insight_reports USING btree (agent_id);



CREATE INDEX ix_insight_reports_agent_version ON public.insight_reports USING btree (agent_version);



CREATE INDEX ix_insight_reports_agent_version_id ON public.insight_reports USING btree (agent_version_id);



CREATE INDEX ix_insight_reports_triggered_by ON public.insight_reports USING btree (triggered_by);



CREATE INDEX ix_mcp_listings_namespace ON public.mcp_listings USING btree (namespace);



CREATE INDEX ix_mcp_listings_project_id ON public.mcp_listings USING btree (project_id);



CREATE INDEX ix_mcp_listings_submitted_by ON public.mcp_listings USING btree (submitted_by);



CREATE INDEX ix_mcp_listings_team_id ON public.mcp_listings USING btree (team_id);



CREATE INDEX ix_mcp_versions_listing_id ON public.mcp_versions USING btree (listing_id);



CREATE INDEX ix_mcp_versions_status ON public.mcp_versions USING btree (status);



CREATE INDEX ix_migration_jobs_status ON public.migration_jobs USING btree (status);



CREATE INDEX ix_org_memberships_user_id ON public.organization_memberships USING btree (user_id);



CREATE INDEX ix_organizations_created_by ON public.organizations USING btree (created_by);



CREATE INDEX ix_project_memberships_org_id ON public.project_memberships USING btree (organization_id);



CREATE INDEX ix_project_memberships_user_id ON public.project_memberships USING btree (user_id);



CREATE INDEX ix_projects_organization_id ON public.projects USING btree (organization_id);



CREATE INDEX ix_prompt_listings_namespace ON public.prompt_listings USING btree (namespace);



CREATE INDEX ix_prompt_listings_project_id ON public.prompt_listings USING btree (project_id);



CREATE INDEX ix_prompt_listings_submitted_by ON public.prompt_listings USING btree (submitted_by);



CREATE INDEX ix_prompt_listings_team_id ON public.prompt_listings USING btree (team_id);



CREATE INDEX ix_prompt_versions_listing_id ON public.prompt_versions USING btree (listing_id);



CREATE INDEX ix_prompt_versions_status ON public.prompt_versions USING btree (status);



CREATE INDEX ix_recommendation_feedback_user ON public.recommendation_feedback USING btree (user_id);



CREATE INDEX ix_review_issue_comments_issue_id ON public.review_issue_comments USING btree (issue_id);



CREATE INDEX ix_review_issues_subject ON public.review_issues USING btree (subject_type, subject_id);



CREATE INDEX ix_review_issues_version_id ON public.review_issues USING btree (version_id);



CREATE INDEX ix_sandbox_listings_namespace ON public.sandbox_listings USING btree (namespace);



CREATE INDEX ix_sandbox_listings_project_id ON public.sandbox_listings USING btree (project_id);



CREATE INDEX ix_sandbox_listings_submitted_by ON public.sandbox_listings USING btree (submitted_by);



CREATE INDEX ix_sandbox_listings_team_id ON public.sandbox_listings USING btree (team_id);



CREATE INDEX ix_sandbox_versions_listing_id ON public.sandbox_versions USING btree (listing_id);



CREATE INDEX ix_sandbox_versions_status ON public.sandbox_versions USING btree (status);



CREATE INDEX ix_skill_listings_namespace ON public.skill_listings USING btree (namespace);



CREATE INDEX ix_skill_listings_project_id ON public.skill_listings USING btree (project_id);



CREATE INDEX ix_skill_listings_submitted_by ON public.skill_listings USING btree (submitted_by);



CREATE INDEX ix_skill_listings_team_id ON public.skill_listings USING btree (team_id);



CREATE INDEX ix_skill_versions_listing_id ON public.skill_versions USING btree (listing_id);



CREATE INDEX ix_skill_versions_status ON public.skill_versions USING btree (status);



CREATE INDEX ix_team_invites_invited_by ON public.team_invites USING btree (invited_by);



CREATE INDEX ix_team_invites_team_id ON public.team_invites USING btree (team_id);



CREATE INDEX ix_team_membership_requests_invite_id ON public.team_membership_requests USING btree (invite_id);



CREATE INDEX ix_team_membership_requests_user_id ON public.team_membership_requests USING btree (user_id);



CREATE INDEX ix_team_memberships_user_id ON public.team_memberships USING btree (user_id);



CREATE INDEX ix_teams_created_by ON public.teams USING btree (created_by);



CREATE INDEX ix_user_groups_group_name ON public.user_groups USING btree (group_name);



CREATE INDEX ix_user_groups_user_id ON public.user_groups USING btree (user_id);



CREATE INDEX ix_users_email_trgm ON public.users USING gin (email public.gin_trgm_ops);



CREATE INDEX ix_users_name_trgm ON public.users USING gin (name public.gin_trgm_ops);



CREATE INDEX ix_users_username_trgm ON public.users USING gin (username public.gin_trgm_ops);



CREATE UNIQUE INDEX uq_agents_active_namespace_slug ON public.agents USING btree (namespace, slug) WHERE (deleted_at IS NULL);



CREATE UNIQUE INDEX uq_exec_dashboard_config_singleton ON public.exec_dashboard_config USING btree ((true));



CREATE UNIQUE INDEX uq_org_memberships_single_owner ON public.organization_memberships USING btree (organization_id) WHERE (role = 'owner'::public.organization_role);



CREATE UNIQUE INDEX uq_team_membership_requests_pending ON public.team_membership_requests USING btree (team_id, user_id) WHERE (status = 'pending'::public.team_join_request_status);



CREATE UNIQUE INDEX uq_teams_personal_created_by ON public.teams USING btree (created_by) WHERE is_personal;



ALTER TABLE ONLY public.agent_components
    ADD CONSTRAINT agent_components_agent_version_id_fkey FOREIGN KEY (agent_version_id) REFERENCES public.agent_versions(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.agent_download_records
    ADD CONSTRAINT agent_download_records_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.agent_download_records
    ADD CONSTRAINT agent_download_records_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);



ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_editing_by_fkey FOREIGN KEY (editing_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_released_by_fkey FOREIGN KEY (released_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_latest_version_id_fkey FOREIGN KEY (latest_version_id) REFERENCES public.agent_versions(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;



ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE RESTRICT;



ALTER TABLE ONLY public.component_bundles
    ADD CONSTRAINT component_bundles_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.component_download_records
    ADD CONSTRAINT component_download_records_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.component_sources
    ADD CONSTRAINT component_sources_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;



ALTER TABLE ONLY public.component_sources
    ADD CONSTRAINT component_sources_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE RESTRICT;



ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT fk_organizations_created_by_users FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.project_memberships
    ADD CONSTRAINT fk_project_memberships_project_org FOREIGN KEY (project_id, organization_id) REFERENCES public.projects(id, organization_id) ON DELETE CASCADE;



ALTER TABLE ONLY public.projects
    ADD CONSTRAINT fk_projects_created_by_users FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.projects
    ADD CONSTRAINT fk_projects_organization FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;



ALTER TABLE ONLY public.teams
    ADD CONSTRAINT fk_teams_visibility_requested_by_users FOREIGN KEY (visibility_requested_by) REFERENCES public.users(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.teams
    ADD CONSTRAINT fk_teams_visibility_reviewed_by_users FOREIGN KEY (visibility_reviewed_by) REFERENCES public.users(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.hook_downloads
    ADD CONSTRAINT hook_downloads_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.hook_listings(id);



ALTER TABLE ONLY public.hook_downloads
    ADD CONSTRAINT hook_downloads_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);



ALTER TABLE ONLY public.hook_listings
    ADD CONSTRAINT hook_listings_bundle_id_fkey FOREIGN KEY (bundle_id) REFERENCES public.component_bundles(id);



ALTER TABLE ONLY public.hook_listings
    ADD CONSTRAINT hook_listings_latest_version_id_fkey FOREIGN KEY (latest_version_id) REFERENCES public.hook_versions(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.hook_listings
    ADD CONSTRAINT hook_listings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;



ALTER TABLE ONLY public.hook_listings
    ADD CONSTRAINT hook_listings_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.hook_listings
    ADD CONSTRAINT hook_listings_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE RESTRICT;



ALTER TABLE ONLY public.hook_versions
    ADD CONSTRAINT hook_versions_editing_by_fkey FOREIGN KEY (editing_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.hook_versions
    ADD CONSTRAINT hook_versions_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.hook_listings(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.hook_versions
    ADD CONSTRAINT hook_versions_released_by_fkey FOREIGN KEY (released_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.hook_versions
    ADD CONSTRAINT hook_versions_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.inbox_item_events
    ADD CONSTRAINT inbox_item_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.inbox_item_events
    ADD CONSTRAINT inbox_item_events_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.inbox_items(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.inbox_items
    ADD CONSTRAINT inbox_items_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.inbox_items
    ADD CONSTRAINT inbox_items_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.inbox_items
    ADD CONSTRAINT inbox_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.insight_meta_cache
    ADD CONSTRAINT insight_meta_cache_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.insight_reports
    ADD CONSTRAINT insight_reports_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.insight_reports
    ADD CONSTRAINT insight_reports_agent_version_id_fkey FOREIGN KEY (agent_version_id) REFERENCES public.agent_versions(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.insight_reports
    ADD CONSTRAINT insight_reports_comparison_agent_version_id_fkey FOREIGN KEY (comparison_agent_version_id) REFERENCES public.agent_versions(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.insight_reports
    ADD CONSTRAINT insight_reports_previous_report_id_fkey FOREIGN KEY (previous_report_id) REFERENCES public.insight_reports(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.insight_reports
    ADD CONSTRAINT insight_reports_triggered_by_fkey FOREIGN KEY (triggered_by) REFERENCES public.users(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.insight_session_facets
    ADD CONSTRAINT insight_session_facets_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.insight_session_meta
    ADD CONSTRAINT insight_session_meta_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.mcp_downloads
    ADD CONSTRAINT mcp_downloads_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.mcp_listings(id);



ALTER TABLE ONLY public.mcp_downloads
    ADD CONSTRAINT mcp_downloads_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);



ALTER TABLE ONLY public.mcp_listings
    ADD CONSTRAINT mcp_listings_bundle_id_fkey FOREIGN KEY (bundle_id) REFERENCES public.component_bundles(id);



ALTER TABLE ONLY public.mcp_listings
    ADD CONSTRAINT mcp_listings_latest_version_id_fkey FOREIGN KEY (latest_version_id) REFERENCES public.mcp_versions(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.mcp_listings
    ADD CONSTRAINT mcp_listings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;



ALTER TABLE ONLY public.mcp_listings
    ADD CONSTRAINT mcp_listings_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.mcp_listings
    ADD CONSTRAINT mcp_listings_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE RESTRICT;



ALTER TABLE ONLY public.mcp_validation_results
    ADD CONSTRAINT mcp_validation_results_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.mcp_listings(id);



ALTER TABLE ONLY public.mcp_versions
    ADD CONSTRAINT mcp_versions_editing_by_fkey FOREIGN KEY (editing_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.mcp_versions
    ADD CONSTRAINT mcp_versions_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.mcp_listings(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.mcp_versions
    ADD CONSTRAINT mcp_versions_released_by_fkey FOREIGN KEY (released_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.mcp_versions
    ADD CONSTRAINT mcp_versions_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.migration_jobs
    ADD CONSTRAINT migration_jobs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.organization_memberships
    ADD CONSTRAINT organization_memberships_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.organization_memberships
    ADD CONSTRAINT organization_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.project_memberships
    ADD CONSTRAINT project_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.prompt_downloads
    ADD CONSTRAINT prompt_downloads_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.prompt_listings(id);



ALTER TABLE ONLY public.prompt_downloads
    ADD CONSTRAINT prompt_downloads_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);



ALTER TABLE ONLY public.prompt_listings
    ADD CONSTRAINT prompt_listings_bundle_id_fkey FOREIGN KEY (bundle_id) REFERENCES public.component_bundles(id);



ALTER TABLE ONLY public.prompt_listings
    ADD CONSTRAINT prompt_listings_latest_version_id_fkey FOREIGN KEY (latest_version_id) REFERENCES public.prompt_versions(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.prompt_listings
    ADD CONSTRAINT prompt_listings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;



ALTER TABLE ONLY public.prompt_listings
    ADD CONSTRAINT prompt_listings_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.prompt_listings
    ADD CONSTRAINT prompt_listings_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE RESTRICT;



ALTER TABLE ONLY public.prompt_versions
    ADD CONSTRAINT prompt_versions_editing_by_fkey FOREIGN KEY (editing_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.prompt_versions
    ADD CONSTRAINT prompt_versions_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.prompt_listings(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.prompt_versions
    ADD CONSTRAINT prompt_versions_released_by_fkey FOREIGN KEY (released_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.prompt_versions
    ADD CONSTRAINT prompt_versions_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.recommendation_feedback
    ADD CONSTRAINT recommendation_feedback_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.review_issue_comments
    ADD CONSTRAINT review_issue_comments_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.review_issue_comments
    ADD CONSTRAINT review_issue_comments_issue_id_fkey FOREIGN KEY (issue_id) REFERENCES public.review_issues(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.review_issues
    ADD CONSTRAINT review_issues_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.review_issues
    ADD CONSTRAINT review_issues_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.sandbox_downloads
    ADD CONSTRAINT sandbox_downloads_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.sandbox_listings(id);



ALTER TABLE ONLY public.sandbox_downloads
    ADD CONSTRAINT sandbox_downloads_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);



ALTER TABLE ONLY public.sandbox_listings
    ADD CONSTRAINT sandbox_listings_bundle_id_fkey FOREIGN KEY (bundle_id) REFERENCES public.component_bundles(id);



ALTER TABLE ONLY public.sandbox_listings
    ADD CONSTRAINT sandbox_listings_latest_version_id_fkey FOREIGN KEY (latest_version_id) REFERENCES public.sandbox_versions(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.sandbox_listings
    ADD CONSTRAINT sandbox_listings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;



ALTER TABLE ONLY public.sandbox_listings
    ADD CONSTRAINT sandbox_listings_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.sandbox_listings
    ADD CONSTRAINT sandbox_listings_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE RESTRICT;



ALTER TABLE ONLY public.sandbox_versions
    ADD CONSTRAINT sandbox_versions_editing_by_fkey FOREIGN KEY (editing_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.sandbox_versions
    ADD CONSTRAINT sandbox_versions_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.sandbox_listings(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.sandbox_versions
    ADD CONSTRAINT sandbox_versions_released_by_fkey FOREIGN KEY (released_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.sandbox_versions
    ADD CONSTRAINT sandbox_versions_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.skill_downloads
    ADD CONSTRAINT skill_downloads_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.skill_listings(id);



ALTER TABLE ONLY public.skill_downloads
    ADD CONSTRAINT skill_downloads_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);



ALTER TABLE ONLY public.skill_listings
    ADD CONSTRAINT skill_listings_bundle_id_fkey FOREIGN KEY (bundle_id) REFERENCES public.component_bundles(id);



ALTER TABLE ONLY public.skill_listings
    ADD CONSTRAINT skill_listings_latest_version_id_fkey FOREIGN KEY (latest_version_id) REFERENCES public.skill_versions(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.skill_listings
    ADD CONSTRAINT skill_listings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE RESTRICT;



ALTER TABLE ONLY public.skill_listings
    ADD CONSTRAINT skill_listings_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.skill_listings
    ADD CONSTRAINT skill_listings_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE RESTRICT;



ALTER TABLE ONLY public.skill_versions
    ADD CONSTRAINT skill_versions_editing_by_fkey FOREIGN KEY (editing_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.skill_versions
    ADD CONSTRAINT skill_versions_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.skill_listings(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.skill_versions
    ADD CONSTRAINT skill_versions_released_by_fkey FOREIGN KEY (released_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.skill_versions
    ADD CONSTRAINT skill_versions_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT submissions_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT submissions_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.team_membership_requests
    ADD CONSTRAINT team_membership_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL;



ALTER TABLE ONLY public.team_membership_requests
    ADD CONSTRAINT team_membership_requests_invite_id_fkey FOREIGN KEY (invite_id) REFERENCES public.team_invites(id) ON DELETE RESTRICT;



ALTER TABLE ONLY public.team_membership_requests
    ADD CONSTRAINT team_membership_requests_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.team_membership_requests
    ADD CONSTRAINT team_membership_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.team_memberships
    ADD CONSTRAINT team_memberships_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.team_memberships
    ADD CONSTRAINT team_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);



ALTER TABLE ONLY public.user_groups
    ADD CONSTRAINT user_groups_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.user_work_profiles
    ADD CONSTRAINT user_work_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
