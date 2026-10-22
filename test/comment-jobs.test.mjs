import assert from "node:assert/strict";
import { test } from "node:test";
import { CommentJobs, parseSavedJobs } from "../src/comment-jobs.ts";

const request = (id = "one") => ({ id, source: "comment-block", notePath: "Note.md", commentId: id, message: "@teddy help", quote: null, thread: [] });
async function until(predicate) {
	for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 1)); }
	assert.fail("job did not settle");
}
function fixture(overrides = {}, saved = []) {
	const published = [], applied = [], snapshots = [];
	let runs = 0;
	const jobs = new CommentJobs({
		persist: async (data) => { snapshots.push(structuredClone(data)); },
		launch: () => { runs++; return { result: Promise.resolve({ reply: "Answer", changes: [] }), cancel() {} }; },
		apply: async (change) => { applied.push(change); }, ...overrides,
	}, saved);
	jobs.configure("teddy");
	const host = { validate: async () => true, publish: async (...args) => { published.push(args); } };
	const detach = jobs.attach("comment-block", host);
	return { jobs, host, published, applied, snapshots, detach, runs: () => runs, state: (id = "one") => jobs.jobs("comment-block", "Note.md").find((j) => j.request.id === id)?.state };
}

test("a submitted comment runs once across repeated submissions and restarts", async () => {
	const f = fixture();
	await Promise.all([f.jobs.submit(request()), f.jobs.submit(request()), f.jobs.submit({ ...request("duplicate"), commentId: "one" })]);
	await until(() => f.state() === "completed");
	assert.equal(f.runs(), 1); assert.equal(f.published.length, 1);
	const restored = fixture({}, f.snapshots.at(-1));
	await restored.jobs.submit(request());
	assert.equal(restored.runs(), 0);
});

test("queue serializes runs and persists before launching", async () => {
	let release, launches = 0, persisted = 0;
	const f = fixture({ persist: async () => { persisted++; }, launch: () => {
		assert.ok(persisted); launches++;
		return { result: launches === 1 ? new Promise((r) => { release = r; }) : Promise.resolve({ reply: "Second", changes: [] }), cancel() {} };
	} });
	await f.jobs.submit(request()); await until(() => !!release);
	await f.jobs.submit(request("two")); assert.equal(launches, 1);
	release({ reply: "First", changes: [] });
	await until(() => f.state("two") === "completed"); assert.equal(launches, 2);
});

test("publication retry retains the result and never repeats applied edits", async () => {
	let publications = 0;
	const f = fixture({ launch: () => ({ result: Promise.resolve({ reply: "Proposed change", changes: [{ kind: "create", path: "New.md", content: "Body" }] }), cancel() {} }) });
	f.host.publish = async () => { if (++publications === 1) throw new Error("Publication failed"); };
	await f.jobs.submit(request()); await until(() => f.state() === "failed");
	assert.equal(f.applied.length, 1);
	await f.jobs.retry("one"); await until(() => f.state() === "completed");
	assert.equal(f.applied.length, 1); assert.equal(publications, 2);
});

test("partial changes are reported, with failed replacements not claimed as applied", async () => {
	const f = fixture({
		launch: () => ({ result: Promise.resolve({ reply: "Requested edits", changes: [
			{ kind: "create", path: "Good.md", content: "Body" }, { kind: "create", path: "Bad.md", content: "Body" },
		] }), cancel() {} }),
		apply: async (change) => { if (change.path === "Bad.md") throw new Error("Already exists"); },
	});
	await f.jobs.submit(request()); await until(() => f.state() === "completed");
	assert.match(f.published[0][2], /Applied: Good.md/); assert.match(f.published[0][2], /Not applied: Bad.md.*Already exists/);
});

test("removed or changed comments cancel before any changes or publication", async () => {
	const f = fixture(); f.host.validate = async () => false;
	await f.jobs.submit(request()); await until(() => f.state() === "cancelled");
	assert.equal(f.runs(), 0); assert.equal(f.applied.length, 0); assert.equal(f.published.length, 0);
});

test("detaching a source cancels its running process and does not publish", async () => {
	let reject, cancelled = false;
	const f = fixture({ launch: () => ({ result: new Promise((_resolve, fail) => { reject = fail; }), cancel() { cancelled = true; reject(new Error("Cancelled")); } }) });
	await f.jobs.submit(request()); await until(() => !!reject); f.detach();
	await until(() => f.state() === "cancelled"); assert.equal(cancelled, true); assert.equal(f.published.length, 0);
});

test("interrupted work requires retry and uncertain changes are never replayed", async () => {
	const f = fixture({}, [{ request: request(), tag: "teddy", state: "applying", result: { reply: "Answer", changes: [{ kind: "create", path: "New.md", content: "Body" }] }, outcomes: [{ path: "New.md", state: "applying" }] }]);
	assert.equal(f.state(), "failed"); assert.equal(f.runs(), 0);
	await f.jobs.retry("one"); await until(() => f.state() === "completed");
	assert.equal(f.applied.length, 0); assert.match(f.published[0][2], /Uncertain/);
});

test("blank tag and unavailable sources do not execute", async () => {
	const f = fixture(); f.jobs.configure(""); await f.jobs.submit(request());
	assert.equal(f.runs(), 0); assert.equal(f.state(), undefined);
});

test("storage failure prevents launch", async () => {
	const f = fixture({ persist: async () => { throw new Error("Disk full"); } });
	await f.jobs.submit(request()); assert.equal(f.state(), "failed"); assert.equal(f.runs(), 0);
});

test("corrupt history fails closed instead of forgetting processed requests", () => {
 for(const value of [null,{},[{request:{id:'one'},outcomes:[]}],[{request:request(),tag:'teddy',state:'completed',outcomes:[null]}]]) assert.throws(()=>parseSavedJobs(value));
});
