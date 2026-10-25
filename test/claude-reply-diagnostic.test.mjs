import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyze, buildPrompt, validateReply, REPLY_SCHEMA } from "../scripts/reproduce-claude-reply.mjs";
import { buildCommentPrompt } from "../src/agent.ts";
import { COMMENT_SCHEMA, parseCommentReply } from "../src/comment-output.ts";

test("standalone prompt and parser match the production comment contract", () => {
	const request = { notePath: "Folder/Note.md", message: "Summarize quotes and backslashes", thread: [], quote: null };
	assert.equal(buildPrompt(request.notePath, request.message), buildCommentPrompt(request));
	assert.deepEqual(REPLY_SCHEMA, COMMENT_SCHEMA);
	for (const raw of ['{"reply":"Done"}', '```json\n{"reply":"Done"}\n```', '{"reply":"Line one\\nLine two\\n\\\"quoted\\\""}', "plain Markdown", '{"reply":"raw\nnewline"}', '{"reply":"Done","changes":[]}', '{"reply":""}', "null", "[]", '{"reply":"unfinished']) {
		let accepted = true;
		try { parseCommentReply(raw); } catch { accepted = false; }
		assert.equal(validateReply(raw).state === "valid-reply", accepted, raw);
	}
});

test("diagnostic distinguishes CLI, permission, transport and reply syntax failures", () => {
	const result = (event, overrides = {}) => ({ stdout: JSON.stringify(event) + "\n", stderr: "", code: 0, signal: null, durationMs: 1, ...overrides });
	assert.equal(analyze(result({ type: "result", result: "Prose", structured_output: { reply: "Done" } })).state, "valid-reply");
	assert.equal(analyze(result({ type: "result", result: '{"reply":"Do not use fallback"}' })).state, "missing-structured-output");
	assert.equal(analyze(result({ type: "result", structured_output: { reply: "Done", extra: true } })).state, "invalid-shape");
	assert.equal(analyze(result({ type: "result", result: "Auth failed", is_error: true })).state, "cli-error");
	assert.equal(analyze(result({}, { stdout: [JSON.stringify({ type: "result", result: "Earlier failure", is_error: true }), JSON.stringify({ type: "result", result: '{"reply":"Done"}' }), ""].join("\n") })).state, "cli-error");
	assert.equal(analyze(result({ type: "result", result: '{"reply":"Partial"}', permission_denials: [{}] })).state, "permission-error");
	const tail = analyze(result({}, { stdout: '{"type":"result","result":"unfinished"}' }));
	assert.equal(tail.state, "incomplete-event");
	assert.equal(tail.unterminatedTail, true);
	assert.equal(analyze(result({}, { timedOut: true })).state, "timeout");
});

async function fixture(t, reply, timeout = false) {
	const root = await mkdtemp(join(tmpdir(), "claude-diagnostic-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const plugin = join(root, ".obsidian", "plugins", "different-folder-name");
	await mkdir(plugin, { recursive: true });
	await writeFile(join(root, "Note with spaces.md"), "Synthetic note");
	await writeFile(join(plugin, "manifest.json"), JSON.stringify({ id: "ai-overview" }));
	const command = join(root, "fake-claude.mjs");
	await writeFile(command, `#!${process.execPath}\nimport assert from 'node:assert/strict';
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('claude-fixture 1.0');
else {
 assert.deepEqual(args.slice(1), ['--print','--output-format','stream-json','--verbose','--json-schema',${JSON.stringify(JSON.stringify(COMMENT_SCHEMA))},'--model','fixture-model','--effort','high','--add-dir','shared context','--permission-prompts','none']);
 assert.equal(process.env.DIAGNOSTIC_SECRET_MARKER, 'private-fixture-value');
 assert.match(args[0], /Current note: Note with spaces.md/);
 assert.match(args[0], /Do not modify files/);
 console.log(JSON.stringify({type:'system',subtype:'init'}));
 ${timeout ? "setInterval(() => {}, 1000);" : `console.log(JSON.stringify({type:'result',is_error:false,result:'Prose to ignore',structured_output:${JSON.stringify(reply)}}));`}
}
`);
	await chmod(command, 0o755);
	await writeFile(join(plugin, "data.json"), JSON.stringify({ provider: "codex", paths: { claude: command }, models: { claude: "fixture-model" }, efforts: { claude: "high" }, extraArgs: { claude: '--add-dir "shared context"' }, env: 'DIAGNOSTIC_SECRET_MARKER="private-fixture-value"', timeoutSeconds: 1 }));
	return { root };
}

async function execute(args) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["scripts/reproduce-claude-reply.mjs", ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

for (const [name, reply, expected, code, count] of [
	["valid replies", { reply: "Done" }, "valid-reply", 0, 2],
	["malformed replies", { reply: "Done", extra: true }, "invalid-shape", 1, 1],
	["timeouts", "", "timeout", 2, 1],
]) {
	test(`standalone command captures ${name}, reuses configuration and stops correctly`, async (t) => {
		const f = await fixture(t, reply, expected === "timeout");
		const run = await execute(["--vault", f.root, "--note", "Note with spaces.md", "--runs", "2"]);
		assert.equal(run.code, code, run.stdout + run.stderr);
		const output = /^Diagnostics: (.+)$/m.exec(run.stdout)?.[1];
		assert.ok(output, run.stdout + run.stderr);
		t.after(() => rm(output, { recursive: true, force: true }));
		const summaryText = await readFile(join(output, "summary.json"), "utf8");
		const summary = JSON.parse(summaryText);
		assert.equal(summary.claudeVersion, "claude-fixture 1.0");
		assert.equal(summary.runs.length, count);
		assert.equal(summary.runs.at(-1).state, expected);
		assert.ok(!summaryText.includes("private-fixture-value"));
		assert.ok((await readdir(output)).includes("run-01.stdout.jsonl"));
		assert.equal(await readFile(join(output, "run-01.reply.txt"), "utf8"), expected === "timeout" ? "" : JSON.stringify(reply));
		assert.equal(await readFile(join(f.root, "Note with spaces.md"), "utf8"), "Synthetic note");
	});
}
