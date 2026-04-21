import React from "react";
import Link from "@docusaurus/Link";
import type { DocCard } from "@site/src/components/types";

type HubPageProps = {
  eyebrow: string;
  title: string;
  summary: string;
  cards: DocCard[];
};

export default function HubPage({ eyebrow, title, summary, cards }: HubPageProps): React.ReactElement {
  return (
    <div className="caracal-hub">
      <header className="caracal-hub__header">
        <div className="caracal-hub__eyebrow">{eyebrow}</div>
        <h1 className="caracal-hub__title">{title}</h1>
        <p className="caracal-hub__summary">{summary}</p>
      </header>
      <section>
        <h2 className="caracal-hub__section-heading">Explore this hub</h2>
        <div className="caracal-grid caracal-grid--hub">
          {cards.map((card) => (
            <Link className="caracal-card" key={card.title} to={card.to}>
              <span className="caracal-card__tag">{card.tag}</span>
              <h2 className="caracal-card__title">{card.title}</h2>
              <p className="caracal-card__description">{card.description}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
