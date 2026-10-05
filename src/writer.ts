import { parseRegions, promptHash, type AiRegion } from "./parser.ts";

export interface SummaryDraft {
	/** Generated title; goes on the `[!ai]` header unless the user wrote one. */
	title: string | null;
	body: string;
	provider: string;
	model: string;
	/** ISO timestamp, supplied by the caller so this stays a pure function. */
	generated: string;
}

/** The `[!ai]` header, keeping any fold marker, up to where the title starts. */
const AI_HEADER_PREFIX = /^(\s*>\s*\[!ai\][+-]?)\s*(.*)$/i;

/** Second-level quoting, as the nested callout sits inside the `[!ai]` one. */
function quote(line: string): string {
	return line.trim() ? `> > ${line}` : "> >";
}

/**
 * Renders the nested summary callout. Provenance goes in an HTML comment on the
 * title line, where it is invisible when rendered but survives edits to the
 * body.
 */
function summaryLines(
	region: AiRegion,
	draft: SummaryDraft,
	ownsParentTitle: boolean
): string[] {
	const flag = ownsParentTitle ? " title" : "";
	const meta = `<!-- ai ${draft.provider}/${draft.model || "default"} ${draft.generated} ${promptHash(region.prompt)}${flag} -->`;
	// The title shows on the parent header, except where that is the user's own.
	const title = ownsParentTitle ? "" : (draft.title ?? "").trim();

	const header = `> > [!summary] ${[title, meta].filter(Boolean).join(" ")}`;
	return [header, ...draft.body.split("\n").map(quote)];
}

/**
 * Writes a generated summary into its callout, replacing an existing generated
 * one. The region is located afresh in the given text by matching the prompt, so
 * a note that shifted since generation started is still updated correctly — and
 * a note whose prompt has since changed is left alone.
 */
export function upsertSummary(
	text: string,
	prompt: string,
	draft: SummaryDraft
): string | null {
	const hash = promptHash(prompt);
	const region = parseRegions(text).find((r) => promptHash(r.prompt) === hash);
	if (!region) return null;
	// A hand-written summary is never overwritten.
	if (region.summary && !region.summary.meta) return null;

	// The generated title goes on the header, unless the user titled it there
	// themselves — which a previously written title does not count as.
	const generatedTitle = (draft.title ?? "").trim();
	const ownsParentTitle =
		generatedTitle !== "" &&
		(region.title === "" || region.summary?.meta?.ownsParentTitle === true);

	const lines = text.split("\n");

	if (ownsParentTitle) {
		const header = AI_HEADER_PREFIX.exec(lines[region.lineStart]);
		if (header) lines[region.lineStart] = `${header[1]} ${generatedTitle}`;
	}

	const block = summaryLines(region, draft, ownsParentTitle);

	if (region.summary) {
		lines.splice(
			region.summary.lineStart,
			region.summary.lineEnd - region.summary.lineStart + 1,
			...block
		);
		return lines.join("\n");
	}

	// Separate the prompt from the summary with an empty quoted line, unless the
	// callout already ends with one.
	const last = lines[region.lineEnd] ?? "";
	const spacer = /^\s*>\s*$/.test(last) ? [] : ["> "];
	lines.splice(region.lineEnd + 1, 0, ...spacer, ...block);
	return lines.join("\n");
}

/** An `[!ai]` callout skeleton for the insert command. */
export function newRegion(title: string): string {
	const header = title ? `> [!ai] ${title}` : "> [!ai]";
	return `${header}\n> `;
}
