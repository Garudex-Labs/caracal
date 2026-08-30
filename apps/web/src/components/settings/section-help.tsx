// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Help affordance for settings sections that have documentation mapped in
// docs-map.ts. Renders nothing when no doc exists for the given title/page.

import { HelpCircle } from "lucide-react";
import { useHelp } from "@/components/help/help-context";
import { PAGE_DOCS, SECTION_DOCS } from "@/lib/docs-map";

export function SectionHelpButton({ sectionTitle, pageKey }: { sectionTitle?: string; pageKey?: string }) {
	const { openHelp } = useHelp();
	const hasDoc = (sectionTitle && SECTION_DOCS[sectionTitle]) || (pageKey && PAGE_DOCS[pageKey]);
	if (!hasDoc) return null;
	return (
		<button
			type="button"
			className="text-muted-foreground transition-colors hover:text-primary"
			onClick={(event) => {
				event.preventDefault();
				event.stopPropagation();
				openHelp({ sectionTitle, pageKey });
			}}
			aria-label={`Open ${sectionTitle ?? pageKey} documentation`}
		>
			<HelpCircle className="h-3.5 w-3.5" />
		</button>
	);
}
