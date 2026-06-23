/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file holds a temporary browser-local installation and zone store pending the Control API.
*/
export type ZoneStatus = "active" | "archived";

export interface ZoneRecord {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: ZoneStatus;
  createdAt: string;
}

export interface InstallationRecord {
  name: string;
  onboarded: boolean;
}

export interface ProfileRecord {
  fullName: string;
  displayName: string;
  organization: string;
  avatar: string;
}

const INSTALL_KEY = "caracal.install";
const ZONES_KEY = "caracal.zones";
const ACTIVE_ZONE_KEY = "caracal.activeZone";
const PROFILE_KEY = "caracal.profile";

function read<T>(key: string, fallback: T): T {
  if (typeof localStorage === "undefined") return fallback;
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(key, JSON.stringify(value));
}

export function getInstallation(): InstallationRecord {
  return read<InstallationRecord>(INSTALL_KEY, { name: "", onboarded: false });
}

export function setInstallation(record: InstallationRecord): void {
  write(INSTALL_KEY, record);
}

export function isOnboarded(): boolean {
  return getInstallation().onboarded;
}

export function listZones(): ZoneRecord[] {
  return read<ZoneRecord[]>(ZONES_KEY, []);
}

export function activeZones(): ZoneRecord[] {
  return listZones().filter((zone) => zone.status === "active");
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function addZone(input: { name: string; description: string; slug?: string }): ZoneRecord {
  const zones = listZones();
  const zone: ZoneRecord = {
    id: `zone_${Math.random().toString(36).slice(2, 10)}`,
    name: input.name,
    slug: input.slug?.trim() || slugify(input.name),
    description: input.description,
    status: "active",
    createdAt: new Date().toISOString(),
  };
  write(ZONES_KEY, [...zones, zone]);
  if (!getActiveZoneId()) setActiveZoneId(zone.id);
  return zone;
}

export function archiveZone(id: string): void {
  write(
    ZONES_KEY,
    listZones().map((zone) => (zone.id === id ? { ...zone, status: "archived" } : zone)),
  );
}

export function getActiveZoneId(): string | null {
  return read<string | null>(ACTIVE_ZONE_KEY, null);
}

export function setActiveZoneId(id: string): void {
  write(ACTIVE_ZONE_KEY, id);
}

export function getActiveZone(): ZoneRecord | null {
  const id = getActiveZoneId();
  const zones = activeZones();
  return zones.find((zone) => zone.id === id) ?? zones[0] ?? null;
}

export function getProfile(): ProfileRecord {
  return read<ProfileRecord>(PROFILE_KEY, {
    fullName: "",
    displayName: "",
    organization: "",
    avatar: "",
  });
}

export function setProfile(record: ProfileRecord): void {
  write(PROFILE_KEY, record);
}

/** Human label for the active workspace shown in the Console chrome. */
export function workspaceLabel(): string {
  const profile = getProfile();
  return (
    profile.organization.trim() ||
    profile.displayName.trim() ||
    profile.fullName.trim() ||
    "Caracal"
  );
}

export function completeOnboarding(profile: ProfileRecord): void {
  setProfile(profile);
  setInstallation({ name: workspaceLabel(), onboarded: true });
}

export function resetInstallation(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(INSTALL_KEY);
  localStorage.removeItem(ZONES_KEY);
  localStorage.removeItem(ACTIVE_ZONE_KEY);
  localStorage.removeItem(PROFILE_KEY);
}
