-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Consolidated baseline schema: service roles, tables, RLS policies, functions, triggers, and grants for the Caracal control plane.

-- Service roles
CREATE ROLE caracalapi;
ALTER ROLE caracalapi WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;
CREATE ROLE caracalaudit;
ALTER ROLE caracalaudit WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;
CREATE ROLE caracalauth;
-- The auth service creates and owns its dedicated database; it holds no grants
-- in the control-plane schema.
ALTER ROLE caracalauth WITH NOSUPERUSER INHERIT NOCREATEROLE CREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;
CREATE ROLE caracalcoordinator;
ALTER ROLE caracalcoordinator WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;
CREATE ROLE caracalgateway;
ALTER ROLE caracalgateway WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;
CREATE ROLE caracalsts;
ALTER ROLE caracalsts WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;

-- Schema
--
-- PostgreSQL database dump
--


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

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: reject_policy_snapshot_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_policy_snapshot_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'policy snapshot rows are immutable';
END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit_events (
    id text NOT NULL,
    request_id text NOT NULL,
    actor_id text,
    actor_name text,
    actor_scope text,
    action text NOT NULL,
    method text NOT NULL,
    path text NOT NULL,
    zone_id text,
    entity_type text,
    entity_id text,
    status_code integer NOT NULL,
    payload_json jsonb,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    content_sha256 text,
    prev_content_sha256 text,
    chain_hmac text,
    chain_seq bigint
);


--
-- Name: admin_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_tokens (
    id text NOT NULL,
    name text NOT NULL,
    token_sha256 bytea NOT NULL,
    scope text NOT NULL,
    zone_id text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    token_hash text,
    capability text DEFAULT 'write'::text NOT NULL,
    CONSTRAINT admin_token_scope_zone_pair CHECK ((((scope = 'global'::text) AND (zone_id IS NULL)) OR ((scope = 'zone'::text) AND (zone_id IS NOT NULL)))),
    CONSTRAINT admin_tokens_capability_check CHECK ((capability = ANY (ARRAY['read'::text, 'write'::text, 'approve'::text]))),
    CONSTRAINT admin_tokens_scope_check CHECK ((scope = ANY (ARRAY['global'::text, 'zone'::text])))
);


--
-- Name: agent_invocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_invocations (
    id text NOT NULL,
    zone_id text NOT NULL,
    service_id text NOT NULL,
    source_session_id text,
    target_session_id text,
    method text NOT NULL,
    params_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    timeout_ms integer DEFAULT 30000 NOT NULL,
    retry_policy_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_json jsonb,
    deadline_at timestamp with time zone,
    cancel_requested_at timestamp with time zone,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_invocations_max_attempts_check CHECK ((max_attempts > 0)),
    CONSTRAINT agent_invocations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancel_requested'::text, 'canceled'::text, 'timed_out'::text, 'dead'::text]))),
    CONSTRAINT agent_invocations_timeout_ms_check CHECK ((timeout_ms > 0))
);


--
-- Name: agent_services; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_services (
    id text NOT NULL,
    zone_id text NOT NULL,
    application_id text NOT NULL,
    endpoint_url text NOT NULL,
    protocol_versions text[] DEFAULT '{}'::text[] NOT NULL,
    framework_name text,
    framework_version text,
    capabilities text[] DEFAULT '{}'::text[] NOT NULL,
    health text DEFAULT 'starting'::text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_heartbeat_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_services_health_check CHECK ((health = ANY (ARRAY['starting'::text, 'healthy'::text, 'degraded'::text, 'unhealthy'::text])))
);


--
-- Name: coordinator_idempotency_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coordinator_idempotency_receipts (
    id text NOT NULL,
    operation text NOT NULL,
    zone_id text NOT NULL,
    scope_id text NOT NULL,
    key_digest bytea NOT NULL,
    request_digest bytea NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    response_status smallint NOT NULL,
    response_json jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT coordinator_idempotency_operation_check CHECK ((operation = ANY (ARRAY['session.start.v2'::text, 'delegation.create.v2'::text, 'invocation.create.v2'::text]))),
    CONSTRAINT coordinator_idempotency_key_digest_check CHECK ((octet_length(key_digest) = 32)),
    CONSTRAINT coordinator_idempotency_request_digest_check CHECK ((octet_length(request_digest) = 32)),
    CONSTRAINT coordinator_idempotency_response_status_check CHECK (((response_status >= 200) AND (response_status <= 299))),
    CONSTRAINT coordinator_idempotency_response_size_check CHECK ((octet_length((response_json)::text) <= 65536)),
    CONSTRAINT coordinator_idempotency_expiry_check CHECK ((expires_at > created_at))
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id text NOT NULL,
    zone_id text NOT NULL,
    application_id text NOT NULL,
    parent_id text,
    subject_authority_record_id text CONSTRAINT sessions_authority_record_id_not_null NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    depth integer DEFAULT 0 NOT NULL,
    labels text[] DEFAULT '{}'::text[] CONSTRAINT sessions_labels_not_null NOT NULL,
    max_children integer DEFAULT 10 NOT NULL,
    child_count integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_active_at timestamp with time zone DEFAULT now() NOT NULL,
    terminated_at timestamp with time zone,
    ttl_seconds integer DEFAULT 3600,
    metadata_json jsonb,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    lifecycle text DEFAULT 'task'::text CONSTRAINT sessions_lifecycle_not_null NOT NULL,
    last_heartbeat_at timestamp with time zone,
    heartbeat_deadline_at timestamp with time zone,
    termination_reason text,
    CONSTRAINT sessions_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['task'::text, 'service'::text]))),
    CONSTRAINT sessions_lifecycle_fields_check CHECK ((((lifecycle = 'task'::text) AND (ttl_seconds IS NOT NULL) AND (ttl_seconds > 0) AND (last_heartbeat_at IS NULL) AND (heartbeat_deadline_at IS NULL)) OR ((lifecycle = 'service'::text) AND (ttl_seconds IS NULL) AND (last_heartbeat_at IS NOT NULL) AND (heartbeat_deadline_at IS NOT NULL)))),
    CONSTRAINT sessions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'terminated'::text, 'expired'::text]))),
    CONSTRAINT sessions_terminal_fields_check CHECK ((((status = ANY (ARRAY['terminated'::text, 'expired'::text])) AND (terminated_at IS NOT NULL)) OR ((status = ANY (ARRAY['active'::text, 'suspended'::text])) AND (terminated_at IS NULL))))
);


--
-- Name: agent_topology; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_topology (
    parent_id text NOT NULL,
    child_id text NOT NULL
);


--
-- Name: applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.applications (
    id text NOT NULL,
    zone_id text NOT NULL,
    name text NOT NULL,
    registration_method text NOT NULL,
    credential_type text DEFAULT 'token'::text NOT NULL,
    client_secret_hash text,
    traits text[] DEFAULT '{}'::text[] NOT NULL,
    expires_at timestamp with time zone,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text,
    created_via_operator boolean DEFAULT false NOT NULL,
    updated_by text,
    updated_via_operator boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone,
    CONSTRAINT applications_credential_type_check CHECK ((credential_type = 'token'::text)),
    CONSTRAINT applications_dcr_expires_at_required CHECK (((registration_method <> 'dcr'::text) OR (expires_at IS NOT NULL))),
    CONSTRAINT applications_registration_method_check CHECK ((registration_method = ANY (ARRAY['managed'::text, 'dcr'::text])))
);


--
-- Name: audit_chain_rehash; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_chain_rehash (
    id smallint DEFAULT 1 NOT NULL,
    completed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_chain_rehash_id_check CHECK ((id = 1))
);


--
-- Name: audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events (
    id text NOT NULL,
    zone_id text NOT NULL,
    event_type text NOT NULL,
    request_id text,
    decision text,
    policy_set_id text,
    policy_set_version_id text,
    manifest_sha text,
    evaluation_status text,
    determining_policies_json jsonb,
    diagnostics_json jsonb,
    metadata_json jsonb,
    occurred_at timestamp with time zone NOT NULL,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL,
    content_sha256 text,
    prev_content_sha256 text,
    chain_hmac text,
    chain_seq bigint,
    ingest_signature text
)
PARTITION BY RANGE (occurred_at);


--
-- Name: audit_events_default; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events_default (
    id text CONSTRAINT audit_events_id_not_null NOT NULL,
    zone_id text CONSTRAINT audit_events_zone_id_not_null NOT NULL,
    event_type text CONSTRAINT audit_events_event_type_not_null NOT NULL,
    request_id text,
    decision text,
    policy_set_id text,
    policy_set_version_id text,
    manifest_sha text,
    evaluation_status text,
    determining_policies_json jsonb,
    diagnostics_json jsonb,
    metadata_json jsonb,
    occurred_at timestamp with time zone CONSTRAINT audit_events_occurred_at_not_null NOT NULL,
    ingested_at timestamp with time zone DEFAULT now() CONSTRAINT audit_events_ingested_at_not_null NOT NULL,
    content_sha256 text,
    prev_content_sha256 text,
    chain_hmac text,
    chain_seq bigint,
    ingest_signature text
);


--
-- Name: audit_export_watermark; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_export_watermark (
    name text NOT NULL,
    last_exported_hour timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_ingest_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_ingest_alerts (
    id bigint NOT NULL,
    event_id text NOT NULL,
    zone_id text NOT NULL,
    kind text NOT NULL,
    detail text,
    observed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_ingest_alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_ingest_alerts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_ingest_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_ingest_alerts_id_seq OWNED BY public.audit_ingest_alerts.id;


--
-- Name: audit_retention; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_retention (
    singleton boolean DEFAULT true NOT NULL,
    retention_days integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    CONSTRAINT audit_retention_retention_days_check CHECK ((retention_days >= 1)),
    CONSTRAINT audit_retention_singleton_check CHECK (singleton)
);


--
-- Name: caracal_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.caracal_outbox (
    id text NOT NULL,
    producer text NOT NULL,
    topic text NOT NULL,
    dedupe_key text NOT NULL,
    payload_json jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT caracal_outbox_producer_check CHECK ((producer = ANY (ARRAY['api'::text, 'coordinator'::text]))),
    CONSTRAINT caracal_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'published'::text, 'dead'::text])))
);


--
-- Name: delegated_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delegated_grants (
    id text NOT NULL,
    zone_id text NOT NULL,
    application_id text,
    user_id text NOT NULL,
    resource_id text NOT NULL,
    scopes text[] NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text,
    created_via_operator boolean DEFAULT false NOT NULL,
    updated_by text,
    updated_via_operator boolean DEFAULT false NOT NULL,
    CONSTRAINT delegated_grants_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'expired'::text])))
);


--
-- Name: delegation_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delegation_edges (
    id text NOT NULL,
    zone_id text NOT NULL,
    source_session_id text NOT NULL,
    target_session_id text NOT NULL,
    issuer_application_id text NOT NULL,
    receiver_application_id text NOT NULL,
    resource_id text,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    constraints_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    edge_version integer DEFAULT 0 NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    parent_edge_id text,
    CONSTRAINT delegation_edges_check CHECK ((source_session_id <> target_session_id)),
    CONSTRAINT delegation_edges_revocation_fields_check CHECK ((((status = 'revoked'::text) AND (revoked_at IS NOT NULL)) OR ((status = ANY (ARRAY['active'::text, 'expired'::text])) AND (revoked_at IS NULL)))),
    CONSTRAINT delegation_edges_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'expired'::text])))
);


--
-- Name: delegation_graph_epochs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delegation_graph_epochs (
    zone_id text NOT NULL,
    epoch bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: event_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_outbox (
    id text NOT NULL,
    stream_name text NOT NULL,
    payload_json jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_until timestamp with time zone,
    locked_by text,
    last_error text,
    dispatched_at timestamp with time zone,
    request_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notification_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_deliveries (
    id text NOT NULL,
    sink_id text NOT NULL,
    zone_id text NOT NULL,
    event_id text NOT NULL,
    event_type text NOT NULL,
    payload_json jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    abandoned_at timestamp with time zone,
    response_status integer,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notification_sinks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_sinks (
    id text NOT NULL,
    zone_id text NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    secret_ct bytea NOT NULL,
    event_types text[] NOT NULL,
    active boolean DEFAULT true NOT NULL,
    cursor_chain_seq bigint DEFAULT 0 NOT NULL,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    last_success_at timestamp with time zone,
    last_failure_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_sinks_event_types_check CHECK ((cardinality(event_types) > 0))
);


--
-- Name: operator_ai_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_ai_providers (
    slug text NOT NULL,
    label text NOT NULL,
    base_url text NOT NULL,
    models jsonb DEFAULT '[]'::jsonb NOT NULL,
    context_window integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auth_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT operator_ai_providers_context_window_check CHECK ((context_window >= 0)),
    CONSTRAINT operator_ai_providers_slug_check CHECK ((slug ~ '^[a-z0-9_]{1,32}$'::text))
);


--
-- Name: operator_conversation_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_conversation_counters (
    zone_id text NOT NULL,
    next_number bigint NOT NULL
);


--
-- Name: operator_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_conversations (
    id text NOT NULL,
    zone_id text NOT NULL,
    title text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by text NOT NULL,
    next_seq bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    mode text DEFAULT 'agent'::text NOT NULL,
    autopilot boolean DEFAULT false NOT NULL,
    number bigint,
    CONSTRAINT operator_conversations_mode_check CHECK ((mode = ANY (ARRAY['ask'::text, 'agent'::text]))),
    CONSTRAINT operator_conversations_next_seq_check CHECK ((next_seq >= 1)),
    CONSTRAINT operator_conversations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))
);


--
-- Name: operator_message_run_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_message_run_events (
    id text NOT NULL,
    run_id text NOT NULL,
    zone_id text NOT NULL,
    conversation_id text NOT NULL,
    event_seq bigint NOT NULL,
    state text NOT NULL,
    reason text,
    error_code text,
    error_detail text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT operator_message_run_events_event_seq_check CHECK ((event_seq >= 1)),
    CONSTRAINT operator_message_run_events_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'sending'::text, 'waiting_for_model'::text, 'reasoning'::text, 'waiting_for_tool'::text, 'waiting_for_user_approval'::text, 'executing'::text, 'streaming'::text, 'completed'::text, 'cancelled'::text, 'failed'::text, 'timeout'::text])))
);


--
-- Name: operator_message_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_message_runs (
    id text NOT NULL,
    zone_id text NOT NULL,
    conversation_id text NOT NULL,
    client_message_id text NOT NULL,
    server_message_turn_id text,
    correlation_id text NOT NULL,
    state text NOT NULL,
    actor_id text,
    provider_id text,
    reason text,
    error_code text,
    error_detail text,
    deadline_at timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    last_event_seq bigint DEFAULT 0 NOT NULL,
    CONSTRAINT operator_message_runs_completion_check CHECK (((state = ANY (ARRAY['completed'::text, 'cancelled'::text, 'failed'::text, 'timeout'::text])) OR (completed_at IS NULL))),
    CONSTRAINT operator_message_runs_last_event_seq_check CHECK ((last_event_seq >= 0)),
    CONSTRAINT operator_message_runs_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'sending'::text, 'waiting_for_model'::text, 'reasoning'::text, 'waiting_for_tool'::text, 'waiting_for_user_approval'::text, 'executing'::text, 'streaming'::text, 'completed'::text, 'cancelled'::text, 'failed'::text, 'timeout'::text])))
);


--
-- Name: operator_plan_secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_plan_secrets (
    conversation_id text NOT NULL,
    zone_id text NOT NULL,
    plan_seq bigint NOT NULL,
    step_id text NOT NULL,
    envelope bytea NOT NULL,
    secret_keys text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT operator_plan_secrets_plan_seq_check CHECK ((plan_seq >= 1))
);


--
-- Name: operator_turns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_turns (
    id text NOT NULL,
    conversation_id text NOT NULL,
    zone_id text NOT NULL,
    seq bigint NOT NULL,
    role text NOT NULL,
    kind text NOT NULL,
    content jsonb DEFAULT '{}'::jsonb NOT NULL,
    actor_id text,
    client_token text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT operator_turns_kind_check CHECK ((kind = ANY (ARRAY['message'::text, 'plan'::text, 'approval'::text, 'rejection'::text, 'execution'::text, 'error'::text, 'note'::text]))),
    CONSTRAINT operator_turns_role_check CHECK ((role = ANY (ARRAY['user'::text, 'operator'::text, 'system'::text]))),
    CONSTRAINT operator_turns_seq_check CHECK ((seq >= 1))
);


--
-- Name: operator_zone_memory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_zone_memory (
    id text NOT NULL,
    zone_id text NOT NULL,
    conversation_id text,
    text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT operator_zone_memory_text_check CHECK (((char_length(text) >= 1) AND (char_length(text) <= 2000)))
);


--
-- Name: policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policies (
    id text NOT NULL,
    zone_id text NOT NULL,
    name text NOT NULL,
    description text,
    archived_at timestamp with time zone,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_via_operator boolean DEFAULT false CONSTRAINT policies_co_authored_by_operator_not_null NOT NULL,
    updated_by text,
    updated_via_operator boolean DEFAULT false NOT NULL
);


--
-- Name: policy_set_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policy_set_bindings (
    zone_id text NOT NULL,
    policy_set_id text NOT NULL,
    active_version_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: policy_set_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policy_set_versions (
    id text NOT NULL,
    policy_set_id text NOT NULL,
    version integer NOT NULL,
    manifest_json jsonb NOT NULL,
    manifest_sha256 text NOT NULL,
    schema_version text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    created_via_operator boolean DEFAULT false NOT NULL
);


--
-- Name: policy_sets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policy_sets (
    id text NOT NULL,
    zone_id text NOT NULL,
    name text NOT NULL,
    description text,
    archived_at timestamp with time zone,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_via_operator boolean DEFAULT false CONSTRAINT policy_sets_co_authored_by_operator_not_null NOT NULL,
    updated_by text,
    updated_via_operator boolean DEFAULT false NOT NULL
);


--
-- Name: policy_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policy_versions (
    id text NOT NULL,
    policy_id text NOT NULL,
    version integer NOT NULL,
    content text NOT NULL,
    content_sha256 text NOT NULL,
    schema_version text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    created_via_operator boolean DEFAULT false NOT NULL
);


--
-- Name: provider_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_connections (
    id text NOT NULL,
    zone_id text NOT NULL,
    subject_id text NOT NULL,
    provider_id text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    access_token_ct bytea,
    refresh_token_ct bytea,
    expires_at timestamp with time zone,
    refreshed_at timestamp with time zone,
    refresh_token_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_connections_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'expired'::text])))
);


--
-- Name: providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.providers (
    id text NOT NULL,
    zone_id text NOT NULL,
    name text NOT NULL,
    identifier text NOT NULL,
    config_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    secret_config_keys text[] DEFAULT '{}'::text[] NOT NULL,
    provider_kind text NOT NULL,
    connectivity_failed_at timestamp with time zone,
    created_by text,
    created_via_operator boolean DEFAULT false NOT NULL,
    updated_by text,
    updated_via_operator boolean DEFAULT false NOT NULL,
    CONSTRAINT providers_provider_kind_check CHECK ((provider_kind = ANY (ARRAY['none'::text, 'caracal_mandate'::text, 'oauth2_authorization_code'::text, 'oauth2_client_credentials'::text, 'api_key'::text, 'bearer_token'::text, 'http_basic'::text])))
);


--
-- Name: resources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resources (
    id text NOT NULL,
    zone_id text NOT NULL,
    name text NOT NULL,
    identifier text NOT NULL,
    upstream_url text,
    credential_provider_id text NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    operations jsonb DEFAULT '[]'::jsonb NOT NULL,
    operation_enforcement text DEFAULT 'transport_uniform'::text NOT NULL,
    created_by text,
    created_via_operator boolean DEFAULT false NOT NULL,
    updated_by text,
    updated_via_operator boolean DEFAULT false NOT NULL,
    CONSTRAINT resources_operation_enforcement_check CHECK ((operation_enforcement = ANY (ARRAY['enforced'::text, 'transport_uniform'::text])))
);


--
-- Name: secret_store; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.secret_store (
    ref text NOT NULL,
    zone_id text NOT NULL,
    envelope bytea NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.secrets (
    id text NOT NULL,
    zone_id text NOT NULL,
    entity_id text NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    envelope bytea NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT secrets_type_check CHECK ((type = ANY (ARRAY['token'::text, 'password'::text])))
);


--
-- Name: authority_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.authority_records (
    id text NOT NULL,
    zone_id text NOT NULL,
    session_type text NOT NULL,
    subject_id text,
    parent_id text,
    status text DEFAULT 'active'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    authenticated_at timestamp with time zone NOT NULL,
    claims_json jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    revoked_reason text,
    CONSTRAINT authority_records_session_type_check CHECK ((session_type = ANY (ARRAY['user'::text, 'application'::text]))),
    CONSTRAINT authority_records_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'expired'::text])))
);


--
-- Name: step_up_challenges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.step_up_challenges (
    id text NOT NULL,
    zone_id text NOT NULL,
    session_id text,
    challenge_type text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    satisfied_at timestamp with time zone,
    principal_id text,
    resource_set_hash bytea,
    consumed_at timestamp with time zone,
    approver_subject_id text,
    application_id text,
    tier text,
    approver_class text DEFAULT 'operator'::text NOT NULL,
    privacy_mode text DEFAULT 'identified'::text NOT NULL,
    rejected_at timestamp with time zone,
    decision_reason text,
    approver_session_id text,
    CONSTRAINT step_up_challenges_approver_class_check CHECK ((approver_class = ANY (ARRAY['operator'::text, 'subject'::text, 'any'::text]))),
    CONSTRAINT step_up_challenges_challenge_type_check CHECK ((challenge_type = 'human_approval'::text)),
    CONSTRAINT step_up_challenges_privacy_mode_check CHECK ((privacy_mode = ANY (ARRAY['identified'::text, 'pseudonymous'::text, 'anonymous'::text])))
);


--
-- Name: subject_issuers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subject_issuers (
    id text NOT NULL,
    zone_id text NOT NULL,
    issuer text NOT NULL,
    jwks_url text NOT NULL,
    audience text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    created_by text,
    created_via_operator boolean DEFAULT false NOT NULL,
    updated_by text,
    updated_via_operator boolean DEFAULT false NOT NULL
);


--
-- Name: workloads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workloads (
    id text NOT NULL,
    zone_id text NOT NULL,
    name text NOT NULL,
    secret_hash text NOT NULL,
    bindings jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    updated_at timestamp with time zone,
    created_by text,
    created_via_operator boolean DEFAULT false NOT NULL,
    updated_via_operator boolean DEFAULT false NOT NULL
);


--
-- Name: zones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zones (
    id text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    dcr_enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    owner_account_id text,
    operator_coauthor_badge boolean DEFAULT true NOT NULL,
    operator_governed boolean DEFAULT false NOT NULL,
    created_by text,
    created_via_operator boolean DEFAULT false NOT NULL,
    updated_by text,
    updated_via_operator boolean DEFAULT false NOT NULL
);


--
-- Name: audit_events_default; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events ATTACH PARTITION public.audit_events_default DEFAULT;


--
-- Name: audit_ingest_alerts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_ingest_alerts ALTER COLUMN id SET DEFAULT nextval('public.audit_ingest_alerts_id_seq'::regclass);


--
-- Name: admin_audit_events admin_audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_events
    ADD CONSTRAINT admin_audit_events_pkey PRIMARY KEY (id);


--
-- Name: admin_tokens admin_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_tokens
    ADD CONSTRAINT admin_tokens_pkey PRIMARY KEY (id);


--
-- Name: agent_invocations agent_invocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_invocations
    ADD CONSTRAINT agent_invocations_pkey PRIMARY KEY (id);


--
-- Name: agent_invocations agent_invocations_zone_id_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_invocations
    ADD CONSTRAINT agent_invocations_zone_id_id_unique UNIQUE (zone_id, id);


--
-- Name: coordinator_idempotency_receipts coordinator_idempotency_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coordinator_idempotency_receipts
    ADD CONSTRAINT coordinator_idempotency_receipts_pkey PRIMARY KEY (id);


--
-- Name: coordinator_idempotency_receipts coordinator_idempotency_scope_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coordinator_idempotency_receipts
    ADD CONSTRAINT coordinator_idempotency_scope_unique UNIQUE (operation, zone_id, scope_id, key_digest);


--
-- Name: agent_services agent_services_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_services
    ADD CONSTRAINT agent_services_pkey PRIMARY KEY (id);


--
-- Name: agent_services agent_services_zone_id_application_id_endpoint_url_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_services
    ADD CONSTRAINT agent_services_zone_id_application_id_endpoint_url_key UNIQUE (zone_id, application_id, endpoint_url);


--
-- Name: agent_services agent_services_zone_id_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_services
    ADD CONSTRAINT agent_services_zone_id_id_unique UNIQUE (zone_id, id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_zone_id_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_zone_id_id_unique UNIQUE (zone_id, id);


--
-- Name: agent_topology agent_topology_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_topology
    ADD CONSTRAINT agent_topology_pkey PRIMARY KEY (parent_id, child_id);


--
-- Name: applications applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_pkey PRIMARY KEY (id);


--
-- Name: applications applications_zone_id_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_zone_id_id_unique UNIQUE (zone_id, id);


--
-- Name: audit_chain_rehash audit_chain_rehash_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_chain_rehash
    ADD CONSTRAINT audit_chain_rehash_pkey PRIMARY KEY (id);


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: audit_events_default audit_events_default_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events_default
    ADD CONSTRAINT audit_events_default_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: audit_export_watermark audit_export_watermark_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_export_watermark
    ADD CONSTRAINT audit_export_watermark_pkey PRIMARY KEY (name);


--
-- Name: audit_ingest_alerts audit_ingest_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_ingest_alerts
    ADD CONSTRAINT audit_ingest_alerts_pkey PRIMARY KEY (id);


--
-- Name: audit_retention audit_retention_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_retention
    ADD CONSTRAINT audit_retention_pkey PRIMARY KEY (singleton);


--
-- Name: caracal_outbox caracal_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caracal_outbox
    ADD CONSTRAINT caracal_outbox_pkey PRIMARY KEY (id);


--
-- Name: caracal_outbox caracal_outbox_producer_topic_dedupe_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caracal_outbox
    ADD CONSTRAINT caracal_outbox_producer_topic_dedupe_key_key UNIQUE (producer, topic, dedupe_key);


--
-- Name: delegated_grants delegated_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegated_grants
    ADD CONSTRAINT delegated_grants_pkey PRIMARY KEY (id);


--
-- Name: delegation_edges delegation_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_edges
    ADD CONSTRAINT delegation_edges_pkey PRIMARY KEY (id);


--
-- Name: delegation_edges delegation_edges_zone_id_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_edges
    ADD CONSTRAINT delegation_edges_zone_id_id_unique UNIQUE (zone_id, id);


--
-- Name: delegation_graph_epochs delegation_graph_epochs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_graph_epochs
    ADD CONSTRAINT delegation_graph_epochs_pkey PRIMARY KEY (zone_id);


--
-- Name: event_outbox event_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_outbox
    ADD CONSTRAINT event_outbox_pkey PRIMARY KEY (id);


--
-- Name: notification_deliveries notification_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_pkey PRIMARY KEY (id);


--
-- Name: notification_deliveries notification_deliveries_sink_event_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_sink_event_uniq UNIQUE (sink_id, event_id);


--
-- Name: notification_sinks notification_sinks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_sinks
    ADD CONSTRAINT notification_sinks_pkey PRIMARY KEY (id);


--
-- Name: operator_ai_providers operator_ai_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_ai_providers
    ADD CONSTRAINT operator_ai_providers_pkey PRIMARY KEY (slug);


--
-- Name: operator_conversation_counters operator_conversation_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversation_counters
    ADD CONSTRAINT operator_conversation_counters_pkey PRIMARY KEY (zone_id);


--
-- Name: operator_conversations operator_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_conversations
    ADD CONSTRAINT operator_conversations_pkey PRIMARY KEY (id);


--
-- Name: operator_message_run_events operator_message_run_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_message_run_events
    ADD CONSTRAINT operator_message_run_events_pkey PRIMARY KEY (id);


--
-- Name: operator_message_run_events operator_message_run_events_run_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_message_run_events
    ADD CONSTRAINT operator_message_run_events_run_seq_key UNIQUE (run_id, event_seq);


--
-- Name: operator_message_runs operator_message_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_message_runs
    ADD CONSTRAINT operator_message_runs_pkey PRIMARY KEY (id);


--
-- Name: operator_plan_secrets operator_plan_secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_plan_secrets
    ADD CONSTRAINT operator_plan_secrets_pkey PRIMARY KEY (conversation_id, plan_seq, step_id);


--
-- Name: operator_turns operator_turns_conversation_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_turns
    ADD CONSTRAINT operator_turns_conversation_seq_key UNIQUE (conversation_id, seq);


--
-- Name: operator_turns operator_turns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_turns
    ADD CONSTRAINT operator_turns_pkey PRIMARY KEY (id);


--
-- Name: operator_zone_memory operator_zone_memory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_zone_memory
    ADD CONSTRAINT operator_zone_memory_pkey PRIMARY KEY (id);


--
-- Name: policies policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policies
    ADD CONSTRAINT policies_pkey PRIMARY KEY (id);


--
-- Name: policy_set_bindings policy_set_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_set_bindings
    ADD CONSTRAINT policy_set_bindings_pkey PRIMARY KEY (zone_id, policy_set_id);


--
-- Name: policy_set_versions policy_set_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_set_versions
    ADD CONSTRAINT policy_set_versions_pkey PRIMARY KEY (id);


--
-- Name: policy_set_versions policy_set_versions_policy_set_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_set_versions
    ADD CONSTRAINT policy_set_versions_policy_set_id_version_key UNIQUE (policy_set_id, version);


--
-- Name: policy_sets policy_sets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_sets
    ADD CONSTRAINT policy_sets_pkey PRIMARY KEY (id);


--
-- Name: policy_versions policy_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_versions
    ADD CONSTRAINT policy_versions_pkey PRIMARY KEY (id);


--
-- Name: policy_versions policy_versions_policy_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_versions
    ADD CONSTRAINT policy_versions_policy_id_version_key UNIQUE (policy_id, version);


--
-- Name: provider_connections provider_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_connections
    ADD CONSTRAINT provider_connections_pkey PRIMARY KEY (id);


--
-- Name: providers providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.providers
    ADD CONSTRAINT providers_pkey PRIMARY KEY (id);


--
-- Name: providers providers_zone_id_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.providers
    ADD CONSTRAINT providers_zone_id_id_unique UNIQUE (zone_id, id);


--
-- Name: resources resources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resources
    ADD CONSTRAINT resources_pkey PRIMARY KEY (id);


--
-- Name: resources resources_zone_id_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resources
    ADD CONSTRAINT resources_zone_id_id_unique UNIQUE (zone_id, id);


--
-- Name: secret_store secret_store_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_store
    ADD CONSTRAINT secret_store_pkey PRIMARY KEY (ref);


--
-- Name: secrets secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT secrets_pkey PRIMARY KEY (id);


--
-- Name: authority_records authority_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authority_records
    ADD CONSTRAINT authority_records_pkey PRIMARY KEY (id);


--
-- Name: authority_records authority_records_zone_id_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authority_records
    ADD CONSTRAINT authority_records_zone_id_id_unique UNIQUE (zone_id, id);


--
-- Name: step_up_challenges step_up_challenges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.step_up_challenges
    ADD CONSTRAINT step_up_challenges_pkey PRIMARY KEY (id);


--
-- Name: subject_issuers subject_issuers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_issuers
    ADD CONSTRAINT subject_issuers_pkey PRIMARY KEY (id);


--
-- Name: workloads workloads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workloads
    ADD CONSTRAINT workloads_pkey PRIMARY KEY (id);


--
-- Name: zones zones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zones
    ADD CONSTRAINT zones_pkey PRIMARY KEY (id);


--
-- Name: zones zones_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zones
    ADD CONSTRAINT zones_slug_key UNIQUE (slug);


--
-- Name: admin_audit_events_actor_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_events_actor_time ON public.admin_audit_events USING btree (actor_id, occurred_at DESC) WHERE (actor_id IS NOT NULL);


--
-- Name: admin_audit_events_chain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_events_chain ON public.admin_audit_events USING btree (zone_id, chain_seq DESC);


--
-- Name: admin_audit_events_request; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_events_request ON public.admin_audit_events USING btree (request_id);


--
-- Name: admin_audit_events_zone_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_events_zone_time ON public.admin_audit_events USING btree (zone_id, occurred_at DESC);


--
-- Name: admin_tokens_token_sha256_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX admin_tokens_token_sha256_active ON public.admin_tokens USING btree (token_sha256) WHERE (revoked_at IS NULL);


--
-- Name: admin_tokens_zone_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_tokens_zone_active ON public.admin_tokens USING btree (zone_id) WHERE ((revoked_at IS NULL) AND (scope = 'zone'::text));


--
-- Name: agent_invocations_deadline_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_invocations_deadline_at_idx ON public.agent_invocations USING btree (deadline_at) WHERE (status = 'running'::text);


--
-- Name: agent_invocations_zone_id_service_id_status_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_invocations_zone_id_service_id_status_created_at_idx ON public.agent_invocations USING btree (zone_id, service_id, status, created_at DESC);


--
-- Name: agent_invocations_zone_id_source_session_id_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_invocations_zone_id_source_session_id_status_idx ON public.agent_invocations USING btree (zone_id, source_session_id, status) WHERE (source_session_id IS NOT NULL);


--
-- Name: agent_invocations_zone_id_target_session_id_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_invocations_zone_id_target_session_id_status_idx ON public.agent_invocations USING btree (zone_id, target_session_id, status) WHERE (target_session_id IS NOT NULL);


--
-- Name: agent_services_last_heartbeat_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_services_last_heartbeat_at_idx ON public.agent_services USING btree (last_heartbeat_at) WHERE (health = ANY (ARRAY['healthy'::text, 'degraded'::text]));


--
-- Name: agent_services_zone_id_application_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_services_zone_id_application_id_idx ON public.agent_services USING btree (zone_id, application_id);


--
-- Name: agent_services_zone_id_health_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_services_zone_id_health_idx ON public.agent_services USING btree (zone_id, health);


--
-- Name: coordinator_idempotency_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX coordinator_idempotency_expiry_idx ON public.coordinator_idempotency_receipts USING btree (expires_at, id);


--
-- Name: sessions_last_active_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_last_active_at_idx ON public.sessions USING btree (last_active_at) WHERE (status = 'active'::text);


--
-- Name: sessions_service_heartbeat_deadline_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_service_heartbeat_deadline_idx ON public.sessions USING btree (heartbeat_deadline_at) WHERE ((status = 'active'::text) AND (lifecycle = 'service'::text));


--
-- Name: sessions_subject_authority_record_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_subject_authority_record_id_idx ON public.sessions USING btree (subject_authority_record_id);


--
-- Name: sessions_zone_id_parent_id_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_zone_id_parent_id_status_idx ON public.sessions USING btree (zone_id, parent_id, status);


--
-- Name: agent_topology_child_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_topology_child_id_idx ON public.agent_topology USING btree (child_id);


--
-- Name: applications_zone_id_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX applications_zone_id_expires_at_idx ON public.applications USING btree (zone_id, expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: applications_zone_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX applications_zone_id_idx ON public.applications USING btree (zone_id);


--
-- Name: applications_zone_keyset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX applications_zone_keyset_idx ON public.applications USING btree (zone_id, created_at DESC, id DESC) WHERE (archived_at IS NULL);


--
-- Name: audit_events_agent_labels_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_agent_labels_idx ON ONLY public.audit_events USING gin (((metadata_json -> 'agent_labels'::text)));


--
-- Name: audit_events_agent_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_agent_session_idx ON ONLY public.audit_events USING btree (((metadata_json ->> 'agent_session_id'::text))) WHERE (metadata_json ? 'agent_session_id'::text);


--
-- Name: audit_events_default_expr_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_default_expr_idx ON public.audit_events_default USING btree (((metadata_json ->> 'agent_session_id'::text))) WHERE (metadata_json ? 'agent_session_id'::text);


--
-- Name: audit_events_default_expr_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_default_expr_idx1 ON public.audit_events_default USING gin (((metadata_json -> 'agent_labels'::text)));


--
-- Name: audit_events_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_session_idx ON ONLY public.audit_events USING btree (((metadata_json ->> 'session_id'::text))) WHERE (metadata_json ? 'session_id'::text);


--
-- Name: audit_events_default_expr_idx2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_default_expr_idx2 ON public.audit_events_default USING btree (((metadata_json ->> 'session_id'::text))) WHERE (metadata_json ? 'session_id'::text);


--
-- Name: audit_events_request_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_request_id_idx ON ONLY public.audit_events USING btree (request_id) WHERE (request_id IS NOT NULL);


--
-- Name: audit_events_default_request_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_default_request_id_idx ON public.audit_events_default USING btree (request_id) WHERE (request_id IS NOT NULL);


--
-- Name: audit_events_zone_chain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_zone_chain ON ONLY public.audit_events USING btree (zone_id, chain_seq DESC);


--
-- Name: audit_events_default_zone_id_chain_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_default_zone_id_chain_seq_idx ON public.audit_events_default USING btree (zone_id, chain_seq DESC);


--
-- Name: audit_events_zone_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_zone_id_occurred_at_idx ON ONLY public.audit_events USING btree (zone_id, occurred_at DESC);


--
-- Name: audit_events_default_zone_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_default_zone_id_occurred_at_idx ON public.audit_events_default USING btree (zone_id, occurred_at DESC);


--
-- Name: audit_ingest_alerts_zone_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_ingest_alerts_zone_time ON public.audit_ingest_alerts USING btree (zone_id, observed_at DESC);


--
-- Name: caracal_outbox_status_available_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX caracal_outbox_status_available_at_idx ON public.caracal_outbox USING btree (status, available_at);


--
-- Name: caracal_outbox_topic_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX caracal_outbox_topic_status_idx ON public.caracal_outbox USING btree (topic, status);


--
-- Name: delegated_grants_zone_id_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delegated_grants_zone_id_user_id_idx ON public.delegated_grants USING btree (zone_id, user_id);


--
-- Name: delegated_grants_zone_id_user_id_resource_id_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delegated_grants_zone_id_user_id_resource_id_status_idx ON public.delegated_grants USING btree (zone_id, user_id, resource_id, status);


--
-- Name: delegated_grants_zone_keyset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delegated_grants_zone_keyset_idx ON public.delegated_grants USING btree (zone_id, created_at DESC, id DESC);


--
-- Name: delegation_edges_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delegation_edges_expires_at_idx ON public.delegation_edges USING btree (expires_at) WHERE (status = 'active'::text);


--
-- Name: delegation_edges_zone_id_parent_edge_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delegation_edges_zone_id_parent_edge_id_idx ON public.delegation_edges USING btree (zone_id, parent_edge_id) WHERE (parent_edge_id IS NOT NULL);


--
-- Name: delegation_edges_zone_id_resource_id_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delegation_edges_zone_id_resource_id_status_idx ON public.delegation_edges USING btree (zone_id, resource_id, status) WHERE (resource_id IS NOT NULL);


--
-- Name: delegation_edges_zone_id_source_session_id_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delegation_edges_zone_id_source_session_id_status_idx ON public.delegation_edges USING btree (zone_id, source_session_id, status);


--
-- Name: delegation_edges_zone_id_target_session_id_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delegation_edges_zone_id_target_session_id_status_idx ON public.delegation_edges USING btree (zone_id, target_session_id, status);


--
-- Name: event_outbox_dispatch_ready; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_outbox_dispatch_ready ON public.event_outbox USING btree (available_at) WHERE (dispatched_at IS NULL);


--
-- Name: event_outbox_undispatched_age; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_outbox_undispatched_age ON public.event_outbox USING btree (created_at) WHERE (dispatched_at IS NULL);


--
-- Name: notification_deliveries_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_deliveries_due_idx ON public.notification_deliveries USING btree (available_at) WHERE ((delivered_at IS NULL) AND (abandoned_at IS NULL));


--
-- Name: notification_deliveries_settled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_deliveries_settled_idx ON public.notification_deliveries USING btree (created_at) WHERE ((delivered_at IS NOT NULL) OR (abandoned_at IS NOT NULL));


--
-- Name: notification_deliveries_sink_keyset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_deliveries_sink_keyset_idx ON public.notification_deliveries USING btree (sink_id, created_at DESC, id DESC);


--
-- Name: notification_sinks_zone_keyset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_sinks_zone_keyset_idx ON public.notification_sinks USING btree (zone_id, created_at DESC, id DESC);


--
-- Name: operator_ai_providers_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operator_ai_providers_order_idx ON public.operator_ai_providers USING btree (sort_order, slug);


--
-- Name: operator_conversations_zone_keyset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operator_conversations_zone_keyset_idx ON public.operator_conversations USING btree (zone_id, created_at DESC, id DESC) WHERE (archived_at IS NULL);


--
-- Name: operator_conversations_zone_number_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX operator_conversations_zone_number_idx ON public.operator_conversations USING btree (zone_id, number);


--
-- Name: operator_message_run_events_conversation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operator_message_run_events_conversation_idx ON public.operator_message_run_events USING btree (conversation_id, event_seq);


--
-- Name: operator_message_runs_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operator_message_runs_active_idx ON public.operator_message_runs USING btree (zone_id, conversation_id, updated_at DESC) WHERE (state <> ALL (ARRAY['completed'::text, 'cancelled'::text, 'failed'::text, 'timeout'::text]));


--
-- Name: operator_message_runs_client_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX operator_message_runs_client_id_idx ON public.operator_message_runs USING btree (conversation_id, client_message_id);


--
-- Name: operator_message_runs_conversation_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operator_message_runs_conversation_state_idx ON public.operator_message_runs USING btree (conversation_id, state, started_at DESC);


--
-- Name: operator_message_runs_correlation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX operator_message_runs_correlation_idx ON public.operator_message_runs USING btree (correlation_id);


--
-- Name: operator_turns_conversation_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operator_turns_conversation_seq_idx ON public.operator_turns USING btree (conversation_id, seq);


--
-- Name: operator_turns_idempotency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX operator_turns_idempotency_idx ON public.operator_turns USING btree (conversation_id, client_token) WHERE (client_token IS NOT NULL);


--
-- Name: operator_zone_memory_recall_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operator_zone_memory_recall_idx ON public.operator_zone_memory USING btree (zone_id, created_at DESC, id DESC);


--
-- Name: policies_zone_keyset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX policies_zone_keyset_idx ON public.policies USING btree (zone_id, created_at DESC, id DESC) WHERE (archived_at IS NULL);


--
-- Name: policies_zone_id_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX policies_zone_id_name_key ON public.policies USING btree (zone_id, name) WHERE (archived_at IS NULL);


--
-- Name: policy_sets_zone_keyset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX policy_sets_zone_keyset_idx ON public.policy_sets USING btree (zone_id, created_at DESC, id DESC) WHERE (archived_at IS NULL);


--
-- Name: policy_sets_zone_id_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX policy_sets_zone_id_name_key ON public.policy_sets USING btree (zone_id, name) WHERE (archived_at IS NULL);


--
-- Name: policy_set_bindings_one_active_per_zone; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX policy_set_bindings_one_active_per_zone ON public.policy_set_bindings USING btree (zone_id) WHERE (active_version_id IS NOT NULL);


--
-- Name: policy_versions_policy_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX policy_versions_policy_id_created_at_idx ON public.policy_versions USING btree (policy_id, created_at DESC);


--
-- Name: provider_connections_active_subject_provider_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX provider_connections_active_subject_provider_uidx ON public.provider_connections USING btree (zone_id, subject_id, provider_id) WHERE (status = 'active'::text);


--
-- Name: provider_connections_zone_provider_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_connections_zone_provider_status_idx ON public.provider_connections USING btree (zone_id, provider_id, status);


--
-- Name: provider_connections_zone_subject_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_connections_zone_subject_status_idx ON public.provider_connections USING btree (zone_id, subject_id, status);


--
-- Name: providers_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX providers_active_idx ON public.providers USING btree (id) WHERE (archived_at IS NULL);


--
-- Name: providers_zone_identifier_active_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX providers_zone_identifier_active_uidx ON public.providers USING btree (zone_id, identifier) WHERE (archived_at IS NULL);


--
-- Name: providers_zone_keyset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX providers_zone_keyset_idx ON public.providers USING btree (zone_id, created_at DESC, id DESC) WHERE (archived_at IS NULL);


--
-- Name: resources_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resources_active_idx ON public.resources USING btree (id) WHERE (archived_at IS NULL);


--
-- Name: resources_credential_provider_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resources_credential_provider_id_idx ON public.resources USING btree (credential_provider_id);


--
-- Name: resources_zone_keyset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resources_zone_keyset_idx ON public.resources USING btree (zone_id, created_at DESC, id DESC) WHERE (archived_at IS NULL);


--
-- Name: resources_zone_id_identifier_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX resources_zone_id_identifier_key ON public.resources USING btree (zone_id, identifier) WHERE (archived_at IS NULL);


--
-- Name: secret_store_zone_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX secret_store_zone_id_idx ON public.secret_store USING btree (zone_id);


--
-- Name: secrets_zone_id_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX secrets_zone_id_entity_id_idx ON public.secrets USING btree (zone_id, entity_id);


--
-- Name: authority_records_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX authority_records_expires_at_idx ON public.authority_records USING btree (expires_at) WHERE (status = 'active'::text);


--
-- Name: authority_records_zone_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX authority_records_zone_active_idx ON public.authority_records USING btree (zone_id, expires_at) WHERE (status = 'active'::text);


--
-- Name: authority_records_zone_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX authority_records_zone_created_idx ON public.authority_records USING btree (zone_id, created_at DESC, id DESC);


--
-- Name: authority_records_zone_id_subject_id_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX authority_records_zone_id_subject_id_status_idx ON public.authority_records USING btree (zone_id, subject_id, status);


--
-- Name: authority_records_zone_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX authority_records_zone_subject_idx ON public.authority_records USING btree (zone_id, subject_id);


--
-- Name: step_up_challenges_application_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX step_up_challenges_application_idx ON public.step_up_challenges USING btree (application_id) WHERE (application_id IS NOT NULL);


--
-- Name: step_up_challenges_approver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX step_up_challenges_approver ON public.step_up_challenges USING btree (approver_subject_id) WHERE (approver_subject_id IS NOT NULL);


--
-- Name: step_up_challenges_consume_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX step_up_challenges_consume_uniq ON public.step_up_challenges USING btree (id) WHERE (consumed_at IS NOT NULL);


--
-- Name: step_up_challenges_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX step_up_challenges_expires_idx ON public.step_up_challenges USING btree (expires_at);


--
-- Name: step_up_challenges_live_binding_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX step_up_challenges_live_binding_uniq ON public.step_up_challenges USING btree (zone_id, principal_id, session_id, resource_set_hash) NULLS NOT DISTINCT WHERE (consumed_at IS NULL);


--
-- Name: step_up_challenges_session_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX step_up_challenges_session_id_idx ON public.step_up_challenges USING btree (session_id);


--
-- Name: step_up_challenges_zone_keyset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX step_up_challenges_zone_keyset_idx ON public.step_up_challenges USING btree (zone_id, created_at DESC, id DESC);


--
-- Name: subject_issuers_zone_issuer_active_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX subject_issuers_zone_issuer_active_uidx ON public.subject_issuers USING btree (zone_id, issuer) WHERE (archived_at IS NULL);


--
-- Name: subject_issuers_zone_keyset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subject_issuers_zone_keyset_idx ON public.subject_issuers USING btree (zone_id, created_at DESC, id DESC) WHERE (archived_at IS NULL);


--
-- Name: step_up_challenges_zone_principal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX step_up_challenges_zone_principal ON public.step_up_challenges USING btree (zone_id, principal_id) WHERE (consumed_at IS NULL);


--
-- Name: workloads_zone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workloads_zone_idx ON public.workloads USING btree (zone_id, created_at DESC, id DESC);


--
-- Name: zones_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX zones_active_idx ON public.zones USING btree (id) WHERE (archived_at IS NULL);


--
-- Name: zones_owner_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX zones_owner_account_id_idx ON public.zones USING btree (owner_account_id) WHERE (owner_account_id IS NOT NULL);


--
-- Name: audit_events_default_expr_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.audit_events_agent_session_idx ATTACH PARTITION public.audit_events_default_expr_idx;


--
-- Name: audit_events_default_expr_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.audit_events_agent_labels_idx ATTACH PARTITION public.audit_events_default_expr_idx1;


--
-- Name: audit_events_default_expr_idx2; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.audit_events_session_idx ATTACH PARTITION public.audit_events_default_expr_idx2;


--
-- Name: audit_events_default_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.audit_events_pkey ATTACH PARTITION public.audit_events_default_pkey;


--
-- Name: audit_events_default_request_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.audit_events_request_id_idx ATTACH PARTITION public.audit_events_default_request_id_idx;


--
-- Name: audit_events_default_zone_id_chain_seq_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.audit_events_zone_chain ATTACH PARTITION public.audit_events_default_zone_id_chain_seq_idx;


--
-- Name: audit_events_default_zone_id_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.audit_events_zone_id_occurred_at_idx ATTACH PARTITION public.audit_events_default_zone_id_occurred_at_idx;


--
-- Name: policy_versions policy_versions_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER policy_versions_immutable BEFORE DELETE OR UPDATE ON public.policy_versions FOR EACH ROW EXECUTE FUNCTION public.reject_policy_snapshot_mutation();


--
-- Name: policy_set_versions policy_set_versions_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER policy_set_versions_immutable BEFORE DELETE OR UPDATE ON public.policy_set_versions FOR EACH ROW EXECUTE FUNCTION public.reject_policy_snapshot_mutation();


--
-- Name: admin_tokens admin_tokens_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_tokens
    ADD CONSTRAINT admin_tokens_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id) ON DELETE CASCADE;


--
-- Name: agent_invocations agent_invocations_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_invocations
    ADD CONSTRAINT agent_invocations_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.agent_services(id) ON DELETE CASCADE;


--
-- Name: agent_invocations agent_invocations_source_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_invocations
    ADD CONSTRAINT agent_invocations_source_session_id_fkey FOREIGN KEY (source_session_id) REFERENCES public.sessions(id) ON DELETE SET NULL;


--
-- Name: agent_invocations agent_invocations_target_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_invocations
    ADD CONSTRAINT agent_invocations_target_session_id_fkey FOREIGN KEY (target_session_id) REFERENCES public.sessions(id) ON DELETE SET NULL;


--
-- Name: agent_invocations agent_invocations_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_invocations
    ADD CONSTRAINT agent_invocations_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id) ON DELETE CASCADE;


--
-- Name: agent_invocations agent_invocations_zone_service_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_invocations
    ADD CONSTRAINT agent_invocations_zone_service_fk FOREIGN KEY (zone_id, service_id) REFERENCES public.agent_services(zone_id, id) ON DELETE CASCADE;


--
-- Name: agent_invocations agent_invocations_zone_source_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_invocations
    ADD CONSTRAINT agent_invocations_zone_source_fk FOREIGN KEY (zone_id, source_session_id) REFERENCES public.sessions(zone_id, id);


--
-- Name: agent_invocations agent_invocations_zone_target_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_invocations
    ADD CONSTRAINT agent_invocations_zone_target_fk FOREIGN KEY (zone_id, target_session_id) REFERENCES public.sessions(zone_id, id);


--
-- Name: agent_services agent_services_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_services
    ADD CONSTRAINT agent_services_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: agent_services agent_services_zone_application_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_services
    ADD CONSTRAINT agent_services_zone_application_fk FOREIGN KEY (zone_id, application_id) REFERENCES public.applications(zone_id, id);


--
-- Name: agent_services agent_services_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_services
    ADD CONSTRAINT agent_services_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id) ON DELETE CASCADE;


--
-- Name: coordinator_idempotency_receipts coordinator_idempotency_receipts_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coordinator_idempotency_receipts
    ADD CONSTRAINT coordinator_idempotency_receipts_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.sessions(id);


--
-- Name: sessions sessions_zone_application_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_zone_application_fk FOREIGN KEY (zone_id, application_id) REFERENCES public.applications(zone_id, id);


--
-- Name: sessions sessions_zone_parent_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_zone_parent_fk FOREIGN KEY (zone_id, parent_id) REFERENCES public.sessions(zone_id, id);


--
-- Name: sessions sessions_zone_authority_record_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_zone_authority_record_fk FOREIGN KEY (zone_id, subject_authority_record_id) REFERENCES public.authority_records(zone_id, id);


--
-- Name: agent_topology agent_topology_child_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_topology
    ADD CONSTRAINT agent_topology_child_id_fkey FOREIGN KEY (child_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: agent_topology agent_topology_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_topology
    ADD CONSTRAINT agent_topology_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: applications applications_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id);


--
-- Name: delegated_grants delegated_grants_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegated_grants
    ADD CONSTRAINT delegated_grants_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id);


--
-- Name: delegated_grants delegated_grants_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegated_grants
    ADD CONSTRAINT delegated_grants_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.resources(id);


--
-- Name: delegated_grants delegated_grants_zone_application_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegated_grants
    ADD CONSTRAINT delegated_grants_zone_application_fk FOREIGN KEY (zone_id, application_id) REFERENCES public.applications(zone_id, id);


--
-- Name: delegated_grants delegated_grants_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegated_grants
    ADD CONSTRAINT delegated_grants_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id);


--
-- Name: delegated_grants delegated_grants_zone_resource_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegated_grants
    ADD CONSTRAINT delegated_grants_zone_resource_fk FOREIGN KEY (zone_id, resource_id) REFERENCES public.resources(zone_id, id);


--
-- Name: delegation_edges delegation_edges_zone_parent_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_edges
    ADD CONSTRAINT delegation_edges_zone_parent_fk FOREIGN KEY (zone_id, parent_edge_id) REFERENCES public.delegation_edges(zone_id, id) ON DELETE SET NULL (parent_edge_id);


--
-- Name: delegation_edges delegation_edges_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_edges
    ADD CONSTRAINT delegation_edges_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.resources(id);


--
-- Name: delegation_edges delegation_edges_source_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_edges
    ADD CONSTRAINT delegation_edges_source_session_id_fkey FOREIGN KEY (source_session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: delegation_edges delegation_edges_target_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_edges
    ADD CONSTRAINT delegation_edges_target_session_id_fkey FOREIGN KEY (target_session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: delegation_edges delegation_edges_zone_issuer_application_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_edges
    ADD CONSTRAINT delegation_edges_zone_issuer_application_fk FOREIGN KEY (zone_id, issuer_application_id) REFERENCES public.applications(zone_id, id);


--
-- Name: delegation_edges delegation_edges_zone_receiver_application_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_edges
    ADD CONSTRAINT delegation_edges_zone_receiver_application_fk FOREIGN KEY (zone_id, receiver_application_id) REFERENCES public.applications(zone_id, id);


--
-- Name: delegation_edges delegation_edges_zone_resource_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_edges
    ADD CONSTRAINT delegation_edges_zone_resource_fk FOREIGN KEY (zone_id, resource_id) REFERENCES public.resources(zone_id, id);


--
-- Name: delegation_edges delegation_edges_zone_source_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_edges
    ADD CONSTRAINT delegation_edges_zone_source_fk FOREIGN KEY (zone_id, source_session_id) REFERENCES public.sessions(zone_id, id) ON DELETE CASCADE;


--
-- Name: delegation_edges delegation_edges_zone_target_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_edges
    ADD CONSTRAINT delegation_edges_zone_target_fk FOREIGN KEY (zone_id, target_session_id) REFERENCES public.sessions(zone_id, id) ON DELETE CASCADE;


--
-- Name: delegation_graph_epochs delegation_graph_epochs_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_graph_epochs
    ADD CONSTRAINT delegation_graph_epochs_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id) ON DELETE CASCADE;


--
-- Name: notification_deliveries notification_deliveries_sink_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_sink_id_fkey FOREIGN KEY (sink_id) REFERENCES public.notification_sinks(id) ON DELETE CASCADE;


--
-- Name: notification_sinks notification_sinks_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_sinks
    ADD CONSTRAINT notification_sinks_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id) ON DELETE CASCADE;


--
-- Name: operator_message_run_events operator_message_run_events_conversation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_message_run_events
    ADD CONSTRAINT operator_message_run_events_conversation_fkey FOREIGN KEY (conversation_id) REFERENCES public.operator_conversations(id) ON DELETE CASCADE;


--
-- Name: operator_message_run_events operator_message_run_events_run_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_message_run_events
    ADD CONSTRAINT operator_message_run_events_run_fkey FOREIGN KEY (run_id) REFERENCES public.operator_message_runs(id) ON DELETE CASCADE;


--
-- Name: operator_message_runs operator_message_runs_conversation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_message_runs
    ADD CONSTRAINT operator_message_runs_conversation_fkey FOREIGN KEY (conversation_id) REFERENCES public.operator_conversations(id) ON DELETE CASCADE;


--
-- Name: operator_message_runs operator_message_runs_message_turn_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_message_runs
    ADD CONSTRAINT operator_message_runs_message_turn_fkey FOREIGN KEY (server_message_turn_id) REFERENCES public.operator_turns(id) ON DELETE SET NULL;


--
-- Name: operator_plan_secrets operator_plan_secrets_conversation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_plan_secrets
    ADD CONSTRAINT operator_plan_secrets_conversation_fkey FOREIGN KEY (conversation_id) REFERENCES public.operator_conversations(id) ON DELETE CASCADE;


--
-- Name: operator_turns operator_turns_conversation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_turns
    ADD CONSTRAINT operator_turns_conversation_fkey FOREIGN KEY (conversation_id) REFERENCES public.operator_conversations(id) ON DELETE CASCADE;


--
-- Name: policies policies_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policies
    ADD CONSTRAINT policies_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id);


--
-- Name: policy_set_bindings policy_set_bindings_active_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_set_bindings
    ADD CONSTRAINT policy_set_bindings_active_version_id_fkey FOREIGN KEY (active_version_id) REFERENCES public.policy_set_versions(id);


--
-- Name: policy_set_bindings policy_set_bindings_policy_set_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_set_bindings
    ADD CONSTRAINT policy_set_bindings_policy_set_id_fkey FOREIGN KEY (policy_set_id) REFERENCES public.policy_sets(id);


--
-- Name: policy_set_bindings policy_set_bindings_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_set_bindings
    ADD CONSTRAINT policy_set_bindings_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id);


--
-- Name: policy_set_versions policy_set_versions_policy_set_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_set_versions
    ADD CONSTRAINT policy_set_versions_policy_set_id_fkey FOREIGN KEY (policy_set_id) REFERENCES public.policy_sets(id);


--
-- Name: policy_sets policy_sets_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_sets
    ADD CONSTRAINT policy_sets_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id);


--
-- Name: policy_versions policy_versions_policy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_versions
    ADD CONSTRAINT policy_versions_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES public.policies(id);


--
-- Name: provider_connections provider_connections_zone_provider_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_connections
    ADD CONSTRAINT provider_connections_zone_provider_fk FOREIGN KEY (zone_id, provider_id) REFERENCES public.providers(zone_id, id);


--
-- Name: providers providers_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.providers
    ADD CONSTRAINT providers_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id);


--
-- Name: resources resources_credential_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resources
    ADD CONSTRAINT resources_credential_provider_id_fkey FOREIGN KEY (credential_provider_id) REFERENCES public.providers(id);


--
-- Name: resources resources_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resources
    ADD CONSTRAINT resources_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id);


--
-- Name: resources resources_zone_provider_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resources
    ADD CONSTRAINT resources_zone_provider_fk FOREIGN KEY (zone_id, credential_provider_id) REFERENCES public.providers(zone_id, id);


--
-- Name: secret_store secret_store_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_store
    ADD CONSTRAINT secret_store_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id);


--
-- Name: secrets secrets_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT secrets_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id);


--
-- Name: authority_records authority_records_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authority_records
    ADD CONSTRAINT authority_records_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.authority_records(id);


--
-- Name: authority_records authority_records_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authority_records
    ADD CONSTRAINT authority_records_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id);


--
-- Name: step_up_challenges step_up_challenges_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.step_up_challenges
    ADD CONSTRAINT step_up_challenges_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: step_up_challenges step_up_challenges_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.step_up_challenges
    ADD CONSTRAINT step_up_challenges_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id) ON DELETE CASCADE;


--
-- Name: workloads workloads_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workloads
    ADD CONSTRAINT workloads_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id) ON DELETE CASCADE;


--
-- Name: subject_issuers subject_issuers_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_issuers
    ADD CONSTRAINT subject_issuers_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id);


--
-- Name: admin_audit_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_audit_events ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_invocations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_invocations ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_services; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_services ENABLE ROW LEVEL SECURITY;

--
-- Name: coordinator_idempotency_receipts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.coordinator_idempotency_receipts ENABLE ROW LEVEL SECURITY;

--
-- Name: sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: applications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

--
-- Name: delegated_grants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delegated_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: delegation_edges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delegation_edges ENABLE ROW LEVEL SECURITY;

--
-- Name: delegation_graph_epochs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delegation_graph_epochs ENABLE ROW LEVEL SECURITY;

--
-- Name: operator_conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.operator_conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: operator_message_run_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.operator_message_run_events ENABLE ROW LEVEL SECURITY;

--
-- Name: operator_message_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.operator_message_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: operator_plan_secrets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.operator_plan_secrets ENABLE ROW LEVEL SECURITY;

--
-- Name: operator_turns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.operator_turns ENABLE ROW LEVEL SECURITY;

--
-- Name: operator_zone_memory; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.operator_zone_memory ENABLE ROW LEVEL SECURITY;

--
-- Name: policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.policies ENABLE ROW LEVEL SECURITY;

--
-- Name: policy_set_bindings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.policy_set_bindings ENABLE ROW LEVEL SECURITY;

--
-- Name: policy_sets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.policy_sets ENABLE ROW LEVEL SECURITY;

--
-- Name: provider_connections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.provider_connections ENABLE ROW LEVEL SECURITY;

--
-- Name: providers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.providers ENABLE ROW LEVEL SECURITY;

--
-- Name: resources; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.resources ENABLE ROW LEVEL SECURITY;

--
-- Name: secret_store; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.secret_store ENABLE ROW LEVEL SECURITY;

--
-- Name: secrets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.secrets ENABLE ROW LEVEL SECURITY;

--
-- Name: authority_records; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.authority_records ENABLE ROW LEVEL SECURITY;

--
-- Name: step_up_challenges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.step_up_challenges ENABLE ROW LEVEL SECURITY;

--
-- Name: subject_issuers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subject_issuers ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_audit_events zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.admin_audit_events USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: admin_tokens zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.admin_tokens USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: agent_invocations zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.agent_invocations USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: agent_services zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.agent_services USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: coordinator_idempotency_receipts zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.coordinator_idempotency_receipts USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: sessions zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.sessions USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: applications zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.applications USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: audit_events zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.audit_events USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: delegated_grants zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.delegated_grants USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: delegation_edges zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.delegation_edges USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: delegation_graph_epochs zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.delegation_graph_epochs USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: operator_conversations zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.operator_conversations USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: operator_message_run_events zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.operator_message_run_events USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: operator_message_runs zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.operator_message_runs USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: operator_plan_secrets zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.operator_plan_secrets USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: operator_turns zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.operator_turns USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: operator_zone_memory zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.operator_zone_memory USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: policies zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.policies USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: policy_set_bindings zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.policy_set_bindings USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: policy_sets zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.policy_sets USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: provider_connections zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.provider_connections USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: providers zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.providers USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: resources zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.resources USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: secret_store zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.secret_store USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: secrets zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.secrets USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: authority_records zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.authority_records USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: step_up_challenges zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.step_up_challenges USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: subject_issuers zone_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY zone_isolation ON public.subject_issuers USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));


--
-- Name: TABLE agent_invocations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_invocations TO caracalcoordinator;
GRANT SELECT ON TABLE public.agent_invocations TO caracalapi;
GRANT SELECT ON TABLE public.agent_invocations TO caracalsts;


--
-- Name: TABLE agent_services; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_services TO caracalcoordinator;
GRANT SELECT ON TABLE public.agent_services TO caracalapi;
GRANT SELECT ON TABLE public.agent_services TO caracalsts;


--
-- Name: TABLE coordinator_idempotency_receipts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE public.coordinator_idempotency_receipts TO caracalcoordinator;


--
-- Name: TABLE sessions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.sessions TO caracalcoordinator;
GRANT SELECT,UPDATE ON TABLE public.sessions TO caracalapi;


--
-- Name: TABLE agent_topology; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_topology TO caracalcoordinator;


--
-- Name: TABLE applications; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.applications TO caracalsts;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.applications TO caracalapi;
GRANT SELECT ON TABLE public.applications TO caracalcoordinator;
GRANT SELECT ON TABLE public.applications TO caracalgateway;


--
-- Name: TABLE audit_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.audit_events TO caracalaudit;
GRANT SELECT ON TABLE public.audit_events TO caracalapi;


--
-- Name: TABLE audit_export_watermark; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.audit_export_watermark TO caracalaudit;


--
-- Name: TABLE audit_ingest_alerts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.audit_ingest_alerts TO caracalaudit;


--
-- Name: SEQUENCE audit_ingest_alerts_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.audit_ingest_alerts_id_seq TO caracalaudit;


--
-- Name: TABLE caracal_outbox; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.caracal_outbox TO caracalapi;
GRANT SELECT,INSERT,UPDATE ON TABLE public.caracal_outbox TO caracalcoordinator;


--
-- Name: TABLE delegated_grants; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.delegated_grants TO caracalsts;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.delegated_grants TO caracalapi;


--
-- Name: TABLE delegation_edges; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.delegation_edges TO caracalcoordinator;
GRANT SELECT ON TABLE public.delegation_edges TO caracalsts;
GRANT SELECT,UPDATE ON TABLE public.delegation_edges TO caracalapi;


--
-- Name: TABLE delegation_graph_epochs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.delegation_graph_epochs TO caracalcoordinator;
GRANT SELECT ON TABLE public.delegation_graph_epochs TO caracalapi;
GRANT SELECT ON TABLE public.delegation_graph_epochs TO caracalsts;


--
-- Name: TABLE operator_conversations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.operator_conversations TO caracalapi;


--
-- Name: TABLE operator_message_run_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.operator_message_run_events TO caracalapi;


--
-- Name: TABLE operator_message_runs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.operator_message_runs TO caracalapi;


--
-- Name: TABLE operator_plan_secrets; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.operator_plan_secrets TO caracalapi;


--
-- Name: TABLE operator_turns; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.operator_turns TO caracalapi;


--
-- Name: TABLE operator_zone_memory; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.operator_zone_memory TO caracalapi;


--
-- Name: TABLE notification_deliveries; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notification_deliveries TO caracalapi;


--
-- Name: TABLE notification_sinks; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notification_sinks TO caracalapi;


--
-- Name: TABLE policies; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.policies TO caracalsts;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.policies TO caracalapi;


--
-- Name: TABLE policy_set_bindings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.policy_set_bindings TO caracalsts;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.policy_set_bindings TO caracalapi;


--
-- Name: TABLE policy_set_versions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.policy_set_versions TO caracalsts;
GRANT SELECT,INSERT ON TABLE public.policy_set_versions TO caracalapi;


--
-- Name: TABLE policy_sets; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.policy_sets TO caracalsts;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.policy_sets TO caracalapi;


--
-- Name: TABLE policy_versions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.policy_versions TO caracalsts;
-- UPDATE is required for the SELECT ... FOR SHARE row locks taken while activating a
-- policy set; actual mutation stays blocked by the policy_versions_immutable trigger.
GRANT SELECT,INSERT,UPDATE ON TABLE public.policy_versions TO caracalapi;


--
-- Name: TABLE provider_connections; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.provider_connections TO caracalsts;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.provider_connections TO caracalapi;


--
-- Name: TABLE providers; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.providers TO caracalsts;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.providers TO caracalapi;
GRANT SELECT ON TABLE public.providers TO caracalgateway;


--
-- Name: TABLE resources; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.resources TO caracalsts;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.resources TO caracalapi;
GRANT SELECT ON TABLE public.resources TO caracalgateway;
GRANT SELECT ON TABLE public.resources TO caracalcoordinator;


--
-- Name: TABLE secret_store; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.secret_store TO caracalsts;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.secret_store TO caracalapi;


--
-- Name: TABLE secrets; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.secrets TO caracalsts;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.secrets TO caracalapi;


--
-- Name: TABLE authority_records; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.authority_records TO caracalsts;
GRANT SELECT,UPDATE ON TABLE public.authority_records TO caracalapi;
GRANT SELECT ON TABLE public.authority_records TO caracalcoordinator;


--
-- Name: TABLE step_up_challenges; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.step_up_challenges TO caracalsts;
GRANT SELECT,UPDATE ON TABLE public.step_up_challenges TO caracalapi;
GRANT SELECT ON TABLE public.subject_issuers TO caracalsts;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.subject_issuers TO caracalapi;


--
-- Name: TABLE zones; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.zones TO caracalsts;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.zones TO caracalapi;
GRANT SELECT ON TABLE public.zones TO caracalcoordinator;
GRANT SELECT ON TABLE public.zones TO caracalgateway;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.admin_tokens TO caracalapi;
GRANT SELECT,INSERT ON TABLE public.admin_audit_events TO caracalapi;
GRANT SELECT,INSERT ON TABLE public.admin_audit_events TO caracalcoordinator;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.audit_retention TO caracalapi;
GRANT SELECT ON TABLE public.audit_retention TO caracalaudit;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.audit_chain_rehash TO caracalaudit;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.event_outbox TO caracalapi;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.operator_ai_providers TO caracalapi;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.operator_conversation_counters TO caracalapi;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.workloads TO caracalapi;
GRANT SELECT ON TABLE public.workloads TO caracalsts;
GRANT SELECT ON TABLE public.sessions TO caracalsts;
GRANT SELECT ON TABLE public.authority_records TO caracalgateway;
GRANT SELECT ON TABLE public.sessions TO caracalgateway;
GRANT SELECT ON TABLE public.delegation_edges TO caracalgateway;

-- The audit retention worker maintains the monthly partition window through
-- definer functions owned by the administrative role, so the audit role can
-- create and drop partitions without holding UPDATE or DELETE on the event
-- store and the append-only guarantee stays intact.
CREATE FUNCTION public.audit_partition_ensure(month date) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
    start_month date := date_trunc('month', month)::date;
    end_month date := start_month + make_interval(months => 1);
    part_name text := format('audit_events_y%sm%s',
                             to_char(start_month, 'YYYY'),
                             to_char(start_month, 'MM'));
BEGIN
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.audit_events FOR VALUES FROM (%L) TO (%L)',
        part_name, start_month, end_month);
END
$$;

CREATE FUNCTION public.audit_partition_drop(part_name text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public
    AS $$
BEGIN
    IF part_name !~ '^audit_events_y[0-9]{4}m[0-9]{2}$' THEN
        RAISE EXCEPTION 'not an audit_events monthly partition: %', part_name;
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_inherits
        JOIN pg_class child ON child.oid = inhrelid
        JOIN pg_class parent ON parent.oid = inhparent
        WHERE parent.relname = 'audit_events' AND child.relname = part_name
    ) THEN
        RETURN;
    END IF;
    EXECUTE format('DROP TABLE public.%I', part_name);
END
$$;

REVOKE ALL ON FUNCTION public.audit_partition_ensure(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audit_partition_drop(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.audit_partition_ensure(date) TO caracalaudit;
GRANT EXECUTE ON FUNCTION public.audit_partition_drop(text) TO caracalaudit;


--
-- Name: audit_events partition window; Type: PARTITIONS; Schema: public; Owner: -
--

-- Provision the current rolling window of monthly audit_events partitions
-- (current month plus the next three) at apply time so a fresh database
-- satisfies the partition window immediately, matching the audit retention
-- worker instead of a static list that rots as the calendar advances.
DO $$
DECLARE
    base_month date := date_trunc('month', now())::date;
    start_month date;
    end_month date;
    part_name text;
    m int;
BEGIN
    FOR m IN 0..3 LOOP
        start_month := base_month + make_interval(months => m);
        end_month := start_month + make_interval(months => 1);
        part_name := format('audit_events_y%sm%s',
                            to_char(start_month, 'YYYY'),
                            to_char(start_month, 'MM'));
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.audit_events FOR VALUES FROM (%L) TO (%L)',
            part_name, start_month, end_month);
    END LOOP;
END
$$;


--
-- PostgreSQL database dump complete
--
