-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Enforces same-zone ownership for core domain references.

ALTER TABLE providers
    ADD CONSTRAINT providers_zone_id_id_unique UNIQUE (zone_id, id);

ALTER TABLE applications
    ADD CONSTRAINT applications_zone_id_id_unique UNIQUE (zone_id, id);

ALTER TABLE resources
    ADD CONSTRAINT resources_zone_id_id_unique UNIQUE (zone_id, id),
    ADD CONSTRAINT resources_zone_provider_fk
        FOREIGN KEY (zone_id, credential_provider_id) REFERENCES providers(zone_id, id);

ALTER TABLE sessions
    ADD CONSTRAINT sessions_zone_id_id_unique UNIQUE (zone_id, id),
    ADD CONSTRAINT sessions_status_check CHECK (status IN ('active', 'revoked', 'expired'));

ALTER TABLE delegated_grants
    ADD CONSTRAINT delegated_grants_status_check CHECK (status IN ('active', 'revoked', 'expired')),
    ADD CONSTRAINT delegated_grants_zone_application_fk
        FOREIGN KEY (zone_id, application_id) REFERENCES applications(zone_id, id),
    ADD CONSTRAINT delegated_grants_zone_resource_fk
        FOREIGN KEY (zone_id, resource_id) REFERENCES resources(zone_id, id),
    ADD CONSTRAINT delegated_grants_zone_provider_fk
        FOREIGN KEY (zone_id, provider_id) REFERENCES providers(zone_id, id);

ALTER TABLE agent_sessions
    ADD CONSTRAINT agent_sessions_zone_id_id_unique UNIQUE (zone_id, id),
    ADD CONSTRAINT agent_sessions_status_check CHECK (status IN ('active', 'suspended', 'terminated', 'expired')),
    ADD CONSTRAINT agent_sessions_zone_application_fk
        FOREIGN KEY (zone_id, application_id) REFERENCES applications(zone_id, id),
    ADD CONSTRAINT agent_sessions_zone_session_fk
        FOREIGN KEY (zone_id, session_sid) REFERENCES sessions(zone_id, id),
    ADD CONSTRAINT agent_sessions_zone_parent_fk
        FOREIGN KEY (zone_id, parent_id) REFERENCES agent_sessions(zone_id, id);

ALTER TABLE agent_services
    ADD CONSTRAINT agent_services_zone_id_id_unique UNIQUE (zone_id, id),
    ADD CONSTRAINT agent_services_zone_application_fk
        FOREIGN KEY (zone_id, application_id) REFERENCES applications(zone_id, id);

ALTER TABLE delegation_edges
    ADD CONSTRAINT delegation_edges_zone_source_fk
        FOREIGN KEY (zone_id, source_session_id) REFERENCES agent_sessions(zone_id, id) ON DELETE CASCADE,
    ADD CONSTRAINT delegation_edges_zone_target_fk
        FOREIGN KEY (zone_id, target_session_id) REFERENCES agent_sessions(zone_id, id) ON DELETE CASCADE,
    ADD CONSTRAINT delegation_edges_zone_issuer_application_fk
        FOREIGN KEY (zone_id, issuer_application_id) REFERENCES applications(zone_id, id),
    ADD CONSTRAINT delegation_edges_zone_receiver_application_fk
        FOREIGN KEY (zone_id, receiver_application_id) REFERENCES applications(zone_id, id),
    ADD CONSTRAINT delegation_edges_zone_resource_fk
        FOREIGN KEY (zone_id, resource_id) REFERENCES resources(zone_id, id);

ALTER TABLE agent_invocations
    ADD CONSTRAINT agent_invocations_zone_id_id_unique UNIQUE (zone_id, id),
    ADD CONSTRAINT agent_invocations_zone_service_fk
        FOREIGN KEY (zone_id, service_id) REFERENCES agent_services(zone_id, id) ON DELETE CASCADE,
    ADD CONSTRAINT agent_invocations_zone_source_fk
        FOREIGN KEY (zone_id, source_session_id) REFERENCES agent_sessions(zone_id, id),
    ADD CONSTRAINT agent_invocations_zone_target_fk
        FOREIGN KEY (zone_id, target_session_id) REFERENCES agent_sessions(zone_id, id);
