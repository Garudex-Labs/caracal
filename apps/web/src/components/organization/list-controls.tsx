// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Shared controls for the server-paginated organization listings: a debounce
// for search input (bounded request rate) and the offset pagination footer.

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export function useDebouncedValue<T>(value: T, delayMs = 300): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const handle = window.setTimeout(() => setDebounced(value), delayMs);
		return () => window.clearTimeout(handle);
	}, [value, delayMs]);
	return debounced;
}

export function ListPaginationFooter({
	page,
	pageSize,
	total,
	label,
	onPageChange,
}: {
	page: number;
	pageSize: number;
	total: number;
	label: string;
	onPageChange: (page: number) => void;
}) {
	const pages = Math.max(1, Math.ceil(total / pageSize));
	const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
	const last = Math.min(total, page * pageSize);
	return (
		<div className="flex items-center justify-between text-xs text-muted-foreground">
			<span>
				{first}–{last} of {total} {label}
			</span>
			<div className="flex items-center gap-2">
				<span>
					Page {page} of {pages}
				</span>
				<Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
					<ChevronLeft className="mr-1 h-3.5 w-3.5" />
					Previous
				</Button>
				<Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPageChange(page + 1)}>
					Next
					<ChevronRight className="ml-1 h-3.5 w-3.5" />
				</Button>
			</div>
		</div>
	);
}
