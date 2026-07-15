/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the onboarding review callout that positions the Enterprise Edition for growing teams.
*/
import type { ReactNode } from "react";

import { Link } from "@tanstack/react-router";

import { rainbowFill, rainbowFrame, rainbowGradient } from "@/components/ui";

const SALES_CALL_URL = "https://calendly.com/ryanmadhuwala/caracal";

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6" />
      <path d="M17.5 14.2A5.5 5.5 0 0 1 20.5 19" />
    </svg>
  );
}

function KeyIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="8" cy="15" r="4" />
      <path d="m10.8 12.2 8.2-8.2" />
      <path d="m17 5 2.5 2.5" />
      <path d="m14 8 2.5 2.5" />
    </svg>
  );
}

function BuildingIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16" />
      <path d="M15 9h2a2 2 0 0 1 2 2v10" />
      <path d="M3 21h18" />
      <path d="M9 7h2M9 11h2M9 15h2" />
    </svg>
  );
}

function CloudIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M7 18a4 4 0 0 1-.5-7.97A6 6 0 0 1 18 9.5a3.5 3.5 0 0 1-.5 8.5Z" />
      <path d="m9.5 13.5 1.8 1.8 3.2-3.6" />
    </svg>
  );
}

function SellingPoint({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-3.5 transition-colors hover:border-white/20 hover:bg-white/[0.06]">
      <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/15 bg-white/10 text-white">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-white">{title}</span>
        <span className="mt-1 block text-xs leading-relaxed text-white/55">{children}</span>
      </span>
    </li>
  );
}

export function EnterpriseCallout() {
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
            Built for one.
            <br />
            <span className="text-white/50">Ready for the whole team.</span>
          </h3>

          <p className="mt-3 text-sm leading-relaxed text-white/55">
            When you grow past a single owner, Enterprise adds teams, SSO, and managed
            multi-tenancy, with nothing extra to run.
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

        <ul className="grid gap-3 sm:grid-cols-2">
          <SellingPoint icon={<UsersIcon className="h-[18px] w-[18px]" />} title="Teams and RBAC">
            Org, team, and role permissions.
          </SellingPoint>
          <SellingPoint icon={<KeyIcon className="h-[18px] w-[18px]" />} title="Single sign-on">
            SAML and OIDC with SCIM.
          </SellingPoint>
          <SellingPoint icon={<BuildingIcon className="h-[18px] w-[18px]" />} title="Multi-tenancy">
            Native tenants and workspaces.
          </SellingPoint>
          <SellingPoint icon={<CloudIcon className="h-[18px] w-[18px]" />} title="Fully managed">
            Hosted services with an SLA.
          </SellingPoint>
        </ul>
      </div>
    </div>
  );
}
