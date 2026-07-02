/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Settings layout route with grouped navigation over the /settings/{section} pages.
*/
import { Link, Outlet, createFileRoute, useLocation } from "@tanstack/react-router";

import { ModulePage } from "@/components/console/ModulePage";
import { HelpTip } from "@/components/console/SettingsPanels";
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
      <div className="grid gap-8 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="xl:sticky xl:top-20 xl:self-start">
          <div className="border border-border bg-card">
            {SETTINGS_GROUPS.map((group) => (
              <div key={group.id} className="border-b border-border last:border-b-0">
                <div className="px-4 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  {group.label}
                </div>
                <nav className="grid">
                  {group.items.map((item) => {
                    const active = item.id === segment;
                    return (
                      <Link
                        key={item.id}
                        to={appLink(`/settings/${item.id}`)}
                        className={[
                          "flex items-center justify-between gap-2 px-4 py-2.5 text-left transition-colors",
                          active
                            ? "bg-foreground text-background"
                            : "text-muted-foreground hover:bg-surface hover:text-foreground",
                        ].join(" ")}
                      >
                        <span className="text-sm font-semibold">{item.label}</span>
                        {item.featureSlug ? (
                          <span className={active ? "opacity-80" : ""}>
                            <LockBadge />
                          </span>
                        ) : null}
                      </Link>
                    );
                  })}
                </nav>
              </div>
            ))}
          </div>
        </aside>

        <section className="min-w-0 border-y border-border">
          {current ? (
            <div className="border-b border-border py-6">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {current.label}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                  {current.label}
                </h2>
                {current.featureSlug ? <LockBadge /> : <HelpTip label={current.description} />}
              </div>
            </div>
          ) : null}
          <Outlet />
        </section>
      </div>
    </ModulePage>
  );
}
