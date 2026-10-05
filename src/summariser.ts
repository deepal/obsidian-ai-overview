import { MarkdownView, Notice, TFile } from "obsidian";
import { runAgent, type AgentRun } from "./agent.ts";
import {
	needsSummary,
	parseRegions,
	promptHash,
	runKey,
	runKeyPrefix,
	type AiRegion,
} from "./parser.ts";
import { upsertSummary } from "./writer.ts";
import type AiOverviewPlugin from "./main.ts";

export type CalloutState = "running" | "failed" | "idle";

/** Failures are logged so a Notice that has been dismissed is still recoverable. */
function log(message: string): void {
	console.error(`[ai-overview] ${message}`);
}

/** Idle time after an edit before a note is examined again. */
const EDIT_SETTLE_MS = 2_500;
/** Delay before a freshly opened note is examined. */
const OPEN_DELAY_MS = 400;
/** How long to wait before retrying a region the caret was sitting in. */
const CARET_RETRY_MS = 2_000;

/**
 * Watches notes for `[!ai]` callouts and keeps their nested summaries current.
 *
 * Generation is driven by the file rather than by the renderer, so it behaves
 * the same in reading view and Live Preview. A summary is written back into the
 * note, and the prompt hash stored alongside it is what stops a write from
 * triggering another generation.
 */
export class Summariser {
	private readonly plugin: AiOverviewPlugin;
	/** In-flight runs, keyed by note path and prompt. */
	private running = new Map<string, AgentRun>();
	/** Failures with their reason, so a broken setup isn't retried on every keystroke. */
	private failed = new Map<string, string>();
	private timers = new Map<string, number>();
	/** Latest progress line per in-flight run, for the in-note overlay. */
	private progress = new Map<string, string>();
	private listeners = new Set<() => void>();
	private statusEl: HTMLElement | null = null;

	constructor(plugin: AiOverviewPlugin) {
		this.plugin = plugin;
	}

	/** Begins watching, and examines whatever note is already open. */
	start(): void {
		this.statusEl = this.plugin.addStatusBarItem();
		this.statusEl.addClass("aio-status-bar");
		this.paintStatus();

		this.plugin.registerEvent(
			this.plugin.app.workspace.on("file-open", (file) => {
				if (file) this.schedule(file, OPEN_DELAY_MS);
			})
		);
		this.plugin.registerEvent(
			this.plugin.app.vault.on("modify", (file) => {
				if (file instanceof TFile) this.schedule(file, EDIT_SETTLE_MS);
			})
		);

		const open = this.plugin.app.workspace.getActiveFile();
		if (open) this.schedule(open, OPEN_DELAY_MS);
	}

	dispose(): void {
		for (const timer of this.timers.values()) window.clearTimeout(timer);
		this.timers.clear();
		for (const run of this.running.values()) run.cancel();
		this.running.clear();
		this.progress.clear();
		this.listeners.clear();
		document.body.classList.remove("aio-busy");
	}

	/** Notified whenever a run starts, reports progress, or finishes. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** The live progress line for a callout, or null when nothing is running. */
	progressFor(notePath: string, prompt: string): string | null {
		return this.progress.get(runKey(notePath, prompt)) ?? null;
	}

	/** The live progress line for whichever callout in a note is running. */
	statusIn(notePath: string): string | null {
		const prefix = runKeyPrefix(notePath);
		for (const [key, status] of this.progress) {
			if (key.startsWith(prefix)) return status;
		}
		return null;
	}

	/** What a callout is currently doing, for the title and icon. */
	stateFor(notePath: string, prompt: string): CalloutState {
		const key = runKey(notePath, prompt);
		if (this.progress.has(key)) return "running";
		if (this.failed.has(key)) return "failed";
		return "idle";
	}

	/** The most notable state across a note, when a single callout can't be told. */
	stateIn(notePath: string): CalloutState {
		const prefix = runKeyPrefix(notePath);
		let state: CalloutState = "idle";
		for (const key of this.progress.keys()) {
			if (key.startsWith(prefix)) return "running";
		}
		for (const key of this.failed.keys()) {
			if (key.startsWith(prefix)) state = "failed";
		}
		return state;
	}

	/** A snapshot for the status command. */
	async describe(file: TFile): Promise<string> {
		const text = await this.plugin.app.vault.read(file);
		const regions = parseRegions(text);
		const lines = [
			`CLI: ${this.plugin.settings.provider} (${this.plugin.command()})`,
			`Runs in flight: ${this.running.size}`,
			`[!ai] callouts in this note: ${regions.length}`,
		];

		regions.forEach((region, index) => {
			const state = region.prompt ? this.stateFor(file.path, region.prompt) : "no prompt";
			lines.push(
				`  ${index + 1}. line ${region.lineStart + 1} · ${state} · ` +
					`${needsSummary(region) ? "needs generating" : "up to date"}` +
					`${region.summary ? "" : " · no summary yet"}`
			);
			const failure = this.failed.get(runKey(file.path, region.prompt));
			if (failure) lines.push(`     last error: ${failure}`);
		});

		return lines.join("\n");
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	/** Queues a note for examination, replacing any pending pass for it. */
	private schedule(file: TFile, delayMs: number): void {
		if (file.extension !== "md") return;

		const existing = this.timers.get(file.path);
		if (existing) window.clearTimeout(existing);

		const timer = window.setTimeout(() => {
			this.timers.delete(file.path);
			void this.scan(file);
		}, delayMs);
		this.timers.set(file.path, timer);
	}

	/**
	 * Generates whatever is missing or stale in a note. With `force`, every
	 * callout is regenerated regardless of its stored hash.
	 */
	async scan(file: TFile, force = false): Promise<void> {
		const text = await this.plugin.app.vault.read(file);
		for (const region of parseRegions(text)) {
			if (!region.prompt) continue;
			if (!force && !needsSummary(region)) continue;

			// A summary with no provenance was written by hand; the writer refuses to
			// replace it, so there is no point generating one.
			if (region.summary && !region.summary.meta) {
				if (force) {
					new Notice("AI Overview: that summary was written by hand, so it was left alone.");
				}
				continue;
			}

			const key = this.keyFor(file, region);
			if (this.running.has(key)) continue;
			if (force) this.failed.delete(key);
			else if (this.failed.has(key)) continue;

			// Writing into a callout that is being edited would move the caret.
			if (this.caretInside(file, region)) {
				this.schedule(file, CARET_RETRY_MS);
				continue;
			}

			void this.generate(file, region, key);
		}
	}

	/** Regenerates the callout the cursor is in, ignoring its stored hash. */
	async regenerateAtCursor(file: TFile, line: number): Promise<void> {
		const text = await this.plugin.app.vault.read(file);
		const region = parseRegions(text).find(
			(r) => line >= r.lineStart && line <= r.lineEnd
		);

		if (!region) {
			new Notice("AI Overview: put the cursor inside an [!ai] callout first.");
			return;
		}
		if (!region.prompt) {
			new Notice("AI Overview: that callout has no prompt.");
			return;
		}
		if (region.summary && !region.summary.meta) {
			new Notice("AI Overview: that summary was written by hand, so it was left alone.");
			return;
		}

		const key = this.keyFor(file, region);
		this.failed.delete(key);
		this.running.get(key)?.cancel();
		await this.generate(file, region, key);
	}

	private async generate(file: TFile, region: AiRegion, key: string): Promise<void> {
		const provider = this.plugin.settings.provider;
		const model = this.plugin.model();

		const run = runAgent({
			provider,
			command: this.plugin.command(),
			cwd: this.plugin.vaultRoot(),
			notePath: file.path,
			prompt: region.prompt,
			model,
			effort: this.plugin.effort(),
			timeoutMs: this.plugin.settings.timeoutSeconds * 1000,
			extraArgs: this.plugin.extraArgs(),
			env: this.plugin.env(),
			onProgress: (status) => {
				this.progress.set(key, status);
				this.paintStatus(status);
				this.notify();
			},
		});

		this.running.set(key, run);
		this.progress.set(key, "Starting…");
		this.paintStatus();
		this.notify();

		try {
			const result = await run.result;
			await this.plugin.app.vault.process(file, (current) => {
				// Recomputed against the note as it is now, so an edit made while the
				// agent was working can't be clobbered.
				const updated = upsertSummary(current, region.prompt, {
					title: result.title,
					body: result.body,
					provider,
					model,
					generated: new Date().toISOString(),
				});
				return updated ?? current;
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.failed.set(key, message);
			log(`${file.path}: ${message}`);
			if (message !== "Cancelled.") new Notice(`AI Overview: ${message}`, 10_000);
		} finally {
			this.running.delete(key);
			this.progress.delete(key);
			this.paintStatus();
			this.notify();
		}
	}

	/** Identity of a run: the note plus the exact prompt being answered. */
	private keyFor(file: TFile, region: AiRegion): string {
		return runKey(file.path, region.prompt);
	}

	/** Whether the cursor sits inside the region, in an editor showing this note. */
	private caretInside(file: TFile, region: AiRegion): boolean {
		const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.file?.path !== file.path) return false;
		if (view.getMode() !== "source") return false;

		const line = view.editor.getCursor().line;
		return line >= region.lineStart && line <= region.lineEnd;
	}

	private paintStatus(detail?: string): void {
		const count = this.running.size;
		// A body class as well as the per-callout ones, so the icon still animates
		// wherever Obsidian renders a callout beyond the plugin's reach.
		document.body.classList.toggle("aio-busy", count > 0);

		if (!this.statusEl) return;

		if (count === 0) {
			this.statusEl.setText("");
			this.statusEl.removeAttribute("aria-label");
			return;
		}

		const label = count > 1 ? `Generating ${count} AI overviews…` : "Generating AI overview…";
		this.statusEl.setText(`✦ ${label}`);
		if (detail) this.statusEl.setAttribute("aria-label", detail);
	}
}
