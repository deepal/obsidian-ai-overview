import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeSettings, DEFAULT_SETTINGS } from "../src/settings-data.ts";

test("missing or invalid stored settings fall back to defaults", () => {
	for (const value of [undefined, null, [], "invalid", 42]) {
		assert.deepEqual(mergeSettings(value), DEFAULT_SETTINGS);
	}
});

test("provider values, secrets, and legacy settings survive migration", () => {
	const value = mergeSettings({ provider: "opencode", models: { opencode: "local/test", claude: "custom" }, paths: { opencode: "/tmp/agent" }, codexPath: "/tmp/codex", model: "legacy", extraArgs: "--legacy", env: "EXAMPLE=local-test", timeoutSeconds: 10 });
	assert.equal(value.provider, "opencode");
	assert.equal(value.models.opencode, "local/test");
	assert.equal(value.models.claude, "custom");
	assert.equal(value.models.codex, "legacy");
	assert.equal(value.paths.codex, "/tmp/codex");
	assert.equal(value.extraArgs.codex, "--legacy");
	assert.equal(value.env, "EXAMPLE=local-test");
	assert.equal(value.timeoutSeconds, 10);
	assert.equal(DEFAULT_SETTINGS.models.codex, "");
});

test("malformed nested values cannot leak into CLI arguments", () => {
	const value = mergeSettings({ provider: "unknown", paths: { codex: "  ", claude: 1 }, models: "bad", efforts: { codex: false }, extraArgs: { opencode: [] }, env: {}, timeoutSeconds: -1 });
	assert.deepEqual(value, DEFAULT_SETTINGS);
	assert.equal(mergeSettings({ timeoutSeconds: 1.2 }).timeoutSeconds, 300);
});
