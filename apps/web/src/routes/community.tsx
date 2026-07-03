/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the community route.
*/
import { createFileRoute } from "@tanstack/react-router";
import { SectionLabel } from "@/components/SiteShell";

export const Route = createFileRoute("/community")({
  head: () => ({
    meta: [
      { title: "Community · Caracal" },
      { name: "description", content: "Join the Caracal community on GitHub, Discord, and X." },
      { property: "og:title", content: "Caracal Community" },
      { property: "og:description", content: "Built in the open by a community of contributors." },
    ],
  }),
  component: CommunityPage,
});

const CARDS = [
  {
    title: "GitHub",
    desc: "Star the repo, file issues, and send PRs.",
    stat: "100+ ★",
    href: "https://github.com/Garudex-Labs/caracal",
  },
  {
    title: "Discord",
    desc: "Chat with maintainers and the community in real time.",
    stat: "60+ members",
    href: "https://discord.gg/WX7dNMhM7E",
  },
  {
    title: "X / Twitter",
    desc: "Release notes, tips, and ecosystem updates.",
    stat: "@caracalrun",
    href: "https://x.com/caracalrun",
  },
  {
    title: "LinkedIn",
    desc: "Follow us for company updates and news.",
    stat: "@caracal-run",
    href: "https://www.linkedin.com/company/caracal-run",
  },
];

function CommunityPage() {
  return (
    <div className="px-4 py-10 sm:px-6 md:px-10 md:py-14">
      <SectionLabel>Community</SectionLabel>
      <h1 className="mt-6 max-w-3xl text-3xl font-medium tracking-tight md:text-5xl">
        Built in the open, by the community.
      </h1>
      <p className="mt-6 max-w-2xl text-base text-muted-foreground md:text-lg">
        Caracal is open source under Apache 2.0. Come help us build the identity and authorization
        layer for AI agents.
      </p>

      <div className="mt-12 grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-2 [&>*]:bg-background">
        {CARDS.map((c) => (
          <a
            key={c.title}
            href={c.href}
            className="group flex items-start justify-between gap-6 p-6 transition hover:bg-surface"
          >
            <div>
              <h3 className="text-base font-semibold tracking-tight">{c.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{c.desc}</p>
            </div>
            <span className="shrink-0 font-mono text-xs text-muted-foreground group-hover:text-foreground">
              {c.stat}
            </span>
          </a>
        ))}
      </div>

      <div className="mt-16 rounded-lg border border-border bg-surface p-6 md:p-10">
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">Community guidelines</h2>
        <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
          <li>· Be kind. Assume good intent.</li>
          <li>· Search before asking, chances are someone hit the same bug.</li>
          <li>· Share minimal reproductions when reporting issues.</li>
          <li>· Credit contributors. Caracal wouldn't exist without them.</li>
        </ul>
      </div>
    </div>
  );
}
