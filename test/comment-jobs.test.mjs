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
		launch: () => { runs++; return { result: Promise.resolve({ reply: "Answer" }), cancel() {} }; },
		apply: async (change) => { applied.push(change); }, ...overrides,
	}, saved);
	jobs.configure("teddy");
	const host = { prepare: async () => {}, validate: async () => true, publish: async (...args) => { published.push(args); } };
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
		return { result: launches === 1 ? new Promise((r) => { release = r; }) : Promise.resolve({ reply: "Second" }), cancel() {} };
	} });
	await f.jobs.submit(request()); await until(() => !!release);
	await f.jobs.submit(request("two")); assert.equal(launches, 1);
	release({ reply: "First" });
	await until(() => f.state("two") === "completed"); assert.equal(launches, 2);
});

test("publication retry retains a direct response and never repeats execution or applies planned changes", async () => {
 let publications=0, launches=0;
 const f=fixture({launch:()=>{launches++;return {result:Promise.resolve({reply:"Edited directly"}),cancel(){}};}});
 f.host.publish=async()=>{if(++publications===1)throw new Error("Publication failed");};
 await f.jobs.submit(request());await until(()=>f.state()==="failed");
 assert.equal(launches,1);assert.equal(f.applied.length,0);assert.deepEqual(f.snapshots.find(s=>s[0]?.result)?.[0].result,{reply:"Edited directly"});
 await f.jobs.retry("one");await until(()=>f.state()==="completed");
 assert.equal(launches,1);assert.equal(f.applied.length,0);assert.equal(publications,2);
});

test("saved legacy changes retain partial outcomes and do not launch a new agent",async()=>{
 const legacy={request:request(),tag:"teddy",state:"failed",result:{reply:"Requested edits",changes:[{kind:"create",path:"Good.md",content:"Body"},{kind:"create",path:"Bad.md",content:"Body"}]},outcomes:[{path:"Good.md",state:"applied"},{path:"Bad.md",state:"pending"}]};
 const f=fixture({apply:async()=>{throw new Error("Already exists");}},[legacy]);
 await f.jobs.retry("one");await until(()=>f.state()==="completed");
 assert.equal(f.runs(),0);assert.match(f.published[0][2],/Applied: Good.md/);assert.match(f.published[0][2],/Not applied: Bad.md.*Already exists/);
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

test("v2 requires preparation support and saves before direct execution",async()=>{
 const f=fixture();assert.equal(f.jobs.version,2);
 assert.throws(()=>f.jobs.attach("inline-review-comment",{validate:async()=>true,publish:async()=>{}}),/v2/);
 let prepared=false;f.host.prepare=async()=>{prepared=true;};
 await f.jobs.submit(request());await until(()=>f.state()==="completed");assert.equal(prepared,true);
});

test("execution retry receives prior failure context and never restarts automatically",async()=>{
 const seen=[];let effects=0;
 const f=fixture({launch:r=>{seen.push(r);effects++;return {result:effects===1?Promise.reject(new Error("Failed after a direct write")):Promise.resolve({reply:"Continued from current files"}),cancel(){}};}});
 await f.jobs.submit(request());await until(()=>f.state()==="failed");assert.equal(effects,1);
 await f.jobs.retry("one");await until(()=>f.state()==="completed");
 assert.equal(seen[1].retryContext.attempt,2);assert.match(seen[1].retryContext.previousError,/direct write/);assert.equal(f.applied.length,0);
});

test("rename follows the originating note without cancelling the running agent",async()=>{
 let release,cancels=0;
 const f=fixture({launch:()=>({result:new Promise(r=>{release=r;}),cancel(){cancels++;}})});
 await f.jobs.submit(request());await until(()=>!!release);f.jobs.rename("Note.md","Moved.md");release({reply:"Renamed"});
 await until(()=>f.jobs.jobs("comment-block","Moved.md")[0]?.state==="completed");
 assert.equal(cancels,0);assert.equal(f.published[0][0].notePath,"Moved.md");
});

test("missing publication targets retain the response and retry only publication",async()=>{
 let valid=true,missing=true;
 const f=fixture({persist:async jobs=>{if(jobs[0]?.result&&missing){valid=false;missing=false;}}});f.host.validate=async()=>valid;
 await f.jobs.submit(request());await until(()=>f.state()==="failed");
 assert.equal(f.runs(),1);assert.deepEqual(f.jobs.jobs("comment-block","Note.md")[0].result,{reply:"Answer"});
 valid=true;await f.jobs.retry("one");await until(()=>f.state()==="completed");assert.equal(f.runs(),1);
});

test("old interrupted executions without a result require explicit retry and migrate to direct replies",async()=>{
 const saved={request:request(),tag:"teddy",state:"running",outcomes:[]};
 let context;
 const f=fixture({launch:r=>{context=r.retryContext;return {result:Promise.resolve({reply:"Recovered"}),cancel(){}};}},[saved]);
 assert.equal(f.state(),"failed");await f.jobs.retry("one");await until(()=>f.state()==="completed");assert.equal(context.attempt,2);assert.equal(f.applied.length,0);
});


test("folder renames follow nested originating notes", async () => {
 const f=fixture();
 await f.jobs.submit({...request(),notePath:"Folder/Nested/Note.md"});
 await until(()=>f.jobs.jobs("comment-block","Folder/Nested/Note.md")[0]?.state==="completed");
 f.jobs.rename("Folder","Moved");
 assert.equal(f.jobs.jobs("comment-block","Moved/Nested/Note.md").length,1);
});

test("malformed replies retain effects but cannot be published as success", async () => {
 let effects=0;
 const f=fixture({launch:()=>{effects++;return{result:Promise.resolve({reply:"Done",changes:[]}),cancel(){}};}});
 await f.jobs.submit(request());await until(()=>f.state()==="failed");
 assert.equal(effects,1);assert.equal(f.published.length,0);assert.match(f.jobs.jobs("comment-block","Note.md")[0].error,/Work may already/);
});


test("failed response persistence blocks publication and retry never reruns direct work", async () => {
 let failed=false;
 const f=fixture({persist:async jobs=>{if(jobs[0]?.result&&!failed){failed=true;throw new Error("Result persistence failed");}}});
 await f.jobs.submit(request());await until(()=>f.state()==="failed");
 assert.equal(f.runs(),1);assert.equal(f.published.length,0);
 await f.jobs.retry("one");await until(()=>f.state()==="completed");
 assert.equal(f.runs(),1);assert.equal(f.published.length,1);
});
