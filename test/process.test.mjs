import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, chmod, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/agent.ts";
import { parseCommentReply } from "../src/comment-output.ts";
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
 test(`${provider} comment subprocess inherits configuration and writes files directly`, async (t) => {
  const f = await fixture(t, `
   import { writeFileSync } from 'node:fs';
   import assert from 'node:assert/strict';
   const args=process.argv.slice(2), provider=process.env.FIXTURE_PROVIDER;
   const answer=JSON.stringify({reply:'Edited New.md directly'});
   writeFileSync('New.md','Body written by the agent');
   assert.equal(process.env.USER_CONFIG_MARKER,'inherited');
   if(provider==='codex') {
    assert.ok(!args.includes('--ignore-user-config'));assert.ok(!args.includes('--ignore-rules'));
    assert.ok(!args.includes('--sandbox'));
    const schema=JSON.parse((await import('node:fs')).readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));assert.deepEqual(schema.required,['reply']);
    writeFileSync(args[args.indexOf('--output-last-message')+1],answer);
    console.log(JSON.stringify({type:'thread.started'}));
   } else if(provider==='claude') {
    assert.ok(!args.includes('--strict-mcp-config'));assert.ok(!args.includes('--disallowed-tools'));
    assert.ok(!args.includes('--allowed-tools'));assert.equal(args[args.indexOf('--permission-prompts')+1],'none');
    console.log(JSON.stringify({type:'result',result:answer}));
   } else {
    assert.ok(!args.includes('--pure'));assert.ok(!args.includes('--agent'));
    assert.equal(process.env.OPENCODE_CONFIG_CONTENT,undefined);
    console.log(JSON.stringify({type:'text',part:{type:'text',text:answer}}));
   }
  `);
  const comment={id:'request',source:'comment-block',notePath:'Synthetic.md',commentId:'1',message:'@teddy help',quote:null,thread:[]};
  const result=await runAgent({...options(f.command,f.dir),provider,comment,env:{FIXTURE_PROVIDER:provider,USER_CONFIG_MARKER:'inherited'}}).result;
  assert.equal(JSON.parse(result.body).reply,'Edited New.md directly');assert.equal(await readFile(join(f.dir,'New.md'),'utf8'),'Body written by the agent');
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

for(const provider of ["codex","claude","opencode"]){
 test(`${provider} comment permission denial fails even with a reply and a successful exit`,async(t)=>{
  const f=await fixture(t,`const provider=process.env.FIXTURE_PROVIDER;const events={codex:{type:'turn.failed',error:{message:'sandbox permission denied'}},claude:{type:'result',result:'{"reply":"Partial"}',permission_denials:[{tool_name:'Edit'}]},opencode:{type:'permission.asked'}};console.log(JSON.stringify(events[provider]));`);
  const comment={id:'request',source:'comment-block',notePath:'Synthetic.md',commentId:'1',message:'@teddy help',quote:null,thread:[]};
  await assert.rejects(runAgent({...options(f.command,f.dir),provider,comment,env:{FIXTURE_PROVIDER:provider}}).result,/permission|approval/i);
 });
 test(`${provider} direct run timeout leaves completed file writes in place`,async(t)=>{
  const f=await fixture(t,`import {writeFileSync} from 'node:fs';writeFileSync('Partial.md','Written before timeout');setInterval(()=>{},1000);`);
  const comment={id:'request',source:'comment-block',notePath:'Synthetic.md',commentId:'1',message:'@teddy help',quote:null,thread:[]};
  await assert.rejects(runAgent({...options(f.command,f.dir),provider,comment,timeoutMs:1000}).result,/Timed out/);
  assert.equal(await readFile(join(f.dir,'Partial.md'),'utf8'),'Written before timeout');
 });
}


for (const provider of ["codex", "claude", "opencode"]) {
 test(`${provider} streams direct work before returning a malformed reply`, async (t) => {
  const f=await fixture(t, `
   import {writeFileSync} from 'node:fs';
   const provider=process.env.FIXTURE_PROVIDER,args=process.argv;
   writeFileSync('Partial.md','Direct effect remains');
   const progress={codex:{type:'item.started',item:{type:'command_execution',command:'Editing Partial.md'}},claude:{type:'assistant',message:{content:[{type:'tool_use',name:'Edit',input:{file_path:'Partial.md'}}]}},opencode:{type:'tool_use',part:{type:'step-start'}}};
   console.log(JSON.stringify(progress[provider]));
   if(provider==='codex')writeFileSync(args[args.indexOf('--output-last-message')+1],'malformed reply');
   else console.log(JSON.stringify(provider==='claude'?{type:'result',result:'malformed reply'}:{type:'text',part:{type:'text',text:'malformed reply'}}));
  `);
  const progress=[],comment={id:'request',source:'comment-block',notePath:'Synthetic.md',commentId:'1',message:'@teddy help',quote:null,thread:[]};
  const result=await runAgent({...options(f.command,f.dir),provider,comment,env:{FIXTURE_PROVIDER:provider},onProgress:text=>progress.push(text)}).result;
  assert.ok(progress.length);assert.throws(()=>parseCommentReply(result.body),/Work may already/);
  assert.equal(await readFile(join(f.dir,'Partial.md'),'utf8'),'Direct effect remains');
 });
 test(`${provider} cancellation stops execution without rolling back direct edits`, async (t) => {
  const f=await fixture(t, `import {writeFileSync} from 'node:fs';writeFileSync('Partial.md','Completed before cancellation');console.log(JSON.stringify({type:'thread.started'}));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  const comment={id:'request',source:'comment-block',notePath:'Synthetic.md',commentId:'1',message:'@teddy help',quote:null,thread:[]};
  const run=runAgent({...options(f.command,f.dir),provider,comment,timeoutMs:5000});
  for(let i=0;i<100;i++){try{await readFile(join(f.dir,'Partial.md'));break;}catch{await new Promise(r=>setTimeout(r,10));}}
  run.cancel();await assert.rejects(run.result,/Cancelled/);
  assert.equal(await readFile(join(f.dir,'Partial.md'),'utf8'),'Completed before cancellation');
 });
}
