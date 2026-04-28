import React, { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useHistory } from "@docusaurus/router";
import useBaseUrl from "@docusaurus/useBaseUrl";
import {
  getDocResults,
  getNavigationResults,
  getQuickActions,
  loadSearchDocs,
  navigate,
} from "@site/src/components/Search/searchData";
import type { NavigationAction, SearchDocEntry } from "@site/src/components/Search/types";

type ResultSectionProps = {
  title: string;
  children: React.ReactNode;
};

function ResultSection({ title, children }: ResultSectionProps): React.ReactElement {
  return (
    <section className="caracal-search__section">
      <div className="caracal-search__section-title">{title}</div>
      <div className="caracal-search__section-body">{children}</div>
    </section>
  );
}

function NavigationResult({
  action,
  onSelect,
}: {
  action: NavigationAction;
  onSelect: (to: string) => void;
}): React.ReactElement {
  return (
    <button className="caracal-search__result" onClick={() => onSelect(action.to)} type="button">
      <div className="caracal-search__result-main">
        <span className="caracal-search__result-title">{action.title}</span>
        <span className="caracal-search__result-description">{action.description}</span>
      </div>
      <span className="caracal-search__result-kind">Navigation</span>
    </button>
  );
}

function DocResult({
  doc,
  onSelect,
}: {
  doc: SearchDocEntry;
  onSelect: (to: string) => void;
}): React.ReactElement {
  const kindLabel =
    doc.type === "page" ? "Page" : doc.type === "heading" ? "Heading" : "Section";

  return (
    <button className="caracal-search__result" onClick={() => onSelect(doc.url)} type="button">
      <div className="caracal-search__result-main">
        <span className="caracal-search__result-title">{doc.title}</span>
        <span className="caracal-search__result-description">{doc.description}</span>
      </div>
      <span className="caracal-search__result-kind">{kindLabel}</span>
    </button>
  );
}

export default function SearchBar(): React.ReactElement {
  const history = useHistory();
  const baseUrl = useBaseUrl("/");
  const searchPageUrl = useBaseUrl("/search");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [docs, setDocs] = useState<SearchDocEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open || docs.length > 0 || loading) {
      return;
    }

    setLoading(true);
    loadSearchDocs(baseUrl)
      .then(setDocs)
      .finally(() => setLoading(false));
  }, [baseUrl, docs.length, loading, open]);

  const inputRef = React.useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      document.body.classList.remove("caracal-search-open");
      return;
    }

    document.body.classList.add("caracal-search-open");
    return () => document.body.classList.remove("caracal-search-open");
  }, [open]);

  const navigationResults = useMemo(() => getNavigationResults(query), [query]);
  const docResults = useMemo(() => getDocResults(docs, query), [docs, query]);
  const quickActions = useMemo(() => getQuickActions(), []);

  const openSearchPage = () => {
    const next = query.trim() ? `${searchPageUrl}?q=${encodeURIComponent(query.trim())}` : searchPageUrl;
    setOpen(false);
    navigate(history, next);
  };

  const onSelect = (to: string) => {
    setOpen(false);
    navigate(history, to);
  };

  return (
    <>
      <button className="caracal-search-trigger" onClick={() => setOpen(true)} type="button">
          <span className="caracal-search-trigger__icon" aria-hidden="true">
            /
          </span>
        <span className="caracal-search-trigger__text">Search documentation</span>
        <span className="caracal-search-trigger__hint">Ctrl K</span>
      </button>

      {open ? (
        <div aria-modal="true" className="caracal-search" role="dialog">
          <button
            aria-label="Close search"
            className="caracal-search__backdrop"
            onClick={() => setOpen(false)}
            type="button"
          />
          <div className="caracal-search__dialog">
            <div className="caracal-search__header">
              <input
                ref={inputRef}
                className="caracal-search__input"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search docs, commands, workflows, and navigation"
                type="search"
                value={query}
              />
              <button className="caracal-search__open-page" onClick={openSearchPage} type="button">
                View all results
              </button>
            </div>

            <div className="caracal-search__body">
              {!query.trim() ? (
                <div className="caracal-search__empty-state">
                  <ResultSection title="Quick Actions">
                    {quickActions.map((action) => (
                      <NavigationResult action={action} key={action.title} onSelect={onSelect} />
                    ))}
                  </ResultSection>
                  <ResultSection title="Popular Pages">
                    {docResults.slice(0, 5).map((doc) => (
                      <DocResult doc={doc} key={`${doc.url}-${doc.title}`} onSelect={onSelect} />
                    ))}
                  </ResultSection>
                </div>
              ) : (
                <div className="caracal-search__results">
                  <ResultSection title="Navigation">
                    {navigationResults.length > 0 ? (
                      navigationResults.map((action) => (
                        <NavigationResult action={action} key={action.title} onSelect={onSelect} />
                      ))
                    ) : (
                      <div className="caracal-search__status">No navigation matches.</div>
                    )}
                  </ResultSection>
                  <ResultSection title="Docs">
                    {loading ? (
                      <div className="caracal-search__status">Loading index…</div>
                    ) : docResults.length > 0 ? (
                      docResults.map((doc) => (
                        <DocResult doc={doc} key={`${doc.url}-${doc.title}`} onSelect={onSelect} />
                      ))
                    ) : (
                      <div className="caracal-search__status">No documentation matches.</div>
                    )}
                  </ResultSection>
                </div>
              )}
            </div>

            <div className="caracal-search__footer">
              <span>Search pages, headings, sections, and navigation from the keyboard.</span>
              <span className={clsx("caracal-search__footer-key")}>Esc</span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
