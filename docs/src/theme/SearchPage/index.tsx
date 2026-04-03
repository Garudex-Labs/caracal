import React, { useEffect, useMemo, useState } from "react";
import Layout from "@theme/Layout";
import { useHistory, useLocation } from "@docusaurus/router";
import useBaseUrl from "@docusaurus/useBaseUrl";
import {
  getDocResults,
  getNavigationResults,
  loadSearchDocs,
  navigate,
  type NavigationAction,
  type SearchDocEntry,
} from "@site/src/components/Search/searchData";

function ResultCard({
  title,
  description,
  kind,
  onClick,
}: {
  title: string;
  description: string;
  kind: string;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button className="caracal-search-page__result" onClick={onClick} type="button">
      <div>
        <div className="caracal-search-page__result-title">{title}</div>
        <div className="caracal-search-page__result-description">{description}</div>
      </div>
      <div className="caracal-search-page__result-kind">{kind}</div>
    </button>
  );
}

export default function SearchPage(): React.ReactElement {
  const history = useHistory();
  const location = useLocation();
  const baseUrl = useBaseUrl("/");
  const params = new URLSearchParams(location.search);
  const initialQuery = params.get("q") ?? "";
  const [query, setQuery] = useState(initialQuery);
  const [docs, setDocs] = useState<SearchDocEntry[]>([]);

  useEffect(() => {
    loadSearchDocs(baseUrl).then(setDocs);
  }, [baseUrl]);

  const navigationResults = useMemo(() => getNavigationResults(query, 8), [query]);
  const docResults = useMemo(() => getDocResults(docs, query, 24), [docs, query]);

  useEffect(() => {
    const next = new URLSearchParams(location.search);
    if (query.trim()) {
      next.set("q", query.trim());
    } else {
      next.delete("q");
    }
    const nextSearch = next.toString();
    const nextUrl = nextSearch ? `${location.pathname}?${nextSearch}` : location.pathname;
    const currentUrl = location.search ? `${location.pathname}${location.search}` : location.pathname;
    if (nextUrl !== currentUrl) {
      history.replace(nextUrl);
    }
  }, [history, location.pathname, location.search, query]);

  const onNavigation = (item: NavigationAction) => navigate(history, item.to);
  const onDoc = (item: SearchDocEntry) => navigate(history, item.url);
  const kindLabel = (item: SearchDocEntry) =>
    item.type === "page" ? "Page" : item.type === "heading" ? "Heading" : "Section";

  return (
    <Layout title={query ? `Search: ${query}` : "Search"} description="Search Caracal documentation">
      <main className="container caracal-search-page">
        <section className="caracal-search-page__hero">
          <span className="caracal-search-page__eyebrow">Search</span>
          <h1 className="caracal-search-page__title">Search Caracal docs</h1>
          <p className="caracal-search-page__summary">Grouped results for navigation shortcuts plus documentation pages, headings, and section hits.</p>
          <input
            autoFocus
            className="caracal-search-page__input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search commands, concepts, architecture, and support topics"
            type="search"
            value={query}
          />
        </section>

        <div className="caracal-search-page__grid">
          <section className="caracal-search-page__column">
            <div className="caracal-search-page__section-title">Navigation</div>
            {navigationResults.length > 0 ? (
              navigationResults.map((item) => (
                <ResultCard
                  description={item.description}
                  key={item.title}
                  kind="Navigation"
                  onClick={() => onNavigation(item)}
                  title={item.title}
                />
              ))
            ) : (
              <div className="caracal-search-page__status">No navigation matches.</div>
            )}
          </section>

          <section className="caracal-search-page__column">
            <div className="caracal-search-page__section-title">Docs</div>
            {docResults.length > 0 ? (
              docResults.map((item) => (
                <ResultCard
                  description={item.description}
                  key={`${item.url}-${item.title}`}
                  kind={kindLabel(item)}
                  onClick={() => onDoc(item)}
                  title={item.title}
                />
              ))
            ) : (
              <div className="caracal-search-page__status">No documentation matches.</div>
            )}
          </section>
        </div>
      </main>
    </Layout>
  );
}
