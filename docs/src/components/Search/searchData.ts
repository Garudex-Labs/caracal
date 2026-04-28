import { searchIndexUrl } from "@generated/@easyops-cn/docusaurus-search-local/default/generated-constants";
import type { NavigationAction, SearchDocEntry } from "./types";

export type { NavigationAction, SearchDocEntry } from "./types";

const navigationActions: NavigationAction[] = [
  {
    title: "Go to Open Source",
    description: "Browse the public runtime docs split into end users and developers.",
    to: "/open-source/overview",
    keywords: ["open source", "oss", "users", "developers"],
    type: "navigation",
  },
  {
    title: "Go to CLI",
    description: "Jump into the host and in-container command model.",
    to: "/open-source/end-users/cli",
    keywords: ["cli", "commands", "shell"],
    type: "navigation",
  },
  {
    title: "Go to Enterprise",
    description: "Open the enterprise user-facing documentation lane.",
    to: "/enterprise/overview",
    keywords: ["enterprise", "admin", "managed"],
    type: "navigation",
  },
  {
    title: "Go to Build",
    description: "Contributor setup, architecture, testing, and releases.",
    to: "/build",
    keywords: ["build", "development", "testing", "releases"],
    type: "navigation",
  },
  {
    title: "Go to Manage",
    description: "Operational hub for runtime management and configuration.",
    to: "/manage",
    keywords: ["manage", "operations", "workspaces", "configuration"],
    type: "navigation",
  },
  {
    title: "Go to Reference",
    description: "Reach command maps, concepts, and reference surfaces.",
    to: "/reference",
    keywords: ["reference", "api", "commands", "concepts"],
    type: "navigation",
  },
];

let searchDocsPromise: Promise<SearchDocEntry[]> | null = null;

type RawSearchDocument = {
  i?: number;
  t?: string;
  u?: string;
  b?: string[];
  s?: string;
  h?: string;
  p?: number;
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function formatBreadcrumbs(breadcrumbs: string[]): string {
  return breadcrumbs.join(" / ");
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

function summarize(text: string, limit = 140): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }

  if (compact.length <= limit) {
    return compact;
  }

  return `${compact.slice(0, limit - 1).trimEnd()}…`;
}

function buildDescription(entry: SearchDocEntry): string {
  if (entry.type === "page") {
    return formatBreadcrumbs(entry.breadcrumbs) || "Documentation";
  }

  const location = dedupeStrings([formatBreadcrumbs(entry.breadcrumbs), entry.parentTitle]).join(" / ");
  if (entry.type === "heading") {
    return location || "Documentation";
  }

  return dedupeStrings([location, entry.description]).join(" • ");
}

function includesAllTerms(haystack: string, query: string): boolean {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  return terms.every((term) => haystack.includes(term));
}

function scoreMatch(parts: string[], query: string): number {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return 0;
  }

  const title = normalize(parts[0] ?? "");
  const haystack = normalize(parts.join(" "));
  let score = 0;

  if (title === normalizedQuery) {
    score += 120;
  }
  if (title.startsWith(normalizedQuery)) {
    score += 72;
  }
  if (title.includes(normalizedQuery)) {
    score += 48;
  }
  if (haystack.includes(normalizedQuery)) {
    score += 20;
  }

  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  score += terms.filter((term) => title.includes(term)).length * 12;
  score += terms.filter((term) => haystack.includes(term)).length * 4;

  return score;
}

function rankMatches<T>(
  entries: T[],
  query: string,
  limit: number,
  resolveParts: (entry: T) => string[],
): T[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return entries.slice(0, limit);
  }

  return entries
    .map((entry) => {
      const parts = resolveParts(entry);
      return {
        entry,
        score: scoreMatch(parts, normalizedQuery),
        matches: includesAllTerms(parts.join(" ").toLowerCase(), normalizedQuery),
      };
    })
    .filter((entry) => entry.matches)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.entry);
}

export async function loadSearchDocs(baseUrl: string): Promise<SearchDocEntry[]> {
  if (!searchDocsPromise) {
    const resolvedSearchIndexUrl = `${baseUrl}${searchIndexUrl.replace("{dir}", "").replace(/^\//, "")}`;

    searchDocsPromise = fetch(resolvedSearchIndexUrl)
      .then((response) => response.json())
      .then((payload: Array<{ documents?: RawSearchDocument[] }>) => {
        const rawDocuments = payload.flatMap((group) => group.documents ?? []);
        const pageEntries = new Map<number, SearchDocEntry>();
        const searchEntries = new Map<string, SearchDocEntry>();

        rawDocuments.forEach((entry) => {
          const id = typeof entry.i === "number" ? entry.i : null;
          const title = typeof entry.t === "string" ? entry.t : null;
          const url = typeof entry.u === "string" ? entry.u : null;
          const breadcrumbs = Array.isArray(entry.b)
            ? entry.b.filter((item): item is string => typeof item === "string")
            : [];

          if (id === null || !title || !url || "p" in entry || "h" in entry) {
            return;
          }

          pageEntries.set(id, {
            title,
            url,
            breadcrumbs,
            description: formatBreadcrumbs(breadcrumbs) || "Documentation",
            searchText: [title, ...breadcrumbs, url].join(" "),
            type: "page",
          });
        });

        rawDocuments.forEach((entry) => {
          const url = typeof entry.u === "string" ? entry.u : null;
          const text = typeof entry.t === "string" ? entry.t : "";
          const parent =
            typeof entry.p === "number" ? pageEntries.get(entry.p) : undefined;
          const hash = typeof entry.h === "string" ? entry.h : "";

          if (!url) {
            return;
          }

          if (!hash) {
            if (parent && text) {
              parent.searchText = `${parent.searchText} ${text}`.trim();
              if (parent.description === "Documentation") {
                parent.description = summarize(text);
              }
            }
            return;
          }

          const resolvedUrl = `${url}${hash}`;
          const locationBreadcrumbs = parent?.breadcrumbs ?? [];
          const parentTitle = parent?.title;

          if (typeof entry.s === "string" && entry.s.trim()) {
            const sectionEntry: SearchDocEntry = {
              title: entry.s,
              url: resolvedUrl,
              breadcrumbs: locationBreadcrumbs,
              description: summarize(text),
              searchText: [entry.s, text, parentTitle, ...locationBreadcrumbs, resolvedUrl]
                .filter(Boolean)
                .join(" "),
              parentTitle,
              type: "section",
            };

            searchEntries.set(
              `${sectionEntry.type}::${sectionEntry.url}::${sectionEntry.title}`,
              sectionEntry,
            );
            return;
          }

          if (text.trim()) {
            const headingEntry: SearchDocEntry = {
              title: text,
              url: resolvedUrl,
              breadcrumbs: locationBreadcrumbs,
              description: parentTitle ? `In ${parentTitle}` : "Documentation",
              searchText: [text, parentTitle, ...locationBreadcrumbs, resolvedUrl]
                .filter(Boolean)
                .join(" "),
              parentTitle,
              type: "heading",
            };

            searchEntries.set(
              `${headingEntry.type}::${headingEntry.url}::${headingEntry.title}`,
              headingEntry,
            );
          }
        });

        pageEntries.forEach((entry) => {
          searchEntries.set(`${entry.type}::${entry.url}::${entry.title}`, entry);
        });

        return Array.from(searchEntries.values()).map((entry) => ({
          ...entry,
          description: buildDescription(entry),
        }));
      });
  }

  return searchDocsPromise;
}

export function getNavigationResults(query: string, limit = 6): NavigationAction[] {
  return rankMatches(navigationActions, query, limit, (item) => [
    item.title,
    item.description,
    ...item.keywords,
  ]);
}

export function getDocResults(docs: SearchDocEntry[], query: string, limit = 8): SearchDocEntry[] {
  return rankMatches(docs, query, limit, (doc) => [
    doc.title,
    doc.parentTitle ?? "",
    doc.description,
    ...doc.breadcrumbs,
    doc.searchText,
    doc.url,
  ]);
}

export function getQuickActions(): NavigationAction[] {
  return navigationActions.slice(0, 5);
}

export function navigate(history: { push: (to: string) => void }, to: string): void {
  history.push(to);
}
