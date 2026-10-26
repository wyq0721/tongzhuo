import {readFileSync,writeFileSync,unlinkSync,existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const local=process.env.TONGZHUO_LOCAL_URL||'http://127.0.0.1:8796';
const external=process.env.TONGZHUO_PUBLIC_URL;
if(!external||new URL(external).protocol!=='https:')throw Error('Set a verified HTTPS TONGZHUO_PUBLIC_URL');
const admin=readFileSync('.local/owner.secret','utf8');let roomId,roomToken;
const checks=[];
async function request(base,path,{token,method='GET',data,raw,headers={}}={}){
  if(token)headers.Authorization='Bearer '+token;if(data!==undefined)headers['Content-Type']='application/json';
  return fetch(base+path,{method,headers,body:raw??(data===undefined?undefined:JSON.stringify(data)),redirect:'error',signal:AbortSignal.timeout(25000)});
}
try{
  let res=await request(external,'/api/health');assert.equal(res.status,200);assert.equal((await res.json()).ok,true);checks.push('外部HTTPS访问到本机服务');
  res=await request(external,'/api/local-owner',{method:'POST',data:{}});assert.equal(res.status,403);checks.push('外部入口不能获取本机房主凭证');
  res=await request(local,'/api/rooms',{token:admin,method:'POST',data:{title:'临时公网传输验证',goal:'仅验证传输，不调用模型',environment:'协议测试'}});assert.equal(res.status,201);const created=await res.json();roomId=created.id;roomToken=created.token;
  res=await request(external,`/api/rooms/${roomId}`);assert.equal(res.status,401);
  res=await request(external,`/api/rooms/${roomId}/join`,{method:'POST',data:{invite:created.invite,name:'协议验证客户端',role:'测试'}});assert.equal(res.status,201);const member=(await res.json()).token;checks.push('外网邀请与成员权限验证');
  const bytes=Buffer.from('跨外网传输的原始提案资料\r\n');res=await request(external,`/api/rooms/${roomId}/files`,{token:member,method:'POST',raw:bytes,headers:{'X-Filename':encodeURIComponent('传输验证.md'),'Content-Type':'text/markdown'}});assert.equal(res.status,201);const file=await res.json();
  res=await request(local,`/api/rooms/${roomId}/files/${file.id}`,{token:roomToken});assert.deepEqual(Buffer.from(await res.arrayBuffer()),bytes);checks.push('外网成员上传，Mac下载原始字节一致');
  res=await request(local,`/api/rooms/${roomId}/messages`,{token:roomToken,method:'POST',data:{text:'协议验证任务，不调用模型',mention_agent:true,client_id:crypto.randomUUID(),file_ids:[file.id]}});assert.equal(res.status,201);
  res=await request(local,`/api/rooms/${roomId}/agent/connect`,{token:roomToken,method:'POST',data:{public_url:external,environment:'协议测试'}});assert.equal(res.status,200);const connection=await res.json();const agentToken=connection.prompt.match(/Authorization: Bearer ([A-Za-z0-9_-]+)/)[1];
  const script=`import json,sys,tempfile\nfrom pathlib import Path\nfrom agent_client import RoomClient\nb=json.load(sys.stdin)\nc=RoomClient(b['url'],b['token'])\nc.hello()\nj=c.next_job(wait_for=1)\nassert j\nwith tempfile.TemporaryDirectory() as d:\n files=c.download(j,d)\n assert Path(files[0]['path']).read_bytes()=='跨外网传输的原始提案资料\\r\\n'.encode()\n out=Path(d)/'report.md'\n out.write_text('公网协议验证产物；没有调用模型')\n c.artifact(j,out,mime='text/markdown')\n c.finish(j,'公网协议验证完成；不代表托管云推理成功',d)\n c.retry_result(j['id'],d)\nprint('public transport passed')\n`;
  await new Promise((resolve,reject)=>{const p=spawn('python3',['-c',script]);let stderr='',stdout='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('error',reject);p.on('close',code=>code===0?resolve(stdout):reject(new Error(stderr)));p.stdin.end(JSON.stringify({url:external,token:agentToken}));});
  checks.push('客户端经公网领取、校验下载、上传产物并幂等回传');
  res=await request(external,`/api/rooms/${roomId}`,{token:member});const state=await res.json();assert.equal(state.jobs[0].status,'done');const output=state.files.find(f=>f.source==='agent');assert.ok(output);
  res=await request(external,`/api/rooms/${roomId}/files/${output.id}`,{token:member});assert.equal(Buffer.from(await res.arrayBuffer()).toString(),'公网协议验证产物；没有调用模型');checks.push('外网成员下载原始产物一致');
  writeFileSync('.local/qa/public-report.json',JSON.stringify({url:external,checks,realCloudVerified:false,at:new Date().toISOString()},null,2));writeFileSync('.local/public-origin.json',JSON.stringify({url:external,verified:true,at:new Date().toISOString()},null,2));console.log(JSON.stringify({checks,realCloudVerified:false}));
}finally{
  if(roomId){
    try{await request(local,`/api/rooms/${roomId}/agent/disconnect`,{token:roomToken,method:'POST',data:{}});}catch{}
    const db=new DatabaseSync('.local/rooms.sqlite');db.exec('PRAGMA foreign_keys=ON');
    const check=db.prepare('SELECT title FROM rooms WHERE id=?').get(roomId);
    if(check?.title==='临时公网传输验证'){
      const files=db.prepare('SELECT id FROM files WHERE room_id=?').all(roomId);
      db.exec('BEGIN IMMEDIATE');try{
        db.prepare('DELETE FROM file_reads WHERE job_id IN (SELECT id FROM jobs WHERE room_id=?)').run(roomId);
        for(const table of ['files','jobs','messages','members'])db.prepare(`DELETE FROM ${table} WHERE room_id=?`).run(roomId);
        db.prepare('DELETE FROM rooms WHERE id=?').run(roomId);db.exec('COMMIT');
        for(const f of files){const path='.local/files/'+f.id;if(existsSync(path))unlinkSync(path);}
      }catch(e){db.exec('ROLLBACK');throw e;}
    }db.close();
  }
}
