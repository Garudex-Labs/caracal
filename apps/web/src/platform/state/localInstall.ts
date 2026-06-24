/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file holds browser-local Community Edition identity: the operator profile, onboarding state, and active-zone selection.
*/
import { useSyncExternalStore } from "react";

export interface InstallationRecord {
  name: string;
  onboarded: boolean;
}

export interface ProfileRecord {
  accountId: string;
  fullName: string;
  displayName: string;
  avatar: string;
}

// In-progress onboarding wizard state, persisted so a reload mid-flow restores the
// operator's step and entered values instead of resetting to a blank wizard.
export interface OnboardingDraft {
  step: number;
  fullName: string;
  displayName: string;
  avatar: string;
  zoneName: string;
  zoneDcr: boolean;
}

// Shared limits and rules for operator name fields, kept here so onboarding, Settings,
// and the Console chrome enforce one identical pattern.
export const NAME_MAX = 40;
export const HANDLE_MAX = 24;

/** A display name is a compact, space-free handle: keep letters, digits, _, ., - only. */
export function sanitizeHandle(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, HANDLE_MAX);
}

/**
 * Resolve the handle shown in the Console. An explicit display name wins; otherwise the
 * full name's first token (the part before any space) becomes the handle, so the fallback
 * never carries a space the field itself would reject.
 */
export function resolveDisplayName(fullName: string, displayName: string): string {
  const handle = sanitizeHandle(displayName.trim());
  if (handle) return handle;
  const firstName = fullName.trim().split(/\s+/)[0] ?? "";
  return sanitizeHandle(firstName);
}

const INSTALL_KEY = "caracal.install";
const ACTIVE_ZONE_KEY = "caracal.activeZone";
const PROFILE_KEY = "caracal.profile";
const OWNER_KEY = "caracal.owner";
const GUIDED_SETUP_KEY = "caracal.guidedSetup";
const ONBOARDING_DRAFT_KEY = "caracal.onboardingDraft";
const profileListeners = new Set<() => void>();
let profileSnapshot: ProfileRecord | null = null;

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

function remove(key: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(key);
}

function emitProfileChange(): void {
  for (const listener of profileListeners) listener();
}

function subscribeProfile(listener: () => void): () => void {
  profileListeners.add(listener);
  return () => profileListeners.delete(listener);
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

export function getActiveZoneId(): string | null {
  return read<string | null>(ACTIVE_ZONE_KEY, null);
}

export function setActiveZoneId(id: string): void {
  write(ACTIVE_ZONE_KEY, id);
}

// Tracks whether the operator has finished or dismissed the in-app guided setup, so the
// coachmark checklist does not reappear on every visit once they have opted out or
// completed it. Completion of individual steps is derived from live backend state, not
// stored here.
interface GuidedSetupRecord {
  dismissed: boolean;
  finished: boolean;
}

export type { GuidedSetupRecord };

export function getGuidedSetup(): GuidedSetupRecord {
  return read<GuidedSetupRecord>(GUIDED_SETUP_KEY, { dismissed: false, finished: false });
}

export function setGuidedSetup(record: GuidedSetupRecord): void {
  write(GUIDED_SETUP_KEY, record);
}

export function getOnboardingDraft(): OnboardingDraft | null {
  return read<OnboardingDraft | null>(ONBOARDING_DRAFT_KEY, null);
}

export function setOnboardingDraft(draft: OnboardingDraft): void {
  write(ONBOARDING_DRAFT_KEY, draft);
}

export function clearOnboardingDraft(): void {
  remove(ONBOARDING_DRAFT_KEY);
}

/** Generate a stable, unique internal account identifier, formatted CRC-XXXX-XXXX-XXXX. */
function generateAccountId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const pick = () =>
    Array.from(
      typeof crypto !== "undefined" && crypto.getRandomValues
        ? crypto.getRandomValues(new Uint8Array(4))
        : [0, 0, 0, 0].map(() => Math.floor(Math.random() * 256)),
      (byte) => alphabet[byte % alphabet.length],
    ).join("");
  return `CRC-${pick()}-${pick()}-${pick()}`;
}

export function getProfile(): ProfileRecord {
  if (profileSnapshot) return profileSnapshot;
  const stored = read<Partial<ProfileRecord>>(PROFILE_KEY, {});
  const accountId =
    stored.accountId && stored.accountId.startsWith("CRC-")
      ? stored.accountId
      : generateAccountId();
  const profile: ProfileRecord = {
    accountId,
    fullName: stored.fullName ?? "",
    displayName: stored.displayName ?? "",
    avatar: stored.avatar ?? "",
  };
  if (stored.accountId !== accountId) write(PROFILE_KEY, profile);
  profileSnapshot = profile;
  return profile;
}

export function setProfile(record: ProfileRecord): void {
  profileSnapshot = record;
  write(PROFILE_KEY, record);
  emitProfileChange();
}

export function useProfile(): ProfileRecord {
  return useSyncExternalStore(subscribeProfile, getProfile, getProfile);
}

export function clearLocalIdentity(): void {
  profileSnapshot = null;
  remove(INSTALL_KEY);
  remove(ACTIVE_ZONE_KEY);
  remove(PROFILE_KEY);
  remove(OWNER_KEY);
  remove(GUIDED_SETUP_KEY);
  remove(ONBOARDING_DRAFT_KEY);
  emitProfileChange();
}

// The browser caches the operator profile and onboarding state in localStorage, but
// the authentication backend is the source of truth for the account. Bind the cached
// identity to the signed-in user id and drop it whenever the server reports a different
// account or none at all, so a backend `caracal purge` (which deletes the account)
// fully resets the web identity on the next session check instead of resurfacing a
// profile whose account no longer exists.
export function reconcileLocalIdentity(serverUserId: string | null): void {
  const boundId = read<string | null>(OWNER_KEY, null);
  if (serverUserId === null) {
    if (boundId !== null || hasStoredIdentity()) clearLocalIdentity();
    return;
  }
  if (boundId !== serverUserId) {
    clearLocalIdentity();
    write(OWNER_KEY, serverUserId);
  }
}

function hasStoredIdentity(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(INSTALL_KEY) !== null || localStorage.getItem(PROFILE_KEY) !== null;
}

/** Human label for the active workspace shown in the Console chrome. */
export function workspaceLabel(): string {
  const profile = getProfile();
  return resolveDisplayName(profile.fullName, profile.displayName) || "Caracal";
}

export function completeOnboarding(profile: ProfileRecord): void {
  setProfile(profile);
  setInstallation({ name: workspaceLabel(), onboarded: true });
  clearOnboardingDraft();
}
