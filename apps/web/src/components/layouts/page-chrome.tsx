// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Pages publish their title/breadcrumbs here; the top bar renders them next
// to the global search, so pages don't need a dedicated title bar.

import { createContext, useCallback, useContext, useMemo, useState } from "react";

export interface BreadcrumbEntry {
	label: string;
	href?: string;
}

export interface PageChrome {
	title?: string;
	breadcrumbs?: BreadcrumbEntry[];
	/** PAGE_DOCS key; when set, the top bar shows a contextual help trigger. */
	helpKey?: string;
}

interface PageChromeContextValue {
	chrome: PageChrome;
	setChrome: (chrome: PageChrome, owner: symbol) => void;
	clearChrome: (owner: symbol) => void;
}

const PageChromeContext = createContext<PageChromeContextValue | null>(null);

export function PageChromeProvider({ children }: { children: React.ReactNode }) {
	const [state, setState] = useState<{ data: PageChrome; owner: symbol | null }>({
		data: {},
		owner: null,
	});

	const setChrome = useCallback((data: PageChrome, owner: symbol) => {
		setState({ data, owner });
	}, []);

	// Owner check keeps an unmounting page from clobbering the next page's title.
	const clearChrome = useCallback((owner: symbol) => {
		setState((cur) => (cur.owner === owner ? { data: {}, owner: null } : cur));
	}, []);

	const value = useMemo(
		() => ({ chrome: state.data, setChrome, clearChrome }),
		[state.data, setChrome, clearChrome],
	);

	return <PageChromeContext.Provider value={value}>{children}</PageChromeContext.Provider>;
}

export function usePageChrome(): PageChromeContextValue {
	const ctx = useContext(PageChromeContext);
	if (!ctx) throw new Error("usePageChrome must be used within PageChromeProvider");
	return ctx;
}
