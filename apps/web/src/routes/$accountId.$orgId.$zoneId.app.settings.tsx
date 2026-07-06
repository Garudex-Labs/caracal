/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Settings layout route with grouped navigation over the /settings/{section} pages.
*/
import { Link, Outlet, createFileRoute, useLocation } from "@tanstack/react-router";

import { ModulePage } from "@/components/console/ModulePage";
import { systemZoneViewPath, useConsoleVersion, useSystemZoneId } from "@/platform/api/hooks";
import { appLink } from "@/platform/nav/appLink";
import { SETTINGS_GROUPS, settingsItem } from "@/platform/nav/settingsNav";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/settings")({
  component: SettingsLayout,
});

function LockGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function SettingsLayout() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const segment = pathname.split("/settings/")[1]?.split("/")[0] ?? "";
  const current = settingsItem(segment);
  const systemZone = useSystemZoneId();
  const version = useConsoleVersion();

  return (
    <ModulePage
      title="Settings"
      description="Account and administration controls."
      breadcrumbs={[
        { label: "Console", to: appLink() },
        ...(current
          ? [{ label: "Settings", to: appLink("/settings") }, { label: current.label }]
          : [{ label: "Settings" }]),
      ]}
    >
      <div className="grid gap-10 xl:grid-cols-[250px_minmax(0,1fr)] xl:gap-0">
        <aside className="xl:sticky xl:top-20 xl:self-start xl:pr-8">
          <div className="flex flex-col gap-7">
            {SETTINGS_GROUPS.map((group) => (
              <div key={group.id}>
                <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
                  {group.label}
                </div>
                <nav className="grid gap-0.5">
                  {group.items.map((item) => {
                    const active = item.id === segment;
                    return (
                      <Link
                        key={item.id}
                        to={appLink(`/settings/${item.id}`)}
                        className={[
                          "flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                          active
                            ? "bg-accent font-semibold text-foreground"
                            : "font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                        ].join(" ")}
                      >
                        <span>{item.label}</span>
                        {item.featureSlug ? (
                          <LockGlyph className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/70" />
                        ) : null}
                      </Link>
                    );
                  })}
                </nav>
              </div>
            ))}
          </div>
        </aside>

        <section className="min-w-0 xl:flex xl:h-[calc(100vh-9.75rem)] xl:flex-col xl:border-l xl:border-border xl:pl-10">
          {current ? (
            <header className="mb-8 flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border pb-5">
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <h2 className="text-xl font-semibold tracking-tight text-foreground">
                    {current.label}
                  </h2>
                  {current.featureSlug ? (
                    <LockGlyph className="h-4 w-4 text-muted-foreground/70" />
                  ) : null}
                </div>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                  {current.description}
                </p>
              </div>
              {current.id === "operator" && systemZone.data ? (
                <a
                  href={systemZoneViewPath(systemZone.data)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-pink-500/50 px-2.5 py-1.5 text-xs font-medium text-pink-600 transition-colors hover:bg-pink-500/10 dark:text-pink-400"
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                  Open System Zone
                </a>
              ) : null}
            </header>
          ) : null}
          <div className="scrollbar-thin min-w-0 xl:flex-1 xl:overflow-y-auto xl:pb-4 xl:pr-3">
            <Outlet />
          </div>
          <footer className="mt-8 flex flex-shrink-0 items-center justify-between gap-3 border-t border-border pb-1 pt-3 text-xs text-muted-foreground/80 xl:mt-0">
            <span>© Garudex Labs 2026</span>
            {version.data ? <span className="font-mono">{version.data}</span> : null}
          </footer>
        </section>
      </div>
    </ModulePage>
  );
}
