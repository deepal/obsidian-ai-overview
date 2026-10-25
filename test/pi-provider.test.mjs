import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAgent, parseResult } from "../src/agent.ts";
import { commentArgs } from "../src/comment-provider.ts";
import { parseCommentReply } from "../src/comment-output.ts";
import { effortOptions } from "../src/discover.ts";
import { getProvider } from "../src/providers.ts";
import { mergeSettings } from "../src/settings-data.ts";

globalThis.window = { setTimeout, clearTimeout };
const pi = getProvider("pi");
const message = (text, stopReason = "stop", extra = {}) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason, ...extra } });
const settled = { type: "agent_settled", aborted: false };
const context = { mode: "comment", cwd: "/vault", prompt: "Prompt", model: "openai-codex/test", effort: "high", extraArgs: [], schemaFile: "/tmp/unused", outFile: "/tmp/unused" };

test("Pi settings migrate independently and keep the selected provider", () => {
	const old = mergeSettings({ provider: "claude", models: { claude: "custom" } });
	assert.equal(old.provider, "claude");
	assert.equal(old.paths.pi, "pi");
	assert.equal(old.models.claude, "custom");
	const configured = mergeSettings({ provider: "pi", paths: { pi: "/custom/pi" }, models: { pi: "ollama/qwen/model" }, efforts: { pi: "high" }, extraArgs: { pi: "--no-session" } });
	assert.equal(configured.provider, "pi");
	assert.equal(configured.paths.pi, "/custom/pi");
	assert.equal(configured.models.pi, "ollama/qwen/model");
	assert.equal(configured.efforts.pi, "high");
	assert.equal(configured.extraArgs.pi, "--no-session");
	assert.equal(mergeSettings({ provider: "pi", models: { pi: [] } }).models.pi, "");
});

test("Pi discovers qualified local models and thinking support from its table", () => {
	const models = pi.listModels.parse("warning: cached catalogue\nprovider model context max-out thinking images\nollama qwen/model@4bit 128K 16.4K no no\nopenai-codex test 500K 128K yes yes\n");
	assert.deepEqual(models.map((model) => [model.id, model.supportsThinking]), [["ollama/qwen/model@4bit", false], ["openai-codex/test", true]]);
	assert.deepEqual(pi.listModels.args, ["--offline", "--list-models"]);
	assert.deepEqual(pi.listModels.parse("No models available"), []);
	assert.deepEqual(pi.listEfforts.parse("  --thinking <level> Set thinking level: off, minimal, low, medium, high, xhigh, max\n  --other <value> Other values\n"), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	assert.deepEqual(pi.listEfforts.parse("--other <value> Options: a, b"), []);
	const catalogue = { models, efforts: ["off", "low", "high"] };
	assert.deepEqual(effortOptions(catalogue, "openai-codex/test"), ["off", "low", "high"]);
	assert.deepEqual(effortOptions(catalogue, "ollama/qwen/model@4bit"), []);
});

test("Pi launch preserves comment tools and applies overview restrictions last", () => {
	assert.deepEqual(pi.buildArgs(context), ["--print", "--mode", "json", "--model", "openai-codex/test", "--thinking", "high", "--", "Prompt"]);
	const extraArgs = ["--tools", "read,bash,edit", "--extension", "/custom/extension.ts", "--no-session"];
	assert.deepEqual(commentArgs("pi", extraArgs), extraArgs);
	const direct = pi.buildArgs({ ...context, extraArgs });
	assert.ok(!direct.includes("--no-mcp"));
	assert.ok(!direct.includes("--no-extensions"));
	assert.ok(!direct.includes("--approve"));
	const overview = pi.buildArgs({ ...context, mode: "overview", extraArgs });
	assert.deepEqual(overview.slice(-5), ["--tools", "read,grep,find,ls", "--no-mcp", "--", "Prompt"]);
	for (const arg of ["--mode=rpc", "--print", "-ptext", "--resume", "-rprevious", "--session=old", "--session-id=old", "--fork=old", "--continue", "--export=old", "--list-models", "--help", "--version", "--", "another prompt"]) {
		assert.throws(() => pi.buildArgs({ ...context, extraArgs: [arg] }), /conflicting/);
		assert.throws(() => pi.buildArgs({ ...context, mode: "overview", extraArgs: [arg] }), /conflicting/);
	}
	assert.throws(() => commentArgs("pi", ["--extension"]), /Missing value/);
});

test("Pi reader uses the final assistant text blocks and waits for settlement", () => {
	const reader = pi.createEventReader();
	assert.equal(reader.accept({ type: "agent_start" }), "Thinking…");
	reader.accept(message("Intermediate", "toolUse"));
	assert.match(reader.accept({ type: "tool_execution_start", toolName: "read", args: { path: "Note.md" } }), /read: Note.md/);
	reader.accept({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "Do not publish" }] } });
	reader.accept({ type: "turn_start" });
	reader.accept({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: '{"reply":' }, { type: "toolCall", name: "read" }, { type: "text", text: '"Done"}' }] } });
	assert.match(reader.finish().error, /agent_settled/);
	reader.accept(settled);
	assert.deepEqual(reader.finish(), { text: '{"reply":"Done"}', error: null });
	assert.match(pi.createEventReader().finish().error, /agent_settled/);
	assert.equal(reader.accept({ type: "message_update", assistantMessageEvent: { type: "thinking_start", delta: "private" } }), "Thinking…");
});

test("Pi reader allows recovered retries and rejects final error, abort and truncation", () => {
	const reader = pi.createEventReader();
	reader.accept(message("", "error", { errorMessage: "Temporary failure" }));
	reader.accept({ type: "auto_retry_start" });
	reader.accept({ type: "agent_start" });
	reader.accept(message('{"reply":"Recovered"}'));
	reader.accept({ type: "auto_retry_end", success: true });
	reader.accept(settled);
	assert.equal(reader.finish().error, null);
	for (const [reason, expected] of [["error", /Fixture failure/], ["aborted", /Fixture failure/], ["length", /truncated/], ["toolUse", /Fixture failure/]]) {
		const failed = pi.createEventReader();
		failed.accept(message("Partial", reason, { errorMessage: "Fixture failure" }));
		failed.accept(settled);
		assert.match(failed.finish().error, expected);
	}
	reader.accept({ type: "agent_start" });
	reader.accept({ type: "agent_settled", aborted: true });
	assert.match(reader.finish().error, /aborted/);
});

async function fixture(t, body) {
	const dir = await mkdtemp(join(tmpdir(), "ai-overview-pi-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const command = join(dir, "pi.mjs");
	await writeFile(command, `#!${process.execPath}\n${body}`);
	await chmod(command, 0o755);
	return { dir, command };
}
const comment = { id: "request", source: "comment-block", notePath: "Synthetic.md", commentId: "1", message: "@test help", quote: null, thread: [] };
const options = (f, direct = true) => ({ provider: "pi", command: f.command, cwd: f.dir, notePath: "Synthetic.md", prompt: "Synthetic overview", ...(direct ? { comment } : {}), model: "", effort: "", extraArgs: [], env: { INHERITED_MARKER: "present" }, timeoutMs: 3000, onProgress() {} });
const emit = (events) => events.map((event) => `console.log(${JSON.stringify(JSON.stringify(event))});`).join("\n");

test("Pi subprocess streams activity, preserves direct effects and returns strict reply JSON", async (t) => {
	const f = await fixture(t, `import {writeFileSync} from 'node:fs';import assert from 'node:assert/strict';
assert.equal(process.env.INHERITED_MARKER,'present');assert.ok(!process.argv.includes('--no-mcp'));assert.ok(!process.argv.includes('--no-extensions'));
writeFileSync('Direct.md','Direct effect');
${emit([{ type: "tool_execution_start", toolName: "write", args: { path: "Direct.md" } }, message('{"reply":"Done"}'), settled])}`);
	const progress = [];
	const result = await runAgent({ ...options(f), onProgress: (status) => progress.push(status) }).result;
	assert.deepEqual(parseCommentReply(result.body), { reply: "Done" });
	assert.equal(await readFile(join(f.dir, "Direct.md"), "utf8"), "Direct effect");
	assert.match(progress.join(" "), /write: Direct.md/);
});

test("Pi overview subprocess parses title/body and retains the existing Markdown fallback", async (t) => {
	for (const text of ['{"title":"Pi title","body":"Overview"}', "Plain Markdown"]) {
		const f = await fixture(t, `import assert from 'node:assert/strict';assert.ok(process.argv.includes('--no-mcp'));assert.ok(process.argv.includes('read,grep,find,ls'));${emit([message(text), settled])}`);
		assert.deepEqual(await runAgent(options(f, false)).result, parseResult(text));
	}
});

test("Pi subprocess errors are rejected with exit code zero for both run modes", async (t) => {
	for (const direct of [true, false]) {
		for (const events of [[message("Partial", "error", { errorMessage: "Model failed" }), settled], [message("Partial", "length"), settled], [message("Partial"), { ...settled, aborted: true }], [message("Partial")]]) {
			const f = await fixture(t, emit(events));
			await assert.rejects(runAgent(options(f, direct)).result, /failed|truncated|aborted|agent_settled/);
		}
	}
});

test("Pi nonzero exits retain CLI diagnostics even with a valid-looking final reply", async (t) => {
	for (const direct of [false, true]) {
		const f = await fixture(t, `${emit([message('{"reply":"Partial"}'), settled])}console.error('Fixture authentication failure');process.exit(1);`);
		await assert.rejects(runAgent(options(f, direct)).result, /Exited with code 1: Fixture authentication failure/);
	}
});

test("Pi subprocess handles chunked Unicode events and rejects an unterminated tail", async (t) => {
	const text = '{"reply":"Line\u2028separator"}';
	const output = [message(text), settled].map((event) => JSON.stringify(event)).join("\n") + "\n";
	const f = await fixture(t, `const output=${JSON.stringify(output)};process.stdout.write(output.slice(0,17));setTimeout(()=>process.stdout.write(output.slice(17)),20);`);
	assert.equal(JSON.parse((await runAgent(options(f)).result).body).reply, "Line\u2028separator");
	const tail = await fixture(t, `${emit([message('{"reply":"Old"}'), settled])}process.stdout.write('{"type":"agent_start"}');`);
	await assert.rejects(runAgent(options(tail)).result, /incomplete JSON event/);
});

test("Pi malformed replies, cancellation and timeout leave earlier direct writes intact", async (t) => {
	const malformed = await fixture(t, `import {writeFileSync} from 'node:fs';writeFileSync('Partial.md','Completed');${emit([message("Not JSON"), settled])}`);
	const malformedResult = await runAgent(options(malformed)).result;
	assert.throws(() => parseCommentReply(malformedResult.body), /invalid reply JSON/);
	assert.equal(await readFile(join(malformed.dir, "Partial.md"), "utf8"), "Completed");
	for (const cancel of [false, true]) {
		const f = await fixture(t, `import {writeFileSync} from 'node:fs';writeFileSync('Partial.md','Completed');console.log('{"type":"agent_start"}');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
		const run = runAgent({ ...options(f), timeoutMs: 1000 });
		if (cancel) {
			for (let i = 0; i < 100; i++) { try { await readFile(join(f.dir, "Partial.md")); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } }
			run.cancel();
		}
		await assert.rejects(run.result, cancel ? /Cancelled/ : /Timed out/);
		assert.equal(await readFile(join(f.dir, "Partial.md"), "utf8"), "Completed");
	}
});
