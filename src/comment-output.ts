export type NoteChange =
	| { kind: "create"; path: string; content: string }
	| { kind: "replace"; path: string; oldText: string; newText: string };
export interface CommentResult { reply: string; changes: NoteChange[] }

export interface CommentReply { reply: string }
export type CommentReplyFormat = "json" | "markdown";
export const COMMENT_SCHEMA = {
	type: "object", properties: { reply: { type: "string" } },
	required: ["reply"], additionalProperties: false,
};

export function parseCommentReply(text: string): CommentReply {
	let value: unknown;
	try {
		value = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```$/, ""));
	} catch {
		throw new Error("The agent returned invalid reply JSON. Work may already have taken effect; inspect current files before retrying.");
	}
	if (!value || typeof value !== "object" || Array.isArray(value) ||
		Object.keys(value).length !== 1 || !("reply" in value) || typeof value.reply !== "string" || !value.reply.trim()) {
		throw new Error("The agent must return only a nonempty Markdown reply. Work may already have taken effect; inspect current files before retrying.");
	}
	return { reply: value.reply };
}

/** Decode the provider's declared contract, never guess from the response text. */
export function parseAgentCommentReply(text: string, format: CommentReplyFormat): CommentReply {
	if (format === "json") return parseCommentReply(text);
	const reply = text.trim();
	if (!reply) throw new Error("The agent returned an empty Markdown reply. Work may already have taken effect; inspect current files before retrying.");
	return { reply };
}

/** Unlike overview text, a malformed comment result must never be applied. */
export function parseCommentResult(text: string): CommentResult {
	const value: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```$/, ""));
	if (!value || typeof value !== "object") throw new Error("The agent did not return a comment result.");
	const result = value as CommentResult;
	if (typeof result.reply !== "string" || !result.reply.trim() || !Array.isArray(result.changes)) {
		throw new Error("The agent must return a reply and a changes array.");
	}
	for (const change of result.changes) {
		if (!change || typeof change.path !== "string" ||
			(change.kind === "create" ? typeof change.content !== "string" :
				change.kind !== "replace" || typeof change.oldText !== "string" || !change.oldText || typeof change.newText !== "string")) {
			throw new Error("The agent returned an invalid note change.");
		}
	}
	return result;
}

export function validateNotePath(path: string): void {
	if (!path || path.includes("\\") || path.includes(":") || [...path].some((c) => c.charCodeAt(0) < 32) ||
		!path.endsWith(".md") || path.split("/").some((p) => !p || p.startsWith("."))) {
		throw new Error(`Only Markdown note paths inside the vault are allowed: ${path}`);
	}
}

function commentRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	for (const pattern of [/%%[\s\S]*?%%/g, /<discussion\b[^>]*>[\s\S]*?<\/discussion>/gi, /<comment\b[^>]*>[\s\S]*?<\/comment>/gi]) {
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(text))) ranges.push([match.index, match.index + match[0].length]);
	}
	return ranges;
}

export function safeReplacement(text: string, change: Extract<NoteChange, { kind: "replace" }>): string {
	const protectedRanges = commentRanges(text);
	const candidates: number[] = [];
	for (let offset = 0; offset <= text.length - change.oldText.length;) {
		const found = text.indexOf(change.oldText, offset);
		if (found < 0) break;
		if (!protectedRanges.some(([start, end]) => found < end && found + change.oldText.length > start)) candidates.push(found);
		offset = found + 1;
	}
	if (candidates.length !== 1) {
		throw new Error(`The text to replace is missing or ambiguous in ${change.path}.`);
	}
	const from = candidates[0];
	const to = from + change.oldText.length;
	if (/%%|<\/?(?:discussion|comment)\b|<!-- aio-/i.test(change.newText)) {
		throw new Error("Note changes must preserve comments; the plugin publishes the reply separately.");
	}
	return text.slice(0, from) + change.newText + text.slice(to);
}
