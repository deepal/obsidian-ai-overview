import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { analyzeCommits } from "@semantic-release/commit-analyzer";
import { generateNotes } from "@semantic-release/release-notes-generator";

const config = JSON.parse(await readFile(new URL("../.releaserc.json", import.meta.url), "utf8"));
const [, analyzerOptions] = config.plugins.find(([name]) => name === "@semantic-release/commit-analyzer");
const script = fileURLToPath(new URL("../scripts/update-obsidian-version.mjs", import.meta.url));

test("release rules recognize features, fixes, breaking changes, and non-release commits", async () => {
	for (const [message, expected] of [
		["fix: correct callout parsing", "patch"],
		["feat: add a provider", "minor"],
		["feat!: change the callout format", "major"],
		["refactor: change parsing\n\nBREAKING CHANGE: old callouts are no longer supported", "major"],
		["docs: clarify installation", null],
		["chore(release): 1.0.0 [skip ci]", null],
	]) {
		const result = await analyzeCommits(analyzerOptions, {
			cwd: process.cwd(),
			commits: [{ hash: "abcdef0", message }],
			logger: { log() {} },
		});
		assert.equal(result, expected, message);
	}
});

test("release notes render with the configured Conventional Commits preset", async () => {
	const [, options] = config.plugins.find(([name]) => name === "@semantic-release/release-notes-generator");
	const notes = await generateNotes(options, {
		cwd: process.cwd(),
		options: { repositoryUrl: "https://github.com/deepal/obsidian-ai-overview.git" },
		commits: [{ hash: "abcdef0123456789", message: "feat: add a provider" }],
		lastRelease: { version: "1.0.0", gitTag: "1.0.0" },
		nextRelease: { version: "1.1.0", gitTag: "1.1.0" },
		logger: { log() {} },
	});
	assert.match(notes, /1\.1\.0/);
	assert.match(notes, /Features/);
	assert.match(notes, /add a provider/);
});

test("Obsidian release versions stay in sync and preserve compatibility history", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "ai-overview-version-"));
	try {
		const manifest = { id: "ai-overview", version: "0.1.0", minAppVersion: "1.5.0", isDesktopOnly: true };
		await writeFile(path.join(directory, "package.json"), JSON.stringify({ version: "1.2.3" }));
		await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
		await writeFile(path.join(directory, "versions.json"), JSON.stringify({ "0.1.0": "1.5.0" }));
		const run = (version) => execFileSync(process.execPath, [script, version], { cwd: directory, stdio: "pipe" });
		const readJson = async (file) => JSON.parse(await readFile(path.join(directory, file), "utf8"));

		for (const invalid of ["v1.2.3", "1.2.3-beta.1", "01.2.3", "1.2", "2.0.0"]) {
			assert.throws(() => run(invalid));
			assert.deepEqual(await readJson("manifest.json"), manifest);
			assert.deepEqual(await readJson("versions.json"), { "0.1.0": "1.5.0" });
		}

		run("1.2.3");
		assert.deepEqual(await readJson("manifest.json"), { ...manifest, version: "1.2.3" });
		assert.deepEqual(await readJson("versions.json"), { "0.1.0": "1.5.0", "1.2.3": "1.5.0" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
