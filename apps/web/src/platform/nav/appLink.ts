/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Reserved org ids and Console path building for the account/org/zone URL hierarchy.
*/
import { getProfile, getActiveZoneId } from "@/platform/state/localInstall";

// The Console URL is /:accountId/:orgId/:zoneId/app/...: account outermost as the stable human
// identity, org as the tenancy boundary, zone innermost. Open source has no orgs, so every account
// uses this reserved sentinel org; enterprise replaces it with real org ids on the same shape, so
// zone and account routing never change when orgs arrive.
const OSS_ORG_ID = "00000000-0000-0000-0000-000000000000";

// Builds an account/org/zone-scoped Console path. Identity comes from the current profile and
// active zone, so every link carries it without each caller threading params. A sub-path like
// "/audit" is appended; the bare app root is "". Open source always uses the sentinel org.
export function appLink(sub = "", zoneId?: string): string {
  const account = getProfile().accountId;
  const zone = zoneId ?? getActiveZoneId() ?? "_";
  return `/${account}/${OSS_ORG_ID}/${zone}/app${sub}`;
}

// Converts a flat nav path (/app or /app/audit) into the account/org/zone-scoped link, so the
// shared nav model keeps stable flat ids while every rendered link carries identity.
export function navTarget(to: string): string {
  return appLink(to === "/app" ? "" : to.slice(4));
}
