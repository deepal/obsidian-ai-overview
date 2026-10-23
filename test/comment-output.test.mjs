import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommentReply, parseCommentResult, safeReplacement, validateNotePath } from "../src/comment-output.ts";
import { commentArgs, commentEventError } from "../src/comment-provider.ts";
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
test("reply-only output rejects planned edits, empty replies and malformed results", () => {
 assert.deepEqual(parseCommentReply('{"reply":"Done"}'),{reply:"Done"});
 for(const text of ['{"reply":"Done","changes":[]}','{"reply":""}','null','[]','plain answer'])assert.throws(()=>parseCommentReply(text));
});

test("comment arguments retain user permissions, tools and profiles but reserve transport and sessions",()=>{
 assert.deepEqual(commentArgs("codex",["--profile","work","--sandbox=workspace-write","-c","model_verbosity=low"]),["--profile","work","--sandbox=workspace-write","-c","model_verbosity=low"]);
 assert.deepEqual(commentArgs("claude",["--permission-mode","acceptEdits","--allowedTools","Read,Edit"]),["--permission-mode","acceptEdits","--allowedTools","Read,Edit","--permission-prompts","none"]);
 assert.deepEqual(commentArgs("opencode",["--agent","work"]),["--agent","work"]);
 assert.deepEqual(commentArgs("claude",["--allowedTools","Read","Edit","--add-dir","/tmp/one","/tmp/two"]),["--allowedTools","Read","Edit","--add-dir","/tmp/one","/tmp/two","--permission-prompts","none"]);
 assert.throws(()=>commentArgs("codex",["--profile","--json"]),/Missing value/);
 for(const [provider,flags] of [["codex",["--json","--output-schema=x","-ooutput","resume","--cd"]],["claude",["--output-format=json","--resume","--permission-prompts=default","--no-verbose"]],["opencode",["--format=json","--session=old","--attach=http://localhost","--interactive"]]]){
  for(const flag of flags)assert.throws(()=>commentArgs(provider,[flag]),/conflicting/);
 }
});

test("provider approval denials are actionable execution errors",()=>{
 for(const [provider,event] of [["codex",{type:"turn.failed",error:{message:"sandbox permission denied"}}],["claude",{type:"result",permission_denials:[{tool_name:"Edit"}]}],["opencode",{type:"permission.asked"}]])assert.match(commentEventError(provider,event),/permission|approval/i);
 assert.equal(commentEventError("codex",{type:"thread.started"}),null);
});
