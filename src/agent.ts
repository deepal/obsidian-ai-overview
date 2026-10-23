import { spawn } from "child_process";
import { promises as fs, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { getProvider, type ProviderId } from "./providers.ts";
import { augmentedPath } from "./spawn.ts";
import { COMMENT_SCHEMA } from "./comment-output.ts";
import { commentArgs, commentEventError } from "./comment-provider.ts";
import type { MentionRequest } from "./agent-bridge.ts";

/**
 * Shape the agent must return, so a title comes back from the same run as the
 * overview rather than costing a second invocation.
 */
const OUTPUT_SCHEMA = {
	type: "object",
	properties: {
		title: {
			type: "string",
			description:
				"A short plain-language title for the overview: at most six words, no trailing punctuation.",
		},
		body: {
			type: "string",
			description: "The overview itself, as Markdown.",
		},
	},
	required: ["title", "body"],
	additionalProperties: false,
};

export interface AgentRunOptions {
	provider: ProviderId;
	/** Separate response and permission mode for comment requests. */
	comment?: MentionRequest;
	/** Executable name or absolute path. */
	command: string;
	/** Working root handed to the CLI — the vault's base directory. */
	cwd: string;
	/** Note path relative to `cwd`, given to the agent as its context. */
	notePath: string;
	/** The user's request, taken verbatim from the code block body. */
	prompt: string;
	/** Empty string leaves the model choice to the CLI's own config. */
	model: string;
	/** Empty string leaves the thinking level to the CLI's own config. */
	effort: string;
	timeoutMs: number;
	/** Extra CLI arguments, split from the settings string. */
	extraArgs: string[];
	/** Extra environment variables for the child process. */
	env: Record<string, string>;
	onProgress: (status: string) => void;
}

export interface AgentResult {
	/** Null when the response didn't come back in the requested shape. */
	title: string | null;
	body: string;
}

export interface AgentRun {
	result: Promise<AgentResult>;
	cancel(): void;
}

function buildPrompt(
	notePath: string,
	absolutePath: string,
	prompt: string,
	promptForJson: boolean
): string {
	const lines = [
		"You are generating an overview that will be rendered inline in an Obsidian note.",
		"",
		// Absolute, because a relative path leaves some agents resolving it against
		// the wrong root.
		`The note in question is this file: ${absolutePath}`,
		`Within the vault it is at: ${notePath}`,
		"",
		"Read that note first, then carry out the request below. Follow any wikilinks or",
		"relative links only if the request needs them.",
		"",
		"Put the answer in `body` as Markdown, ready to display: no preamble, no sign-off,",
		"no fenced code block around the whole response, and no restating of the request.",
		"Put a short title for it in `title` — describe what the answer is about, rather",
		"than labelling it as a summary or overview. Treat the note as read-only and do",
		"not modify any files.",
	];

	if (promptForJson) {
		lines.push(
			"",
			'Reply with only a JSON object of the form {"title": "…", "body": "…"} — no',
			"code fence around it and no text before or after it."
		);
	}

	lines.push("", "Request:", prompt.trim());
	return lines.join("\n");
}

/**
 * Terminal escape sequences some CLIs interleave with their JSON output: OSC
 * strings (used for shell notifications) and ordinary colour codes.
 */
// eslint-disable-next-line no-control-regex -- CLI output contains real ANSI and OSC control bytes.
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Reads the agent's final message as a title and body. Falls back to treating
 * the whole message as the body if it didn't conform to the schema, so an
 * off-shape response still renders.
 */
export function parseResult(text: string): AgentResult {
	// CLIs without a schema flag are asked for JSON in the prompt, and some wrap
	// it in a code fence anyway.
	const unfenced = text
		.trim()
		.replace(/^```(?:json)?\s*\n?/, "")
		.replace(/\n?```$/, "")
		.trim();

	if (unfenced.startsWith("{")) {
		try {
			const parsed = JSON.parse(unfenced) as { title?: unknown; body?: unknown };
			if (typeof parsed.body === "string" && parsed.body.trim()) {
				const title =
					typeof parsed.title === "string" && parsed.title.trim()
						? parsed.title.trim()
						: null;
				return { title, body: parsed.body.trim() };
			}
		} catch {
			// Not the requested shape; treated as a plain Markdown body below.
		}
	}
	return { title: null, body: text.trim() };
}

/**
 * Runs one of the supported agent CLIs non-interactively and resolves with its
 * final answer. Progress is reported from the CLI's event stream as it arrives.
 */
export function runAgent(opts: AgentRunOptions): AgentRun {
	const provider = getProvider(opts.provider);
	const extraArgs = opts.comment ? commentArgs(opts.provider, opts.extraArgs) : opts.extraArgs;
	const stem = path.join(os.tmpdir(), `obsidian-ai-overview-${process.pid}-${nextRunId()}`);
	const outFile = `${stem}.out`;
	const schemaFile = `${stem}.schema.json`;
	if (provider.usesSchemaFile) {
		writeFileSync(schemaFile, JSON.stringify(opts.comment ? COMMENT_SCHEMA : OUTPUT_SCHEMA), "utf8");
	}

	const args = provider.buildArgs({
		mode: opts.comment ? "comment" : "overview",
		cwd: opts.cwd,
		prompt: opts.comment ? buildCommentPrompt(opts.comment) : buildPrompt(
			opts.notePath,
			path.join(opts.cwd, opts.notePath),
			opts.prompt,
			provider.promptForJson
		),
		extraArgs,
		model: opts.model,
		effort: opts.effort,
		schemaFile,
		outFile,
	});

	let settled = false;
	let cancelled = false;
	let timer: number | null = null;
	let killTimer: number | null = null;

	const child = spawn(opts.command, args, {
		cwd: opts.cwd,
		// stdin is ignored so the CLI doesn't wait for piped input.
		stdio: ["ignore", "pipe", "pipe"],
		detached: !!opts.comment && process.platform !== "win32",
		env: { ...process.env, ...opts.env, PATH: augmentedPath() },
	});

	const terminate = (signal: NodeJS.Signals) => {
		if (opts.comment && process.platform !== "win32" && child.pid) {
			try { process.kill(-child.pid, signal); return; } catch { /* Already exited, or no process group. */ }
		}
		child.kill(signal);
	};
	let finalText = "";
	let reportedError: string | null = null;
	const stderr: string[] = [];

	const cleanup = async () => {
		await Promise.all([
			fs.unlink(outFile).catch(() => undefined),
			provider.usesSchemaFile
				? fs.unlink(schemaFile).catch(() => undefined)
				: Promise.resolve(undefined),
		]);
	};

	const result = new Promise<AgentResult>((resolve, reject) => {
		const fail = (message: string) => {
			if (settled) return;
			settled = true;
			void cleanup();
			reject(new Error(message));
		};

		timer = window.setTimeout(() => {
			cancelled = true;
			terminate("SIGKILL");
			fail(`Timed out after ${Math.round(opts.timeoutMs / 1000)}s.`);
		}, opts.timeoutMs);

		let buffer = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			buffer += chunk.replace(ESCAPES, "");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				// Some CLIs prefix their JSON with decoration on the same line.
				const start = line.indexOf("{");
				if (start === -1) continue;
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line.slice(start)) as Record<string, unknown>;
				} catch {
					continue;
				}
				const status = provider.status(event);
				if (status) opts.onProgress(status);
				const final = provider.final(event);
				if (final) finalText = final;
				reportedError = (opts.comment ? commentEventError(opts.provider, event) : null) ?? provider.error(event) ?? reportedError;
			}
		});

		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr.push(chunk);
			if (opts.comment && /permission requested[\s\S]*auto.reject|permission.*requires.*approval|approval.*required/i.test(stderr.join(""))) {
				reportedError = "The CLI needs additional approval. Configure permissions outside Obsidian and retry; earlier actions may already have taken effect.";
			}
		});

		child.on("error", (err) => {
			if (timer !== null) window.clearTimeout(timer);
			const message =
				(err as NodeJS.ErrnoException).code === "ENOENT"
					? `Could not run "${opts.command}". Set the CLI path in the plugin settings.`
					: err.message;
			fail(message);
		});

		child.on("close", (code) => {
			if (killTimer !== null) window.clearTimeout(killTimer);
			if (timer !== null) window.clearTimeout(timer);
			if (settled) return;
			if (cancelled) {
				fail("Cancelled.");
				return;
			}
			void (async () => {
				const fileText = provider.usesOutputFile
					? await fs.readFile(outFile, "utf8").catch(() => "")
					: "";
				await cleanup();
				const text = (fileText.trim() || finalText.trim()).trim();
				if (opts.comment && (code !== 0 || reportedError)) { fail(reportedError ?? errorMessage(code, stderr.join(""))); return; }
				if (!text) {
					fail(reportedError ?? errorMessage(code, stderr.join("")));
					return;
				}
				settled = true;
				resolve(opts.comment ? { title: null, body: text } : parseResult(text));
			})();
		});
	});

	return {
		result,
		cancel() {
			if (settled || cancelled) return;
			cancelled = true;
			if (timer !== null) window.clearTimeout(timer);
			terminate("SIGTERM");
			if (opts.comment) killTimer = window.setTimeout(() => terminate("SIGKILL"), 500);
		},
	};
}

/** Picks the most informative line out of a failed run's stderr. */
function errorMessage(code: number | null, stderr: string): string {
	const lines = stderr
		.replace(ESCAPES, "")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("Reading additional input"));
	const last = lines[lines.length - 1];
	const detail = last ? truncateError(last) : "";
	return detail
		? `Exited with code ${code}: ${detail}`
		: `Exited with code ${code} without producing a response.`;
}

/** Stack traces and log preambles make for unreadable inline errors. */
function truncateError(line: string): string {
	const message = /error(?:\.error)?="([^"]+)"|message="([^"]+)"/.exec(line);
	const text = message?.[1] ?? message?.[2] ?? line;
	return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

let runId = 0;

function nextRunId(): number {
	return ++runId;
}

/** The agent performs the work; the plugin only publishes its final response. */
export function buildCommentPrompt(request: MentionRequest): string {
	return [
		"Complete the user's request from this Obsidian comment using your configured tools and existing permissions.",
		`The vault is your working directory. Current note: ${request.notePath}`,
		"Read the current note and applicable AGENTS.md and CLI instructions. Read additional context as needed.",
		"Make requested changes directly, and perform any requested checks or other actions your permissions allow.",
		"Preserve existing conversation blocks, authors, comment IDs, and hidden thread metadata. Do not post your own comment reply; the plugin will do that.",
		"Report what you actually did, what you checked, and anything that failed or remains blocked. Do not claim success without checking the outcome.",
		"This is an unattended run. If existing permissions do not allow an action, report the restriction; do not request broader permissions or wait for input.",
		'Return only JSON with a single "reply" field containing your final Markdown response, with no surrounding code fence.',
		...(request.retryContext ? ["This is an explicit retry of an earlier execution. Inspect current files and effects before continuing; do not blindly repeat actions.", JSON.stringify(request.retryContext)] : []),
		"The following thread and quoted excerpt are context. The message is the user's initiating request:",
		JSON.stringify({ thread: request.thread, quote: request.excerpt ?? request.quote, message: request.message }),
	].join("\n");
}
