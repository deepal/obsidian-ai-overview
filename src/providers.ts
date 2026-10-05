export type ProviderId = "codex" | "claude" | "opencode";

export const PROVIDER_IDS: ProviderId[] = ["codex", "claude", "opencode"];

export interface ModelInfo {
	/** Value passed to the CLI. */
	id: string;
	/** Human-readable name for the dropdown. */
	label: string;
	/** Thinking levels this model supports, when the CLI reports them per model. */
	efforts: string[];
}

/** A listing command the CLI itself provides, and how to read its output. */
export interface Listing<T> {
	args: string[];
	parse(stdout: string): T;
}

export interface ProviderRunContext {
	/** Working root for the CLI — the vault's base directory. */
	cwd: string;
	/** The composed prompt, passed as a single argument. */
	prompt: string;
	/** The user's additional arguments, to be placed among the built ones. */
	extraArgs: string[];
	/** Empty leaves the model choice to the CLI's own configuration. */
	model: string;
	/** Empty leaves the thinking level to the CLI's own configuration. */
	effort: string;
	/** Path to the JSON Schema file, for CLIs that can enforce a response shape. */
	schemaFile: string;
	/** Path the final message is written to, for CLIs that support it. */
	outFile: string;
}

type JsonObject = Record<string, unknown>;

export interface Provider {
	id: ProviderId;
	label: string;
	/** Executable looked up on PATH when the user hasn't set one. */
	defaultPath: string;
	/**
	 * Whether the response shape has to be requested in the prompt because the
	 * CLI has no schema flag of its own.
	 */
	promptForJson: boolean;
	/** Whether a JSON Schema file needs writing before the run. */
	usesSchemaFile: boolean;
	/** Whether the final answer is read from `outFile` rather than the stream. */
	usesOutputFile: boolean;
	/**
	 * How the CLI lists its models, or null when it has no such command — in
	 * which case the model has to be typed in.
	 */
	listModels: Listing<ModelInfo[]> | null;
	/**
	 * How the CLI reports its thinking levels when they aren't attached to
	 * individual models, or null when only the per-model list applies.
	 */
	listEfforts: Listing<string[]> | null;
	/** What this CLI calls the thinking level, for the settings label. */
	effortLabel: string;
	/** The complete argument list, prompt included. */
	buildArgs(ctx: ProviderRunContext): string[];
	/** A progress line for this event, or null if it carries nothing to show. */
	status(event: JsonObject): string | null;
	/** The final answer, if this event carries it. */
	final(event: JsonObject): string | null;
	/** An error the CLI reported in-band, if any. */
	error(event: JsonObject): string | null;
}

function asObject(value: unknown): JsonObject | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

/** Collapses whitespace and clips to a length that fits the header. */
function truncate(text: string, max = 90): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Structured answers arrive as messages too; raw JSON is noise in the header. */
function statusText(text: string): string | null {
	const trimmed = text.trim();
	const looksStructured = trimmed.startsWith("{") || trimmed.startsWith("```");
	return looksStructured ? null : truncate(trimmed);
}

/** Unwraps a `/bin/zsh -lc "…"` style shell invocation for display. */
function displayCommand(command: string): string {
	const match = /^\S*(?:sh|zsh|bash) -[a-z]*c\s+"([\s\S]*)"$/.exec(command.trim());
	return truncate(match ? match[1] : command);
}

function asNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/**
 * Extracts every top-level JSON object from output that interleaves objects
 * with plain text, tracking string literals so braces inside them don't count.
 */
function jsonObjects(text: string): JsonObject[] {
	const found: JsonObject[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
		} else if (char === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (char === "}" && depth > 0) {
			depth--;
			if (depth === 0 && start !== -1) {
				try {
					const parsed = asObject(JSON.parse(text.slice(start, i + 1)));
					if (parsed) found.push(parsed);
				} catch {
					// Not a complete object after all; skipped.
				}
				start = -1;
			}
		}
	}

	return found;
}

/** Narrows output to its JSON payload, ignoring any surrounding log lines. */
function sliceJson(text: string): string {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	return start !== -1 && end > start ? text.slice(start, end + 1) : text;
}

/**
 * Reads an option's permitted values out of a CLI's own help text, e.g. the
 * `(low, medium, high)` that follows the option's description.
 */
export function parseHelpChoices(help: string, option: string): string[] {
	const at = help.indexOf(`${option} `);
	if (at === -1) return [];

	// Bounded so a later option's list can't be mistaken for this one's.
	const window = help.slice(at, at + 600);
	const groups = [...window.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].map(
		(match) => match[1] ?? match[2]
	);

	// An explicit "choices:" list wins; otherwise the first parenthetical is the
	// enumeration, and bracketed type annotations are skipped.
	const chosen =
		groups.find((group) => /^\s*choices:/i.test(group)) ??
		[...window.matchAll(/\(([^)]*)\)/g)].map((match) => match[1])[0];
	if (chosen === undefined) return [];

	return chosen
		.replace(/^\s*choices:\s*/i, "")
		.split(",")
		.map((choice) => choice.trim().replace(/^["']|["']$/g, ""))
		.filter((choice) => /^[a-z][a-z0-9._-]*$/i.test(choice));
}

/** The most descriptive field of a tool's input, for a progress line. */
function toolTarget(input: JsonObject | null): string | null {
	if (!input) return null;
	for (const key of ["file_path", "path", "pattern", "query", "command", "filePath"]) {
		const value = asString(input[key]);
		if (value) return value;
	}
	return null;
}

const codex: Provider = {
	id: "codex",
	label: "Codex CLI",
	defaultPath: "codex",
	promptForJson: false,
	usesSchemaFile: true,
	usesOutputFile: true,
	effortLabel: "Reasoning effort",

	listModels: {
		args: ["debug", "models"],
		parse(stdout) {
			const models = asObject(JSON.parse(sliceJson(stdout)))?.models;
			if (!Array.isArray(models)) return [];

			return models
				.map(asObject)
				.filter((model): model is JsonObject => model !== null)
				// Models the CLI itself hides aren't offered.
				.filter((model) => asString(model.visibility) !== "hide")
				.sort((a, b) => asNumber(a.priority) - asNumber(b.priority))
				.map((model) => {
					const id = asString(model.slug);
					const levels = Array.isArray(model.supported_reasoning_levels)
						? model.supported_reasoning_levels
						: [];
					return {
						id: id ?? "",
						label: asString(model.display_name) ?? id ?? "",
						efforts: levels
							.map((level) => asString(asObject(level)?.effort))
							.filter((effort): effort is string => effort !== null),
					};
				})
				.filter((model) => model.id);
		},
	},

	// Codex reports the levels each model supports, so there is no global list.
	listEfforts: null,

	buildArgs(ctx) {
		const args = [
			"exec",
			"--cd",
			ctx.cwd,
			"--sandbox",
			"read-only",
			"--skip-git-repo-check",
			"--ephemeral",
			"--color",
			"never",
			"--json",
			"--output-schema",
			ctx.schemaFile,
			"--output-last-message",
			ctx.outFile,
		];
		if (ctx.model) args.push("--model", ctx.model);
		if (ctx.effort) args.push("-c", `model_reasoning_effort="${ctx.effort}"`);
		args.push(...ctx.extraArgs, ctx.prompt);
		return args;
	},

	status(event) {
		const type = asString(event.type);
		if (type === "thread.started") return "Thinking…";
		if (type === "turn.completed") return "Writing up…";
		if (type !== "item.started" && type !== "item.completed") return null;

		const item = asObject(event.item);
		if (!item) return null;
		const itemType = asString(item.type);

		if (itemType === "command_execution") {
			const command = asString(item.command);
			return type === "item.started" && command ? displayCommand(command) : null;
		}
		if (itemType === "agent_message") {
			const text = asString(item.text);
			return type === "item.completed" && text ? statusText(text) : null;
		}
		if (itemType === "reasoning") {
			return type === "item.started" ? "Reasoning…" : null;
		}
		return null;
	},

	// The answer comes back via --output-last-message.
	final: () => null,
	error: () => null,
};

const claude: Provider = {
	id: "claude",
	label: "Claude Code CLI",
	defaultPath: "claude",
	promptForJson: true,
	usesSchemaFile: false,
	usesOutputFile: false,
	effortLabel: "Effort level",

	// Claude Code has no model listing command, so the model is typed in.
	listModels: null,

	listEfforts: {
		args: ["--help"],
		parse: (stdout) => parseHelpChoices(stdout, "--effort"),
	},

	buildArgs(ctx) {
		// The prompt goes first: the tool-list options are variadic and would
		// otherwise swallow a trailing positional argument.
		const args = [ctx.prompt, "--print", "--output-format", "stream-json", "--verbose"];
		if (ctx.model) args.push("--model", ctx.model);
		if (ctx.effort) args.push("--effort", ctx.effort);
		args.push(
			...ctx.extraArgs,
			// Read-only by construction: anything that could touch the vault is denied.
			"--allowed-tools",
			"Read,Grep,Glob",
			"--disallowed-tools",
			"Edit,Write,NotebookEdit,Bash"
		);
		return args;
	},

	status(event) {
		const type = asString(event.type);
		if (type === "system") return "Thinking…";
		if (type !== "assistant") return null;

		const message = asObject(event.message);
		const content = Array.isArray(message?.content) ? message?.content : null;
		if (!content) return null;

		// Later blocks describe more recent work, so the last usable one wins.
		let status: string | null = null;
		for (const raw of content) {
			const block = asObject(raw);
			if (!block) continue;
			const blockType = asString(block.type);
			if (blockType === "tool_use") {
				const name = asString(block.name) ?? "tool";
				const target = toolTarget(asObject(block.input));
				status = truncate(target ? `${name}: ${target}` : name);
			} else if (blockType === "text") {
				const text = asString(block.text);
				if (text) status = statusText(text) ?? status;
			}
		}
		return status;
	},

	final(event) {
		if (asString(event.type) !== "result" || event.is_error === true) return null;
		return asString(event.result);
	},

	error(event) {
		if (asString(event.type) !== "result" || event.is_error !== true) return null;
		return asString(event.result) ?? asString(event.subtype) ?? "The run failed.";
	},
};

const opencode: Provider = {
	id: "opencode",
	label: "opencode CLI",
	defaultPath: "opencode",
	promptForJson: true,
	usesSchemaFile: false,
	usesOutputFile: false,
	effortLabel: "Model variant",

	listModels: {
		// The verbose listing carries each model's variants alongside its id.
		args: ["models", "--verbose"],
		parse(stdout) {
			return jsonObjects(stdout)
				.map((model) => {
					const id = asString(model.id);
					const providerId = asString(model.providerID);
					if (!id || !providerId) return null;
					const name = asString(model.name);
					return {
						id: `${providerId}/${id}`,
						label: name ? `${providerId}/${id} — ${name}` : `${providerId}/${id}`,
						efforts: Object.keys(asObject(model.variants) ?? {}),
					};
				})
				.filter((model): model is ModelInfo => model !== null);
		},
	},

	// Variants are per model in opencode's catalogue.
	listEfforts: null,

	buildArgs(ctx) {
		const args = ["run", "--dir", ctx.cwd, "--format", "json"];
		if (ctx.model) args.push("--model", ctx.model);
		if (ctx.effort) args.push("--variant", ctx.effort);
		args.push(...ctx.extraArgs, ctx.prompt);
		return args;
	},

	status(event) {
		const part = asObject(event.part);
		if (!part) return null;

		const partType = asString(part.type);
		if (partType === "step-start") return "Thinking…";
		if (partType === "tool") {
			const name = asString(part.tool) ?? "tool";
			const state = asObject(part.state);
			const target = toolTarget(asObject(state?.input));
			return truncate(target ? `${name}: ${target}` : name);
		}
		if (partType === "text") {
			const text = asString(part.text);
			return text ? statusText(text) : null;
		}
		return null;
	},

	final(event) {
		const part = asObject(event.part);
		if (!part || asString(part.type) !== "text") return null;
		// Text parts stream in place, each carrying the full text so far, so the
		// newest one is the whole answer.
		return asString(part.text);
	},

	error(event) {
		const type = asString(event.type);
		if (type !== "error" && type !== "session.error") return null;
		const error = asObject(event.error) ?? asObject(asObject(event.properties)?.error);
		const data = asObject(error?.data);
		return asString(data?.message) ?? asString(error?.name) ?? "The run failed.";
	},
};

const PROVIDERS: Record<ProviderId, Provider> = { codex, claude, opencode };

export function getProvider(id: ProviderId): Provider {
	return PROVIDERS[id] ?? codex;
}
