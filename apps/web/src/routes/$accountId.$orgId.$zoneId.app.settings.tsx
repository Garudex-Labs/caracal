/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Settings layout route with grouped navigation over the /settings/{section} pages.
*/
import { Link, Outlet, createFileRoute, useLocation } from "@tanstack/react-router";

import { ModulePage } from "@/components/console/ModulePage";
import { LockBadge } from "@/components/ui";
import { appLink } from "@/platform/nav/appLink";
import { SETTINGS_GROUPS, settingsItem } from "@/platform/nav/settingsNav";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const segment = pathname.split("/settings/")[1]?.split("/")[0] ?? "";
  const current = settingsItem(segment);

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
                        {item.featureSlug ? <LockBadge /> : null}
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
            <header className="mb-8 flex-shrink-0 border-b border-border pb-5">
              <div className="flex items-center gap-2.5">
                <h2 className="text-xl font-semibold tracking-tight text-foreground">
                  {current.label}
                </h2>
                {current.featureSlug ? <LockBadge /> : null}
              </div>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                {current.description}
              </p>
            </header>
          ) : null}
          <div className="scrollbar-thin min-w-0 xl:flex-1 xl:overflow-y-auto xl:pb-4 xl:pr-3">
            <Outlet />
          </div>
        </section>
      </div>
    </ModulePage>
  );
}
