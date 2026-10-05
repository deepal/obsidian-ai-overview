import { getProvider, type ModelInfo, type ProviderId } from "./providers.ts";
import { runCapture } from "./spawn.ts";

/** What a CLI reported about itself. */
export interface Catalogue {
	/** Empty when the CLI has no listing command, or the listing failed. */
	models: ModelInfo[];
	/** Thinking levels that apply regardless of model. */
	efforts: string[];
	/** Whether the CLI offers a model listing at all. */
	supportsModelListing: boolean;
	/** Whether the CLI reports thinking levels at all. */
	supportsEffortListing: boolean;
	/** Why a listing came back empty, when it was meant to work. */
	error: string | null;
}

/** Listing commands are quick; anything slower is a broken install. */
const LISTING_TIMEOUT_MS = 30_000;

/**
 * Runs the CLIs' own listing commands and remembers the answers, so the
 * settings dropdowns are built from what is installed rather than from a list
 * baked into the plugin. Results last for the session and can be refreshed.
 */
export class CatalogueCache {
	private resolved = new Map<string, Catalogue>();
	private inFlight = new Map<string, Promise<Catalogue>>();
	private readonly env: () => Record<string, string>;

	constructor(env: () => Record<string, string>) {
		this.env = env;
	}

	/** The catalogue if already loaded, without starting a lookup. */
	peek(provider: ProviderId, command: string): Catalogue | null {
		return this.resolved.get(key(provider, command)) ?? null;
	}

	/** Loads the catalogue, reusing an in-flight lookup for the same CLI. */
	load(provider: ProviderId, command: string): Promise<Catalogue> {
		const id = key(provider, command);
		const done = this.resolved.get(id);
		if (done) return Promise.resolve(done);

		const running = this.inFlight.get(id);
		if (running) return running;

		const lookup = this.fetch(provider, command).then((catalogue) => {
			this.resolved.set(id, catalogue);
			this.inFlight.delete(id);
			return catalogue;
		});
		this.inFlight.set(id, lookup);
		return lookup;
	}

	/** Drops what a CLI reported so the next load asks it again. */
	invalidate(provider: ProviderId, command: string): void {
		const id = key(provider, command);
		this.resolved.delete(id);
		this.inFlight.delete(id);
	}

	private async fetch(provider: ProviderId, command: string): Promise<Catalogue> {
		const { listModels, listEfforts } = getProvider(provider);
		const catalogue: Catalogue = {
			models: [],
			efforts: [],
			supportsModelListing: listModels !== null,
			supportsEffortListing: listModels !== null || listEfforts !== null,
			error: null,
		};

		const run = async <T>(args: string[], parse: (stdout: string) => T): Promise<T | null> => {
			try {
				return parse(await runCapture(command, args, { env: this.env(), timeoutMs: LISTING_TIMEOUT_MS }));
			} catch (err) {
				catalogue.error =
					catalogue.error ?? (err instanceof Error ? err.message : String(err));
				return null;
			}
		};

		if (listModels) {
			catalogue.models = (await run(listModels.args, listModels.parse)) ?? [];
		}
		if (listEfforts) {
			catalogue.efforts = (await run(listEfforts.args, listEfforts.parse)) ?? [];
		}

		return catalogue;
	}
}

/**
 * Thinking levels to offer: the selected model's own, falling back to the CLI's
 * global list, then to every level any model supports (for when no model is
 * pinned and the CLI leaves the choice to itself).
 */
export function effortOptions(catalogue: Catalogue, model: string): string[] {
	const selected = catalogue.models.find((m) => m.id === model);
	if (selected) return selected.efforts;
	if (catalogue.efforts.length) return catalogue.efforts;

	const union: string[] = [];
	for (const entry of catalogue.models) {
		for (const effort of entry.efforts) {
			if (!union.includes(effort)) union.push(effort);
		}
	}
	return union;
}

function key(provider: ProviderId, command: string): string {
	return `${provider}\u0000${command}`;
}
