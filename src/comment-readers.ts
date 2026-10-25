import type { ProviderEventReader } from "./providers.ts";
import { parseCommentReply } from "./comment-output.ts";

type JsonObject = Record<string, unknown>;
type Progress = (event: JsonObject) => string | null;
const object = (value: unknown): JsonObject | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
const string = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const failure = (error: string) => ({ text: "", error });
const effects = "Work may already have taken effect; inspect current files before retrying.";

/** A stream-json envelope is not the schema result; only structured_output is. */
export function createClaudeCommentReader(progress: Progress): ProviderEventReader {
	let result: JsonObject | null = null;
	return {
		accept(event) {
			if (event.type === "result") result = event;
			return progress(event);
		},
		finish() {
			if (!result) return failure(`Claude Code finished without a final result event. ${effects}`);
			if (result.is_error === true || typeof result.subtype === "string" && result.subtype !== "success") {
				return failure(`Claude Code did not complete its structured reply (${string(result.subtype) ?? "error"}). ${effects}`);
			}
			if (result.structured_output === undefined) return failure(`Claude Code did not return the required structured_output. Check that your CLI supports --json-schema. ${effects}`);
			try {
				const text = JSON.stringify(result.structured_output);
				parseCommentReply(text);
				return { text, error: null };
			} catch {
				return failure(`Claude Code returned an invalid structured reply; expected only a nonempty reply string. ${effects}`);
			}
		},
	};
}

/** Final Markdown must belong to the latest successfully completed assistant message. */
export function createOpenCodeCommentReader(progress: Progress): ProviderEventReader {
	let session: string | null = null;
	let latest: string | null = null;
	let protocolError: string | null = null;
	const messages = new Map<string, { parts: Map<string, string>; reason: string | null }>();
	return {
		accept(event) {
			if (!["step_start", "step_finish", "text"].includes(String(event.type))) return progress(event);
			const part = object(event.part);
			if (!part) return null;
			const eventSession = string(event.sessionID);
			const partSession = string(part.sessionID);
			const messageId = string(part.messageID);
			if (!eventSession || !partSession || !messageId) { protocolError = "OpenCode response events are missing session or message identity."; return null; }
			if (!session) session = eventSession;
			if (eventSession !== session || partSession !== session) return null;
			if (!messages.has(messageId)) {
				messages.set(messageId, { parts: new Map(), reason: null });
				latest = messageId;
			}
			const message = messages.get(messageId)!;
			if (event.type === "step_start" && part.type === "step-start") message.reason = null;
			if (event.type === "step_finish" && part.type === "step-finish") message.reason = string(part.reason);
			if (event.type === "text" && part.type === "text") {
				const id = string(part.id);
				if (!id) { protocolError = "OpenCode text is missing its part identity."; return null; }
				const end = object(part.time)?.end;
				if (typeof end === "number" && Number.isFinite(end) && typeof part.text === "string") message.parts.set(id, part.text);
				else message.parts.delete(id);
			}
			return progress(event);
		},
		finish() {
			if (protocolError) return failure(`${protocolError} Update the CLI to a supported event format. ${effects}`);
			const message = latest ? messages.get(latest) : undefined;
			if (message?.reason === "length") return failure(`OpenCode's final response was truncated at the model's output limit. ${effects}`);
			if (!message || message.reason !== "stop") return failure(`OpenCode did not report a completed final assistant response (${message?.reason ?? "missing step_finish"}). ${effects}`);
			// Separate completed parts are Markdown blocks; snapshots of one part replace it.
			const text = [...message.parts.values()].join("\n\n").trim();
			return text ? { text, error: null } : failure(`OpenCode finished without any completed final response text. ${effects}`);
		},
	};
}
