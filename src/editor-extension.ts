import { editorInfoField } from "obsidian";
import {
	EditorState,
	Extension,
	RangeSetBuilder,
	StateEffect,
	StateField,
} from "@codemirror/state";
import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
} from "@codemirror/view";
import { parseRegions } from "./parser.ts";
import { GENERATING_CLASS, patchPlaceholderTitle } from "./progress.ts";
import type AiOverviewPlugin from "./main.ts";

/** Dispatched when a run starts, reports progress, or finishes. */
export const progressEffect = StateEffect.define<void>();

/**
 * Marks the lines of a callout whose summary is being generated, so its icon can
 * be animated. Line decorations are used rather than a widget so nothing is
 * inserted into the document and nothing is written to the note.
 */
function buildDecorations(state: EditorState, plugin: AiOverviewPlugin): DecorationSet {
	// `false` returns undefined instead of throwing while Obsidian is still
	// attaching its fields to a new editor.
	const notePath = state.field(editorInfoField, false)?.file?.path;
	if (!notePath) return Decoration.none;

	const builder = new RangeSetBuilder<Decoration>();
	let decorated = false;

	for (const region of parseRegions(state.doc.toString())) {
		if (!region.prompt) continue;
		if (plugin.summariser.progressFor(notePath, region.prompt) === null) continue;

		const lastLine = Math.min(region.lineEnd, state.doc.lines - 1);
		for (let index = region.lineStart; index <= lastLine; index++) {
			const line = state.doc.line(index + 1);
			builder.add(line.from, line.from, Decoration.line({ class: GENERATING_CLASS }));
			decorated = true;
		}
	}

	return decorated ? builder.finish() : Decoration.none;
}

/**
 * Replaces the type-derived title Obsidian gives an untitled callout, and keeps
 * it in step with whether a run is under way. The text belongs to Obsidian's own
 * rendering, so it is corrected after each update rather than decorated.
 */
function createTitlePatcher(plugin: AiOverviewPlugin): Extension {
	return ViewPlugin.fromClass(
		class {
			constructor(view: EditorView) {
				this.patch(view);
			}

			update(update: ViewUpdate): void {
				const runsChanged = update.transactions.some((tr) =>
					tr.effects.some((effect) => effect.is(progressEffect))
				);
				if (
					update.docChanged ||
					update.viewportChanged ||
					update.heightChanged ||
					runsChanged
				) {
					this.patch(update.view);
				}
			}

			private patch(view: EditorView): void {
				const notePath = view.state.field(editorInfoField, false)?.file?.path;
				// Per-callout state isn't recoverable from the rendered DOM, so the
				// note as a whole decides — exact whenever a note has one such callout.
				const state = notePath ? plugin.summariser.stateIn(notePath) : "idle";
				const status = notePath ? plugin.summariser.statusIn(notePath) : null;
				view.dom
					.querySelectorAll<HTMLElement>('.callout[data-callout="ai"]')
					.forEach((calloutEl) => patchPlaceholderTitle(calloutEl, state, status));
			}
		}
	);
}

/** Builds the Live Preview / Source overlay extension. */
export function createEditorExtension(plugin: AiOverviewPlugin): Extension {
	return [createTitlePatcher(plugin), generatingField(plugin)];
}

/** Tracks which callouts are generating, for the icon animation. */
function generatingField(plugin: AiOverviewPlugin): Extension {
	return StateField.define<DecorationSet>({
		create(state) {
			return buildDecorations(state, plugin);
		},
		update(decorations, tr) {
			const runsChanged = tr.effects.some((effect) => effect.is(progressEffect));
			if (tr.docChanged || runsChanged) return buildDecorations(tr.state, plugin);
			return decorations.map(tr.changes);
		},
		provide: (field) => EditorView.decorations.from(field),
	});
}
