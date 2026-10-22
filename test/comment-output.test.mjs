import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommentResult, safeReplacement, validateNotePath } from "../src/comment-output.ts";
import { restrictedCommentArgs, restrictedCommentEnv } from "../src/comment-provider.ts";
import { safeCodexDefaults } from "../src/comment-config.ts";
import { mergeSettings } from "../src/settings-data.ts";

test("comment output requires an explicit reply and valid note operations", () => {
	assert.deepEqual(parseCommentResult('{"reply":"Answer","changes":[]}'), { reply: "Answer", changes: [] });
	for (const text of ["plain answer", "null", '{"reply":"","changes":[]}', '{"reply":"x","changes":[{"kind":"delete","path":"A.md"}]}', '{"reply":"x","changes":[{"kind":"replace","path":"A.md","oldText":"","newText":"x"}]}']) assert.throws(() => parseCommentResult(text));
});
test("only visible vault-relative Markdown paths are accepted", () => {
	validateNotePath("Folder/Note.md");
	for (const path of ["../Outside.md", "/Outside.md", "Folder/../Note.md", ".obsidian/config.md", "Folder//Note.md", "C:\\Note.md", "Note.txt", "a\u0000.md"]) assert.throws(() => validateNotePath(path));
});
test("exact replacements preserve surrounding edits and reject ambiguity", () => {
	const change = { kind: "replace", path: "A.md", oldText: "old", newText: "new" };
	assert.equal(safeReplacement("User addition\nold\nTail", change), "User addition\nnew\nTail");
	assert.equal(safeReplacement("old %% old %%", change), "new %% old %%");
	assert.throws(() => safeReplacement("old old", change)); assert.throws(() => safeReplacement("changed", change));
	for (const text of ["%% old %%", '<comment id="1">old</comment>', "<discussion>old</discussion>"]) assert.throws(() => safeReplacement(text, change));
	assert.throws(() => safeReplacement("old", { ...change, newText: "%% forged %%" }));
});
test("name tags are opt-in, normalized and validated", () => {
	assert.equal(mergeSettings({}).agentNameTag, ""); assert.equal(mergeSettings({ agentNameTag: " @teddy " }).agentNameTag, "teddy");
	assert.equal(mergeSettings({ agentNameTag: "two words" }).agentNameTag, "");
});
test("comment CLI restrictions cannot be replaced by extra arguments", () => {
	for (const provider of ["codex", "claude", "opencode"]) {
		for (const args of [["--dangerously-bypass-approvals-and-sandbox"], ["--agent", "build"], ["--tools", "Bash"], ["-c", "approval_policy=never"]]) assert.throws(() => restrictedCommentArgs(provider, args));
	}
	assert.ok(restrictedCommentArgs("codex", ["-c", "model_verbosity=low"]).includes("--ignore-user-config"));
	assert.ok(restrictedCommentArgs("claude", []).includes("--strict-mcp-config"));
	const config = JSON.parse(restrictedCommentEnv("opencode").OPENCODE_CONFIG_CONTENT);
	assert.equal(config.permission, "deny");
	assert.equal(config.agent["aio-comment-reader"].permission["*"], "deny");
	assert.equal(config.agent["aio-comment-reader"].permission.read, "allow");
});

test("Codex defaults preserve model routing without inheriting executable configuration", () => {
 const config=`model = "configured-model"
model_provider = "local"
model_reasoning_effort = "high"
[model_providers.local]
name = "Local model"
base_url = "http://localhost:1234/v1"
env_key = "LOCAL_MODEL_KEY"
wire_api = "responses"
[mcp_servers.unwanted]
command = "unwanted-command"
[hooks.SessionStart]
command = "unwanted-hook"
`;
 const inherited=safeCodexDefaults(config,"","").join(" ");
 assert.match(inherited,/configured-model/);assert.match(inherited,/model_providers/);assert.match(inherited,/localhost:1234/);
 assert.doesNotMatch(inherited,/unwanted/);
 const explicit=safeCodexDefaults(config,"explicit-model","low").join(" ");
 assert.doesNotMatch(explicit,/configured-model|model_reasoning_effort/);
 assert.throws(()=>safeCodexDefaults('api_key_helper = "execute something"',"",""),/api_key_helper/);
});
