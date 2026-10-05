import assert from "node:assert/strict";
import { test } from "node:test";
import { parseResult } from "../src/agent.ts";

test("a conforming object yields title and body", () => {
	const result = parseResult('{"title": "A title", "body": "- one\\n- two"}');
	assert.equal(result.title, "A title");
	assert.equal(result.body, "- one\n- two");
});

test("a fenced object is unwrapped", () => {
	const result = parseResult('```json\n{"title": "T", "body": "B"}\n```');
	assert.deepEqual(result, { title: "T", body: "B" });
});

test("plain Markdown becomes the body with no title", () => {
	const result = parseResult("## Heading\n\nSome prose.");
	assert.equal(result.title, null);
	assert.equal(result.body, "## Heading\n\nSome prose.");
});

test("a blank title is treated as absent", () => {
	assert.equal(parseResult('{"title": "  ", "body": "B"}').title, null);
});

test("an object without a body is rendered as-is", () => {
	const text = '{"summary": "wrong shape"}';
	assert.deepEqual(parseResult(text), { title: null, body: text });
});

test("invalid JSON is rendered as-is", () => {
	const text = '{"title": "unterminated';
	assert.deepEqual(parseResult(text), { title: null, body: text });
});
