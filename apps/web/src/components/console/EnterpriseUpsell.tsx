/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the shared, strategic upgrade showcase for enterprise-only capabilities.
*/
import { Link } from "@tanstack/react-router";

import { Button, LockBadge } from "@/components/ui";
import { config } from "@/platform/config";
import type { LockedFeature } from "@/platform/edition/lockedFeatures";

function CheckIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-0.5 shrink-0"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="mt-0.5 shrink-0 text-muted-foreground"
      aria-hidden="true"
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/**
 * Presents an enterprise-only capability as a calm, value-led upgrade surface.
 * `heading` controls whether the component renders its own title block (standalone
 * pages) or sits inside a host that already provides one (settings sections).
 */
export function EnterpriseUpsell({
  feature,
  heading = true,
}: {
  feature: LockedFeature;
  heading?: boolean;
}) {
  return (
    <div className="border border-border">
      {heading ? (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h2 className="text-lg font-semibold tracking-tight text-foreground">
                {feature.title}
              </h2>
              <LockBadge />
            </div>
            <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{feature.summary}</p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-px bg-border lg:grid-cols-[minmax(0,1fr)_300px] [&>*]:bg-background">
        <div className="flex flex-col gap-6 p-6">
          {!heading ? (
            <p className="max-w-2xl text-sm text-muted-foreground">{feature.summary}</p>
          ) : null}

          <div>
            <SectionHead>Why teams upgrade</SectionHead>
            <ul className="mt-3 flex flex-col gap-2.5 text-sm text-foreground">
              {feature.value.map((point) => (
                <li key={point} className="flex items-start gap-2.5">
                  <span className="text-emerald-600 dark:text-emerald-400">
                    <CheckIcon />
                  </span>
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <SectionHead>Included in Enterprise</SectionHead>
            <ul className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {feature.includes.map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <LockGlyph />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
            <a href={config.enterpriseUrl} target="_blank" rel="noreferrer">
              <Button>Upgrade to Enterprise</Button>
            </a>
            <Link
              to="/pricing"
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Compare editions
            </Link>
          </div>
        </div>

        <div className="flex flex-col gap-4 p-6">
          <SectionHead>On Community today</SectionHead>
          <p className="text-sm text-muted-foreground">{feature.community}</p>
          <div className="mt-auto border border-dashed border-border bg-muted/40 p-4">
            <div className="flex items-center gap-2">
              <LockBadge />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {feature.title} activates in this exact place when you upgrade, with no migration, the
              Community security model is unchanged.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
      {children}
    </h3>
  );
}
