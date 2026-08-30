// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0


import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { config, type PublicConfig } from "@/lib/api";
import { configureOrgSubdomains } from "@/lib/tenant-host";

export function useDeploymentConfig() {
	const { data, isLoading, isError, refetch } = useQuery<PublicConfig>({
		queryKey: ["config", "public"],
		queryFn: config.public,
		staleTime: 5 * 60 * 1000, // cache for 5 minutes
		retry: 2,
	});

	// Mirror the deployment's subdomain capability into the tenancy module so
	// org context only crosses origins when the server actually uses subdomains.
	const orgSubdomains = data?.org_subdomains ?? false;
	useEffect(() => {
		configureOrgSubdomains(orgSubdomains);
	}, [orgSubdomains]);

	return {
		licensed: data?.licensed ?? true,
		licensedFeatures: data?.licensed_features ?? ["all"],
		ssoEnabled: data?.sso_enabled ?? false,
		googleSsoEnabled: data?.google_sso_enabled ?? false,
		githubSsoEnabled: data?.github_sso_enabled ?? false,
		ssoOnly: data?.sso_only ?? false,
		selfRegistrationEnabled: data?.self_registration_enabled ?? false,
		samlEnabled: data?.saml_enabled ?? false,
		devLoginEnabled: data?.dev_login_enabled ?? false,
		// Capability flags fail closed: an unknown deployment advertises
		// nothing rather than methods that may not exist.
		magicLinksEnabled: data?.auth?.magic_links ?? false,
		passkeysEnabled: data?.auth?.passkeys ?? false,
		emailPasswordEnabled: data?.auth?.email_password ?? false,
		authAvailable: data?.auth_available ?? Object.keys(data?.auth ?? {}).length > 0,
		enabledFeatures: data?.enabled_features ?? [],
		brandingLogo: data?.branding_logo ?? null,
		brandingAppName: data?.branding_app_name ?? null,
		brandingWordmark: data?.branding_wordmark ?? null,
		orgSubdomains,
		loading: isLoading,
		configError: isError,
		refetchConfig: refetch,
	};
}

export function useServerVersion() {
	const { data, isLoading } = useQuery({
		queryKey: ["config", "version"],
		queryFn: config.version,
		staleTime: 5 * 60 * 1000,
		retry: 1,
	});

	return {
		serverVersion: data?.server_version ?? null,
		loading: isLoading,
	};
}
