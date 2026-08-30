// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0


import { useRouter } from "@tanstack/react-router";
import { Building2, Check, ChevronsUpDown, CircleUser, LogOut, Settings2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { clearSession, getUserAvatar } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { canManageOrganization } from "@/lib/permissions";
import { useSyncExternalStore } from "react";

function initials(name: string) {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

interface NavUserProps {
  user: { name: string; email: string; username?: string };
}

export function NavUser({ user }: NavUserProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { orgs, currentOrg, setCurrentOrg } = useCurrentOrg();
  const avatarUrl = useSyncExternalStore(
    (cb) => { window.addEventListener("storage", cb); return () => window.removeEventListener("storage", cb); },
    () => getUserAvatar(),
    () => null,
  );

  const primaryLabel = user.username || user.name || "User";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={
            currentOrg
              ? `Account menu for ${primaryLabel}, organization ${currentOrg.slug}`
              : `Account menu for ${primaryLabel}`
          }
          className="group flex h-8 max-w-50 items-center gap-2 rounded-md border border-border pl-1 pr-1.5 outline-none ring-ring transition-colors hover:border-input hover:bg-accent/40 focus-visible:ring-2 data-[state=open]:border-input data-[state=open]:bg-accent sm:pr-2"
        >
          <Avatar
            className="h-6 w-6 shrink-0 ring-1 ring-border transition-shadow group-hover:ring-muted-foreground/50 group-data-[state=open]:ring-primary"
            key={avatarUrl || "no-avatar"}
          >
            {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
            <AvatarFallback className="bg-secondary text-[10px] font-medium text-foreground">
              {initials(user.name || "U")}
            </AvatarFallback>
          </Avatar>
          <span className="hidden min-w-0 flex-1 flex-col justify-center gap-0.5 text-left sm:flex">
            <span className="truncate text-xs font-medium leading-none text-foreground">
              {primaryLabel}
            </span>
            {currentOrg && (
              <span className="truncate text-[10px] leading-none text-muted-foreground">
                @{currentOrg.slug}
              </span>
            )}
          </span>
          <ChevronsUpDown aria-hidden="true" className="hidden h-3 w-3 shrink-0 text-muted-foreground sm:block" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-56"
        side="bottom"
        align="end"
        sideOffset={6}
      >
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium leading-none">{user.name}</p>
            {user.username && (
              <p className="text-xs leading-none text-muted-foreground">
                @{user.username}
              </p>
            )}
            <p className="text-xs leading-none text-muted-foreground">
              {user.email}
            </p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href="/settings/profile">
            <CircleUser className="mr-2 h-4 w-4" />
            Profile
          </a>
        </DropdownMenuItem>
        {orgs.length > 0 && (
          <>
            <DropdownMenuSeparator />
            {/* Same selector pattern as the project switcher, one level up the hierarchy. */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="gap-2">
                <Building2 className="h-4 w-4 shrink-0 text-primary-accent" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{currentOrg?.name ?? "Select organization"}</span>
                  {currentOrg && (
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {currentOrg.slug}
                    </span>
                  )}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64" sideOffset={8}>
                <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Organizations
                </DropdownMenuLabel>
                <div className="max-h-72 overflow-y-auto overscroll-contain">
                  {orgs.map((org) => (
                    <DropdownMenuItem
                      key={org.id}
                      className="gap-2"
                      onSelect={() => {
                        if (org.slug === currentOrg?.slug) return;
                        setCurrentOrg(org.slug);
                        // Refresh membership-derived state so revocations and
                        // new orgs surface immediately; org-scoped queries are
                        // keyed by slug, so no cross-org cache reuse either way.
                        queryClient.invalidateQueries({ queryKey: ["orgs"] });
                      }}
                    >
                      <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{org.name}</span>
                        <span className="block truncate font-mono text-[10px] text-muted-foreground">{org.slug}</span>
                      </span>
                      {org.role && (
                        <span className="text-[10px] capitalize text-muted-foreground">{org.role}</span>
                      )}
                      {org.slug === currentOrg?.slug && <Check className="h-3.5 w-3.5 shrink-0 text-primary-accent" />}
                    </DropdownMenuItem>
                  ))}
                </div>
                <DropdownMenuSeparator />
                {canManageOrganization(currentOrg) && (
                  <DropdownMenuItem asChild>
                    {/* Plain anchor: leaves project context, so the URL must drop the prefix. */}
                    <a href="/organization" className="gap-2">
                      <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
                      Manage organization
                    </a>
                  </DropdownMenuItem>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async () => {
            try {
              await authClient.signOut();
            } catch {
              // Best-effort - proceed with client-side cleanup regardless
            }
            clearSession();
            router.navigate({ to: "/login" });
          }}
        >
          <LogOut className="mr-2 h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
