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

const GENERIC_PERMISSION_ERROR = "The agent needs permission that is not available to this unattended run. Configure the CLI's permissions outside Obsidian, then retry. Earlier actions may already have taken effect.";
const vault = "/vaults/synthetic";
const denied = (...denials) => ({ type: "result", subtype: "success", permission_denials: denials });
const denial = (tool_name, tool_input = {}) => ({ tool_name, tool_use_id: `toolu_${tool_name}`, tool_input });
const claudeError = (event, options = { vaultRoot: vault }) => commentEventError("claude", event, options);

test("permission denial names the denied tool and starts the message with it", () => {
	const error = claudeError(denied(denial("Edit", { file_path: `${vault}/Notes/Plan.md`, old_string: "a", new_string: "b", replace_all: false })));
	assert.match(error, /^Claude Code denied Edit /);
	assert.doesNotMatch(error, /Bash/);
});

test("permission denial names each tool once, in order of first appearance", () => {
	const error = claudeError(denied(denial("Edit", { file_path: `${vault}/A.md` }), denial("Bash", { command: "ls" }), denial("Edit", { file_path: `${vault}/B.md` })));
	assert.equal(error.indexOf("Edit") < error.indexOf("Bash"), true);
	assert.match(error, /^Claude Code denied Edit \(A\.md\) and Bash \(ls\)\./);
	assert.equal(error.match(/denied [^.]*\bEdit\b/g).length, 1);
	assert.doesNotMatch(error, /B\.md/);
});

test("permission denial names at most three tools and counts the rest", () => {
	const error = claudeError(denied(...["Edit", "Write", "Bash", "WebFetch", "NotebookEdit"].map((name) => denial(name))));
	assert.match(error, /^Claude Code denied Edit, Write, Bash and 2 more\./);
	assert.doesNotMatch(error, /WebFetch|NotebookEdit/);
	assert.match(claudeError(denied(...["Edit", "Write", "Bash", "WebFetch"].map((name) => denial(name)))), /Edit, Write, Bash and 1 more\./);
	assert.match(claudeError(denied(...["Edit", "Write", "Bash"].map((name) => denial(name)))), /Edit, Write and Bash\./);
});

test("permission denial shows files relative to the vault and otherwise only the file name", () => {
	assert.match(claudeError(denied(denial("Edit", { file_path: `${vault}/Notes/Plan.md` }))), /^Claude Code denied Edit \(Notes\/Plan\.md\)\./);
	assert.match(claudeError(denied(denial("Read", { file_path: "/elsewhere/secret/Key.txt" }))), /^Claude Code denied Read \(Key\.txt\)\./);
	assert.match(claudeError(denied(denial("Read", { file_path: "/vaults/synthetic-sibling/Note.md" }))), /^Claude Code denied Read \(Note\.md\)\./);
	assert.match(claudeError(denied(denial("NotebookEdit", { notebook_path: `${vault}/Lab/Run.ipynb` }))), /\(Lab\/Run\.ipynb\)/);
	assert.match(claudeError(denied(denial("Edit", { file_path: `${vault}/Plan.md` })), {}), /\(Plan\.md\)/);
});

test("permission denial shortens long commands to the first line", () => {
	const command = `grep ${"x ".repeat(50)}\n${"y ".repeat(50)}`;
	const error = claudeError(denied(denial("Bash", { command })));
	const target = error.match(/denied Bash \((.*)\)\. To allow/)[1];
	assert.equal(target.length, 60);
	assert.equal(target, `${command.split("\n")[0].slice(0, 59)}…`);
	assert.doesNotMatch(error, /y y/);
	assert.ok(error.includes('"Bash(grep *)"'));
});

test("permission denial shows only the domain of a URL and shortens searches", () => {
	assert.match(claudeError(denied(denial("WebFetch", { url: "https://example.com/private/path?token=abc", prompt: "secret" }))), /^Claude Code denied WebFetch \(example\.com\)\./);
	assert.match(claudeError(denied(denial("WebFetch", { url: "not a url" }))), /^Claude Code denied WebFetch\./);
	assert.match(claudeError(denied(denial("Grep", { pattern: "p".repeat(80) }))), new RegExp(`\\(${"p".repeat(39)}…\\)`));
	assert.match(claudeError(denied(denial("WebSearch", { query: "short query" }))), /\(short query\)/);
});

test("permission denial never repeats note content", () => {
	const input = { file_path: `${vault}/A.md`, old_string: "OLD-SECRET", new_string: "NEW-SECRET", content: "CONTENT-SECRET", prompt: "PROMPT-SECRET", other: "OTHER-SECRET" };
	for (const tool of ["Edit", "Write", "WebFetch"]) assert.doesNotMatch(claudeError(denied(denial(tool, input))), /SECRET/);
});

test("permission denial without a target names only the tool", () => {
	const error = claudeError(denied(denial("mcp__x__y", {})));
	assert.match(error, /^Claude Code denied mcp__x__y\. /);
	assert.doesNotMatch(error, /\(/);
	assert.match(claudeError(denied({ tool_name: "mcp__x__y" })), /^Claude Code denied mcp__x__y\./);
});

test("permission denial suggests the narrow --allowed-tools that allows the named tools", () => {
	const error = claudeError(denied(denial("Edit", { file_path: `${vault}/Notes/Plan.md` }), denial("Bash", { command: "grep -n foo note.md" })));
	assert.ok(error.includes('--allowed-tools Edit "Bash(grep *)" to Extra arguments'));
	const noBashRule = (command) => {
		const error = claudeError(denied(denial("Bash", command === undefined ? {} : { command })));
		assert.doesNotMatch(error, /--allowed-tools/, String(command));
		assert.doesNotMatch(error, /Bash\(|allowed-tools Bash|"Bash"/, String(command));
		assert.match(error, /Allow the command in Claude Code's permission settings, then retry\./, String(command));
		assert.ok(error.length <= 500);
	};
	for (const command of [undefined, "   ", ";", "$(rm -rf x)", `${"w".repeat(81)} --flag`, "sudo rm -rf x", "su -c ls", "bash -c 'rm x'", "/bin/bash -c ls", "env FOO=1 ls", "xargs rm", "timeout 5 ls", "ls && sudo rm x", "grep \"a|b\" file"]) noBashRule(command);
	assert.ok(claudeError(denied(denial("mcp__x__y"))).includes("--allowed-tools mcp__x__y to Extra arguments"));
	assert.ok(claudeError(denied(denial("Edit"), denial("Write"), denial("Read"), denial("Glob"))).includes("--allowed-tools Edit Write Read to Extra arguments"));
});

test("permission denial asks for one Bash rule per part of a compound command", () => {
	const error = claudeError(denied(denial("Bash", { command: "touch a && mkdir -p b | tee c" })));
	assert.ok(error.includes('--allowed-tools "Bash(touch *)" "Bash(mkdir *)" "Bash(tee *)" to Extra arguments'));
	assert.ok(claudeError(denied(denial("Bash", { command: "a || b ; c | d && a" }))).includes('--allowed-tools "Bash(a *)" "Bash(b *)" "Bash(c *)" "Bash(d *)" to'));
	assert.ok(claudeError(denied(denial("Bash", { command: "ls;" }))).includes('--allowed-tools "Bash(ls *)" to'));
	assert.ok(claudeError(denied(denial("Bash", { command: "/usr/bin/grep -r x ." }))).includes('"Bash(/usr/bin/grep *)"'));
});

test("permission denial collects the Bash rules of every denied command, not only the first", () => {
	const error = claudeError(denied(denial("Bash", { command: "ls -la" }), denial("Edit"), denial("Bash", { command: "git status && git diff" })));
	assert.ok(error.includes('--allowed-tools "Bash(ls *)" "Bash(git *)" Edit to Extra arguments'), error);
	assert.match(error, /^Claude Code denied Bash \(ls -la\) and Edit\./);
	const blocked = claudeError(denied(denial("Bash", { command: "ls" }), denial("Bash", { command: "sudo rm x" })));
	assert.doesNotMatch(blocked, /--allowed-tools/);
});

test("permission denial never offers Bash whole and says how to allow what no rule can cover", () => {
	const partial = claudeError(denied(denial("Edit", { file_path: `${vault}/A.md` }), denial("Bash", { command: "sudo rm x" })));
	assert.ok(partial.includes("--allowed-tools Edit to Extra arguments"));
	assert.match(partial, /allow the Bash command in Claude Code's permission settings, then retry/);
	assert.equal(partial.match(/--allowed-tools (.*?) to Extra/)[1], "Edit");
	assert.match(claudeError(denied(denial("Edit"), denial("Write"), denial("Bash", { command: "bash -c x" }))), /allow the Bash command in Claude Code's permission settings/);
});

test("permission denial leaves tool names that look like flags out of the suggestion", () => {
	for (const name of ["--add-dir", "*", "--dangerously-skip-permissions", "-x", "1tool", "a b", "Edit\nWrite", "Edit;ls", `A${"b".repeat(80)}`]) {
		const error = claudeError(denied(denial(name)));
		assert.doesNotMatch(error, /--allowed-tools/, name);
		assert.doesNotMatch(error, /[\r\n]/, name);
		assert.ok(error.length <= 500, name);
		assert.match(error, /^Claude Code denied /);
		assert.match(error, /Allow it in Claude Code's permission settings, then retry\./);
	}
	const mixed = claudeError(denied(denial("Edit"), denial("--add-dir"), denial("*")));
	assert.ok(mixed.includes("--allowed-tools Edit to Extra arguments"));
	assert.doesNotMatch(mixed.split("--allowed-tools")[1], /--add-dir|\*/);
	assert.ok(claudeError(denied(denial("mcp__server__tool-1"), denial("Edit"))).includes("--allowed-tools mcp__server__tool-1 Edit to"));
});

test("permission error stays within 500 characters on one line for any tool name or command", () => {
	for (const event of [
		denied(denial("x".repeat(600))), denied(denial("A\nB\r\nC")), denied(denial("e".repeat(79)), denial("f".repeat(79)), denial("g".repeat(79))),
		denied(denial("Bash", { command: Array.from({ length: 60 }, (_, i) => `cmd${i}`).join(" && ") })),
		denied(denial("Bash", { command: Array.from({ length: 60 }, (_, i) => `cmd${i}`).join(" && ") }), denial("Edit", { file_path: `${vault}/${"d".repeat(400)}.md` })),
		denied(denial("\u{1F600}".repeat(300))),
	]) {
		const error = claudeError(event);
		assert.doesNotMatch(error, /[\r\n\u2028\u2029]/);
		assert.ok(error.length <= 500, String(error.length));
		assert.match(error, /^Claude Code denied /);
		assert.doesNotMatch(error, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
	}
});

test("permission targets are cut by character and neutralize control and direction marks", () => {
	const emoji = "\u{1F600}";
	const target = (input, tool = "Bash") => claudeError(denied(denial(tool, input))).match(/denied \S+ \((.*?)\)\. /)?.[1];
	assert.equal(Array.from(target({ command: `ls ${emoji.repeat(100)}` })).length, 60);
	assert.equal(target({ command: `ls ${emoji.repeat(100)}` }).endsWith(`${emoji}…`), true);
	assert.equal(target({ pattern: emoji.repeat(100) }, "Grep"), `${emoji.repeat(39)}…`);
	assert.doesNotMatch(claudeError(denied(denial("Grep", { pattern: emoji.repeat(100) }))), /[\ud800-\udbff](?![\udc00-\udfff])/);
	assert.equal(target({ command: "echo\u0085a\u200eb\u202ec\u2066d\u2069e\u009ff\u0007g" }), "echo a b c d e f g");
	assert.equal(target({ command: "tab\tsep\u2028line" }), "tab sep line");
	assert.equal(target({ file_path: `${vault}/..hidden.md` }, "Edit"), "..hidden.md");
	assert.equal(target({ file_path: `${vault}/../outside.md` }, "Edit"), "outside.md");
	assert.equal(target({ file_path: `${vault}/..` }, "Edit"), "..");
});

test("permission denial keeps the warnings and never suggests broader access", () => {
	for (const event of [denied(denial("Edit")), denied(denial("Bash", { command: "ls" }), denial("Edit"), denial("Write"), denial("Read"))]) {
		const error = claudeError(event);
		assert.match(error, /reply was not published/);
		assert.match(error, /earlier actions may already have taken effect/);
		assert.match(error, /update Claude Code's permission settings/);
		assert.doesNotMatch(error, /--permission-mode|bypassPermissions|dangerously-skip-permissions/);
	}
});

test("permission error is one line of at most 500 characters with names and flag intact", () => {
	const long = "z".repeat(300);
	const error = claudeError(denied(
		denial("Edit", { file_path: `${vault}/${"d/".repeat(100)}Plan.md` }),
		denial("Bash", { command: `grep ${long}` }),
		denial("WebFetch", { url: `https://${"a".repeat(200)}.example.com/` }),
	));
	assert.doesNotMatch(error, /[\r\n]/);
	assert.ok(error.length <= 500, String(error.length));
	assert.match(error, /^Claude Code denied Edit[^.]*Bash[^.]*WebFetch/);
	assert.ok(error.includes('--allowed-tools Edit "Bash(grep *)" WebFetch to Extra arguments'));
	assert.match(error, /reply was not published/);
	const newlines = claudeError(denied(denial("Bash", { command: "echo one\necho two" }), denial("Grep", { pattern: "a\nb" })));
	assert.doesNotMatch(newlines, /[\r\n]/);
});

test("a typical permission error fits well within the limit", () => {
	const error = claudeError(denied(denial("Edit", { file_path: `${vault}/Notes/Plan.md` }), denial("Bash", { command: "grep -n foo note.md" })));
	assert.equal(error, 'Claude Code denied Edit (Notes/Plan.md) and Bash (grep -n foo note.md). To allow them, add --allowed-tools Edit "Bash(grep *)" to Extra arguments and retry, or update Claude Code\'s permission settings. The reply was not published, and earlier actions may already have taken effect.');
	assert.ok(error.length < 500);
});

test("permission denial without usable data keeps the generic message", () => {
	for (const event of [
		denied({}), denied("x", null, 3), denied({ tool_name: "" }, { tool_name: "  " }, { tool_name: 7 }), denied([]),
		{ type: "result", permission_denials: [{ tool_input: { file_path: "A.md" } }] },
		{ type: "permission_denied" }, { type: "result", subtype: "permission_denied" },
	]) assert.equal(commentEventError("claude", event, { vaultRoot: vault }), GENERIC_PERMISSION_ERROR);
	assert.equal(commentEventError("claude", denied({})), GENERIC_PERMISSION_ERROR);
	assert.equal(commentEventError("claude", { type: "result", permission_denials: [] }), null);
	assert.equal(commentEventError("claude", { type: "result", permission_denials: "Edit" }), null);
	assert.equal(commentEventError("claude", denied(denial("Edit", "bad"))).startsWith("Claude Code denied Edit"), true);
	assert.doesNotThrow(() => commentEventError("claude", denied(denial("Edit", { file_path: 5, command: {}, url: [], pattern: null })), { vaultRoot: vault }));
});

test("other providers keep the generic permission message", () => {
	assert.equal(commentEventError("opencode", { type: "permission.asked" }), GENERIC_PERMISSION_ERROR);
	assert.equal(commentEventError("opencode", { type: "permission.rejected" }), GENERIC_PERMISSION_ERROR);
	assert.equal(commentEventError("opencode", denied(denial("Edit", { file_path: `${vault}/A.md` }))), GENERIC_PERMISSION_ERROR);
	assert.equal(commentEventError("codex", denied(denial("Edit"))), GENERIC_PERMISSION_ERROR);
	assert.equal(commentEventError("pi", denied(denial("Edit"))), GENERIC_PERMISSION_ERROR);
	assert.match(commentEventError("codex", { type: "turn.failed", error: { message: "sandbox permission denied" } }), /^The configured Codex permissions blocked this run\./);
});

test("turning off permission details keeps the generic message even with a usable denial", () => {
	const event = denied(denial("Edit", { file_path: `${vault}/Notes/Plan.md` }), denial("Bash", { command: "ls" }));
	assert.equal(commentEventError("claude", event, { vaultRoot: vault, details: false }), GENERIC_PERMISSION_ERROR);
	assert.match(commentEventError("claude", event, { vaultRoot: vault, details: true }), /^Claude Code denied Edit/);
	assert.match(commentEventError("claude", event, { vaultRoot: vault }), /^Claude Code denied Edit/);
	assert.match(commentEventError("claude", event, { vaultRoot: vault, details: undefined }), /^Claude Code denied Edit/);
});
