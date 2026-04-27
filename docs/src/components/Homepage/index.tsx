import React, { FormEvent, useState, type ReactElement } from "react";
import Link from "@docusaurus/Link";
import useBaseUrl from "@docusaurus/useBaseUrl";

type Feature = {
  title: string;
  description: string;
  glyph: string;
};

type PathCard = {
  eyebrow: string;
  title: string;
  description: string;
  to: string;
  cta: string;
};

type ResourceLink = {
  title: string;
  to: string;
  description: string;
};

const features: Feature[] = [
  {
    title: "Pre-execution authority",
    description: "No action runs without a verified, time-bound mandate issued under a governing policy.",
    glyph: "→",
  },
  {
    title: "Cryptographic mandates",
    description: "Asymmetric session signing, deterministic verification, and append-only audit trails.",
    glyph: "✓",
  },
  {
    title: "Runtime isolation",
    description: "Host orchestrator and restricted in-container CLI keep agent context separated by design.",
    glyph: "□",
  },
  {
    title: "Built for agents",
    description: "First-class Python and Node SDKs, MCP adapter, and a documentation mirror for machines.",
    glyph: "◇",
  },
];

const paths: PathCard[] = [
  {
    eyebrow: "Operate",
    title: "End Users",
    description: "Install the runtime, register principals, and run workflows on your host.",
    to: "/open-source/end-users/getting-started/installation",
    cta: "Start operating",
  },
  {
    eyebrow: "Integrate",
    title: "SDK Developers",
    description: "Wire Caracal into agents and tools through the Python or Node SDK.",
    to: "/open-source/sdk/overview",
    cta: "Open the SDK",
  },
  {
    eyebrow: "Build",
    title: "Contributors",
    description: "Read the architecture, set up the repo, and contribute to the core.",
    to: "/open-source/developers/architecture",
    cta: "Read the internals",
  },
  {
    eyebrow: "Deploy",
    title: "Enterprise",
    description: "Configure access, deploy at scale, and monitor authority across teams.",
    to: "/enterprise/overview",
    cta: "View Enterprise",
  },
];

const resources: ResourceLink[] = [
  {
    title: "Concepts",
    to: "/open-source/end-users/concepts",
    description: "Principal, policy, mandate, ledger, and the rest of the model.",
  },
  {
    title: "CLI Reference",
    to: "/open-source/end-users/cli",
    description: "Host orchestrator and in-container command groups.",
  },
  {
    title: "Security",
    to: "/open-source/end-users/security",
    description: "Threat model, fail-closed semantics, and key management.",
  },
  {
    title: "AI Docs",
    to: "/ai",
    description: "Machine-readable mirror with a fixed schema for tooling and agents.",
  },
];

export default function Homepage(): ReactElement {
  const [query, setQuery] = useState("");
  const searchBaseUrl = useBaseUrl("/search");
  const searchUrl = useBaseUrl(`/search?q=${encodeURIComponent(query.trim())}`);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    window.location.assign(query.trim() ? searchUrl : searchBaseUrl);
  };

  return (
    <div className="caracal-home">
      <section className="caracal-home__hero">
        <div className="caracal-home__hero-glow" aria-hidden="true" />
        <div className="caracal-home__hero-inner">
          <div className="caracal-home__eyebrow">
            <span className="caracal-home__eyebrow-dot" aria-hidden="true" />
            v1.0 documentation
          </div>
          <h1 className="caracal-home__title">
            Authority enforcement for <span className="caracal-home__title-accent">AI agents</span>.
          </h1>
          <p className="caracal-home__lede">
            Caracal is a pre-execution authority layer. No action runs without a cryptographically verified,
            time-bound mandate issued under a governing policy.
          </p>
          <div className="caracal-home__cta-row">
            <Link
              className="caracal-home__cta caracal-home__cta--primary"
              to="/open-source/end-users/getting-started/quickstart"
            >
              Quickstart
            </Link>
            <Link className="caracal-home__cta caracal-home__cta--ghost" to="/open-source/overview">
              What is Caracal
            </Link>
            <a
              className="caracal-home__cta caracal-home__cta--ghost"
              href="https://github.com/Garudex-Labs/caracal"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
          </div>
          <form className="caracal-home__search" onSubmit={onSubmit}>
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
          <div className="caracal-home__install">
            <div className="caracal-home__install-label">Install</div>
            <pre className="caracal-home__install-code">
              <code>
                <span className="caracal-home__install-prompt">$</span> pip install caracal-core
                {"\n"}
                <span className="caracal-home__install-prompt">$</span> caracal up
              </code>
            </pre>
          </div>
        </div>
      </section>

      <section className="caracal-home__section">
        <div className="caracal-home__section-head">
          <span className="caracal-home__kicker">Why Caracal</span>
          <h2 className="caracal-home__section-title">Authority, verifiable before execution.</h2>
        </div>
        <div className="caracal-home__features">
          {features.map((feature) => (
            <article key={feature.title} className="caracal-feature">
              <div className="caracal-feature__glyph" aria-hidden="true">
                {feature.glyph}
              </div>
              <h3 className="caracal-feature__title">{feature.title}</h3>
              <p className="caracal-feature__description">{feature.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="caracal-home__section">
        <div className="caracal-home__section-head">
          <span className="caracal-home__kicker">Pick your path</span>
          <h2 className="caracal-home__section-title">Documentation, organized by what you do.</h2>
        </div>
        <div className="caracal-home__paths">
          {paths.map((path) => (
            <Link key={path.title} className="caracal-path" to={path.to}>
              <div className="caracal-path__eyebrow">{path.eyebrow}</div>
              <h3 className="caracal-path__title">{path.title}</h3>
              <p className="caracal-path__description">{path.description}</p>
              <div className="caracal-path__cta">{path.cta} →</div>
            </Link>
          ))}
        </div>
      </section>

      <section className="caracal-home__section">
        <div className="caracal-home__section-head">
          <span className="caracal-home__kicker">Reference</span>
          <h2 className="caracal-home__section-title">Jump to what you came for.</h2>
        </div>
        <div className="caracal-home__resources">
          {resources.map((resource) => (
            <Link key={resource.title} className="caracal-resource" to={resource.to}>
              <div className="caracal-resource__title">
                {resource.title}
                <span className="caracal-resource__arrow" aria-hidden="true">
                  →
                </span>
              </div>
              <p className="caracal-resource__description">{resource.description}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
