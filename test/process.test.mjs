import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, chmod, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/agent.ts";
import { runCapture } from "../src/spawn.ts";
import { CatalogueCache } from "../src/discover.ts";

// Obsidian supplies browser timers; use Node's equivalent for subprocess fixtures.
globalThis.window = { setTimeout, clearTimeout };

async function fixture(t, code) {
	const dir = await mkdtemp(join(tmpdir(), "ai-overview-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const command = join(dir, "agent.mjs");
	await writeFile(command, `#!${process.execPath}\n${code}`);
	await chmod(command, 0o755);
	return { dir, command };
}

const options = (command, cwd) => ({ provider: "codex", command, cwd, notePath: "Synthetic.md", prompt: "Return synthetic test content.", extraArgs: [], model: "", effort: "", env: {}, timeoutMs: 1000, onProgress() {} });

test("missing CLIs and hung discovery return actionable errors", async (t) => {
	const f = await fixture(t, "setInterval(() => {}, 1000);");
	await assert.rejects(runCapture(join(f.dir, "missing"), [], { timeoutMs: 1000 }), /Could not run/);
	await assert.rejects(runCapture(f.command, [], { timeoutMs: 100 }), /did not respond in time/);
	await assert.rejects(runAgent(options(join(f.dir, "missing"), f.dir)).result, /Could not run/);
	await assert.rejects(runAgent({ ...options(f.command, f.dir), timeoutMs: 100 }).result, /Timed out/);
});

test("Codex structured output and terminal escapes are handled and temporary files are cleaned", async (t) => {
	const f = await fixture(t, `
		import { writeFileSync } from "node:fs";
		const args = process.argv;
		writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ title: "Fixture", body: "Synthetic answer" }));
		process.stdout.write("\\x1b[32m" + JSON.stringify({ type: "turn.completed" }) + "\\x1b[0m\\n");
	`);
	const before = (await readdir(tmpdir())).filter((name) => name.startsWith(`obsidian-ai-overview-${process.pid}-`));
	const result = await runAgent(options(f.command, f.dir)).result;
	assert.deepEqual(result, { title: "Fixture", body: "Synthetic answer" });
	const after = (await readdir(tmpdir())).filter((name) => name.startsWith(`obsidian-ai-overview-${process.pid}-`));
	assert.deepEqual(after, before);
});

test("an invalidated in-flight catalogue cannot overwrite the refreshed result", async (t) => {
	const f = await fixture(t, `
		const delay = Number(process.env.FIXTURE_DELAY);
		const name = process.env.FIXTURE_MODEL;
		setTimeout(() => console.log(JSON.stringify({ models: [{ slug: name }] })), delay);
	`);
	let env = { FIXTURE_DELAY: "180", FIXTURE_MODEL: "old" };
	const cache = new CatalogueCache(() => env);
	const old = cache.load("codex", f.command);
	cache.invalidate("codex", f.command);
	env = { FIXTURE_DELAY: "0", FIXTURE_MODEL: "new" };
	const fresh = await cache.load("codex", f.command);
	await old;
	assert.equal(fresh.models[0].id, "new");
	assert.equal(cache.peek("codex", f.command).models[0].id, "new");
});

test("Claude subprocess fixture returns structured output and reports provider errors", async (t) => {
	const f = await fixture(t, `
		const result = process.env.FIXTURE_ERROR
			? { type: "result", is_error: true, result: "Fixture authentication failure" }
			: { type: "result", result: JSON.stringify({ title: "Claude fixture", body: "Synthetic Claude answer" }) };
		console.log(JSON.stringify(result));
	`);
	const base = { ...options(f.command, f.dir), provider: "claude" };
	assert.deepEqual(await runAgent(base).result, { title: "Claude fixture", body: "Synthetic Claude answer" });
	await assert.rejects(runAgent({ ...base, env: { FIXTURE_ERROR: "1" } }).result, /Fixture authentication failure/);
});

for (const provider of ["codex", "claude", "opencode"]) {
 test(`${provider} comment subprocess returns structured changes with restricted tools`, async (t) => {
  const f = await fixture(t, `
   import { writeFileSync } from 'node:fs';
   import assert from 'node:assert/strict';
   const args=process.argv.slice(2), provider=process.env.FIXTURE_PROVIDER;
   const answer=JSON.stringify({reply:'Synthetic response',changes:[{kind:'create',path:'New.md',content:'Body'}]});
   if(provider==='codex') {
    assert.ok(args.includes('--ignore-user-config'));
    assert.equal(args[args.indexOf('--sandbox')+1],'read-only');
    writeFileSync(args[args.indexOf('--output-last-message')+1],answer);
    console.log(JSON.stringify({type:'thread.started'}));
   } else if(provider==='claude') {
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(args[args.indexOf('--tools')+1],'Read,Grep,Glob');
    console.log(JSON.stringify({type:'result',result:answer}));
   } else {
    assert.ok(args.includes('--pure'));
    assert.equal(JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).permission,'deny');
    const agent=args[args.indexOf('--agent')+1];
    assert.equal(JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).agent[agent].permission.read,'allow');
    console.log(JSON.stringify({type:'text',part:{type:'text',text:answer}}));
   }
  `);
  const comment={id:'request',source:'comment-block',notePath:'Synthetic.md',commentId:'1',message:'@teddy help',quote:null,thread:[]};
  const result=await runAgent({...options(f.command,f.dir),provider,comment,env:{FIXTURE_PROVIDER:provider,CODEX_HOME:f.dir}}).result;
  assert.equal(JSON.parse(result.body).changes[0].path,'New.md');
 });
}

test("comment failures with partial output are rejected and hung processes can be cancelled", async (t) => {
 const f=await fixture(t, `import {writeFileSync} from 'node:fs';const args=process.argv;writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({reply:'Partial',changes:[]}));process.exit(1);`);
 const comment={id:'request',source:'comment-block',notePath:'Synthetic.md',commentId:'1',message:'@teddy help',quote:null,thread:[]};
 await assert.rejects(runAgent({...options(f.command,f.dir),comment,env:{CODEX_HOME:f.dir}}).result,/Exited with code 1/);
 const hung=await fixture(t,"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);");
 const run=runAgent({...options(hung.command,hung.dir),comment,env:{CODEX_HOME:hung.dir},timeoutMs:5000});
 await new Promise((r)=>setTimeout(r,100));run.cancel();
 await assert.rejects(run.result,/Cancelled/);
});
