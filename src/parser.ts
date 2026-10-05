/** Provenance recorded on a generated summary, in an HTML comment. */
export interface SummaryMeta {
	provider: string;
	model: string;
	generated: string;
	/** Hash of the prompt this summary was generated from. */
	hash: string;
	/**
	 * Whether the title on the `[!ai]` header was written by the plugin, and may
	 * therefore be replaced. A title the user typed is left alone.
	 */
	ownsParentTitle: boolean;
}

export interface NestedSummary {
	lineStart: number;
	lineEnd: number;
	title: string;
	body: string;
	/**
	 * Null when the summary carries no provenance comment, which marks it as
	 * hand-written and therefore never overwritten.
	 */
	meta: SummaryMeta | null;
}

export interface AiRegion {
	/** Line of the `> [!ai]` header. */
	lineStart: number;
	/** Last line belonging to the callout. */
	lineEnd: number;
	/** Fold marker on the header: "", "+" or "-". */
	fold: string;
	/** Title given on the header line; empty when omitted. */
	title: string;
	/** The request, taken from the callout's own content. */
	prompt: string;
	/** The nested summary callout, when one has been written. */
	summary: NestedSummary | null;
}

const AI_HEADER = /^>\s*\[!ai\]([+-]?)\s*(.*)$/i;
const SUMMARY_HEADER = /^>\s*\[!summary\]([+-]?)\s*(.*)$/i;
const META = /<!--\s*ai\s+(\S+?)\/(\S*)\s+(\S+)\s+([0-9a-f]+)(\s+title)?\s*-->/i;

/** Whether a line continues a blockquote. */
function isQuoted(line: string): boolean {
	return /^\s*>/.test(line);
}

/** Removes one level of blockquote marker from a line. */
function unquote(line: string): string {
	return line.replace(/^\s*>[ \t]?/, "");
}

/**
 * Finds every `[!ai]` callout in a note, along with its prompt and any summary
 * already nested inside it. Line numbers are zero-based and index into the same
 * text that was passed in.
 */
export function parseRegions(text: string): AiRegion[] {
	const lines = text.split("\n");
	const regions: AiRegion[] = [];

	for (let i = 0; i < lines.length; i++) {
		const header = AI_HEADER.exec(lines[i].replace(/^\s+/, ""));
		if (!header) continue;

		// The callout runs until the first line that no longer continues it.
		let end = i;
		while (end + 1 < lines.length && isQuoted(lines[end + 1])) end++;

		regions.push(buildRegion(lines, i, end, header[1], header[2].trim()));
		i = end;
	}

	return regions;
}

function buildRegion(
	lines: string[],
	lineStart: number,
	lineEnd: number,
	fold: string,
	title: string
): AiRegion {
	const promptLines: string[] = [];
	let summary: NestedSummary | null = null;

	for (let i = lineStart + 1; i <= lineEnd; i++) {
		const inner = unquote(lines[i]);

		if (summary === null) {
			const nested = SUMMARY_HEADER.exec(inner.replace(/^\s+/, ""));
			if (nested) {
				summary = readSummary(lines, i, lineEnd, nested[2].trim());
				i = summary.lineEnd;
				continue;
			}
			promptLines.push(inner);
			continue;
		}

		// Content after the nested summary belongs to the prompt again.
		promptLines.push(inner);
	}

	return {
		lineStart,
		lineEnd,
		fold,
		title,
		prompt: promptLines.join("\n").trim(),
		summary,
	};
}

function readSummary(
	lines: string[],
	lineStart: number,
	regionEnd: number,
	rawTitle: string
): NestedSummary {
	const meta = readMeta(rawTitle);
	const bodyLines: string[] = [];
	let lineEnd = lineStart;

	for (let i = lineStart + 1; i <= regionEnd; i++) {
		const inner = unquote(lines[i]);
		// The nested callout ends where the second level of quoting stops.
		if (!isQuoted(inner)) break;
		bodyLines.push(unquote(inner));
		lineEnd = i;
	}

	return {
		lineStart,
		lineEnd,
		title: rawTitle.replace(META, "").trim(),
		body: bodyLines.join("\n").trim(),
		meta,
	};
}

function readMeta(title: string): SummaryMeta | null {
	const match = META.exec(title);
	if (!match) return null;
	return {
		provider: match[1],
		model: match[2],
		generated: match[3],
		hash: match[4].toLowerCase(),
		ownsParentTitle: match[5] !== undefined,
	};
}

/**
 * Short, stable fingerprint of a prompt (FNV-1a). Written alongside a summary so
 * an edited prompt can be told from an unchanged one without a model call.
 */
export function promptHash(prompt: string): string {
	let hash = 0x811c9dc5;
	const text = prompt.trim();
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		// 16777619, via shifts to stay in 32-bit range.
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * Separator between a note path and a prompt hash. A character that cannot occur
 * in either keeps a path that ends in the separator from colliding with a
 * different note.
 */
const KEY_SEPARATOR = "\u0000";

/**
 * Identity of a run: the note plus the prompt being answered. Built and matched
 * only through these two functions, so the two can never disagree.
 */
export function runKey(notePath: string, prompt: string): string {
	return `${notePath}${KEY_SEPARATOR}${promptHash(prompt)}`;
}

/** Prefix matching every run key belonging to a note. */
export function runKeyPrefix(notePath: string): string {
	return `${notePath}${KEY_SEPARATOR}`;
}

/** Whether a region needs generating: no summary yet, or the prompt moved on. */
export function needsSummary(region: AiRegion): boolean {
	if (!region.prompt) return false;
	if (!region.summary) return true;
	// A summary without provenance was written by hand and is left alone.
	if (!region.summary.meta) return false;
	return region.summary.meta.hash !== promptHash(region.prompt);
}
