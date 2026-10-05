import { MarkdownPostProcessorContext, MarkdownRenderChild } from "obsidian";
import { parseRegions } from "./parser.ts";
import type { CalloutState } from "./summariser.ts";
import type AiOverviewPlugin from "./main.ts";

/** Marks a callout whose summary is being generated, for the icon animation. */
export const GENERATING_CLASS = "aio-generating";

/**
 * What stands in until a generated title exists. Obsidian titles an untitled
 * callout after its type — "Ai" for `[!ai]` — and that text belongs to its own
 * rendering, so it can only be corrected in the DOM.
 *
 * At rest the slot is left empty rather than given an invented word: the header's
 * own label already says what the block is, and there is then nothing to flash
 * away when a run starts reporting.
 */
const PLACEHOLDERS: Record<CalloutState, string> = {
	idle: "",
	running: "Summary is being generated…",
	failed: "Summary could not be generated",
};

/** Obsidian's own fallback, plus whatever this function last wrote. */
function isPlaceholder(text: string): boolean {
	return (
		text === "" ||
		text.toLowerCase() === "ai" ||
		Object.values(PLACEHOLDERS).includes(text)
	);
}

/** Holds the title displaced while a run is in flight, so it can be put back. */
const STASH_ATTR = "data-aio-title";

/**
 * Shows what the callout is doing in its title row — the agent's live status
 * while a run is under way — and returns whether anything changed.
 *
 * A real title — the user's, or one generated earlier — is displaced while a run
 * is in flight and restored when it ends, so regenerating an already-titled
 * callout still reports progress. A title written by the run itself arrives with
 * a re-render, which discards the stash along with the old element.
 */
export function patchPlaceholderTitle(
	calloutEl: HTMLElement,
	state: CalloutState,
	status?: string | null
): boolean {
	// Descendant rather than child: the title row's internals belong to Obsidian.
	const inner = calloutEl.querySelector<HTMLElement>(".callout-title-inner");
	if (!inner) return false;

	const current = inner.textContent?.trim() ?? "";
	const stashed = inner.getAttribute(STASH_ATTR);

	if (state === "running") {
		if (stashed === null) inner.setAttribute(STASH_ATTR, current);
		// The agent's own account of what it is doing, until it reports something.
		const wanted = status?.trim() || PLACEHOLDERS.running;
		if (current === wanted) return false;
		inner.setText(wanted);
		return true;
	}

	// Back to rest: restore a displaced real title, or reflect the state on a
	// placeholder.
	const previous = stashed ?? current;
	inner.removeAttribute(STASH_ATTR);
	const wanted = isPlaceholder(previous) ? PLACEHOLDERS[state] : previous;
	if (current === wanted) return false;
	inner.setText(wanted);
	return true;
}

/**
 * Follows a run for one rendered `[!ai]` callout in reading view, toggling the
 * class its icon animation hangs off. Live Preview is covered by the editor
 * extension, since callouts there are drawn by Obsidian's own widget path.
 */
class ReadingProgress extends MarkdownRenderChild {
	private readonly plugin: AiOverviewPlugin;
	private readonly notePath: string;
	private readonly prompt: string;
	private unsubscribe: (() => void) | null = null;

	constructor(
		calloutEl: HTMLElement,
		plugin: AiOverviewPlugin,
		notePath: string,
		prompt: string
	) {
		super(calloutEl);
		this.plugin = plugin;
		this.notePath = notePath;
		this.prompt = prompt;
	}

	onload(): void {
		this.unsubscribe = this.plugin.summariser.onChange(() => this.paint());
		this.paint();
	}

	onunload(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.containerEl.removeClass(GENERATING_CLASS);
	}

	private paint(): void {
		const summariser = this.plugin.summariser;
		const state = summariser.stateFor(this.notePath, this.prompt);
		this.containerEl.toggleClass(GENERATING_CLASS, state === "running");
		patchPlaceholderTitle(
			this.containerEl,
			state,
			summariser.progressFor(this.notePath, this.prompt)
		);
	}
}

/**
 * Reading-view post-processor. Callouts are paired with parsed regions by
 * document order within the rendered section.
 */
export function createProgressProcessor(plugin: AiOverviewPlugin) {
	return (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
		const callouts = Array.from(
			el.querySelectorAll<HTMLElement>('.callout[data-callout="ai"]')
		);
		if (callouts.length === 0) return;

		const info = ctx.getSectionInfo(el);
		if (!info) return;

		const regions = parseRegions(info.text).filter(
			(region) => region.lineStart >= info.lineStart && region.lineStart <= info.lineEnd
		);

		callouts.forEach((calloutEl, index) => {
			const region = regions[index];
			if (!region?.prompt) {
				patchPlaceholderTitle(calloutEl, "idle");
				return;
			}
			ctx.addChild(new ReadingProgress(calloutEl, plugin, ctx.sourcePath, region.prompt));
		});
	};
}
