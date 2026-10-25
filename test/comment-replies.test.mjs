import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildCommentPrompt, runAgent, runCommentAgent } from "../src/agent.ts";
import { COMMENT_SCHEMA, parseAgentCommentReply } from "../src/comment-output.ts";
import { CommentJobs, parseSavedJobs } from "../src/comment-jobs.ts";
import { getProvider } from "../src/providers.ts";

globalThis.window = { setTimeout, clearTimeout };
const request = { id: "request", source: "comment-block", notePath: "Note.md", commentId: "1", message: "Review the note", quote: null, thread: [], retryContext: { attempt: 2, previousError: "Earlier work may have completed" } };
const md = '## Checked\n\nA "quote", a backslash \\ and Unicode 文\u2028字.\n\n```json\n{"reply":"literal example"}\n```';
const context = { mode: "comment", cwd: "/vault", prompt: "Prompt", model: "", effort: "", extraArgs: [], schemaFile: "/tmp/schema", outFile: "/tmp/output" };
const event = (type, messageID = "m", extra = {}, sessionID = "s") => ({ type, sessionID, part: { type: ({ step_start: "step-start", step_finish: "step-finish" })[type] ?? type, sessionID, messageID, ...extra } });
const text = (value, id = "t", message = "m") => event("text", message, { id, text: value, time: { end: 1 } });
const end = (reason = "stop", message = "m") => event("step_finish", message, { reason });
const piEvents = (value) => [{ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: value }] } }, { type: "agent_settled", aborted: false }];
const openEvents = (value) => [event("step_start"), text(value), end()];

test("comment prompts use the provider contract and keep task, permissions and retry context", () => {
	for (const id of ["codex", "claude", "opencode", "pi"]) {
		const provider = getProvider(id);
		const prompt = buildCommentPrompt(request, provider.commentReplyFormat);
		assert.match(prompt, /Inspect current files and effects/);
		assert.match(prompt, /existing permissions/);
		assert.match(prompt, /Preserve existing conversation blocks/);
		assert.match(prompt, /Review the note/);
		assert.match(prompt, provider.commentReplyFormat === "json" ? /Return only JSON/ : /directly as Markdown/);
	}
	assert.deepEqual(parseAgentCommentReply(` \n${md}\n `, "markdown"), { reply: md });
	assert.deepEqual(parseAgentCommentReply('{"reply":"literal"}', "markdown"), { reply: '{"reply":"literal"}' });
	assert.throws(() => parseAgentCommentReply(" \n", "markdown"), /empty Markdown/);
	assert.throws(() => parseAgentCommentReply(md, "json"), /invalid reply JSON/);
});

test("Claude enforces only the comment schema and leaves overview transport unchanged", () => {
	const claude = getProvider("claude");
	const args = claude.buildArgs(context);
	assert.deepEqual(JSON.parse(args[args.indexOf("--json-schema") + 1]), COMMENT_SCHEMA);
	assert.ok(args.includes("stream-json"));
	assert.ok(!claude.buildArgs({ ...context, mode: "overview" }).includes("--json-schema"));
	assert.equal(claude.createEventReader("overview"), undefined);
	assert.equal(claude.final({ type: "result", result: "Overview", structured_output: { reply: "Ignore" } }), "Overview");
	const reader = claude.createEventReader("comment");
	reader.accept({ type: "result", subtype: "success", result: "Prose is not the schema result", structured_output: { reply: md } });
	assert.deepEqual(parseAgentCommentReply(reader.finish().text, "json"), { reply: md });
	for (const value of [undefined, null, "prose", [], {}, { reply: "" }, { reply: "  " }, { reply: 42 }, { reply: "x", changes: [] }]) {
		const failed = claude.createEventReader("comment");
		failed.accept({ type: "result", result: '{"reply":"Do not fall back"}', structured_output: value });
		assert.match(failed.finish().error, /structured/);
	}
	for (const value of [{ is_error: true }, { subtype: "error_max_turns" }]) {
		const failed = claude.createEventReader("comment");
		failed.accept({ type: "result", structured_output: { reply: "Partial" }, ...value });
		assert.match(failed.finish().error, /did not complete/);
	}
	assert.match(claude.createEventReader("comment").finish().error, /final result/);
});

test("OpenCode assembles completed parts, replaces snapshots, and selects the latest message", () => {
	const provider = getProvider("opencode");
	assert.equal(provider.createEventReader("overview"), undefined);
	const reader = provider.createEventReader("comment");
	for (const item of [event("step_start", "old"), text("Intermediate", "old-text", "old"), end("tool-calls", "old"), event("step_start"), text("Old snapshot"), text(md), text("Second paragraph", "t2"), end(), text("Late old snapshot", "old-text", "old"), event("text", "foreign", { id: "foreign", text: "Ignore", time: { end: 1 } }, "other-session")]) reader.accept(item);
	assert.deepEqual(reader.finish(), { text: md + "\n\nSecond paragraph", error: null });
	assert.match(provider.createEventReader("comment").finish().error, /completed final/);
});

test("OpenCode rejects incomplete, truncated, empty, unknown and tool-only final messages", () => {
	const cases = [
		[event("step_start"), text(md)],
		[event("step_start"), text(md), end("length")],
		[event("step_start"), text(md), end("tool-calls")],
		[event("step_start"), text(md), end("unknown")],
		[event("step_start"), text("  "), end()],
		[event("step_start"), text(md), end(), event("step_start", "next")],
		[event("step_start"), { ...text(md), part: { ...text(md).part, time: {} } }, end()],
		[{ type: "text", part: { type: "text", text: md } }, end()],
		[...openEvents(md), { type: "step_start", part: { type: "step-start", messageID: "next" } }],
	];
	for (const events of cases) {
		const reader = getProvider("opencode").createEventReader("comment");
		for (const item of events) reader.accept(item);
		assert.ok(reader.finish().error, JSON.stringify(events));
	}
});

async function fixture(t, events, { code = 0, tail = "", delayed = false } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "comment-replies-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const command = join(dir, "agent.mjs");
	await writeFile(command, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
writeFileSync('Effect.md','Completed once');
const output=${JSON.stringify(events.map((item) => JSON.stringify(item)).join("\n") + "\n" + tail)};
${delayed ? "process.stdout.write(output.slice(0, 19));setTimeout(()=>{process.stdout.write(output.slice(19));process.exit(" + code + ");},30);" : "process.stdout.write(output);process.exit(" + code + ");"}
`);
	await chmod(command, 0o755);
	return { dir, command };
}
const options = (f, provider) => ({ provider, command: f.command, cwd: f.dir, notePath: "Note.md", prompt: "Test", comment: request, model: "", effort: "", extraArgs: [], env: {}, timeoutMs: 1000, onProgress() {} });

for (const provider of ["opencode", "pi"]) {
	test(`${provider} publishes Markdown literally and freezes its contract during execution`, async (t) => {
		const events = provider === "pi" ? piEvents(md) : openEvents(md);
		const f = await fixture(t, events, { delayed: true });
		const opts = options(f, provider);
		const run = runCommentAgent(opts);
		opts.provider = "claude";
		assert.deepEqual(await run.result, { reply: md });
		assert.equal(await readFile(join(f.dir, "Effect.md"), "utf8"), "Completed once");
		for (const overrides of [{ code: 1 }, { tail: '{"incomplete":' }]) {
			const failed = await fixture(t, events, overrides);
			await assert.rejects(runCommentAgent(options(failed, provider)).result, /Exited|incomplete JSON event/);
		}
	});
}

test("Claude subprocess accepts native schema output and rejects prose fallback, refusal and partial streams", async (t) => {
	const f = await fixture(t, [{ type: "result", result: "Plain prose", structured_output: { reply: md } }], { delayed: true });
	assert.deepEqual(await runCommentAgent(options(f, "claude")).result, { reply: md });
	for (const events of [[{ type: "result", result: '{"reply":"Old shape"}' }], [{ type: "result", is_error: true, result: "Refused", structured_output: { reply: "Partial" } }], [{ type: "result", subtype: "error_max_turns", structured_output: { reply: "Partial" } }]]) {
		const failed = await fixture(t, events);
		await assert.rejects(runCommentAgent(options(failed, "claude")).result, /structured_output|Refused|did not complete/);
	}
	const tail = await fixture(t, [{ type: "result", structured_output: { reply: md } }], { tail: "{" });
	await assert.rejects(runCommentAgent(options(tail, "claude")).result, /incomplete JSON event/);
});

test("overview extraction remains independent of comment completion and Markdown rules", async (t) => {
	for (const [provider, events] of [["claude", [{ type: "result", result: '{"title":"T","body":"B"}' }]], ["opencode", [{ type: "text", part: { type: "text", text: '{"title":"T","body":"B"}' } }]]]) {
		const f = await fixture(t, events);
		assert.deepEqual(await runAgent({ ...options(f, provider), comment: undefined }).result, { title: "T", body: "B" });
	}
});

test("normalized Markdown is saved before publication and retries never repeat execution", async (t) => {
	const f = await fixture(t, openEvents(md));
	let runs = 0, publications = 0, saved;
	const jobs = new CommentJobs({ persist: async (data) => { saved = structuredClone(data); }, launch: () => { runs++; return runCommentAgent(options(f, "opencode")); }, apply: async () => assert.fail("No planned changes") });
	jobs.configure("test");
	jobs.attach("comment-block", { prepare: async () => {}, validate: async () => true, publish: async (_request, _author, body) => {
		assert.equal(saved[0].result.reply, md);
		assert.equal(body, md);
		if (++publications === 1) throw new Error("Editor conflict");
	} });
	await jobs.submit(request);
	const wait = async (state) => { for (let i = 0; i < 200; i++) { if (jobs.jobs("comment-block", "Note.md")[0]?.state === state) return; await new Promise((resolve) => setTimeout(resolve, 5)); } assert.fail(state); };
	await wait("failed");
	assert.equal(parseSavedJobs(saved)[0].result.reply, md);
	await jobs.retry(request.id);
	await wait("completed");
	assert.equal(runs, 1);
	assert.equal(publications, 2);
});
