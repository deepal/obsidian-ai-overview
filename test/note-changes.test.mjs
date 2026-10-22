import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bundle = await build({ entryPoints: ["src/note-changes.ts"], bundle: true, platform: "node", format: "esm", write: false,
	plugins: [{ name: "host", setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "host" }));
		builder.onLoad({ filter: /.*/, namespace: "host" }, () => ({ contents: "export class TFile {} export class MarkdownView {} globalThis.__noteChangeFile = TFile;" }));
	} }],
});
const { assertLocalNote, applyNoteChange } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("note changes reject symlinks, including ancestors of new notes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mention-paths-")); t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "inside")); await symlink(join(root, "inside"), join(root, "alias"));
	await assert.rejects(assertLocalNote(root, "alias/New.md"), /symbolic links/);
	await assertLocalNote(root, "inside/New.md");
	await assert.rejects(assertLocalNote(root, "../Outside.md"));
});

test("vault API writes create folders, protect existing files and preserve unrelated edits", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mention-apply-")); t.after(() => rm(root, { recursive: true, force: true }));
	const files = new Map([["Existing.md", "User edit\nold\n%% old %%"]]);
	const folders = new Set();
	const app = { workspace: { iterateAllLeaves() {} }, vault: {
		getAbstractFileByPath(path) { return files.has(path) ? Object.assign(new globalThis.__noteChangeFile(), { path }) : folders.has(path) ? { path } : null; },
		async process(file, fn) { files.set(file.path, fn(files.get(file.path))); },
		async createFolder(path) { folders.add(path); },
		async create(path, content) { assert.equal(files.has(path), false); files.set(path, content); },
	} };
	await applyNoteChange(app, root, { kind: "create", path: "Folder/New.md", content: "New note" });
	assert.equal(files.get("Folder/New.md"), "New note"); assert.equal(folders.has("Folder"), true);
	await assert.rejects(applyNoteChange(app, root, { kind: "create", path: "Existing.md", content: "overwrite" }));
	await applyNoteChange(app, root, { kind: "replace", path: "Existing.md", oldText: "old", newText: "new" });
	assert.equal(files.get("Existing.md"), "User edit\nnew\n%% old %%");
	await assert.rejects(applyNoteChange(app, root, { kind: "replace", path: "Existing.md", oldText: "old", newText: "bad" }));
	assert.equal(files.get("Existing.md"), "User edit\nnew\n%% old %%");
});
