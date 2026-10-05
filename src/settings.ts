import { App, PluginSettingTab, type Setting, type SettingDefinitionItem } from "obsidian";
import { effortOptions, type Catalogue } from "./discover.ts";
import { getProvider, PROVIDER_IDS, type Provider, type ProviderId } from "./providers.ts";
import type AiOverviewPlugin from "./main.ts";
export { DEFAULT_SETTINGS, mergeSettings, type AiOverviewSettings } from "./settings-data.ts";

const ARGS_PLACEHOLDERS: Record<ProviderId, string> = {
	codex: "-c model_verbosity=low", claude: "--add-dir ../shared", opencode: "--agent plan",
};
const CLI_DEFAULT = "";
const CLI_DEFAULT_LABEL = "CLI default";

export class AiOverviewSettingTab extends PluginSettingTab {
	private plugin: AiOverviewPlugin;

	constructor(app: App, plugin: AiOverviewPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const active = this.plugin.settings.provider;
		const provider = getProvider(active);
		const command = this.plugin.command();
		const catalogue = this.plugin.catalogue.peek(active, command);
		return [
			{
				name: "Agent CLI",
				desc: "Which locally installed CLI generates overviews.",
				render: (setting) => {
					setting.addDropdown((d) => {
						for (const id of PROVIDER_IDS) d.addOption(id, getProvider(id).label);
						d.setValue(active).onChange(async (value) => {
							if (!PROVIDER_IDS.includes(value as ProviderId)) return;
							this.plugin.settings.provider = value as ProviderId;
							await this.plugin.saveSettings();
							this.plugin.refreshViews();
							this.update();
						});
					});
				},
			},
			{
				name: `${provider.label} path`,
				desc: "Executable name or absolute path. Bare names are resolved using the executable search path and common install directories.",
				render: (setting) => {
					setting.addText((t) => {
						t.setPlaceholder(provider.defaultPath).setValue(this.plugin.settings.paths[active]).onChange(async (value) => {
							this.plugin.settings.paths[active] = value.trim() || provider.defaultPath;
							await this.plugin.saveSettings();
						});
						t.inputEl.addEventListener("blur", () => this.update());
					});
				},
			},
			{
				name: "Model",
				desc: "Model used by the selected agent. Leave empty to use its default.",
				render: (setting) => this.addModelSetting(setting, active, provider, command, catalogue),
			},
			{
				name: provider.effortLabel,
				desc: "Thinking level used by the selected model.",
				visible: Boolean(provider.listModels || provider.listEfforts),
				render: (setting) => this.addEffortSetting(setting, active, provider, catalogue),
			},
			{
				name: "Extra arguments",
				desc: `Appended to every ${provider.label} invocation. Quoted values are kept together.`,
				render: (setting) => {
					setting.addText((t) => t.setPlaceholder(ARGS_PLACEHOLDERS[active])
						.setValue(this.plugin.settings.extraArgs[active]).onChange(async (value) => {
							this.plugin.settings.extraArgs[active] = value;
							await this.plugin.saveSettings();
						}));
				},
			},
			{
				name: "Environment variables",
				desc: "One key and value per line, separated by an equals sign. Added to the CLI environment and stored in plain text in the plugin data folder.",
				control: { type: "textarea", key: "env", placeholder: "NAME=value" },
			},
			{
				name: "Timeout",
				desc: "Seconds before a generation is abandoned.",
				control: {
					type: "number", key: "timeoutSeconds", min: 1, step: 1,
					validate: (value) => Number.isSafeInteger(value) && value > 0 ? undefined : "Enter a positive whole number.",
				},
			},
		];
	}

	/**
	 * A dropdown of the models the CLI reports, or a text field when it has no
	 * listing command. The current value is always offered even if the CLI didn't
	 * list it, so a hand-picked model survives.
	 */
	private addModelSetting(
		setting: Setting,
		active: ProviderId,
		provider: Provider,
		command: string,
		catalogue: Catalogue | null
	): void {
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
			void this.loadCatalogue(active, command, setting.settingEl);
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
				this.update();
			});
		});

		setting.addExtraButton((b) =>
			b
				.setIcon("refresh-cw")
				.setTooltip("Ask the CLI again")
				.onClick(() => {
					this.plugin.catalogue.invalidate(active, command);
					this.update();
				})
		);
	}

	/** A dropdown of the thinking levels the CLI reports for the chosen model. */
	private addEffortSetting(
		setting: Setting,
		active: ProviderId,
		provider: Provider,
		catalogue: Catalogue | null
	): void {
		if (!provider.listModels && !provider.listEfforts) return;

		const selected = this.plugin.settings.efforts[active];

		if (!catalogue) {
			setting.setDesc(`Asking ${provider.label} which levels it supports…`);
			void this.loadCatalogue(active, this.plugin.command(), setting.settingEl);
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

	/** Only rendered controls trigger discovery; indexing definitions never does. */
	private async loadCatalogue(provider: ProviderId, command: string, row: HTMLElement): Promise<void> {
		await this.plugin.catalogue.load(provider, command);
		if (this.plugin.settings.provider !== provider || this.plugin.command() !== command) return;
		if (!row.isConnected) return;
		this.update();
	}
}
