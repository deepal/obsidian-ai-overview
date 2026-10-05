import assert from "node:assert/strict";
import { test } from "node:test";
import { effortOptions } from "../src/discover.ts";
import { getProvider, parseHelpChoices } from "../src/providers.ts";

// Trimmed from `codex debug models`.
const CODEX_MODELS = JSON.stringify({
	models: [
		{
			slug: "gpt-5.6-luna",
			display_name: "GPT-5.6-Luna",
			visibility: "list",
			priority: 3,
			default_reasoning_level: "medium",
			supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
		},
		{
			slug: "gpt-5.6-sol",
			display_name: "GPT-5.6-Sol",
			visibility: "list",
			priority: 1,
			supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }],
		},
		{
			slug: "codex-auto-review",
			display_name: "Codex Auto Review",
			visibility: "hide",
			priority: 43,
			supported_reasoning_levels: [{ effort: "low" }],
		},
	],
});

// Trimmed from `opencode models --verbose`: an id line, then its JSON object.
const OPENCODE_MODELS = `google/gemini-2.5-flash
{
  "id": "gemini-2.5-flash",
  "providerID": "google",
  "name": "Gemini 2.5 Flash",
  "variants": { "low": { "thinkingConfig": { "thinkingLevel": "low" } }, "high": {} }
}
opencode/big-pickle
{
  "id": "big-pickle",
  "providerID": "opencode",
  "name": "Big Pickle"
}
`;

// Trimmed from `claude --help`, including its line wrapping.
const CLAUDE_HELP = `  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --fallback-model <model>              Enable automatic fallback (a, b)
`;

test("codex models are ordered by priority and hidden ones dropped", () => {
	const models = getProvider("codex").listModels.parse(CODEX_MODELS);
	assert.deepEqual(
		models.map((m) => m.id),
		["gpt-5.6-sol", "gpt-5.6-luna"]
	);
	assert.equal(models[0].label, "GPT-5.6-Sol");
	assert.deepEqual(models[1].efforts, ["low", "high"]);
});

test("codex listing tolerates surrounding log output", () => {
	const noisy = `warning: something\n${CODEX_MODELS}\n`;
	assert.equal(getProvider("codex").listModels.parse(noisy).length, 2);
});

test("opencode models are qualified by provider and carry variants", () => {
	const models = getProvider("opencode").listModels.parse(OPENCODE_MODELS);
	assert.deepEqual(
		models.map((m) => m.id),
		["google/gemini-2.5-flash", "opencode/big-pickle"]
	);
	assert.equal(models[0].label, "google/gemini-2.5-flash — Gemini 2.5 Flash");
	assert.deepEqual(models[0].efforts, ["low", "high"]);
	assert.deepEqual(models[1].efforts, []);
});

test("claude has no model listing", () => {
	assert.equal(getProvider("claude").listModels, null);
});

test("claude effort levels are read from its help output", () => {
	assert.deepEqual(getProvider("claude").listEfforts.parse(CLAUDE_HELP), [
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
});

test("help parsing returns nothing for an absent option", () => {
	assert.deepEqual(parseHelpChoices(CLAUDE_HELP, "--nonexistent"), []);
});

test("help parsing handles a quoted choices list beside a type annotation", () => {
	// The yargs style opencode uses.
	const help = `      --log-level  log level [string] [choices: "DEBUG", "INFO", "WARN"]\n`;
	assert.deepEqual(parseHelpChoices(help, "--log-level"), ["DEBUG", "INFO", "WARN"]);
});

const catalogue = (models, efforts = []) => ({
	models,
	efforts,
	supportsModelListing: true,
	supportsEffortListing: true,
	error: null,
});

test("effort options come from the selected model", () => {
	const c = catalogue([
		{ id: "a", label: "a", efforts: ["low", "high"] },
		{ id: "b", label: "b", efforts: ["minimal"] },
	]);
	assert.deepEqual(effortOptions(c, "b"), ["minimal"]);
});

test("with no model pinned, every reported level is offered once", () => {
	const c = catalogue([
		{ id: "a", label: "a", efforts: ["low", "high"] },
		{ id: "b", label: "b", efforts: ["high", "max"] },
	]);
	assert.deepEqual(effortOptions(c, ""), ["low", "high", "max"]);
});

test("a global list is used when models report no levels", () => {
	const c = catalogue([{ id: "a", label: "a", efforts: [] }], ["low", "max"]);
	assert.deepEqual(effortOptions(c, ""), ["low", "max"]);
});

test("a model that reports no levels offers none", () => {
	const c = catalogue([{ id: "a", label: "a", efforts: [] }], ["low"]);
	assert.deepEqual(effortOptions(c, "a"), []);
});
