// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { useDeploymentConfig } from "@/hooks/use-deployment-config";

/**
 * The instance's brand mark.
 *
 * Honours white-label branding: a deployment that replaced the logo sees its
 * own mark, not Caracal's. Decorative by default - the surrounding text
 * carries the meaning, so the image stays out of the accessibility tree.
 */
export function RegistryMark({ size = 16, className = "" }: { size?: number; className?: string }) {
	const { brandingLogo } = useDeploymentConfig();
	return (
		<img
			src={brandingLogo || "/caracal_sq.png"}
			alt=""
			aria-hidden="true"
			width={size}
			height={size}
			className={`shrink-0 object-contain ${className}`}
		/>
	);
}

/** The instance's display name, for use in sentences like "Already in X". */
export function useRegistryName(): string {
	const { brandingAppName } = useDeploymentConfig();
	return brandingAppName || "Caracal";
}
