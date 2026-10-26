import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server.mjs';
import {CodexCloud,CloudError,environmentId,cloudTaskUrl} from '../cloud-runtime.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
let dir,app,base,admin,host,rid,runtime,submission,requests,publicValid;
async function call(path,{token=host,method='GET',data}={}){
  const res=await fetch(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data)});
  return{status:res.status,value:await res.json()};
}
const rp=(s='')=>`/api/rooms/${rid}${s}`;
const start=(id=crypto.randomUUID(),token=host)=>call(rp('/agent/start'),{token,method:'POST',data:{client_id:id}});
const state=async()=> (await call(rp())).value;
const configure=()=>call('/api/admin/cloud',{token:admin,method:'POST',data:{environment_id:'env_test',label:'隔离协议测试环境'}});
async function waitFor(predicate){for(let i=0;i<100;i++){const s=await state();if(predicate(s))return s;await new Promise(r=>setTimeout(r,10));}assert.fail('state did not settle');}
function serve(){app=createApp({dataDir:dir,port:0,cloudRuntime:runtime,verifyPublic:async()=>publicValid});return app.listen().then(a=>{base=`http://127.0.0.1:${a.port}`;});}
beforeEach(async()=>{
  dir=mkdtempSync(join(tmpdir(),'tongzhuo-cloud-'));submission=deferred();requests=[];publicValid=true;
  runtime={probe:async()=>({available:true,authentication:'chatgpt'}),discover:async()=>[],list:async()=>[],submit:async args=>{requests.push(args);return submission.promise;},cancelPending(){}};
  await serve();admin=(await call('/api/local-owner',{token:null,method:'POST',data:{}})).value.token;
  const r=(await call('/api/rooms',{token:admin,method:'POST',data:{title:'自动启动 · 隔离测试',goal:'只验证传输协议，不代表真实模型运行'}})).value;rid=r.id;host=r.token;
  await call('/api/admin/settings',{token:admin,method:'POST',data:{public_url:'https://room.example'}});
});
afterEach(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});

test('first use requires a real environment; settings and start remain owner-controlled',async()=>{
  const missing=await start();assert.equal(missing.status,409);assert.equal(missing.value.code,'cloud_environment_not_found');assert.equal(requests.length,0);
  assert.equal((await call('/api/admin/cloud',{method:'POST',data:{environment_id:'default'}})).status,403);
  assert.equal((await call('/api/admin/cloud',{token:admin,method:'POST',data:{environment_id:'default'}})).status,400);
  assert.equal((await configure()).status,200);
  const invite=(await call(rp('/invite'),{method:'POST',data:{}})).value.invite;
  const guest=(await call(rp('/join'),{token:null,method:'POST',data:{invite,name:'测试成员',role:'房主'}})).value.token;
  assert.equal((await start(crypto.randomUUID(),guest)).status,403);assert.equal(requests.length,0);
});

test('one discovered environment is reused automatically without manual configuration',async()=>{
  runtime.discover=async()=>[{id:'env_existing',label:'已有测试环境',source:'recent_task'}];
  const launched=await start();assert.equal(launched.status,202);assert.equal(requests[0].environment_id,'env_existing');
  const config=(await call('/api/admin/cloud',{token:admin})).value;assert.equal(config.environment_id,'env_existing');assert.equal(config.label,'已有测试环境');
  assert.equal((await start()).value.existing,true);assert.equal(requests.length,1);
});

test('multiple environments require an explicit selection from a fresh discovery result',async()=>{
  runtime.discover=async()=>[{id:'env_first',label:'已有环境一'},{id:'env_second',label:'已有环境二'}];
  const launched=await start();assert.equal(launched.status,409);assert.equal(launched.value.code,'cloud_environment_selection_required');assert.equal(requests.length,0);
  assert.equal((await call('/api/admin/cloud/discover',{method:'POST',data:{}})).status,403);
  const catalog=(await call('/api/admin/cloud/discover',{token:admin,method:'POST',data:{}})).value;
  assert.equal(catalog.source,'recent_tasks');assert.equal(catalog.complete_catalog,false);assert.equal(catalog.app_selection_available,false);assert.equal(catalog.environments.length,2);
  assert.equal((await call('/api/admin/cloud/select',{token:admin,method:'POST',data:{environment_id:'env_forged'}})).status,409);
  assert.equal((await call('/api/admin/cloud/select',{method:'POST',data:{environment_id:'env_second'}})).status,403);
  const selected=await call('/api/admin/cloud/select',{token:admin,method:'POST',data:{environment_id:'env_second',label:'伪造名字'}});assert.equal(selected.status,200);assert.equal(selected.value.label,'已有环境二');
  assert.equal((await start()).status,202);assert.equal(requests[0].environment_id,'env_second');
});

test('discovery failures and empty history do not assert that the App has no environment',async()=>{
  runtime.discover=async()=>{throw new CloudError('cloud_list_unavailable','查询网络失败');};
  const failed=await start();assert.equal(failed.status,503);assert.equal(failed.value.code,'cloud_list_unavailable');assert.equal(requests.length,0);
  runtime.discover=async()=>[];const empty=await start();assert.equal(empty.value.code,'cloud_environment_not_found');assert.match(empty.value.error,/不代表 App 中没有环境/);
  assert.equal((await call('/api/admin/cloud',{token:admin})).value.configured,false);
});

test('an environment disappearing before selection is not persisted',async()=>{
  runtime.discover=async()=>[];
  const selected=await call('/api/admin/cloud/select',{token:admin,method:'POST',data:{environment_id:'env_removed'}});assert.equal(selected.status,409);
  assert.equal((await call('/api/admin/cloud',{token:admin})).value.configured,false);assert.equal(requests.length,0);
});

test('launch is idempotent, private, and not connected before a real protocol hello',async()=>{
  await configure();const key=crypto.randomUUID(),first=await start(key);assert.equal(first.status,202);
  assert.equal((await start(key)).value.launch.id,first.value.launch.id);
  assert.equal((await start()).value.launch.id,first.value.launch.id);assert.equal(requests.length,1);
  assert.equal((await state()).agent.connection_state,'starting');
  const token=requests[0].prompt.match(/Authorization: Bearer ([A-Za-z0-9_-]+)/)[1];
  assert.ok(!JSON.stringify(first.value).includes(token));assert.ok(!JSON.stringify(await state()).includes(token));
  submission.resolve({url:'https://chatgpt.com/codex/tasks/task_test',id:'task_test'});
  let s=await waitFor(s=>s.agent.launch.status==='submitted');assert.equal(s.agent.ready,false);assert.equal(s.agent.connection_state,'awaiting_agent');
  assert.equal((await call('/agent/hello',{token,method:'POST',data:{}})).status,200);
  const session=(await state()).agent.session_id;
  for(let i=1;i<=2;i++){
    await call(rp('/messages'),{method:'POST',data:{text:`@Agent 第${i}轮协议测试`,client_id:crypto.randomUUID()}});
    const {job}=(await call('/agent/next',{token})).value;assert.ok(job);assert.match(job.messages.at(-1).text,/协议测试/);
    assert.equal((await call(`/agent/jobs/${job.id}/result`,{token,method:'POST',data:{lease:job.lease,text:`第${i}轮协议回传，未调用模型。`}})).status,200);
  }
  s=await state();assert.equal(s.jobs.filter(j=>j.status==='done').length,2);assert.equal(s.agent.session_id,session);assert.equal(requests.length,1);
  const invite=(await call(rp('/invite'),{method:'POST',data:{}})).value.invite;
  const guest=(await call(rp('/join'),{token:null,method:'POST',data:{invite,name:'测试成员',role:'设计者'}})).value.token;
  const g=(await call(rp(),{token:guest})).value;assert.equal(g.agent.task_url,null);assert.equal(g.agent.launch.task_url,null);
});

test('ambiguous submission never automatically retries; owner must reconcile first',async()=>{
  await configure();await start();submission.reject(new CloudError('submission_uncertain','测试：创建结果未知',{uncertain:true}));
  await waitFor(s=>s.agent.connection_state==='start_uncertain');await start();assert.equal(requests.length,1);
  assert.equal((await call(rp('/agent/launch/reset'),{method:'POST',data:{confirm_no_task:false}})).status,409);
  assert.equal((await call(rp('/agent/launch/reset'),{method:'POST',data:{confirm_no_task:true}})).status,200);
  submission=deferred();assert.equal((await start()).status,202);assert.equal(requests.length,2);
});

test('positive hello resolves unknown; revocation prevents late submission from reconnecting',async()=>{
  await configure();await start();const token=requests[0].prompt.match(/Authorization: Bearer ([A-Za-z0-9_-]+)/)[1];
  submission.reject(new CloudError('submission_uncertain','测试：结果未知',{uncertain:true}));await waitFor(s=>s.agent.connection_state==='start_uncertain');
  await call('/agent/hello',{token,method:'POST',data:{}});assert.equal((await state()).agent.ready,true);
  assert.equal((await call(rp('/agent/launch/reset'),{method:'POST',data:{confirm_no_task:true}})).status,409);
  await call(rp('/agent/disconnect'),{method:'POST',data:{}});submission=deferred();await start();const late=submission;
  await call(rp('/agent/disconnect'),{method:'POST',data:{}});late.resolve({url:'https://chatgpt.com/codex/tasks/late'});
  await waitFor(s=>s.agent.launch.status==='revoked'&&s.agent.launch.task_url);assert.equal((await state()).agent.ready,false);
  assert.equal((await call('/agent/hello',{token,method:'POST',data:{}})).status,401);
});

test('preflight rejects wrong public endpoint and a cancellation while preparing',async()=>{
  await configure();publicValid=false;assert.equal((await start()).status,409);assert.equal(requests.length,0);
  publicValid=true;const pending=deferred();runtime.probe=()=>pending.promise;
  const launching=start();await new Promise(r=>setTimeout(r,30));await call(rp('/agent/disconnect'),{method:'POST',data:{}});pending.resolve({});
  assert.equal((await launching).status,409);assert.equal(requests.length,0);
});

test('restart preserves an uncertain launch without replaying the CLI submission',async()=>{
  await configure();await start();await app.close();await serve();assert.equal((await state()).agent.connection_state,'start_uncertain');
  await start();assert.equal(requests.length,1);submission.resolve({url:'https://chatgpt.com/codex/tasks/late'});
});

test('explicit task termination and public address changes allow a fresh launch',async()=>{
  await configure();await start();submission.resolve({url:'https://chatgpt.com/codex/tasks/first',id:'first'});await waitFor(s=>s.agent.launch.status==='submitted');
  const token=requests[0].prompt.match(/Authorization: Bearer ([A-Za-z0-9_-]+)/)[1];await call('/agent/hello',{token,method:'POST',data:{}});
  runtime.list=async()=>{throw Error('status lookup unavailable');};await app.monitorCloud();assert.equal((await state()).agent.launch.status,'submitted');
  runtime.list=async()=>[{id:'first',status:'pending'}];await app.monitorCloud();assert.equal((await state()).agent.launch.status,'submitted');
  runtime.list=async()=>[{id:'first',status:'ready'}];await app.monitorCloud();assert.equal((await state()).agent.connection_state,'task_ended');
  submission=deferred();assert.equal((await start()).status,202);assert.equal(requests.length,2);
  submission.resolve({url:'https://chatgpt.com/codex/tasks/second'});await waitFor(s=>s.agent.launch.status==='submitted');
  await call('/api/admin/settings',{token:admin,method:'POST',data:{public_url:'https://changed.example'}});
  submission=deferred();assert.equal((await start()).status,202);assert.equal(requests.length,3);
});

test('official CLI adapter uses subscription login, explicit environment and one attempt',async()=>{
  const binary=join(dir,'fake-codex'),capture=join(dir,'capture.json');
  writeFileSync(binary,`#!${process.execPath}\nimport fs from 'node:fs';\nconst a=process.argv.slice(2);if(a[0]==='--version')console.log('codex-cli test');else if(a[0]==='login')console.error('Logged in using ChatGPT');else if(a[1]==='list'){if(Number(a[a.indexOf('--limit')+1])>20)process.exit(2);console.log(JSON.stringify({tasks:[{id:'t1',url:'https://chatgpt.com/codex/tasks/t1',environment_id:'env_test',environment_label:'测试环境'}]}));}else {fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:a,api:process.env.OPENAI_API_KEY||process.env.CODEX_API_KEY||null}));console.log('https://chatgpt.com/codex/tasks/t1');}`);chmodSync(binary,0o700);
  const cli=new CodexCloud({binary,cwd:dir});assert.equal((await cli.probe()).authentication,'chatgpt');assert.equal((await cli.discover())[0].id,'env_test');
  const oldKeys=[process.env.OPENAI_API_KEY,process.env.CODEX_API_KEY];process.env.OPENAI_API_KEY='synthetic-test-key';process.env.CODEX_API_KEY='synthetic-test-key';
  try{const task=await cli.submit({environment_id:'env_test',branch:'main',prompt:'私有协议测试'});assert.equal(task.id,'t1');}finally{for(const [i,k] of ['OPENAI_API_KEY','CODEX_API_KEY'].entries())if(oldKeys[i]===undefined)delete process.env[k];else process.env[k]=oldKeys[i];}
  const captured=JSON.parse(readFileSync(capture,'utf8'));assert.deepEqual(captured.args,['cloud','exec','--env','env_test','--attempts','1','--branch','main','私有协议测试']);assert.equal(captured.api,null);
  writeFileSync(binary,`#!${process.execPath}\nif(process.argv[2]==='--version')console.log('codex-cli test');else console.log('Logged in using an API key');`);
  await assert.rejects(new CodexCloud({binary,cwd:dir}).probe(),e=>e.code==='chatgpt_login_required');
  writeFileSync(binary,`#!${process.execPath}\nsetTimeout(()=>{},10000);`);
  await assert.rejects(new CodexCloud({binary,cwd:dir,timeout:40}).submit({environment_id:'env_test',prompt:'超时测试'}),e=>e.uncertain===true);
  await assert.rejects(new CodexCloud({binary:join(dir,'missing'),cwd:dir}).submit({environment_id:'env_test',prompt:'启动失败测试'}),e=>e.code==='submit_not_started'&&!e.uncertain);
});

test('cloud identifiers and URLs reject arbitrary origins, credentials and default labels',()=>{
  assert.equal(environmentId('default'),null);assert.equal(environmentId('https://evil.example/environments/env_test'),null);
  assert.equal(environmentId('https://chatgpt.com/codex/settings/environments/env_test'),'env_test');
  assert.equal(cloudTaskUrl('https://chatgpt.com/codex/tasks/t1?secret=no'),'https://chatgpt.com/codex/tasks/t1');
  for(const u of ['http://chatgpt.com/codex/tasks/t1','https://evil.example/codex/tasks/t1','https://user:pw@chatgpt.com/codex/tasks/t1'])assert.equal(cloudTaskUrl(u),null);
});
