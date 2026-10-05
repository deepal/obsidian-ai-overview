import { Editor, FileSystemAdapter, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { CatalogueCache } from "./discover.ts";
import { createEditorExtension, progressEffect } from "./editor-extension.ts";
import { createProgressProcessor, patchPlaceholderTitle } from "./progress.ts";
import { Summariser } from "./summariser.ts";
import { newRegion } from "./writer.ts";
import {
	AiOverviewSettings,
	AiOverviewSettingTab,
	DEFAULT_SETTINGS,
	mergeSettings,
} from "./settings.ts";

export default class AiOverviewPlugin extends Plugin {
	settings: AiOverviewSettings = DEFAULT_SETTINGS;

	/** What each installed CLI reports about its models and thinking levels. */
	readonly catalogue = new CatalogueCache(() => this.env());

	summariser!: Summariser;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.summariser = new Summariser(this);
		this.summariser.start();

		this.registerEditorExtension(createEditorExtension(this));
		this.registerMarkdownPostProcessor(createProgressProcessor(this));
		// Editors hold decorations in state, so they need telling when a run moves on.
		this.register(this.summariser.onChange(() => this.repaintProgress()));

		this.addSettingTab(new AiOverviewSettingTab(this.app, this));

		this.addCommand({
			id: "insert-ai-callout",
			name: "Insert AI callout",
			editorCallback: (editor) => insertCallout(editor),
		});

		this.addCommand({
			id: "regenerate-at-cursor",
			name: "Regenerate AI overview at cursor",
			editorCallback: (editor, view) => {
				const file = view.file;
				if (file) void this.summariser.regenerateAtCursor(file, editor.getCursor().line);
			},
		});

		this.addCommand({
			id: "status",
			name: "Show AI Overview status for this note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) {
					void this.summariser.describe(file).then((report) => {
						console.log(`[ai-overview] status\n${report}`);
						new Notice(report, 15_000);
					});
				}
				return true;
			},
		});

		this.addCommand({
			id: "regenerate-note",
			name: "Regenerate every AI overview in this note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.summariser.scan(file, true);
				return true;
			},
		});
	}

	onunload(): void {
		this.summariser?.dispose();
	}

	/**
	 * Absolute path to the vault, used as the agent's working root so the note
	 * path it is given resolves. Empty for non-filesystem vaults, where the CLI
	 * has nothing to read.
	 */
	vaultRoot(): string {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
	}

	/** Executable for the selected CLI. */
	command(): string {
		return this.settings.paths[this.settings.provider];
	}

	/** Model override for the selected CLI. */
	model(): string {
		return this.settings.models[this.settings.provider];
	}

	/** Thinking-level override for the selected CLI. */
	effort(): string {
		return this.settings.efforts[this.settings.provider];
	}

	/** The selected CLI's extra arguments, split on whitespace outside quotes. */
	extraArgs(): string[] {
		const raw = this.settings.extraArgs[this.settings.provider];
		const matches = raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
		return matches.map((arg) => arg.replace(/^["']|["']$/g, ""));
	}

	/**
	 * Environment for the CLI. Google's key is also accepted under the name the
	 * Gemini tooling uses, since that is what tends to already be exported.
	 */
	env(): Record<string, string> {
		const env: Record<string, string> = {};
		for (const line of this.settings.env.split("\n")) {
			const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
			if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
		}

		const gemini = env.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY;
		if (
			!env.GOOGLE_GENERATIVE_AI_API_KEY &&
			!process.env.GOOGLE_GENERATIVE_AI_API_KEY &&
			gemini
		) {
			env.GOOGLE_GENERATIVE_AI_API_KEY = gemini;
		}

		return env;
	}

	/**
	 * Pushes current run state to everything on screen: the titles are set from
	 * the views' own DOM, and the editors are nudged so their decorations rebuild.
	 *
	 * The DOM sweep is deliberately not routed through the editor extension or the
	 * post-processor — it works the same whichever of them rendered the callout,
	 * and neither can be relied on to run at the moment a run changes state.
	 */
	private repaintProgress(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) return;

			const notePath = view.file?.path;
			if (notePath) {
				const state = this.summariser.stateIn(notePath);
				const status = this.summariser.statusIn(notePath);
				view.containerEl
					.querySelectorAll<HTMLElement>('.callout[data-callout="ai"]')
					.forEach((calloutEl) => patchPlaceholderTitle(calloutEl, state, status));
			}

			const cm = (view.editor as { cm?: EditorViewLike }).cm;
			cm?.dispatch({ effects: progressEffect.of() });
		});
	}

	/** Re-examines the open note, e.g. after a settings change. */
	refreshViews(): void {
		const file = this.app.workspace.getActiveFile();
		if (file instanceof TFile && file.extension === "md") void this.summariser.scan(file);
	}

	async loadSettings(): Promise<void> {
		this.settings = mergeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

/** Inserts an empty `[!ai]` callout and puts the caret on its prompt line. */
function insertCallout(editor: Editor): void {
	const cursor = editor.getCursor();
	const atLineStart = cursor.ch === 0;
	const lead = atLineStart ? "" : "\n\n";

	editor.replaceRange(`${lead}${newRegion("")}\n`, cursor);
	const headerLine = cursor.line + (atLineStart ? 0 : 2);
	editor.setCursor({ line: headerLine + 1, ch: 2 });
	editor.focus();
}

/** Minimal shape of the CodeMirror view exposed on Obsidian's Editor. */
interface EditorViewLike {
	dispatch(spec: { effects?: unknown }): void;
}
