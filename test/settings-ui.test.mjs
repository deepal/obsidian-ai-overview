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
	assert.equal(definitions.length, 8);
	assert.equal(f.loads(), 0);
	assert.ok(definitions.every((definition) => definition.name));
});

test("Pi provider can be selected without discarding another CLI's settings", async () => {
	const f = fixture();
	f.plugin.saveSettings = async () => {};
	f.plugin.refreshViews = () => {};
	f.plugin.settings.models.claude = "saved-claude-model";
	const labels = new Map();
	let change;
	const dropdown = { addOption(id, label) { labels.set(id, label); return this; }, setValue() { return this; }, onChange(fn) { change = fn; return this; } };
	f.tab.getSettingDefinitions().find((definition) => definition.name === "Agent CLI").render({ addDropdown(fn) { fn(dropdown); } });
	assert.equal(labels.get("pi"), "Pi CLI");
	await change("pi");
	assert.equal(f.plugin.settings.provider, "pi");
	assert.equal(f.plugin.command(), "pi");
	assert.equal(f.plugin.settings.models.claude, "saved-claude-model");
});

test("Pi model changes clear incompatible thinking and preserve CLI default", async () => {
	const f = fixture();
	f.plugin.settings.provider = "pi";
	f.plugin.settings.efforts.pi = "high";
	f.plugin.saveSettings = async () => {};
	f.plugin.refreshViews = () => {};
	f.plugin.catalogue.peek = () => ({ models: [{ id: "local/plain", label: "Plain", efforts: [], supportsThinking: false }, { id: "remote/reasoning", label: "Reasoning", efforts: [], supportsThinking: true }], efforts: ["off", "low", "high"] });
	let change;
	const dropdown = { addOption() { return this; }, setValue() { return this; }, onChange(fn) { change = fn; return this; } };
	const setting = { setDesc() {}, addDropdown(fn) { fn(dropdown); }, addExtraButton() {} };
	f.tab.getSettingDefinitions().find((definition) => definition.name === "Model").render(setting);
	await change("local/plain");
	assert.equal(f.plugin.settings.efforts.pi, "");
	await change("remote/reasoning");
	assert.equal(f.plugin.settings.efforts.pi, "");
	assert.equal(f.loads(), 0);
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

test("agent name tag removes typed and pasted whitespace from the field and saved value",async(t)=>{
 const f=fixture();f.plugin.saveSettings=async()=>{};
 let change;const text={value:"",setPlaceholder(){return this;},setValue(value){this.value=value;return this;},onChange(fn){change=fn;return this;}};
 const fragments=[];const desc={append:(...items)=>fragments.push(...items),createEl(){const link={};fragments.push(link);return link;}};
 globalThis.createFragment=()=>desc;t.after(()=>{delete globalThis.createFragment;});
 const setting={setDesc(value){assert.equal(value,desc);},addText:fn=>fn(text)};
 f.tab.getSettingDefinitions().find(d=>d.name==="Agent name tag").render(setting);
 assert.deepEqual(fragments.filter(item=>typeof item==="object").map(link=>[link.textContent,link.href]),[
  ["Obsidian Discussions","https://community.obsidian.md/plugins/comment-block"],
  ["Obsidian Inline Review Comments","https://community.obsidian.md/plugins/inline-review-comment"]
 ]);
 for(const value of ["sonny ","son ny"," sonny\t\n", "son\u00a0ny"]){
  text.value=value;await change(value);assert.equal(text.value,"sonny");assert.equal(f.plugin.settings.agentNameTag,"sonny");
 }
 await change("");assert.equal(f.plugin.settings.agentNameTag,"");
});
