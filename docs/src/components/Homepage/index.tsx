import React, { FormEvent, useState } from "react";
import Link from "@docusaurus/Link";
import useBaseUrl from "@docusaurus/useBaseUrl";
import type { DocCard } from "@site/src/components/types";

const primaryCards: DocCard[] = [
  {
    title: "Getting Started",
    description: "Install the runtime, understand the host/container split, and reach first success quickly.",
    to: "/open-source/end-users/getting-started/installation",
    tag: "Start",
  },
  {
    title: "Open Source",
    description: "Choose the right public lane: runtime operators or contributors.",
    to: "/open-source/overview",
    tag: "Navigate",
  },
  {
    title: "Enterprise",
    description: "Open the enterprise user-facing docs without crossing into internals.",
    to: "/enterprise/overview",
    tag: "Navigate",
  },
  {
    title: "CLI",
    description: "Navigate the orchestration commands, workspace model, and in-container command groups.",
    to: "/open-source/end-users/cli",
    tag: "Operate",
  },
  {
    title: "TUI",
    description: "Learn the Textual flows, onboarding sequence, and screen-level operator paths.",
    to: "/open-source/end-users/tui",
    tag: "Operate",
  },
  {
    title: "API / Reference",
    description: "Reach the command map, environment variables, SDK surfaces, and enterprise-safe references.",
    to: "/reference",
    tag: "Reference",
  },
];

const secondaryCards: DocCard[] = [
  {
    title: "Development",
    description: "Set up the repo, run tests, and contribute with confidence.",
    to: "/build",
    tag: "Build",
  },
  {
    title: "Security",
    description: "Find runtime boundaries, encrypted config, and reporting paths.",
    to: "/open-source/end-users/security",
    tag: "Security",
  },
  {
    title: "Troubleshooting",
    description: "Jump straight to runtime, connectivity, database, and support issues.",
    to: "/open-source/end-users/troubleshooting",
    tag: "Support",
  },
  {
    title: "Architecture",
    description: "See the system map across runtime, services, SDKs, and contributor modules.",
    to: "/open-source/developers/architecture",
    tag: "Architecture",
  },
];

function HomepageCard({ title, description, to, tag }: DocCard): React.ReactElement {
  return (
    <Link className="caracal-card" to={to}>
      <span className="caracal-card__tag">{tag}</span>
      <h3 className="caracal-card__title">{title}</h3>
      <p className="caracal-card__description">{description}</p>
    </Link>
  );
}

export default function Homepage(): React.ReactElement {
  const [query, setQuery] = useState("");
  const searchBaseUrl = useBaseUrl("/search");
  const searchUrl = useBaseUrl(`/search?q=${encodeURIComponent(query.trim())}`);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    window.location.assign(query.trim() ? searchUrl : searchBaseUrl);
  };

  return (
    <div className="caracal-homepage">
      <header className="caracal-homepage__header">
        <div className="caracal-homepage__eyebrow">Caracal Documentation</div>
        <h1 className="caracal-homepage__title">Authority docs without the maze.</h1>
        <p className="caracal-homepage__lede">Search first. Choose the right lane. Move with confidence.</p>
        <form className="caracal-homepage__search" onSubmit={onSubmit}>
          <input
            aria-label="Search Caracal documentation"
            autoComplete="off"
            name="q"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search commands, runtime flows, security topics, or contributor guides"
            type="search"
            value={query}
          />
          <button type="submit">Search</button>
        </form>
      </header>

      <section>
        <h2 className="caracal-section__heading">Major sections</h2>
        <div className="caracal-grid">
          {primaryCards.map((card) => (
            <HomepageCard key={card.title} {...card} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="caracal-section__heading">Supporting sections</h2>
        <div className="caracal-grid caracal-grid--secondary">
          {secondaryCards.map((card) => (
            <HomepageCard key={card.title} {...card} />
          ))}
        </div>
      </section>
    </div>
  );
}
