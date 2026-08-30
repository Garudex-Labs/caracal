// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0


import { useEffect, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useCurrentRole } from "@/components/settings/settings-shell";
import { useCurrentProject } from "@/hooks/use-current-project";
import { visibleSettingsSections, scopeLabel } from "@/lib/settings-index";
import { projectRoutePath } from "@/lib/tenant-host";
import { allNavItems } from "./registry-sidebar";

const OPEN_EVENT = "caracal:command-menu";

/** Opens the global command palette (used by the top-bar search control). */
export function openCommandMenu() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const role = useCurrentRole();
  const settingsSections = visibleSettingsSections(role);
  const { currentProject, preferredProject } = useCurrentProject();
  const projectSlug = currentProject?.slug ?? preferredProject?.slug;

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const openFromEvent = () => setOpen(true);
    document.addEventListener("keydown", down);
    window.addEventListener(OPEN_EVENT, openFromEvent);
    return () => {
      document.removeEventListener("keydown", down);
      window.removeEventListener(OPEN_EVENT, openFromEvent);
    };
  }, []);

  const onSelect = (href: string, projectFree = false) => {
    setOpen(false);
    if (projectFree) {
      window.location.assign(href);
      return;
    }
    if (projectSlug) window.location.assign(projectRoutePath(projectSlug, href));
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search agents, components, traces..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Navigate">
          {allNavItems.map((group) =>
            group.items.filter((item) => item.projectFree || projectSlug).map((item) => (
              <CommandItem
                key={item.href}
                onSelect={() => onSelect(item.href, item.projectFree)}
              >
                <item.icon className="mr-2 h-4 w-4" />
                {item.title}
              </CommandItem>
            )),
          )}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Settings">
          {settingsSections.map((section) => (
            <CommandItem
              key={section.to}
              value={`settings ${section.title} ${section.description}`}
              onSelect={() => onSelect(section.to, true)}
            >
              <section.icon className="mr-2 h-4 w-4" />
              {section.title}
              <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground/70">
                {scopeLabel(section.scope)}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
        {projectSlug && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Quick Actions">
              <CommandItem onSelect={() => onSelect("/agents/new")}>
                <span className="mr-2 text-sm">+</span>
                New Agent
              </CommandItem>
              <CommandItem onSelect={() => onSelect("/resources")}>
                <span className="mr-2 text-sm">?</span>
                Search Resources
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
