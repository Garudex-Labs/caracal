/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the onboarding side panel explaining what a zone is and when to create separate zones.
*/
import type { ReactNode } from "react";

function LayersIcon({ className }: { className?: string }) {
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
      <path d="M12 3 3 8l9 5 9-5-9-5Z" />
      <path d="M3 13l9 5 9-5" />
    </svg>
  );
}

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

function ShieldIcon({ className }: { className?: string }) {
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
      <path d="M12 3 5 6v5c0 4.2 2.9 7.8 7 9 4.1-1.2 7-4.8 7-9V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground">
      {children}
    </span>
  );
}

function Reason({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-background text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
          {children}
        </span>
      </span>
    </li>
  );
}

export function ZoneExplainer() {
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-muted/30 p-5">
      <div>
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          What is a zone
        </span>
        <p className="mt-2 text-sm leading-relaxed text-foreground">
          A zone is a self-contained boundary. Everything inside it is isolated from every other
          zone, nothing is shared or leaks across.
        </p>
      </div>

      <div className="rounded-lg border border-dashed border-primary/40 bg-primary/4 p-3">
        <div className="flex items-center gap-1.5">
          <LayersIcon className="h-3.5 w-3.5 text-primary" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
            One zone
          </span>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Chip>Applications</Chip>
          <Chip>Providers</Chip>
          <Chip>Resources</Chip>
          <Chip>Policies</Chip>
          <Chip>Audit</Chip>
        </div>
      </div>

      <div>
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Create separate zones to
        </span>
        <ul className="mt-3 flex flex-col gap-3.5">
          <Reason icon={<LayersIcon className="h-4 w-4" />} title="Split environments">
            Keep Production, Staging, and Development apart so test traffic never touches real
            credentials or live policies.
          </Reason>
          <Reason icon={<UsersIcon className="h-4 w-4" />} title="Separate products or teams">
            Give each product or team its own space, with no visibility into the others.
          </Reason>
          <Reason icon={<ShieldIcon className="h-4 w-4" />} title="Contain blast radius">
            A misconfigured policy or leaked secret can only affect its own zone, never the rest.
          </Reason>
        </ul>
      </div>

      <p className="border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">Rule of thumb:</span> if two workloads should
        never share credentials, policies, or audit, put them in different zones. Start with one,
        add more anytime.
      </p>
    </div>
  );
}
