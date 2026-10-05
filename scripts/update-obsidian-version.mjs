import { readFile, writeFile } from "node:fs/promises";

// @semantic-release/npm updates package.json and package-lock.json first.
// Obsidian accepts stable x.y.z versions and requires a matching release tag.
const version = process.argv[2];
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? "")) {
	throw new Error("Expected an Obsidian release version in x.y.z format.");
}

const [pkg, manifest, versions] = await Promise.all(
	["package.json", "manifest.json", "versions.json"].map(async (file) =>
		JSON.parse(await readFile(file, "utf8"))
	)
);

if (pkg.version !== version) {
	throw new Error("package.json must be updated by @semantic-release/npm before the Obsidian version files.");
}

manifest.version = version;
versions[version] = manifest.minAppVersion;

await writeFile("manifest.json", `${JSON.stringify(manifest, null, "\t")}\n`);
await writeFile("versions.json", `${JSON.stringify(versions, null, "\t")}\n`);
