import type { ModelInfo, Provider, ProviderEventReader } from "./providers.ts";

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
const string = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;

/** Pi owns discovery and tools; the plugin owns one fresh prompt and its transport. */
export function piArgs(args: string[]): string[] {
	const reserved = new Set(["--mode", "--print", "-p", "--continue", "-c", "--resume", "-r", "--session", "--session-id", "--fork", "--export", "--list-models", "--help", "-h", "--version", "-v"]);
	const values = new Set(["--provider", "--model", "--api-key", "--system-prompt", "--append-system-prompt", "--thinking", "--models", "--tools", "-t", "--exclude-tools", "-xt", "--extension", "-e", "--skill", "--prompt-template", "--theme", "--use-theme", "--tui-mode", "--session-dir", "--name", "-n"]);
	for (let i = 0; i < args.length; i++) {
		const flag = args[i].split("=", 1)[0];
		if (!flag.startsWith("-") || flag === "--" || reserved.has(flag) || /^-[pcrhv].+/.test(flag)) {
			throw new Error(`Pi runs control their prompt, output and session. Remove conflicting extra argument: ${args[i]}`);
		}
		if (!args[i].includes("=") && values.has(flag)) {
			if (i + 1 >= args.length || args[i + 1].startsWith("-")) throw new Error(`Missing value for Pi extra argument: ${flag}`);
			i++;
		}
	}
	return [...args];
}

function parseModels(stdout: string): ModelInfo[] {
	const models: ModelInfo[] = [];
	let header = false;
	// eslint-disable-next-line no-control-regex -- Strip CLI colour escapes before reading table columns.
	const clean = stdout.replace(/\x1b\[[0-9;]*m/g, "");
	for (const line of clean.split("\n")) {
		const cells = line.trim().split(/\s+/);
		if (cells[0] === "provider" && cells[1] === "model") { header = true; continue; }
		if (!header || cells.length !== 6 || !/^(yes|no)$/.test(cells[4]) || !/^(yes|no)$/.test(cells[5])) continue;
		const id = `${cells[0]}/${cells[1]}`;
		models.push({ id, label: id, efforts: [], supportsThinking: cells[4] === "yes" });
	}
	return models;
}

function parseThinking(help: string): string[] {
	const section = help.split(/\n\s*(?=--)/).find((line) => line.trimStart().startsWith("--thinking "));
	const choices = section?.match(/level:\s*([a-z]+(?:,\s*[a-z]+)*)/i)?.[1];
	return choices ? choices.split(",").map((value) => value.trim()) : [];
}

function progress(event: JsonObject): string | null {
	if (event.type === "agent_start") return "Thinking…";
	if (event.type === "auto_retry_start") return "Retrying…";
	if (event.type === "tool_execution_start") {
		const args = object(event.args);
		const target = args && ["path", "file_path", "pattern", "query", "command"].map((key) => string(args[key])).find(Boolean);
		return `${string(event.toolName) ?? "Tool"}${target ? `: ${target}` : ""}`.replace(/\s+/g, " ").slice(0, 90);
	}
	if (event.type === "message_update") {
		const update = object(event.assistantMessageEvent);
		if (update?.type === "thinking_start") return "Thinking…";
		if (update?.type === "text_start") return "Writing…";
	}
	return null;
}

function createEventReader(): ProviderEventReader {
	let settled = false;
	let aborted = false;
	let assistant: JsonObject | null = null;
	let retryError: string | null = null;
	return {
		accept(event) {
			if (event.type === "agent_start" || event.type === "turn_start") {
					settled = false;
					assistant = null;
					retryError = null;
			}
			if (event.type === "message_end") {
				const message = object(event.message);
				if (message?.role === "assistant") assistant = message;
			}
			if (event.type === "auto_retry_start") settled = false;
			if (event.type === "auto_retry_end") retryError = event.success === false ? string(event.finalError) ?? "Pi exhausted its automatic retries." : null;
			if (event.type === "agent_settled") {
				settled = typeof event.aborted === "boolean";
				aborted = event.aborted === true;
			}
			return progress(event);
		},
		finish() {
			const fail = (error: string) => ({ text: "", error });
			if (!settled) return fail("Pi did not report a completed run (agent_settled). Pi 1.4.0 is the tested baseline.");
			if (aborted) return fail("Pi aborted the run. Actions already performed are not rolled back.");
			if (retryError) return fail(retryError);
			if (!assistant) return fail("Pi finished without a final assistant response.");
			if (assistant.stopReason === "length") return fail("Pi's final response was truncated at the model's output limit.");
			if (assistant.stopReason !== "stop") return fail(string(assistant.errorMessage) ?? `Pi did not complete its final assistant response (${String(assistant.stopReason)}).`);
				const text = (Array.isArray(assistant.content) ? assistant.content : [])
					.map(object)
					.filter((block) => block?.type === "text")
					.map((block) => typeof block?.text === "string" ? block.text : "")
					.join("").trim();
			return text ? { text, error: null } : fail("Pi finished without any final response text.");
		},
	};
}

export const pi: Provider = {
	id: "pi", label: "Pi CLI", defaultPath: "pi",
	promptForJson: true, usesSchemaFile: false, usesOutputFile: false,
	effortLabel: "Thinking level",
	listModels: { args: ["--offline", "--list-models"], parse: parseModels },
	listEfforts: { args: ["--help"], parse: parseThinking },
	buildArgs(ctx) {
		const args = ["--print", "--mode", "json"];
		if (ctx.model) args.push("--model", ctx.model);
		if (ctx.effort) args.push("--thinking", ctx.effort);
		args.push(...piArgs(ctx.extraArgs));
		if (ctx.mode !== "comment") args.push("--tools", "read,grep,find,ls", "--no-mcp");
		args.push("--", ctx.prompt);
		return args;
	},
	status: progress,
	final: () => null,
	error: () => null,
	createEventReader,
};
