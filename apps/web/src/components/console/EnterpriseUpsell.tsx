/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the shared dark showcase panel for enterprise-only capabilities.
*/
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { rainbowFill, rainbowFrame, rainbowGradient } from "@/components/ui";
import type { FeatureIcon, LockedFeature } from "@/platform/edition/lockedFeatures";

const SALES_CALL_URL = "https://calendly.com/ryanmadhuwala/caracal";

const ICON_PATHS: Record<FeatureIcon, ReactNode> = {
  building: (
    <>
      <path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16" />
      <path d="M15 9h2a2 2 0 0 1 2 2v10" />
      <path d="M3 21h18" />
      <path d="M9 7h2M9 11h2M9 15h2" />
    </>
  ),
  gauge: (
    <>
      <path d="M4 15.5a8.5 8.5 0 1 1 16 0" />
      <path d="m12 15 3.5-4" />
      <circle cx="12" cy="15" r="1" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7.5 9 6 9-6" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m10.8 12.2 8.2-8.2" />
      <path d="m17 5 2.5 2.5" />
      <path d="m14 8 2.5 2.5" />
    </>
  ),
  sync: (
    <>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 8.5 4.5L12 12 3.5 7.5 12 3Z" />
      <path d="m3.5 12 8.5 4.5 8.5-4.5" />
      <path d="m3.5 16.5 8.5 4.5 8.5-4.5" />
    </>
  ),
  wave: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6" />
      <path d="M17.5 14.2A5.5 5.5 0 0 1 20.5 19" />
    </>
  ),
  ticket: (
    <>
      <path d="M3 9a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v1a2 2 0 0 0 0 4v1a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-1a2 2 0 0 0 0-4Z" />
      <path d="M13 7.5v2M13 11v2M13 14.5v2" />
    </>
  ),
  zap: <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />,
  heart: (
    <path d="M12 20.5C7 16.5 3.5 13 3.5 9.4A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 8.5 1.8c0 3.6-3.5 7.1-8.5 11.1Z" />
  ),
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  chart: (
    <>
      <path d="m2.5 17 6.5-6.5 4.5 4.5L21.5 7" />
      <path d="M16 7h5.5v5.5" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3.5 2.5 20h19L12 3.5Z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="16" rx="2" />
      <path d="M3.5 10h17" />
      <path d="M8 3v4M16 3v4" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5.5" rx="8" ry="3" />
      <path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  clipboard: (
    <>
      <rect x="5" y="4.5" width="14" height="16.5" rx="2" />
      <path d="M9 4.5v-1A1.5 1.5 0 0 1 10.5 2h3A1.5 1.5 0 0 1 15 3.5v1" />
      <path d="M9 11h6M9 15h4" />
    </>
  ),
  scale: (
    <>
      <path d="M12 3v18" />
      <path d="M7 21h10" />
      <path d="M4 7h3c2 0 3.5-1 5-2 1.5 1 3 2 5 2h3" />
      <path d="m5.5 7-3 6.5a3.2 3.2 0 0 0 6 0Z" />
      <path d="m18.5 7-3 6.5a3.2 3.2 0 0 0 6 0Z" />
    </>
  ),
  pen: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
};

function TileIcon({ name }: { name: FeatureIcon }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px]"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

export function EnterpriseUpsell({ feature }: { feature: LockedFeature }) {
  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-white/10 text-white shadow-2xl"
      style={{ backgroundColor: "#100D16" }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 100% 0%, rgba(108,63,245,0.35), transparent 55%), radial-gradient(90% 70% at 0% 100%, rgba(56,120,255,0.18), transparent 50%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{
          background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent)",
        }}
      />

      <div className="relative grid gap-8 p-7 md:grid-cols-[minmax(0,0.95fr)_minmax(0,1fr)] md:gap-10 md:p-9">
        <div className="flex flex-col">
          <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/40">
            Enterprise
          </span>

          <h3 className="mt-3 text-2xl font-semibold leading-tight tracking-tight md:text-[28px]">
            {feature.headline[0]}
            <br />
            <span className="text-white/50">{feature.headline[1]}</span>
          </h3>

          <ul className="mt-4 flex flex-col gap-2">
            {feature.value.map((point) => (
              <li
                key={point}
                className="flex items-start gap-2.5 text-sm leading-relaxed text-white/70"
              >
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-gradient-to-br from-violet-400 to-sky-400" />
                {point}
              </li>
            ))}
          </ul>

          <p className="mt-4 text-xs leading-relaxed text-white/40">
            {feature.community} {feature.title} activates right here when you upgrade - no
            migration.
          </p>

          <div className="mt-auto flex flex-col items-start gap-2.5 pt-7">
            <Link
              to="/enterprise"
              className={rainbowFrame}
              style={{ backgroundImage: rainbowGradient }}
            >
              <span className={rainbowFill}>
                <span className="text-white">Explore Enterprise Edition</span>
              </span>
            </Link>
            <a
              href={SALES_CALL_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="text-xs font-medium text-white/45 underline-offset-4 transition-colors hover:text-white hover:underline"
            >
              or book a call →
            </a>
          </div>
        </div>

        <ul className="grid content-start gap-3 sm:grid-cols-2">
          {feature.includes.map((item) => (
            <li
              key={item.label}
              className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-3.5 transition-colors hover:border-white/20 hover:bg-white/[0.06]"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/15 bg-white/10 text-white">
                <TileIcon name={item.icon} />
              </span>
              <span className="min-w-0 text-sm font-medium text-white">{item.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
