/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file maps Console navigation items to their line icons.
*/
import type { ReactNode } from "react";

const PATHS: Record<string, ReactNode> = {
  dashboard: (
    <>
      <path d="M4 13a8 8 0 0 1 16 0v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5Z" />
      <path d="m12 13 4-4" />
      <path d="M8 17h8" />
    </>
  ),
  zones: (
    <>
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
      <path d="m4 7.5 8 4.5 8-4.5" />
      <path d="M12 12v9" />
    </>
  ),
  applications: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  providers: (
    <>
      <path d="m15.5 7.5 1.8-1.8a2.8 2.8 0 1 1 4 4l-1.8 1.8" />
      <path d="m8.5 16.5-1.8 1.8a2.8 2.8 0 1 1-4-4l1.8-1.8" />
      <path d="m9 15 6-6" />
    </>
  ),
  resources: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
      <path d="M7 7h.01M7 17h.01" />
    </>
  ),
  policies: (
    <>
      <path d="M12 3 4 6v5c0 4.5 3.2 7.8 8 10 4.8-2.2 8-5.5 8-10V6l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  agents: (
    <>
      <rect x="4" y="8" width="16" height="11" rx="2.5" />
      <path d="M12 8V4M9 4h6" />
      <path d="M9 13h.01M15 13h.01" />
    </>
  ),
  sessions: (
    <>
      <path d="M3 12h4l2 6 4-14 2 8h6" />
    </>
  ),
  approvals: (
    <>
      <circle cx="12" cy="12" r="7" />
      <path d="m9 12 2 2 4-4.5" />
      <path d="M12 2v3M12 19v3" />
    </>
  ),
  audit: (
    <>
      <path d="M8 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-2" />
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M9 12h6M9 16h4" />
    </>
  ),
  diagnostics: (
    <>
      <path d="M4 4v6a4 4 0 0 0 8 0V4" />
      <path d="M9 16a4 4 0 0 0 8 0v-1" />
      <circle cx="18" cy="11" r="2.5" />
    </>
  ),
  control: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 6.9 19l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 13.4H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 5 6.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 18 5l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
  organization: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M9 7h.01M9 11h.01M9 15h.01M15 7h.01M15 11h.01M15 15h.01M10 21v-3h4v3" />
    </>
  ),
  analytics: (
    <>
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <rect x="7" y="12" width="3" height="5" rx="0.5" />
      <rect x="12" y="8" width="3" height="9" rx="0.5" />
      <rect x="17" y="5" width="3" height="12" rx="0.5" />
    </>
  ),
  governance: (
    <>
      <path d="M12 3v18M5 7h14M7 7l-3 6a3 3 0 0 0 6 0L7 7Zm10 0-3 6a3 3 0 0 0 6 0l-3-6Z" />
    </>
  ),
  connectors: (
    <>
      <rect x="3" y="9" width="6" height="6" rx="1.5" />
      <rect x="15" y="4" width="6" height="6" rx="1.5" />
      <rect x="15" y="14" width="6" height="6" rx="1.5" />
      <path d="M9 12h3a3 3 0 0 0 3-3M9 12h3a3 3 0 0 1 3 3" />
    </>
  ),
};

const FALLBACK = <circle cx="12" cy="12" r="7" />;

export function NavIcon({ name, className }: { name: string; className?: string }) {
  return (
    <svg
      className={className}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name] ?? FALLBACK}
    </svg>
  );
}
