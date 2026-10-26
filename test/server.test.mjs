import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../server.mjs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

let app,base,dir,admin,room,host,invite;
async function call(path,{token=host,method='GET',data,raw,headers={}}={}){
  const h={...headers};if(token)h.Authorization='Bearer '+token;if(data!==undefined)h['Content-Type']='application/json';
  const res=await fetch(base+path,{method,headers:h,body:raw??(data===undefined?undefined:JSON.stringify(data))});
  const isJson=res.headers.get('content-type')?.includes('application/json');const value=isJson?await res.json():Buffer.from(await res.arrayBuffer());return{status:res.status,value,headers:res.headers};
}
const rp=(suffix='')=>`/api/rooms/${room}${suffix}`;
async function member(name='开发者'){const r=await call(rp('/join'),{method:'POST',data:{invite,name,role:'开发者'},token:null});assert.equal(r.status,201);return r.value.token;}
async function msg(content,mention=false,token=host,extras={}){return call(rp('/messages'),{method:'POST',token,data:{text:content,mention_agent:mention,client_id:crypto.randomUUID(),...extras}});}
async function connect({handshake=true}={}){const r=await call(rp('/agent/connect'),{method:'POST',data:{public_url:'https://room.example',environment:'测试环境'}});assert.equal(r.status,200);const key=r.value.prompt.match(/Authorization: Bearer ([A-Za-z0-9_-]+)/)[1];if(handshake)assert.equal((await call('/agent/hello',{token:key,method:'POST',data:{}})).status,200);return key;}
async function upload(name,content='提案资料',token=host){return call(rp('/files'),{method:'POST',token,raw:Buffer.from(content),headers:{'X-Filename':encodeURIComponent(name),'Content-Type':'text/plain'}});}
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),'tongzhuo-test-'));app=createApp({dataDir:dir,port:0});const address=await app.listen();base=`http://127.0.0.1:${address.port}`;admin=(await call('/api/local-owner',{method:'POST',data:{},token:null})).value.token;const r=await call('/api/rooms',{method:'POST',token:admin,data:{title:'兼容模式提案',goal:'核对版本选择',name:'房主',role:'评审者'}});assert.equal(r.status,201);room=r.value.id;host=r.value.token;invite=r.value.invite;});
afterEach(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});

test('invite membership is required; a self-declared owner role grants no control',async()=>{
  assert.equal((await call(rp(),{token:null})).status,401);
  assert.equal((await call(rp('/join'),{method:'POST',token:null,data:{invite:'bad',name:'x',role:'房主'}})).status,403);
  const guest=await member('同事');
  assert.equal((await call(rp('/identity'),{method:'POST',token:guest,data:{name:'同事',role:'房主'}})).status,200);
  assert.equal((await call(rp('/agent/connect'),{method:'POST',token:guest,data:{public_url:'https://room.example'}})).status,403);
  const state=(await call(rp(),{token:guest})).value;assert.equal(state.me.is_owner,false);assert.ok(!JSON.stringify(state).includes('token_hash'));
});

test('ordinary messages stay quiet; guest mentions require owner approval',async()=>{
  const guest=await member();await msg('讨论 @Agent 这个文字，不代表唤起',false,guest);
  assert.equal((await call(rp())).value.jobs.length,0);
  const request=await msg('请分析',true,guest);assert.equal(request.status,201);
  let j=(await call(rp())).value.jobs[0];assert.equal(j.status,'awaiting_owner');
  assert.equal((await call(rp(`/jobs/${j.id}/approve`),{method:'POST',token:guest,data:{}})).status,403);
  assert.equal((await call(rp(`/jobs/${j.id}/approve`),{method:'POST',data:{}})).status,200);
  j=(await call(rp())).value.jobs[0];assert.equal(j.status,'queued');
});

test('message retries are idempotent and preserve one job',async()=>{
  const cid=crypto.randomUUID(),first=await msg('请分析',true,host,{client_id:cid}),again=await msg('请分析',true,host,{client_id:cid});
  assert.equal(first.value.id,again.value.id);const state=(await call(rp())).value;assert.equal(state.messages.length,1);assert.equal(state.jobs.length,1);
});

test('an explicit typed @Agent prefix creates a request and returns durable waiting feedback',async()=>{
  await msg('我们讨论 @Agent 的用法');await msg('@agentic 不是助手命令');
  assert.equal((await call(rp())).value.jobs.length,0);
  const cid=crypto.randomUUID(),first=await msg('@aGeNt你好，请分析',false,host,{client_id:cid});
  assert.equal(first.value.request.delivery_state,'waiting_agent');assert.match(first.value.request.blocked_reason,/尚未接入/);
  const retry=await msg('@aGeNt你好，请分析',false,host,{client_id:cid});
  assert.equal(retry.value.request.id,first.value.request.id);assert.equal(retry.value.request.delivery_state,'waiting_agent');
  assert.equal((await call(rp())).value.jobs.length,1);
});

test('generating or downloading a connection task cannot mark Agent connected; hello is required',async()=>{
  assert.equal((await call(rp())).value.agent.connection_state,'not_configured');
  await msg('请分析',true);const token=await connect({handshake:false});
  let s=(await call(rp())).value;assert.equal(s.agent.connection_state,'awaiting_agent');assert.equal(s.agent.ready,false);assert.equal(s.jobs[0].delivery_state,'waiting_agent');
  assert.equal((await call('/agent/client.py',{token})).status,200);
  assert.equal((await call('/agent/next',{token})).status,409);
  s=(await call(rp())).value;assert.equal(s.agent.connection_state,'awaiting_agent');assert.equal(s.jobs[0].status,'queued');
  await call('/agent/hello',{token,method:'POST',data:{}});
  s=(await call(rp())).value;assert.equal(s.agent.connection_state,'connected');assert.equal(s.agent.ready,true);assert.ok(s.agent.connected_at);assert.equal(s.jobs[0].delivery_state,'queued');
  app.db.prepare('UPDATE rooms SET agent_expires=? WHERE id=?').run(Date.now()-1,room);
  s=(await call(rp())).value;assert.equal(s.agent.connection_state,'expired');assert.equal(s.agent.ready,false);assert.equal(s.jobs[0].delivery_state,'waiting_agent');assert.match(s.jobs[0].blocked_reason,/已过期/);
});

test('a lost heartbeat never leaves a running request looking connected or puts it back in the queue',async()=>{
  await msg('请分析',true);const token=await connect();await call('/agent/next',{token});
  let s=(await call(rp())).value;assert.equal(s.agent.status,'busy');assert.equal(s.jobs[0].delivery_state,'running');
  app.db.prepare('UPDATE rooms SET agent_seen=? WHERE id=?').run(Date.now()-61_000,room);
  s=(await call(rp())).value;assert.equal(s.agent.connection_state,'connection_lost');assert.equal(s.agent.ready,false);assert.equal(s.jobs[0].status,'running');assert.equal(s.jobs[0].delivery_state,'connection_lost');
  await call('/agent/hello',{token,method:'POST',data:{}});
  s=(await call(rp())).value;assert.equal(s.agent.ready,true);assert.equal(s.jobs[0].delivery_state,'running');
});

test('request snapshot binds speaker identity, reply relation and message cutoff',async()=>{
  const guest=await member('设计者');const first=await msg('旧行为基准',false,guest);const request=await msg('请整理',true,host,{reply_to:first.value.id});
  await call(rp('/identity'),{method:'POST',token:guest,data:{name:'新名字',role:'使用者'}});await msg('稍后新增的补充');
  const token=await connect(),job=(await call('/agent/next',{token})).value.job;
  assert.equal(job.read_through,request.value.id);assert.equal(job.messages.length,2);assert.equal(job.messages[0].name,'设计者');assert.equal(job.messages[0].role,'开发者');assert.equal(job.messages[1].reply_to,first.value.id);
  assert.equal((await call(rp())).value.messages[0].name,'设计者');
});

test('members share exact bytes; same filenames retain versions; cloud reads only selected files',async()=>{
  const guest=await member(),bytes='\u0000资料\r\n提案原始字节';const first=await upload('提案.md',bytes),second=await upload('提案.md','第二版'),other=await upload('未选中的文件.txt');
  assert.equal(first.status,201);assert.equal(second.value.version,2);
  const downloaded=await call(rp('/files/'+first.value.id),{token:guest});assert.deepEqual(downloaded.value,Buffer.from(bytes));assert.match(downloaded.headers.get('content-disposition'),/^attachment/);
  await msg('只分析第一版',true,host,{file_ids:[first.value.id]});const token=await connect(),job=(await call('/agent/next',{token})).value.job;
  assert.equal(job.files[0].version,1);
  const raw=await call(`/agent/jobs/${job.id}/files/${first.value.id}`,{token,headers:{'X-Lease':job.lease}});assert.deepEqual(raw.value,Buffer.from(bytes));
  assert.equal((await call(rp())).value.files.find(f=>f.id===first.value.id).read_at,null);
  assert.equal((await call(`/agent/jobs/${job.id}/files/${first.value.id}/ack`,{token,method:'POST',data:{lease:job.lease,sha256:first.value.sha256}})).status,200);
  assert.equal((await call(`/agent/jobs/${job.id}/files/${other.value.id}`,{token,headers:{'X-Lease':job.lease}})).status,403);
  assert.ok((await call(rp())).value.files.find(f=>f.id===first.value.id).read_at);
});

test('one running request, artifact roundtrip, idempotent result delivery',async()=>{
  await msg('第一个请求',true);await msg('第二个请求',true);const token=await connect();
  assert.equal((await call('/agent/hello',{token,method:'POST',data:{}})).status,200);
  const j=(await call('/agent/next',{token})).value.job;assert.ok(j);
  assert.equal((await call('/agent/next',{token})).value.job,null);
  const artifact=await call('/agent/artifacts',{token,method:'POST',raw:Buffer.from('真实的协议测试产物，不是模型回复'),headers:{'X-Job-Id':j.id,'X-Lease':j.lease,'X-Filename':encodeURIComponent('分析报告.md'),'Content-Type':'text/markdown'}});assert.equal(artifact.status,201);
  const again=await call('/agent/artifacts',{token,method:'POST',raw:Buffer.from('真实的协议测试产物，不是模型回复'),headers:{'X-Job-Id':j.id,'X-Lease':j.lease,'X-Filename':encodeURIComponent('分析报告.md'),'Content-Type':'text/markdown'}});assert.equal(again.value.id,artifact.value.id);
  const result={lease:j.lease,text:'协议测试回复，仅测试传输。'};
  assert.equal((await call(`/agent/jobs/${j.id}/result`,{token,method:'POST',data:result})).status,200);
  assert.equal((await call(`/agent/jobs/${j.id}/result`,{token,method:'POST',data:result})).value.duplicate,true);
  assert.equal((await call(`/agent/jobs/${j.id}/result`,{token,method:'POST',data:{...result,text:'不同正文'}})).status,409);
  const s=(await call(rp())).value;assert.equal(s.messages.filter(m=>m.kind==='agent').length,1);assert.equal(s.files.length,1);assert.equal(s.agent.status,'online');assert.ok((await call('/agent/next',{token})).value.job);
});

test('revocation invalidates cloud capability and leaves in-flight work unknown',async()=>{
  await msg('分析',true);const token=await connect();await call('/agent/next',{token});
  await call(rp('/agent/disconnect'),{method:'POST',data:{}});
  assert.equal((await call('/agent/next',{token})).status,401);const j=(await call(rp())).value.jobs[0];assert.equal(j.status,'unknown');
  assert.equal((await call(rp(`/jobs/${j.id}/retry`),{method:'POST',data:{}})).status,409);
});

test('room boundaries reject foreign reply and foreign file IDs',async()=>{
  const file=await upload('本房间.txt'),m=await msg('本房间消息');
  const r=await call('/api/rooms',{method:'POST',token:admin,data:{title:'另一个房间',goal:'独立讨论'}});const previous=room;room=r.value.id;
  assert.equal((await msg('跨房间回复',false,r.value.token,{reply_to:m.value.id})).status,400);
  assert.equal((await msg('跨房间文件',true,r.value.token,{file_ids:[file.value.id]})).status,400);
  assert.equal((await call(rp('/files/'+file.value.id),{token:r.value.token})).status,404);room=previous;
});

test('browser origins and forwarded bootstrap cannot acquire owner credentials',async()=>{
  const foreign=await call('/api/local-owner',{method:'POST',token:null,data:{},headers:{Origin:'https://evil.example'}});assert.equal(foreign.status,403);
  const forwarded=await call('/api/local-owner',{method:'POST',token:null,data:{},headers:{'X-Forwarded-For':'1.2.3.4'}});assert.equal(forwarded.status,403);
  assert.equal((await call('/api/admin/rooms',{token:await member()})).status,403);
});

test('invitation rotation revokes new entry while retaining existing membership',async()=>{
  const guest=await member();await call(rp('/invite'),{method:'POST',data:{}});
  assert.equal((await call(rp('/join'),{method:'POST',token:null,data:{invite,name:'后来者',role:'使用者'}})).status,403);
  assert.equal((await call(rp(),{token:guest})).status,200);
});

test('invites use the current public origin when an existing room or page has the old address',async()=>{
  const settings=url=>call('/api/admin/settings',{token:admin,method:'POST',data:{public_url:url}});
  await settings('https://old.example');
  const created=await call('/api/rooms',{token:admin,method:'POST',data:{title:'早先创建的房间',goal:'邀请地址随当前入口更新'}});
  room=created.value.id;host=created.value.token;invite=created.value.invite;
  const guest=await member();
  assert.equal((await call(rp('/agent/connect'),{method:'POST',data:{public_url:'https://old.example'}})).status,200);
  assert.equal((await call(rp())).value.room.public_url,'https://old.example');
  assert.equal((await call(rp())).value.agent.reconnect_required,false);
  await settings('https://current.example');
  assert.equal((await call(rp('/invite'),{token:guest,method:'POST',data:{}})).status,403);
  const issued=await call(rp('/invite'),{method:'POST',data:{}});
  assert.equal(issued.status,200);
  assert.equal(issued.value.invite_url,'https://current.example/#join='+room+'&invite='+issued.value.invite);
  assert.equal((await call(rp())).value.room.public_url,'https://current.example');
  assert.equal((await call(rp())).value.agent.reconnect_required,true);
  assert.equal((await call(rp('/invite-info'),{token:null,method:'POST',data:{invite:issued.value.invite}})).status,200);
  await settings('');
  const local=await call(rp('/invite'),{method:'POST',data:{}});
  assert.equal(new URL(local.value.invite_url).origin,base);
  assert.equal((await call(rp())).value.room.public_url,'');
});

test('restarting the service restores messages and original files',async()=>{
  const f=await upload('持久文件.txt','保存的数据');await msg('刷新后仍应存在');await app.close();
  app=createApp({dataDir:dir,port:0});const a=await app.listen();base=`http://127.0.0.1:${a.port}`;
  const s=(await call(rp())).value;assert.equal(s.messages.length,2);const raw=(await call(rp('/files/'+f.value.id))).value;assert.equal(createHash('sha256').update(raw).digest('hex'),f.value.sha256);
});

test('upgrading the existing database preserves messages and adds explicit connection confirmation',async()=>{
  await msg('升级后保留的讨论');await app.close();
  const legacy=new DatabaseSync(join(dir,'rooms.sqlite'));legacy.exec('ALTER TABLE rooms DROP COLUMN agent_connected_at');legacy.close();
  app=createApp({dataDir:dir,port:0});const address=await app.listen();base=`http://127.0.0.1:${address.port}`;
  const s=(await call(rp())).value;assert.equal(s.messages[0].text,'升级后保留的讨论');assert.equal(s.agent.connected_at,null);assert.equal(s.agent.connection_state,'not_configured');
});

test('Python cloud transport verifies files and persists exactly one result across retry',async()=>{
  const f=await upload('跨环境资料.md','传输校验资料');await msg('测试协议，不调用任何模型',true,host,{file_ids:[f.value.id]});const token=await connect();
  const script=`import json,sys,tempfile\nfrom pathlib import Path\nfrom agent_client import RoomClient\nb=json.load(sys.stdin)\nc=RoomClient(b['base'],b['token'],allow_local_test=True)\nc.hello()\nj=c.next_job(wait_for=1)\nassert j\nwith tempfile.TemporaryDirectory() as d:\n files=c.download(j,d)\n assert Path(files[0]['path']).read_text()=='传输校验资料'\n out=Path(d)/'report.md'\n out.write_text('协议测试产物，不是模型生成')\n c.artifact(j,out,mime='text/markdown')\n c.finish(j,'协议测试完成，不代表云端验证',d)\n assert c.retry_result(j['id'],d)['duplicate']\nprint('transport passed')\n`;
  const output=await new Promise((resolve,reject)=>{const p=spawn('python3',['-c',script],{cwd:new URL('..',import.meta.url)});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('error',reject);p.on('close',code=>code===0?resolve(stdout):reject(new Error(stderr)));p.stdin.end(JSON.stringify({base,token}));});
  assert.match(output,/transport passed/);const s=(await call(rp())).value;assert.equal(s.jobs[0].status,'done');assert.equal(s.messages.filter(m=>m.kind==='agent').length,1);assert.equal(s.files.length,2);assert.ok(s.files.find(x=>x.id===f.value.id).read_at);
});
