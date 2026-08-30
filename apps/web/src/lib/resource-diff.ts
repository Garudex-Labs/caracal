// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Shared YAML-projection and diff primitives for resource versions. Used by
// the change review surface and the resource workspace's version compare, so
// both render the same clean projection of a version and the same diff shape.

const DIFF_METADATA_FIELDS = new Set([
	"id",
	"listing_id",
	"download_count",
	"released_by",
	"released_at",
	"created_at",
	"status",
	"rejection_reason",
	"is_prerelease",
	"promoted_from",
]);

export function stripMeta(obj: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(obj).filter(
			([k, v]) =>
				!DIFF_METADATA_FIELDS.has(k) &&
				v !== null &&
				v !== undefined &&
				v !== "",
		),
	);
}

/**
 * Format an object as YAML with values on their own indented line.
 * Keys are rendered as `key:` and values are indented below.
 */
export function formatBlockYaml(obj: Record<string, unknown>, indent = 2): string {
	const pad = " ".repeat(indent);
	const lines: string[] = [];
	for (const [key, value] of Object.entries(obj)) {
		if (value === null || value === undefined || value === "") continue;
		if (Array.isArray(value)) {
			if (value.length === 0) continue;
			// Array of objects (components)
			if (typeof value[0] === "object" && value[0] !== null) {
				lines.push(`${key}:`);
				for (const item of value) {
					const entries = Object.entries(
						item as Record<string, unknown>,
					).filter(([, v]) => v !== null && v !== undefined && v !== "");
					if (entries.length === 0) continue;
					const [firstKey, firstVal] = entries[0];
					lines.push(`${pad}- ${firstKey}: ${formatScalar(firstVal)}`);
					for (const [k, v] of entries.slice(1)) {
						lines.push(`${pad}  ${k}: ${formatScalar(v)}`);
					}
				}
			} else {
				// Array of scalars
				lines.push(`${key}:`);
				for (const item of value) {
					lines.push(`${pad}- ${String(item)}`);
				}
			}
		} else if (typeof value === "object" && value !== null) {
			lines.push(`${key}:`);
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
				if (v !== null && v !== undefined && v !== "") {
					lines.push(`${pad}${k}: ${formatScalar(v)}`);
				}
			}
		} else {
			// Scalar: key on one line, value indented on next
			const strVal = String(value);
			if (strVal.includes("\n")) {
				// Multi-line string: each line indented
				lines.push(`${key}: |`);
				for (const line of strVal.split("\n")) {
					lines.push(`${pad}${line}`);
				}
			} else {
				lines.push(`${key}:`);
				lines.push(`${pad}${strVal}`);
			}
		}
	}
	return lines.join("\n");
}

function formatScalar(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "object") {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
	return String(value);
}

export function toReviewYaml(obj: Record<string, unknown>): string {
	try {
		return formatBlockYaml(stripMeta(obj));
	} catch {
		return JSON.stringify(stripMeta(obj), null, 2);
	}
}

export const COMPONENT_CONTENT_KEYS = [
	"template",
	"skill_md_content",
	"handler_config",
	"input_schema",
	"output_schema",
	"source_url",
	"git_url",
	"config_json",
	"event",
	"execution_mode",
	"task_type",
	"slash_command",
];

// For non-agent component submissions - include all content fields
const COMPONENT_SNAPSHOT_META = new Set([
	"id",
	"listing_id",
	"download_count",
	"released_by",
	"released_at",
	"created_at",
	"status",
	"rejection_reason",
	"is_prerelease",
]);

export function buildComponentYaml(detail: object): string {
	const obj = Object.fromEntries(
		Object.entries(detail as Record<string, unknown>).filter(
			([k, v]) =>
				!COMPONENT_SNAPSHOT_META.has(k) &&
				v !== null &&
				v !== undefined &&
				v !== "" &&
				!(Array.isArray(v) && v.length === 0) &&
				!(
					typeof v === "object" &&
					!Array.isArray(v) &&
					Object.keys(v).length === 0
				),
		),
	);
	try {
		return formatBlockYaml(obj);
	} catch {
		return JSON.stringify(obj, null, 2);
	}
}

export function buildCleanYaml(
	source: object,
	componentDataMap?: Map<string, Record<string, unknown>>,
): string {
	const detail = source as Record<string, unknown>;
	const comps =
		(detail.components as Array<Record<string, unknown>> | undefined) ?? [];
	const obj: Record<string, unknown> = {};
	if (detail.version) obj.version = detail.version;
	if (detail.description) obj.description = detail.description;
	if (detail.prompt) obj.prompt = detail.prompt;
	if (detail.model_name) obj.model_name = detail.model_name;
	const byHarness = detail.models_by_harness as Record<string, unknown> | undefined;
	if (byHarness && Object.keys(byHarness).length) obj.models_by_harness = byHarness;
	const harnesses = detail.supported_harnesses as string[] | undefined;
	if (harnesses?.length) obj.supported_harnesses = harnesses;
	const sc = detail.success_criteria as Record<string, unknown> | null | undefined;
	if (sc && sc.intended_purpose) obj.success_criteria = sc;
	if (comps.length) {
		obj.components = comps.map((c) => {
			const cached = componentDataMap?.get(String(c.component_id ?? "")) as
				| Record<string, unknown>
				| undefined;
			const merged = cached ? { ...cached, ...c } : c;
			const entry: Record<string, unknown> = {};
			if (merged.component_type) entry.type = merged.component_type;
			entry.name =
				merged.name ||
				merged.component_name ||
				c.name ||
				c.component_name ||
				"(pending)";
			const desc = merged.description ?? merged.component_description;
			if (desc) entry.description = desc;
			if (merged.version) entry.version = merged.version;
			for (const k of COMPONENT_CONTENT_KEYS) {
				if (merged[k]) entry[k] = merged[k];
			}
			return entry;
		});
	}
	try {
		return formatBlockYaml(obj);
	} catch {
		return JSON.stringify(obj, null, 2);
	}
}

/**
 * Line-aligned unified diff between two rendered texts. Not a full LCS diff:
 * lines are compared positionally within one pass, which is stable and cheap
 * for the clean YAML projections rendered above.
 */
export function simpleUnifiedDiff(
	prev: string,
	curr: string,
	labelA: string,
	labelB: string,
): string {
	if (prev === curr) return "";
	const prevLines = prev.split("\n");
	const currLines = curr.split("\n");
	const lines: string[] = [`--- ${labelA}`, `+++ ${labelB}`];
	const hunks: string[] = [];
	const maxLen = Math.max(prevLines.length, currLines.length);
	let inHunk = false;
	for (let i = 0; i < maxLen; i++) {
		const pl = prevLines[i] ?? "";
		const cl = currLines[i] ?? "";
		if (pl !== cl) {
			if (!inHunk) {
				hunks.push(`@@ -${i + 1} +${i + 1} @@`);
				inHunk = true;
			}
			if (pl) hunks.push(`-${pl}`);
			if (cl) hunks.push(`+${cl}`);
		} else {
			if (inHunk) {
				hunks.push(` ${cl}`);
				inHunk = false;
			}
		}
	}
	return [...lines, ...hunks].join("\n");
}
