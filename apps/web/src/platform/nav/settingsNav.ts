/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Settings navigation model shared by the settings layout and its pages.
*/
import { featuresByHome, type LockedFeature } from "@/platform/edition/lockedFeatures";

export interface SettingsItem {
  /** Path segment under /app/settings, also the stable item id. */
  id: string;
  label: string;
  /** Section header copy shown on the page. */
  description: string;
  /** Present when the page is an enterprise capability shown as a locked upsell. */
  featureSlug?: string;
}

export interface SettingsGroupModel {
  id: string;
  label: string;
  items: SettingsItem[];
}

function lockedItem(feature: LockedFeature): SettingsItem {
  return {
    id: feature.slug,
    label: feature.title,
    description: feature.summary,
    featureSlug: feature.slug,
  };
}

export const SETTINGS_GROUPS: SettingsGroupModel[] = [
  {
    id: "account",
    label: "Account",
    items: [
      {
        id: "profile",
        label: "Profile",
        description: "Operator identity, account identifiers, and sign-out for this browser.",
      },
      {
        id: "security",
        label: "Security",
        description: "Sign-in methods, password rotation, and authenticated devices.",
      },
      {
        id: "preferences",
        label: "Preferences",
        description: "Theme, guided tours, and the platform-wide audit retention window.",
      },
    ],
  },
  {
    id: "administration",
    label: "Administration",
    items: [
      {
        id: "operator",
        label: "AI Operator",
        description: "Model providers and governed routing for the Caracal Operator.",
      },
      ...featuresByHome("settings").map(lockedItem),
    ],
  },
  {
    id: "danger",
    label: "Danger zone",
    items: [
      {
        id: "danger",
        label: "Account deletion",
        description: "Delete the authenticated account and every zone it owns.",
      },
    ],
  },
];

const ITEMS = SETTINGS_GROUPS.flatMap((group) => group.items);

export function settingsItem(segment: string): SettingsItem | undefined {
  return ITEMS.find((item) => item.id === segment);
}
