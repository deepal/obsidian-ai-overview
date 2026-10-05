import assert from "node:assert/strict";
import { test } from "node:test";
import { getProvider } from "../src/providers.ts";

const ctx = {
	cwd: "/vault",
	prompt: "PROMPT",
	extraArgs: ["--flag"],
	model: "some-model",
	schemaFile: "/tmp/schema.json",
	outFile: "/tmp/out",
};

test("codex passes the prompt last and wires up the schema", () => {
	const args = getProvider("codex").buildArgs(ctx);
	assert.equal(args[args.length - 1], "PROMPT");
	assert.ok(args.includes("--output-schema"));
	assert.equal(args[args.indexOf("--output-schema") + 1], "/tmp/schema.json");
	assert.equal(args[args.indexOf("--cd") + 1], "/vault");
	assert.ok(args.includes("--flag"));
});

test("claude passes the prompt first, ahead of the variadic tool options", () => {
	const args = getProvider("claude").buildArgs(ctx);
	assert.equal(args[0], "PROMPT");
	// A trailing prompt would be swallowed by --allowed-tools.
	assert.ok(args.indexOf("--allowed-tools") > 0);
	assert.ok(args.includes("--print"));
	assert.equal(args[args.indexOf("--disallowed-tools") + 1], "Edit,Write,NotebookEdit,Bash");
});

test("opencode passes the prompt last and sets the working directory", () => {
	const args = getProvider("opencode").buildArgs(ctx);
	assert.equal(args[0], "run");
	assert.equal(args[args.length - 1], "PROMPT");
	assert.equal(args[args.indexOf("--dir") + 1], "/vault");
});

test("codex reports commands and messages as progress", () => {
	const codex = getProvider("codex");
	assert.equal(codex.status({ type: "thread.started" }), "Thinking…");
	assert.equal(
		codex.status({
			type: "item.started",
			item: { type: "command_execution", command: `/bin/zsh -lc "sed -n '1,240p' a.md"` },
		}),
		"sed -n '1,240p' a.md"
	);
	assert.equal(
		codex.status({
			type: "item.completed",
			item: { type: "agent_message", text: "Reading the note." },
		}),
		"Reading the note."
	);
});

test("claude reports tool use and returns the result event", () => {
	const claude = getProvider("claude");
	assert.equal(
		claude.status({
			type: "assistant",
			message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a.md" } }] },
		}),
		"Read: a.md"
	);
	assert.equal(claude.final({ type: "result", result: "ANSWER" }), "ANSWER");
	assert.equal(claude.final({ type: "result", result: "x", is_error: true }), null);
	assert.equal(claude.error({ type: "result", result: "boom", is_error: true }), "boom");
});

test("opencode reads its flat part events", () => {
	const opencode = getProvider("opencode");
	assert.equal(opencode.status({ type: "step_start", part: { type: "step-start" } }), "Thinking…");
	assert.equal(
		opencode.status({
			type: "tool",
			part: { type: "tool", tool: "read", state: { input: { filePath: "a.md" } } },
		}),
		"read: a.md"
	);
	assert.equal(opencode.final({ type: "text", part: { type: "text", text: "ANSWER" } }), "ANSWER");
	assert.equal(
		opencode.error({
			type: "error",
			error: { name: "ProviderAuthError", data: { message: "key missing" } },
		}),
		"key missing"
	);
});

test("structured answers are kept out of the progress line", () => {
	const claude = getProvider("claude");
	for (const text of ['{"title": "x", "body": "y"}', '```json\n{"title": "x"}\n```']) {
		assert.equal(
			claude.status({ type: "assistant", message: { content: [{ type: "text", text }] } }),
			null
		);
	}
});

test("malformed events are ignored rather than throwing", () => {
	for (const id of ["codex", "claude", "opencode"]) {
		const provider = getProvider(id);
		for (const event of [{}, { type: 42 }, { type: "assistant", message: null }, { part: [] }]) {
			assert.doesNotThrow(() => provider.status(event));
			assert.doesNotThrow(() => provider.final(event));
			assert.doesNotThrow(() => provider.error(event));
		}
	}
});
