import React from "react";
import Link from "@docusaurus/Link";

type RelatedLink = {
  label: string;
  to: string;
};

type DocPlaceholderProps = {
  summary: string;
  audience: string;
  prerequisites?: string[];
  plannedSections?: string[];
  related?: RelatedLink[];
};

export default function DocPlaceholder({
  summary,
  audience,
  prerequisites = [],
  plannedSections = [],
  related = [],
}: DocPlaceholderProps): React.ReactElement {
  return (
    <div className="caracal-placeholder">
      <div className="caracal-placeholder__notice">
        Structure is locked for this page. Full documentation content is intentionally deferred until approval.
      </div>

      <p className="caracal-placeholder__summary">{summary}</p>

      <div className="caracal-placeholder__grid">
        <section className="caracal-placeholder__panel">
          <h2>Audience</h2>
          <p>{audience}</p>
        </section>

        <section className="caracal-placeholder__panel">
          <h2>Prerequisites</h2>
          {prerequisites.length > 0 ? (
            <ul className="caracal-placeholder__list">
              {prerequisites.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p>None defined yet.</p>
          )}
        </section>

        <section className="caracal-placeholder__panel">
          <h2>Quick Start / Overview</h2>
          <p>This section will open with the shortest successful path for the intended audience.</p>
        </section>

        <section className="caracal-placeholder__panel">
          <h2>Core Explanation</h2>
          {plannedSections.length > 0 ? (
            <ul className="caracal-placeholder__list">
              {plannedSections.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p>Detailed topics will be added in the content phase.</p>
          )}
        </section>

        <section className="caracal-placeholder__panel">
          <h2>Examples</h2>
          <p>Copy-pastable examples will be added only after the structure and writing standards are approved.</p>
        </section>

        <section className="caracal-placeholder__panel">
          <h2>Edge Cases</h2>
          <p>Failure modes, limits, and surprising behaviors will be captured here during the content phase.</p>
        </section>

        <section className="caracal-placeholder__panel">
          <h2>Troubleshooting</h2>
          <p>Diagnostic checks, expected outputs, and escalation paths will be added here.</p>
        </section>

        <section className="caracal-placeholder__panel">
          <h2>Related Pages</h2>
          {related.length > 0 ? (
            <ul className="caracal-placeholder__list">
              {related.map((item) => (
                <li key={item.to}>
                  <Link to={item.to}>{item.label}</Link>
                </li>
              ))}
            </ul>
          ) : (
            <p>Cross-links will be added with the page content.</p>
          )}
        </section>
      </div>
    </div>
  );
}
