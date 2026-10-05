import { PROVIDER_IDS, type ProviderId } from "./providers.ts";

/** Per-provider values, so switching CLI doesn't clobber the other's setup. */
type ByProvider = Record<ProviderId, string>;

export interface AiOverviewSettings {
	/** Which CLI generates overviews. */
	provider: ProviderId;
	/** Executable name or absolute path, per provider. */
	paths: ByProvider;
	/** Model override per provider; empty defers to that CLI's own config. */
	models: ByProvider;
	/** Thinking level per provider; empty defers to that CLI's own config. */
	efforts: ByProvider;
	/** Extra CLI arguments per provider. */
	extraArgs: ByProvider;
	/** `KEY=VALUE` pairs passed to whichever CLI runs. */
	env: string;
	/** How long a single generation may run before it is killed. */
	timeoutSeconds: number;
}

export const DEFAULT_SETTINGS: AiOverviewSettings = {
	provider: "codex",
	paths: { codex: "codex", claude: "claude", opencode: "opencode" },
	models: { codex: "", claude: "", opencode: "" },
	efforts: { codex: "", claude: "", opencode: "" },
	extraArgs: { codex: "", claude: "", opencode: "" },
	env: "",
	timeoutSeconds: 300,
};

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : {};
}

function providerValues(value: unknown, defaults: ByProvider, paths = false): ByProvider {
	const data = asRecord(value);
	const result = { ...defaults };
	for (const id of PROVIDER_IDS) {
		if (typeof data[id] === "string") {
			const text = data[id].trim();
			result[id] = paths ? text || defaults[id] : text;
		}
	}
	return result;
}

/** Validate persisted values and retain the legacy single-provider format. */
export function mergeSettings(raw: unknown): AiOverviewSettings {
	const data = asRecord(raw);
	const settings: AiOverviewSettings = {
		provider: PROVIDER_IDS.includes(data.provider as ProviderId) ? data.provider as ProviderId : DEFAULT_SETTINGS.provider,
		paths: providerValues(data.paths, DEFAULT_SETTINGS.paths, true),
		models: providerValues(data.models, DEFAULT_SETTINGS.models),
		efforts: providerValues(data.efforts, DEFAULT_SETTINGS.efforts),
		extraArgs: providerValues(data.extraArgs, DEFAULT_SETTINGS.extraArgs),
		env: typeof data.env === "string" ? data.env : DEFAULT_SETTINGS.env,
		timeoutSeconds: typeof data.timeoutSeconds === "number" && Number.isSafeInteger(data.timeoutSeconds) && data.timeoutSeconds > 0
			? data.timeoutSeconds : DEFAULT_SETTINGS.timeoutSeconds,
	};
	if (typeof data.codexPath === "string" && data.codexPath.trim()) settings.paths.codex = data.codexPath.trim();
	if (typeof data.model === "string" && data.model.trim()) settings.models.codex = data.model.trim();
	if (typeof data.extraArgs === "string" && data.extraArgs.trim()) settings.extraArgs.codex = data.extraArgs.trim();
	return settings;
}
