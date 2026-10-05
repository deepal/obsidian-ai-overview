import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mergeSettings } from "../src/settings-data.ts";

const result = await build({
	entryPoints: ["src/settings.ts"], bundle: true, platform: "node", format: "esm", write: false,
	plugins: [{ name: "obsidian-test-host", setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test-host" }));
		builder.onLoad({ filter: /.*/, namespace: "test-host" }, () => ({ contents: `
			export class App {}
			export class PluginSettingTab {
				updates = 0;
				update() { this.updates++; }
			}
		` }));
	} }],
});
const { AiOverviewSettingTab } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

function fixture() {
	let resolve;
	let loads = 0;
	const pending = new Promise((done) => { resolve = done; });
	const plugin = {
		settings: mergeSettings({}), command() { return this.settings.paths[this.settings.provider]; },
		catalogue: { peek: () => null, load: () => { loads++; return pending; } },
	};
	const tab = new AiOverviewSettingTab({}, plugin);
	const row = { isConnected: true };
	const dropdown = { addOption() { return this; }, setDisabled() { return this; } };
	const setting = { settingEl: row, setDesc() {}, addDropdown(fn) { fn(dropdown); } };
	return { tab, plugin, row, setting, resolve, loads: () => loads };
}

test("indexing settings never launches model discovery", () => {
	const f = fixture();
	const definitions = f.tab.getSettingDefinitions();
	assert.equal(definitions.length, 7);
	assert.equal(f.loads(), 0);
	assert.ok(definitions.every((definition) => definition.name));
});

for (const scenario of ["current", "provider changed", "path changed", "row removed"]) {
	test(`model discovery refresh guard - ${scenario}`, async () => {
		const f = fixture();
		f.tab.getSettingDefinitions().find((d) => d.name === "Model").render(f.setting);
		assert.equal(f.loads(), 1);
		if (scenario === "provider changed") f.plugin.settings.provider = "claude";
		if (scenario === "path changed") f.plugin.settings.paths.codex = "/different/codex";
		if (scenario === "row removed") f.row.isConnected = false;
		f.resolve({ models: [], efforts: [] });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(f.tab.updates, scenario === "current" ? 1 : 0);
	});
}

test("Claude effort-only discovery starts from rendering, not indexing", () => {
	const f = fixture();
	f.plugin.settings.provider = "claude";
	const definitions = f.tab.getSettingDefinitions();
	assert.equal(f.loads(), 0);
	definitions.find((d) => d.name === "Effort level").render(f.setting);
	assert.equal(f.loads(), 1);
});
