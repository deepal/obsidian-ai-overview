import { App, PluginSettingTab, Setting } from "obsidian";
import { effortOptions, type Catalogue } from "./discover.ts";
import { getProvider, PROVIDER_IDS, type Provider, type ProviderId } from "./providers.ts";
import type AiOverviewPlugin from "./main.ts";

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

const ARGS_PLACEHOLDERS: ByProvider = {
	codex: "-c model_verbosity=low",
	claude: "--add-dir ../shared",
	opencode: "--agent plan",
};

/** Stands in for "whatever the CLI would choose on its own". */
const CLI_DEFAULT = "";
const CLI_DEFAULT_LABEL = "CLI default";

/**
 * Merges stored data over the defaults, keeping the per-provider maps intact
 * when only some keys were saved, and carrying over the flat single-CLI shape
 * that earlier versions wrote.
 */
export function mergeSettings(raw: unknown): AiOverviewSettings {
	const data = (raw ?? {}) as Partial<AiOverviewSettings> & {
		codexPath?: string;
		model?: string;
		extraArgs?: string | ByProvider;
	};

	const settings: AiOverviewSettings = {
		...DEFAULT_SETTINGS,
		...(data as Partial<AiOverviewSettings>),
		paths: { ...DEFAULT_SETTINGS.paths, ...(data.paths ?? {}) },
		models: { ...DEFAULT_SETTINGS.models, ...(data.models ?? {}) },
		efforts: { ...DEFAULT_SETTINGS.efforts, ...(data.efforts ?? {}) },
		extraArgs: {
			...DEFAULT_SETTINGS.extraArgs,
			...(typeof data.extraArgs === "object" ? data.extraArgs : {}),
		},
	};

	if (typeof data.codexPath === "string" && data.codexPath.trim()) {
		settings.paths.codex = data.codexPath.trim();
	}
	if (typeof data.model === "string" && data.model.trim()) {
		settings.models.codex = data.model.trim();
	}
	if (typeof data.extraArgs === "string" && data.extraArgs.trim()) {
		settings.extraArgs.codex = data.extraArgs;
	}
	if (!PROVIDER_IDS.includes(settings.provider)) {
		settings.provider = DEFAULT_SETTINGS.provider;
	}

	return settings;
}

export class AiOverviewSettingTab extends PluginSettingTab {
	private plugin: AiOverviewPlugin;

	constructor(app: App, plugin: AiOverviewPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const active = this.plugin.settings.provider;
		const provider = getProvider(active);
		const command = this.plugin.command();
		const catalogue = this.plugin.catalogue.peek(active, command);

		new Setting(containerEl)
			.setName("Agent CLI")
			.setDesc("Which locally installed CLI generates overviews.")
			.addDropdown((d) => {
				for (const id of PROVIDER_IDS) d.addOption(id, getProvider(id).label);
				d.setValue(active).onChange(async (value) => {
					this.plugin.settings.provider = value as ProviderId;
					await this.plugin.saveSettings();
					this.plugin.refreshViews();
					// The remaining settings are per-provider, so rebuild them.
					this.display();
				});
			});

		new Setting(containerEl)
			.setName(`${provider.label} path`)
			.setDesc(
				"Executable name or absolute path. A bare name is resolved against PATH plus the usual install directories."
			)
			.addText((t) =>
				t
					.setPlaceholder(provider.defaultPath)
					.setValue(this.plugin.settings.paths[active])
					.onChange(async (v) => {
						this.plugin.settings.paths[active] = v.trim() || provider.defaultPath;
						await this.plugin.saveSettings();
					})
					.inputEl.addEventListener("blur", () => {
						// A different executable may report a different catalogue.
						this.display();
					})
			);

		this.addModelSetting(active, provider, command, catalogue);
		this.addEffortSetting(active, provider, catalogue);

		new Setting(containerEl)
			.setName("Extra arguments")
			.setDesc(
				`Appended to every ${provider.label} invocation. Quoted values are kept together.`
			)
			.addText((t) =>
				t
					.setPlaceholder(ARGS_PLACEHOLDERS[active])
					.setValue(this.plugin.settings.extraArgs[active])
					.onChange(async (v) => {
						this.plugin.settings.extraArgs[active] = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Environment variables")
			.setDesc(
				"One KEY=VALUE per line, added to the CLI's environment. Obsidian doesn't inherit your shell's exports, so API keys usually have to be set here. Stored in plain text in the plugin's data folder."
			)
			.addTextArea((t) => {
				t.setPlaceholder("GOOGLE_GENERATIVE_AI_API_KEY=…")
					.setValue(this.plugin.settings.env)
					.onChange(async (v) => {
						this.plugin.settings.env = v;
						await this.plugin.saveSettings();
					});
				t.inputEl.rows = 3;
			});

		new Setting(containerEl)
			.setName("Timeout")
			.setDesc("Seconds before a generation is abandoned.")
			.addText((t) =>
				t
					.setPlaceholder(String(DEFAULT_SETTINGS.timeoutSeconds))
					.setValue(String(this.plugin.settings.timeoutSeconds))
					.onChange(async (v) => {
						const parsed = Number.parseInt(v, 10);
						this.plugin.settings.timeoutSeconds =
							Number.isFinite(parsed) && parsed > 0
								? parsed
								: DEFAULT_SETTINGS.timeoutSeconds;
						await this.plugin.saveSettings();
					})
			);
	}

	/**
	 * A dropdown of the models the CLI reports, or a text field when it has no
	 * listing command. The current value is always offered even if the CLI didn't
	 * list it, so a hand-picked model survives.
	 */
	private addModelSetting(
		active: ProviderId,
		provider: Provider,
		command: string,
		catalogue: Catalogue | null
	): void {
		const setting = new Setting(this.containerEl).setName("Model");
		const selected = this.plugin.settings.models[active];

		if (!provider.listModels) {
			setting.setDesc(
				`${provider.label} has no model listing command, so the model has to be typed in. Empty uses whichever model it selects.`
			);
			setting.addText((t) =>
				t
					.setPlaceholder(CLI_DEFAULT_LABEL)
					.setValue(selected)
					.onChange(async (v) => {
						this.plugin.settings.models[active] = v.trim();
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					})
			);
			return;
		}

		if (!catalogue) {
			setting.setDesc(`Asking ${provider.label} which models it supports…`);
			setting.addDropdown((d) => {
				d.addOption(selected, selected || "Loading…");
				d.setDisabled(true);
			});
			this.loadCatalogue(active, command);
			return;
		}

		if (catalogue.models.length === 0) {
			setting.setDesc(
				catalogue.error
					? `Couldn't list models: ${catalogue.error}`
					: `${provider.label} reported no models.`
			);
		} else {
			setting.setDesc(
				`${catalogue.models.length} models reported by ${provider.label}. Empty uses whichever it selects.`
			);
		}

		setting.addDropdown((d) => {
			d.addOption(CLI_DEFAULT, CLI_DEFAULT_LABEL);
			for (const model of catalogue.models) d.addOption(model.id, model.label);
			if (selected && !catalogue.models.some((m) => m.id === selected)) {
				d.addOption(selected, `${selected} (not listed)`);
			}
			d.setValue(selected).onChange(async (value) => {
				this.plugin.settings.models[active] = value;
				// Levels are per model for some CLIs, so a stale one is dropped.
				const allowed = effortOptions(catalogue, value);
				if (allowed.length && !allowed.includes(this.plugin.settings.efforts[active])) {
					this.plugin.settings.efforts[active] = CLI_DEFAULT;
				}
				await this.plugin.saveSettings();
				this.plugin.refreshViews();
				this.display();
			});
		});

		setting.addExtraButton((b) =>
			b
				.setIcon("refresh-cw")
				.setTooltip("Ask the CLI again")
				.onClick(() => {
					this.plugin.catalogue.invalidate(active, command);
					this.display();
				})
		);
	}

	/** A dropdown of the thinking levels the CLI reports for the chosen model. */
	private addEffortSetting(
		active: ProviderId,
		provider: Provider,
		catalogue: Catalogue | null
	): void {
		if (!provider.listModels && !provider.listEfforts) return;

		const setting = new Setting(this.containerEl).setName(provider.effortLabel);
		const selected = this.plugin.settings.efforts[active];

		if (!catalogue) {
			setting.setDesc(`Asking ${provider.label} which levels it supports…`);
			setting.addDropdown((d) => {
				d.addOption(selected, selected || "Loading…");
				d.setDisabled(true);
			});
			return;
		}

		const options = effortOptions(catalogue, this.plugin.settings.models[active]);
		if (options.length === 0) {
			setting.setDesc(
				catalogue.error
					? `Couldn't list levels: ${catalogue.error}`
					: `${provider.label} reported none for this model.`
			);
			setting.addDropdown((d) => {
				d.addOption(CLI_DEFAULT, CLI_DEFAULT_LABEL);
				d.setValue(CLI_DEFAULT).setDisabled(true);
			});
			return;
		}

		setting.setDesc(
			this.plugin.settings.models[active]
				? `Reported for the selected model. Empty uses that model's own default.`
				: `Reported by ${provider.label}. Empty uses its own default.`
		);

		setting.addDropdown((d) => {
			d.addOption(CLI_DEFAULT, CLI_DEFAULT_LABEL);
			for (const effort of options) d.addOption(effort, effort);
			if (selected && !options.includes(selected)) {
				d.addOption(selected, `${selected} (not listed)`);
			}
			d.setValue(selected).onChange(async (value) => {
				this.plugin.settings.efforts[active] = value;
				await this.plugin.saveSettings();
				this.plugin.refreshViews();
			});
		});
	}

	/** Kicks off a lookup and redraws once the CLI has answered. */
	private loadCatalogue(provider: ProviderId, command: string): void {
		void this.plugin.catalogue.load(provider, command).then(() => {
			// The tab may have been closed or switched in the meantime.
			if (this.plugin.settings.provider !== provider) return;
			if (!this.containerEl.isConnected) return;
			this.display();
		});
	}
}
