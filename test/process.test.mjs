import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, chmod, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, runCommentAgent } from "../src/agent.ts";
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
   const answer='Edited New.md directly';
   writeFileSync('New.md','Body written by the agent');
   assert.equal(process.env.USER_CONFIG_MARKER,'inherited');
   if(provider==='codex') {
    assert.ok(!args.includes('--ignore-user-config'));assert.ok(!args.includes('--ignore-rules'));
    assert.ok(!args.includes('--sandbox'));
    const schema=JSON.parse((await import('node:fs')).readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));assert.deepEqual(schema.required,['reply']);
    writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({reply:answer}));
    console.log(JSON.stringify({type:'thread.started'}));
   } else if(provider==='claude') {
    assert.ok(!args.includes('--strict-mcp-config'));assert.ok(!args.includes('--disallowed-tools'));
    assert.ok(!args.includes('--allowed-tools'));assert.equal(args[args.indexOf('--permission-prompts')+1],'none');
    assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema')+1]).required,['reply']);
    console.log(JSON.stringify({type:'result',result:'Human prose',structured_output:{reply:answer}}));
   } else {
    assert.ok(!args.includes('--pure'));assert.ok(!args.includes('--agent'));
    assert.equal(process.env.OPENCODE_CONFIG_CONTENT,undefined);
    console.log(JSON.stringify({type:'step_start',sessionID:'s',part:{type:'step-start',messageID:'m',sessionID:'s'}}));
    console.log(JSON.stringify({type:'text',sessionID:'s',part:{type:'text',id:'t',messageID:'m',sessionID:'s',time:{end:1},text:answer}}));
    console.log(JSON.stringify({type:'step_finish',sessionID:'s',part:{type:'step-finish',messageID:'m',sessionID:'s',reason:'stop'}}));
   }
  `);
  const comment={id:'request',source:'comment-block',notePath:'Synthetic.md',commentId:'1',message:'@teddy help',quote:null,thread:[]};
  const result=await runCommentAgent({...options(f.command,f.dir),provider,comment,env:{FIXTURE_PROVIDER:provider,USER_CONFIG_MARKER:'inherited'}}).result;
  assert.equal(result.reply,'Edited New.md directly');assert.equal(await readFile(join(f.dir,'New.md'),'utf8'),'Body written by the agent');
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

test("claude comment denial names the tool, vault-relative target and allowing flag, and the preference turns that off",async(t)=>{
 const f=await fixture(t,`const file=process.cwd()+'/Notes/Plan.md';console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:{reply:'Ready'},permission_denials:[{tool_name:'Edit',tool_use_id:'t1',tool_input:{file_path:file,old_string:'SECRET-OLD',new_string:'SECRET-NEW',replace_all:false}},{tool_name:'Bash',tool_use_id:'t2',tool_input:{command:'grep -n foo note.md'}}]}));`);
 const comment={id:'request',source:'comment-block',notePath:'Synthetic.md',commentId:'1',message:'@teddy help',quote:null,thread:[]};
 const run=(extra={})=>runAgent({...options(f.command,f.dir),provider:'claude',comment,...extra}).result;
 const error=await run().then(()=>assert.fail('a denial must fail the job'),(e)=>e instanceof Error?e.message:String(e));
 assert.match(error,/^Claude Code denied Edit \(Notes\/Plan\.md\) and Bash \(grep -n foo note\.md\)\./);
 assert.ok(error.includes('--allowed-tools Edit "Bash(grep *)"'));
 assert.doesNotMatch(error,/SECRET|[\r\n]/);
 await assert.rejects(run({permissionDetails:true}),/^Error: Claude Code denied Edit/);
 await assert.rejects(run({permissionDetails:false}),/^Error: The agent needs permission that is not available to this unattended run\. Configure the CLI's permissions outside Obsidian, then retry\. Earlier actions may already have taken effect\.$/);
});

test("claude detailed denial is not replaced by an approval message from stderr, whichever arrives first",async(t)=>{
 const event=`JSON.stringify({type:'result',subtype:'success',structured_output:{reply:'Ready'},permission_denials:[{tool_name:'Edit',tool_use_id:'t1',tool_input:{file_path:process.cwd()+'/Plan.md'}}]})`;
 const comment={id:'request',source:'comment-block',notePath:'Synthetic.md',commentId:'1',message:'@teddy help',quote:null,thread:[]};
 const orders={
  'stderr after the event':`console.log(${event});process.stderr.write('permission requested: approval required\\n');`,
  'stderr before the event':`process.stderr.write('permission requested: approval required\\n');setTimeout(()=>console.log(${event}),50);`,
 };
 for(const [name,code] of Object.entries(orders)){
  const f=await fixture(t,code);
  const error=await runAgent({...options(f.command,f.dir),provider:'claude',comment}).result.then(()=>assert.fail(name),(e)=>e instanceof Error?e.message:String(e));
  assert.match(error,/^Claude Code denied Edit \(Plan\.md\)/,name);
  assert.doesNotMatch(error,/CLI needs additional approval/,name);
 }
 const f=await fixture(t,`process.stderr.write('permission requested: approval required\\n');console.log(JSON.stringify({type:'result',subtype:'success',structured_output:{reply:'Ready'}}));`);
 await assert.rejects(runAgent({...options(f.command,f.dir),provider:'claude',comment}).result,/The CLI needs additional approval/);
});

for(const provider of ["codex","claude","opencode"]){
 test(`${provider} comment permission denial fails even with a reply and a successful exit`,async(t)=>{
  const f=await fixture(t,`const provider=process.env.FIXTURE_PROVIDER;const events={codex:{type:'turn.failed',error:{message:'sandbox permission denied'}},claude:{type:'result',result:'{"reply":"Partial"}',permission_denials:[{tool_name:'Edit'}]},opencode:{type:'permission.asked'}};console.log(JSON.stringify(events[provider]));`);
  const comment={id:'request',source:'comment-block',notePath:'Synthetic.md',commentId:'1',message:'@teddy help',quote:null,thread:[]};
  await assert.rejects(runAgent({...options(f.command,f.dir),provider,comment,env:{FIXTURE_PROVIDER:provider}}).result,provider==='claude'?/Claude Code denied Edit[\s\S]*permission/:/permission|approval/i);
 });
 test(`${provider} direct run timeout leaves completed file writes in place`,async(t)=>{
  const f=await fixture(t,`import {writeFileSync} from 'node:fs';writeFileSync('Partial.md','Written before timeout');setInterval(()=>{},1000);`);
  const comment={id:'request',source:'comment-block',notePath:'Synthetic.md',commentId:'1',message:'@teddy help',quote:null,thread:[]};
  await assert.rejects(runAgent({...options(f.command,f.dir),provider,comment,timeoutMs:1000}).result,/Timed out/);
  assert.equal(await readFile(join(f.dir,'Partial.md'),'utf8'),'Written before timeout');
 });
}


for (const provider of ["codex", "claude", "opencode"]) {
 test(`${provider} streams direct work before a malformed or incomplete response fails`, async (t) => {
  const f=await fixture(t, `
   import {writeFileSync} from 'node:fs';
   const provider=process.env.FIXTURE_PROVIDER,args=process.argv;
   writeFileSync('Partial.md','Direct effect remains');
   const progress={codex:{type:'item.started',item:{type:'command_execution',command:'Editing Partial.md'}},claude:{type:'assistant',message:{content:[{type:'tool_use',name:'Edit',input:{file_path:'Partial.md'}}]}},opencode:{type:'step_start',sessionID:'s',part:{type:'step-start',sessionID:'s',messageID:'m'}}};
   console.log(JSON.stringify(progress[provider]));
   if(provider==='codex')writeFileSync(args[args.indexOf('--output-last-message')+1],'malformed reply');
   else console.log(JSON.stringify(provider==='claude'?{type:'result',result:'malformed reply'}:{type:'text',part:{type:'text',text:'malformed reply'}}));
  `);
  const progress=[],comment={id:'request',source:'comment-block',notePath:'Synthetic.md',commentId:'1',message:'@teddy help',quote:null,thread:[]};
  await assert.rejects(runCommentAgent({...options(f.command,f.dir),provider,comment,env:{FIXTURE_PROVIDER:provider},onProgress:text=>progress.push(text)}).result,/Work may already/);
  assert.ok(progress.length);
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
