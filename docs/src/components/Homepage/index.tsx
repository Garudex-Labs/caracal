import React, { type ReactElement } from "react";
import Link from "@docusaurus/Link";

type ProductCard = {
  title: string;
  description: string;
  meta: string;
  to: string;
};

type LinkCard = {
  title: string;
  description: string;
  to: string;
  meta: string;
};

const products: ProductCard[] = [
  {
    title: "Authority",
    description: "Evaluate policy, mandate, delegation, and principal state before any protected action runs.",
    meta: "Policies, mandates, principals",
    to: "/open-source/end-users/concepts/authority-enforcement-model",
  },
  {
    title: "Ledger",
    description: "Record signed authority decisions and supporting state in an append-only verification trail.",
    meta: "Audit trail, verification, replay",
    to: "/open-source/end-users/concepts/ledger",
  },
  {
    title: "Flow",
    description: "Operate the runtime through the constrained terminal interface and inspect authority workflows safely.",
    meta: "Runtime console, workflows, inspection",
    to: "/open-source/end-users/tui/common-tasks",
  },
  {
    title: "Hard-cut",
    description: "Enforce fail-closed runtime preflight checks for storage, signing, secrets, and isolation boundaries.",
    meta: "Vault, PostgreSQL, fail-closed preflight",
    to: "/open-source/end-users/security/fail-closed-semantics",
  },
];

const guides: LinkCard[] = [
  {
    title: "Quickstart",
    description: "Bring up the runtime, validate services, and confirm the host command surface.",
    to: "/open-source/end-users/getting-started/quickstart",
    meta: "Start here",
  },
  {
    title: "Concepts",
    description: "Read the core terms that define how authority enforcement works in Caracal.",
    to: "/open-source/end-users/concepts",
    meta: "Model",
  },
  {
    title: "CLI",
    description: "Inspect host orchestration commands and in-container operational references.",
    to: "/open-source/end-users/cli",
    meta: "Operate",
  },
  {
    title: "Security",
    description: "Review fail-closed behavior, threat assumptions, and key management material.",
    to: "/open-source/end-users/security/threat-model",
    meta: "Verify",
  },
];

const libraries: LinkCard[] = [
  {
    title: "Python SDK",
    description: "Integrate Caracal into Python agents and services.",
    to: "/open-source/sdk/python/usage",
    meta: "Python",
  },
  {
    title: "Node SDK",
    description: "Use Caracal from TypeScript and Node runtimes.",
    to: "/open-source/sdk/node/usage",
    meta: "TypeScript",
  },
  {
    title: "Configuration",
    description: "Runtime settings for storage, secrets, logging, MCP, and service behavior.",
    to: "/open-source/end-users/configuration",
    meta: "Runtime",
  },
  {
    title: "Architecture",
    description: "Read the runtime model, core authority system, and service boundaries.",
    to: "/open-source/developers/architecture",
    meta: "Internals",
  },
  {
    title: "Enterprise",
    description: "Deployment, access, administration, and monitoring for larger environments.",
    to: "/enterprise/overview",
    meta: "Deploy",
  },
  {
    title: "AI Docs",
    description: "Machine-oriented mirror for retrieval, planning, and tooling.",
    to: "/ai",
    meta: "Text mode",
  },
];

export default function Homepage(): ReactElement {
  return (
    <div className="caracal-home">
      <section className="caracal-home__hero">
        <div className="caracal-home__hero-copy">
          <div className="caracal-home__hero-brand" id="caracal-home-brand">
            <div className="caracal-home__hero-text">
              <h1 className="caracal-home__hero-title">Caracal Documentation</h1>
              <p className="caracal-home__hero-description">
                Learn how to deploy, operate, integrate, and verify Caracal through runtime guides, SDK references,
                security material, and machine-readable docs.
              </p>
              <div className="caracal-home__hero-actions">
                <Link className="caracal-home__hero-action" to="/open-source/end-users/getting-started/quickstart">
                  Open quickstart
                </Link>
                <Link className="caracal-home__hero-action" to="/open-source/overview">
                  Read overview
                </Link>
              </div>
            </div>
          </div>
        </div>

        <aside className="caracal-home__starter-card">
          <h2 className="caracal-home__starter-title">Featured Video</h2>
          <div className="caracal-home__featured-video">
            <iframe
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              loading="lazy"
              referrerPolicy="strict-origin-when-cross-origin"
              src="https://www.youtube.com/embed/tZ4FdO-zjeE"
              title="Caracal featured video"
            />
          </div>
        </aside>
      </section>

      <section className="caracal-home__block">
        <div className="caracal-home__block-head">
          <h2>Products</h2>
        </div>
        <div className="caracal-home__product-grid">
          {products.map((product) => (
            <Link key={product.title} className="caracal-home__product-card" to={product.to}>
              <div>
                <div className="caracal-home__product-title">{product.title}</div>
                <div className="caracal-home__product-meta">{product.meta}</div>
                <p className="caracal-home__product-description">{product.description}</p>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="caracal-home__block caracal-home__block--split">
        <div className="caracal-home__block-head">
          <h2>Core Guides</h2>
        </div>
        <div className="caracal-home__compact-grid">
          {guides.map((guide) => (
            <Link key={guide.title} className="caracal-home__compact-link" to={guide.to}>
              <span className="caracal-home__compact-copy">
                <span className="caracal-home__compact-meta">{guide.meta}</span>
                <span className="caracal-home__compact-title">{guide.title}</span>
                <span className="caracal-home__compact-description">{guide.description}</span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="caracal-home__block caracal-home__block--split caracal-home__block--bordered">
        <div className="caracal-home__block-head">
          <h2>Client Libraries</h2>
        </div>
        <div className="caracal-home__compact-grid">
          {libraries.map((library) => (
            <Link key={library.title} className="caracal-home__compact-link" to={library.to}>
              <span className="caracal-home__compact-copy">
                <span className="caracal-home__compact-meta">{library.meta}</span>
                <span className="caracal-home__compact-title">{library.title}</span>
                <span className="caracal-home__compact-description">{library.description}</span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="caracal-home__footer-row">
        <Link className="caracal-home__footer-card" to="/open-source/developers/architecture">
          <span className="caracal-home__footer-label">Architecture</span>
          <span className="caracal-home__footer-text">Read the runtime, service, and authority system structure.</span>
        </Link>
        <Link className="caracal-home__footer-card" to="/open-source/end-users/security">
          <span className="caracal-home__footer-label">Security</span>
          <span className="caracal-home__footer-text">Inspect fail-closed behavior, key management, and threat assumptions.</span>
        </Link>
        <Link className="caracal-home__footer-card" to="/enterprise/overview">
          <span className="caracal-home__footer-label">Enterprise</span>
          <span className="caracal-home__footer-text">Configure access, deployment, and monitoring for larger environments.</span>
        </Link>
      </section>
    </div>
  );
}
