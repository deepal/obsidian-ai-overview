import { promises as fs } from "fs";
import * as path from "path";
import { TFile, type App, MarkdownView } from "obsidian";
import { safeReplacement, validateNotePath, type NoteChange } from "./comment-output.ts";

/** Check every path component, including ancestors of a not-yet-created note. */
export async function assertLocalNote(root: string, note: string): Promise<void> {
	validateNotePath(note);
	const base = await fs.realpath(root);
	let current = base;
	for (const part of note.split("/")) {
		current = path.join(current, part);
		try {
			if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Agent note changes cannot follow symbolic links.");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

export async function flushNote(app: App, notePath: string): Promise<void> {
	const saves: Promise<void>[] = [];
	app.workspace.iterateAllLeaves((leaf) => {
		if (leaf.view instanceof MarkdownView && leaf.view.file?.path === notePath && leaf.view.getMode() === "source") saves.push(leaf.view.save());
	});
	await Promise.all(saves);
}

export async function applyNoteChange(app: App, root: string, change: NoteChange): Promise<void> {
	await assertLocalNote(root, change.path);
	await flushNote(app, change.path);
	if (change.kind === "create") {
		if (/%%|<\/?(?:discussion|comment)\b|<!-- aio-/i.test(change.content)) throw new Error("New note content cannot create comment threads.");
		if (app.vault.getAbstractFileByPath(change.path)) throw new Error(`A note already exists at ${change.path}.`);
		const parts = change.path.split("/");
		for (let i = 1; i < parts.length; i++) {
			const directory = parts.slice(0, i).join("/");
			if (!app.vault.getAbstractFileByPath(directory)) await app.vault.createFolder(directory);
		}
		await assertLocalNote(root, change.path);
		await app.vault.create(change.path, change.content);
	} else {
		const file = app.vault.getAbstractFileByPath(change.path);
		if (!(file instanceof TFile)) throw new Error(`Note not found: ${change.path}`);
		await app.vault.process(file, (text) => safeReplacement(text, change));
	}
}
