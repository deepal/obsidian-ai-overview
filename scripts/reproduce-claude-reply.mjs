#!/usr/bin/env node
// Standalone: copy this file to the affected machine; Node 18+ and Claude Code are sufficient.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `Reproduce AI Overview / Discussions Claude reply parsing (Node 18+).

  node reproduce-claude-reply.mjs --vault /path/to/vault --note "Folder/Note.md" --runs 10

Options:
  --vault PATH         Required vault working directory.
  --note PATH          Required existing Markdown note, relative to the vault.
  --runs NUMBER        Maximum fresh CLI calls; stops on first failure (default 5).
  --message-file PATH  Optional custom comment text. This executes that request;
                       the default request only asks Claude to read and summarize.
  --plugin-dir PATH    Override AI Overview settings directory if discovery is ambiguous.
  --help              Show this help.

Loads Claude's executable, model, effort, extra arguments, environment and timeout
from AI Overview's data.json. Uses the plugin's prompt framing and stream-json
transport, with the comment reply schema. Retains private diagnostic files under the
system temporary directory and prints their location. Calls use normal Claude
authentication and usage. Terminal environment may differ from Obsidian's.
`;

export const REPLY_SCHEMA = { type: "object", properties: { reply: { type: "string" } }, required: ["reply"], additionalProperties: false };

function options(argv) {
	const values = { runs: "5" };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--help") return null;
		const key = argv[i].replace(/^--/, "");
		if (!argv[i].startsWith("--") || !["vault", "note", "runs", "message-file", "plugin-dir"].includes(key) || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Invalid option: ${argv[i]}. Use --help.`);
		values[key] = argv[++i];
	}
	if (!values.vault || !values.note) throw new Error("Supply --vault and --note. Use --help.");
	if (!/^\d+$/.test(values.runs) || !Number.isSafeInteger(Number(values.runs)) || Number(values.runs) < 1) throw new Error("--runs must be a positive integer.");
	return values;
}

// Kept identical to buildCommentPrompt for a new request without retryContext.
export function buildPrompt(notePath, message) {
	return [
		"Complete the user's request from this Obsidian comment using your configured tools and existing permissions.",
		`The vault is your working directory. Current note: ${notePath}`,
		"Read the current note and applicable AGENTS.md and CLI instructions. Read additional context as needed.",
		"Make requested changes directly, and perform any requested checks or other actions your permissions allow.",
		"Preserve existing conversation blocks, authors, comment IDs, and hidden thread metadata. Do not post your own comment reply; the plugin will do that.",
		"Report what you actually did, what you checked, and anything that failed or remains blocked. Do not claim success without checking the outcome.",
		"This is an unattended run. If existing permissions do not allow an action, report the restriction; do not request broader permissions or wait for input.",
		'Return only JSON with a single "reply" field containing your final Markdown response, with no surrounding code fence.',
		"The following thread and quoted excerpt are context. The message is the user's initiating request:",
		JSON.stringify({ thread: [], quote: null, message }),
	].join("\n");
}

// Same fence handling and acceptance checks as parseCommentReply.
export function validateReply(text) {
	let value;
	try {
		value = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```$/, ""));
	} catch (error) {
		return { state: "invalid-json", error: error.message };
	}
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !("reply" in value) || typeof value.reply !== "string" || !value.reply.trim()) return { state: "invalid-shape" };
	return { state: "valid-reply" };
}

function splitArgs(raw) {
	return (raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((arg) => arg.replace(/^["']|["']$/g, ""));
}

async function settingsDirectory(vault, override) {
	if (override) return path.resolve(override);
	const root = path.join(vault, ".obsidian", "plugins");
	const candidates = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		try {
			const dir = path.join(root, entry.name);
			if (JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")).id === "ai-overview") candidates.push(dir);
		} catch { /* Other plugin directories need not contain valid manifests. */ }
	}
	if (candidates.length !== 1) throw new Error(`Found ${candidates.length} AI Overview installations. Supply --plugin-dir with its settings directory.`);
	return candidates[0];
}

export async function runDiagnostic(argv) {
	const opts = options(argv);
	if (!opts) { console.log(HELP); return 0; }
	const vault = await realpath(opts.vault);
	const note = await realpath(path.resolve(vault, opts.note));
	const notePath = path.relative(vault, note);
	if (notePath === ".." || notePath.startsWith(`..${path.sep}`) || path.isAbsolute(notePath) || !note.endsWith(".md") || !(await stat(note)).isFile()) throw new Error("--note must identify an existing Markdown file inside --vault.");
	const pluginDir = await settingsDirectory(vault, opts["plugin-dir"]);
	const config = JSON.parse(await readFile(path.join(pluginDir, "data.json"), "utf8"));
	const command = config.paths?.claude?.trim() || "claude";
	const model = config.models?.claude?.trim() || "";
	const effort = config.efforts?.claude?.trim() || "";
	const extraArgs = splitArgs(config.extraArgs?.claude || "");
	// Refuse transport/session overrides that would change the behavior under diagnosis.
	const reserved = ["--verbose", "--no-verbose", "--output-format", "--input-format", "--json-schema", "--permission-prompts", "--permission-prompt-tool", "--print", "-p", "--continue", "-c", "--resume", "-r", "--session-id", "--fork-session"];
	for (const arg of extraArgs) if (reserved.includes(arg.split("=", 1)[0]) || /^-[pcr].+/.test(arg)) throw new Error(`Conflicting configured extra argument: ${arg}`);
	const message = opts["message-file"] ? await readFile(path.resolve(opts["message-file"]), "utf8") : "Read this note and summarize it in three Markdown bullet points. Include a short quoted phrase and a fenced example containing quotes and a backslash. Do not modify files, run commands, send messages, or take other external actions.";
	if (!message.trim()) throw new Error("The comment text is empty.");
	const prompt = buildPrompt(notePath.split(path.sep).join("/"), message);
	const args = [prompt, "--print", "--output-format", "stream-json", "--verbose", "--json-schema", JSON.stringify(REPLY_SCHEMA)];
	if (model) args.push("--model", model);
	if (effort) args.push("--effort", effort);
	args.push(...extraArgs, "--permission-prompts", "none");
	const env = { ...process.env };
	for (const line of (config.env || "").split("\n")) {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
		if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
	}
	// Match the plugin's PATH augmentation; environment override of PATH is ignored there.
	env.PATH = [...new Set([...(process.env.PATH || "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", path.join(homedir(), ".local/bin"), path.join(homedir(), ".bun/bin"), path.join(homedir(), ".cargo/bin"), "/usr/bin", "/bin"])].join(":");
	const timeoutMs = (Number.isSafeInteger(config.timeoutSeconds) && config.timeoutSeconds > 0 ? config.timeoutSeconds : 300) * 1000;
	const output = await mkdtemp(path.join(tmpdir(), "claude-reply-repro-"));
	const save = (name, text) => writeFile(path.join(output, name), text, { mode: 0o600 });
	console.log(`Diagnostics: ${output}\nClaude model: ${model || "CLI default"}; effort: ${effort || "CLI default"}\nUp to ${opts.runs} calls; stops on the first failure.`);
	await save("prompt.txt", prompt);
	// No environment values or configured extra arguments are copied into metadata.
	const summary = { startedAt: new Date().toISOString(), command, model, effort, timeoutMs, node: process.version, platform: process.platform, runs: [] };
	const version = await capture(command, ["--version"], { cwd: vault, env, timeoutMs: 10000 });
	summary.claudeVersion = version.code === 0 ? version.stdout.trim() : "Version lookup failed; see version.txt";
	await save("version.txt", version.stdout + version.stderr);
	console.log(`Claude version: ${summary.claudeVersion}`);
	for (let index = 1; index <= Number(opts.runs); index++) {
		console.log(`Attempt ${index}/${opts.runs}…`);
		const result = await capture(command, args, { cwd: vault, env, timeoutMs });
		const stem = `run-${String(index).padStart(2, "0")}`;
		await save(`${stem}.stdout.jsonl`, result.stdout);
		await save(`${stem}.stderr.txt`, result.stderr);
		const analysis = analyze(result);
		await save(`${stem}.reply.txt`, analysis.reply);
		const { reply: _reply, ...report } = analysis;
		summary.runs.push({ attempt: index, ...report });
		await save("summary.json", JSON.stringify(summary, null, 2) + "\n");
		console.log(`${analysis.state}${analysis.error ? `: ${analysis.error}` : ""}`);
		if (analysis.state !== "valid-reply") {
			console.log(`Inspect ${stem}.reply.txt and ${stem}.stdout.jsonl in ${output}.`);
			return ["invalid-json", "invalid-shape", "missing-structured-output"].includes(analysis.state) ? 1 : 2;
		}
	}
	console.log(`No malformed reply observed in ${opts.runs} calls. This does not rule out an intermittent failure.\nResults: ${output}`);
	return 0;
}

export function analyze(result) {
	// The plugin processes only newline-terminated events. Record unterminated tails
	// separately so an output transport problem is not confused with reply syntax.
	const lines = result.stdout.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
	const tail = lines.pop();
	let final, reply = "", reportedError, permissionDenied = false;
	for (const line of lines) {
		try {
			const start = line.indexOf("{");
			if (start < 0) continue;
			const event = JSON.parse(line.slice(start));
			if (event.type === "result") {
				final = event;
				if (event.is_error === true || typeof event.subtype === "string" && event.subtype !== "success") reportedError = event.result || event.subtype || "The run failed.";
				else reply = event.structured_output === undefined ? "" : JSON.stringify(event.structured_output);
			}
			if (event.type === "permission_denied" || event.subtype === "permission_denied" || Array.isArray(event.permission_denials) && event.permission_denials.length) permissionDenied = true;
		} catch { /* Same event framing as the plugin. Raw output is retained. */ }
	}
	const base = { reply, exitCode: result.code, signal: result.signal, unterminatedTail: !!tail?.trim(), subtype: final?.subtype, durationMs: result.durationMs };
	if (result.timedOut) return { ...base, state: "timeout" };
	if (result.error || result.code !== 0 || reportedError) return { ...base, state: "cli-error", error: result.error || reportedError || `CLI exited with code ${result.code}` };
	if (permissionDenied || /permission requested[\s\S]*auto.reject|permission.*requires.*approval|approval.*required/i.test(result.stderr)) return { ...base, state: "permission-error" };
	if (base.unterminatedTail) return { ...base, state: "incomplete-event" };
	if (!final) return { ...base, state: "missing-reply" };
	if (!reply) return { ...base, state: "missing-structured-output", error: "Claude did not return the required structured_output; prose result is not a schema reply." };
	return { ...base, ...validateReply(reply) };
}

function capture(command, args, { cwd, env, timeoutMs }) {
	return new Promise((resolve) => {
		const started = Date.now();
		const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
		let stdout = "", stderr = "", error, timedOut = false;
		child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
		const kill = () => {
			try { if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already exited. */ }
		};
		const interrupt = () => { error = "Interrupted"; kill(); };
		process.once("SIGINT", interrupt);
		process.once("SIGTERM", interrupt);
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, timeoutMs);
		child.on("error", (err) => { error = err.message; });
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			process.removeListener("SIGINT", interrupt);
			process.removeListener("SIGTERM", interrupt);
			resolve({ stdout, stderr, code, signal, error, timedOut, durationMs: Date.now() - started });
		});
	});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runDiagnostic(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.message); process.exitCode = 2; });
}
