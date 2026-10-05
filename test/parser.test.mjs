import assert from "node:assert/strict";
import { test } from "node:test";
import {
	needsSummary,
	parseRegions,
	promptHash,
	runKey,
	runKeyPrefix,
} from "../src/parser.ts";
import { upsertSummary } from "../src/writer.ts";

const draft = {
	title: "Generated title",
	body: "- one\n- two",
	provider: "codex",
	model: "gpt-5.6-luna",
	generated: "2026-07-29T09:12Z",
};

test("a bare callout yields a prompt and no summary", () => {
	const [region] = parseRegions("> [!ai]\n> Summarise this note.\n");
	assert.equal(region.title, "");
	assert.equal(region.prompt, "Summarise this note.");
	assert.equal(region.summary, null);
	assert.equal(needsSummary(region), true);
});

test("a title on the header is picked up", () => {
	const [region] = parseRegions("> [!ai] Risk review\n> What are the risks?\n");
	assert.equal(region.title, "Risk review");
	assert.equal(region.prompt, "What are the risks?");
});

test("a multi-line prompt keeps its line breaks", () => {
	const [region] = parseRegions("> [!ai]\n> First line.\n> Second line.\n");
	assert.equal(region.prompt, "First line.\nSecond line.");
});

test("the callout ends at the first unquoted line", () => {
	const text = "> [!ai]\n> Prompt.\n\nOrdinary paragraph.\n";
	const [region] = parseRegions(text);
	assert.equal(region.lineStart, 0);
	assert.equal(region.lineEnd, 1);
	assert.equal(region.prompt, "Prompt.");
});

test("several callouts in one note are all found", () => {
	const text = "> [!ai] One\n> a\n\ntext\n\n> [!ai] Two\n> b\n";
	assert.deepEqual(
		parseRegions(text).map((r) => r.title),
		["One", "Two"]
	);
});

test("a nested summary is read with its provenance", () => {
	const text = [
		"> [!ai] Risk review",
		"> What are the risks?",
		"> ",
		"> > [!summary] <!-- ai codex/gpt-5.6-luna 2026-07-29T09:12Z 1234abcd -->",
		"> > - Budget is unowned.",
		"> > - Rollback untested.",
		"",
	].join("\n");

	const [region] = parseRegions(text);
	assert.equal(region.prompt, "What are the risks?");
	assert.equal(region.summary.body, "- Budget is unowned.\n- Rollback untested.");
	assert.deepEqual(region.summary.meta, {
		provider: "codex",
		model: "gpt-5.6-luna",
		generated: "2026-07-29T09:12Z",
		hash: "1234abcd",
		ownsParentTitle: false,
	});
	assert.equal(region.summary.title, "");
});

test("a generated title on the nested callout is separated from the comment", () => {
	const text = [
		"> [!ai]",
		"> Prompt.",
		"> > [!summary] Budget is unowned <!-- ai claude/opus 2026-07-29T09:12Z 1234abcd -->",
		"> > Body.",
	].join("\n");
	const [region] = parseRegions(text);
	assert.equal(region.summary.title, "Budget is unowned");
	assert.equal(region.summary.meta.model, "opus");
});

test("a matching hash means no regeneration", () => {
	const prompt = "What are the risks?";
	const text = [
		"> [!ai]",
		`> ${prompt}`,
		`> > [!summary] T <!-- ai codex/x 2026-07-29T09:12Z ${promptHash(prompt)} -->`,
		"> > Body.",
	].join("\n");
	assert.equal(needsSummary(parseRegions(text)[0]), false);
});

test("an edited prompt makes the summary stale", () => {
	const text = [
		"> [!ai]",
		"> A different prompt now.",
		`> > [!summary] T <!-- ai codex/x 2026-07-29T09:12Z ${promptHash("the old prompt")} -->`,
		"> > Body.",
	].join("\n");
	assert.equal(needsSummary(parseRegions(text)[0]), true);
});

test("a hand-written summary is never considered stale", () => {
	const text = ["> [!ai]", "> Prompt.", "> > [!summary] Mine", "> > My own words."].join("\n");
	const [region] = parseRegions(text);
	assert.equal(region.summary.meta, null);
	assert.equal(needsSummary(region), false);
});

test("an empty prompt generates nothing", () => {
	assert.equal(needsSummary(parseRegions("> [!ai] Title\n> \n")[0]), false);
});

test("a summary is inserted into a bare callout", () => {
	const text = "> [!ai] Risk review\n> What are the risks?\n\nAfter.\n";
	const out = upsertSummary(text, "What are the risks?", draft);
	assert.equal(
		out,
		[
			"> [!ai] Risk review",
			"> What are the risks?",
			"> ",
			`> > [!summary] Generated title <!-- ai codex/gpt-5.6-luna 2026-07-29T09:12Z ${promptHash("What are the risks?")} -->`,
			"> > - one",
			"> > - two",
			"",
			"After.",
			"",
		].join("\n")
	);
	// Round-trips: the written summary parses back and is no longer stale.
	const [region] = parseRegions(out);
	assert.equal(region.summary.body, "- one\n- two");
	assert.equal(needsSummary(region), false);
});

test("the generated title goes on the header when the callout has none", () => {
	const out = upsertSummary("> [!ai]\n> Prompt.\n", "Prompt.", draft);
	assert.ok(out.includes("> [!ai] Generated title"));
	// Flagged as the plugin's, so a later run may replace it.
	assert.match(out, /\[!summary\] <!-- ai .* title -->/);
	assert.equal(parseRegions(out)[0].summary.meta.ownsParentTitle, true);
});

test("a title the user wrote is kept, and the generated one goes on the summary", () => {
	const out = upsertSummary("> [!ai] My title\n> Prompt.\n", "Prompt.", draft);
	assert.ok(out.includes("> [!ai] My title"));
	assert.match(out, /\[!summary\] Generated title <!-- ai /);
	assert.equal(parseRegions(out)[0].summary.meta.ownsParentTitle, false);
});

test("a header title the plugin wrote earlier is replaced on the next run", () => {
	const first = upsertSummary("> [!ai]\n> Prompt.\n", "Prompt.", draft);
	const second = upsertSummary(first, "Prompt.", { ...draft, title: "Newer title" });
	assert.ok(second.includes("> [!ai] Newer title"));
	assert.ok(!second.includes("Generated title"));
	assert.equal((second.match(/\[!summary\]/g) ?? []).length, 1);
});

test("a fold marker on the header survives a title being written", () => {
	const out = upsertSummary("> [!ai]- \n> Prompt.\n", "Prompt.", draft);
	assert.ok(out.includes("> [!ai]- Generated title"));
});

test("a summary is still written when the agent returned no title", () => {
	const out = upsertSummary("> [!ai]\n> Prompt.\n", "Prompt.", { ...draft, title: null });
	assert.match(out, /\[!summary\] <!-- ai /);
	assert.ok(out.includes("> > - one"));
	// Nothing to put on the header, so it stays untitled and unflagged.
	assert.ok(out.includes("> [!ai]\n"));
	assert.equal(parseRegions(out)[0].summary.meta.ownsParentTitle, false);
});

test("blank lines in the body stay inside the callout", () => {
	const out = upsertSummary("> [!ai]\n> Prompt.\n", "Prompt.", {
		...draft,
		body: "First para.\n\nSecond para.",
	});
	assert.ok(out.includes("> > First para.\n> >\n> > Second para."));
});

test("regenerating replaces the previous summary rather than stacking", () => {
	const first = upsertSummary("> [!ai]\n> Prompt.\n", "Prompt.", draft);
	const second = upsertSummary(first, "Prompt.", { ...draft, body: "- fresh" });
	assert.equal((second.match(/\[!summary\]/g) ?? []).length, 1);
	assert.ok(second.includes("> > - fresh"));
	assert.ok(!second.includes("> > - one"));
});

test("a note whose prompt changed since the run started is left alone", () => {
	const text = "> [!ai]\n> A totally different prompt.\n";
	assert.equal(upsertSummary(text, "the prompt we ran", draft), null);
});

test("a hand-written summary is not overwritten", () => {
	const text = ["> [!ai]", "> Prompt.", "> > [!summary] Mine", "> > My own words."].join("\n");
	assert.equal(upsertSummary(text, "Prompt.", draft), null);
});

test("surrounding content is preserved exactly", () => {
	const text = "# Note\n\nIntro.\n\n> [!ai]\n> Prompt.\n\nOutro.\n";
	const out = upsertSummary(text, "Prompt.", draft);
	assert.ok(out.startsWith("# Note\n\nIntro.\n\n"));
	assert.ok(out.endsWith("\nOutro.\n"));
});

test("hashing ignores surrounding whitespace but tracks content", () => {
	assert.equal(promptHash("  same  "), promptHash("same"));
	assert.notEqual(promptHash("a"), promptHash("b"));
});

test("a run key is matched by its note's prefix", () => {
	const path = "IaC+ Brokered Import Failure (Work Note).md";
	const key = runKey(path, "Summarise the note in 3 sentences");
	// The bug this guards: building a key one way and matching it another.
	assert.ok(key.startsWith(runKeyPrefix(path)));
});

test("run keys distinguish prompts and notes", () => {
	assert.notEqual(runKey("a.md", "one"), runKey("a.md", "two"));
	assert.notEqual(runKey("a.md", "one"), runKey("b.md", "one"));
	assert.equal(runKey("a.md", "  one  "), runKey("a.md", "one"));
});

test("a note's prefix does not match another note's key", () => {
	assert.ok(!runKey("notes/a.md", "p").startsWith(runKeyPrefix("notes/a")));
	assert.ok(!runKey("a b.md", "p").startsWith(runKeyPrefix("a")));
});
