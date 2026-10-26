import {createApp} from '../server.mjs';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.TONGZHUO_PLAYWRIGHT_PATH||'playwright');
const dir=mkdtempSync(join(tmpdir(),'tongzhuo-browser-'));
let cloudPrompt='',submitCount=0;
const cloudRuntime={probe:async()=>({authentication:'chatgpt'}),discover:async()=>[{id:'env_protocol_test',label:'隔离协议测试环境'}],list:async()=>[],submit:async({prompt})=>{cloudPrompt=prompt;submitCount++;return{url:'https://chatgpt.com/codex/tasks/protocol_test',id:'protocol_test'};}};
const app=createApp({dataDir:dir,port:0,cloudRuntime,verifyPublic:async()=>true});const address=await app.listen(),base=`http://127.0.0.1:${address.port}`;
const out=resolve('.local/qa');mkdirSync(out,{recursive:true});
const admin=readFileSync(join(dir,'owner.secret'),'utf8');
async function setPublic(url){const r=await fetch(base+'/api/admin/settings',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+admin},body:JSON.stringify({public_url:url})});assert.equal(r.status,200);}
await setPublic('https://old.example');
const browser=await chromium.launch({headless:true,...(process.env.TONGZHUO_CHROME_PATH?{executablePath:process.env.TONGZHUO_CHROME_PATH}:{})});
const errors=[],checks=[];
try{
  const ownerContext=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});const owner=await ownerContext.newPage();owner.on('pageerror',e=>errors.push(String(e)));
  await owner.goto(base);await owner.waitForLoadState('networkidle');await owner.getByRole('button',{name:'创建任务房间',exact:false}).last().click();
  await owner.locator('[name=title]').fill('兼容模式提案 · 联调验证');await owner.locator('[name=name]').fill('房主（测试）');await owner.locator('#modal-submit').click();
  await owner.locator('#room-title').filter({hasText:'兼容模式提案'}).waitFor();checks.push('房主创建房间');
  await setPublic('https://current.example');
  await owner.locator('#invite-button').click();await owner.locator('.invite-link').waitFor();assert.equal(new URL(await owner.locator('.invite-link').innerText()).origin,'https://current.example');await owner.locator('#modal-close').click();
  await setPublic('');
  await owner.locator('#invite-button').click();await owner.locator('.invite-link').waitFor();const invite=await owner.locator('.invite-link').innerText();assert.equal(new URL(invite).origin,base);await owner.locator('#modal-close').click();checks.push('页面已打开时更新入口，新邀请使用当前域名；清空后回到本机地址');
  const guestContext=await browser.newContext({viewport:{width:1200,height:900},acceptDownloads:true});const guest=await guestContext.newPage();guest.on('pageerror',e=>errors.push(String(e)));
  await guest.goto(invite);await guest.locator('[name=name]').fill('设计者（测试）');await guest.locator('[name=role]').fill('设计者');await guest.locator('#modal-submit').click();await guest.locator('#room-title').waitFor();
  assert.equal(await guest.locator('#connect-button').isVisible(),false);assert.equal(await guest.locator('#invite-button').isVisible(),false);checks.push('独立浏览器通过邀请入场；成员无房主控制');
  await guest.locator('#message-input').fill('版本基准的定义需要先讨论。');await guest.locator('#send-button').click();await owner.getByText('版本基准的定义需要先讨论。',{exact:true}).waitFor();assert.equal(await owner.locator('.job').count(),0);checks.push('跨浏览器同步；普通发言不触发任务');
  await guest.locator('#message-input').fill('<img src=x onerror="window.__xss=1">');await guest.locator('#send-button').click();await owner.getByText('<img src=x onerror="window.__xss=1">',{exact:true}).waitFor();assert.equal(await owner.evaluate(()=>window.__xss),undefined);checks.push('用户文本按文本显示，未执行HTML');
  await guest.locator('#mention-button').click();await guest.locator('#message-input').fill('请整理我们的讨论。');await guest.locator('#send-button').click();await owner.getByRole('button',{name:'批准执行',exact:true}).waitFor();assert.equal(await guest.getByRole('button',{name:'批准执行',exact:true}).count(),0);await owner.getByRole('button',{name:'批准执行',exact:true}).click();await guest.locator('.request-receipt[data-request-state=waiting_agent]').waitFor();checks.push('成员请求等待房主批准；批准后明确显示等待 Agent 连接');
  const content=Buffer.from('文件传输验证\r\n原始字节保持一致\n');await guest.locator('#file-input').setInputFiles({name:'提案附件.md',mimeType:'text/markdown',buffer:content});await owner.locator('.file-row label').filter({hasText:'提案附件.md'}).waitFor();
  const downloadEvent=owner.waitForEvent('download');await owner.getByRole('button',{name:'下载 提案附件.md',exact:true}).click();const download=await downloadEvent;assert.deepEqual(readFileSync(await download.path()),content);checks.push('成员上传，房主下载，原始字节一致');
  await owner.reload();await owner.locator('.file-row label').filter({hasText:'提案附件.md'}).waitFor();await owner.getByText('版本基准的定义需要先讨论。',{exact:true}).waitFor();checks.push('刷新恢复历史、文件与房主权限');
  await owner.locator('#message-input').fill('@aGeNt你好，请回答。');await owner.locator('#mention-strip').waitFor();assert.match(await owner.locator('#mention-help').innerText(),/未连接/);await owner.locator('#send-button').click();await owner.getByText('@aGeNt你好，请回答。',{exact:true}).waitFor();assert.equal(await owner.locator('.request-receipt[data-request-state=waiting_agent]').count(),2);assert.equal(await owner.locator('#cloud-status').innerText(),'Agent 未连接');checks.push('输入 @Agent 前缀可触发；未连接时显示持久请求回执');
  const rid=new URLSearchParams(new URL(owner.url()).hash.slice(1)).get('room');
  async function protocol(path,{token=admin,data,method=data===undefined?'GET':'POST'}={}){const r=await fetch(base+path,{method,headers:{Authorization:'Bearer '+token,...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data)});assert.ok(r.ok);return r.json();}
  await setPublic('https://agent-qa.example');await owner.locator('#connect-button').click();
  await owner.locator('#cloud-status').filter({hasText:'等待 Agent 接入'}).waitFor();assert.equal(await owner.locator('#cloud-status').evaluate(e=>e.classList.contains('online')),false);assert.equal(submitCount,1);const agent=cloudPrompt.match(/Authorization: Bearer ([A-Za-z0-9_-]+)/)[1];checks.push('网页自动复用唯一发现的环境并提交；创建云任务后仍等待真实接入（隔离协议测试）');
  await protocol('/agent/hello',{token:agent,data:{}});await owner.locator('#cloud-status').filter({hasText:'Agent 已连接'}).waitFor();await owner.locator('.request-receipt[data-request-state=queued]').first().waitFor();
  const {job}=await protocol('/agent/next',{token:agent});await owner.locator('.request-receipt[data-request-state=running]').waitFor();assert.equal(await owner.locator('#cloud-status').innerText(),'Agent 正在处理');
  await protocol(`/agent/jobs/${job.id}/result`,{token:agent,data:{lease:job.lease,text:'协议测试回复；未调用真实云端模型。'}});await owner.locator('.request-receipt[data-request-state=done]').waitFor();checks.push('确认连接、领取处理、回复完成分别更新真实回执（协议测试）');
  app.db.prepare('UPDATE rooms SET agent_expires=? WHERE id=?').run(Date.now()-1,rid);await owner.locator('#cloud-status').filter({hasText:'连接已过期'}).waitFor();await owner.locator('.request-receipt[data-request-state=waiting_agent]').waitFor();assert.match(await owner.locator('#agent-status-detail').innerText(),/无需重复发送/);checks.push('连接到期明确显示原因，保留未开始的请求');
  await owner.screenshot({path:join(out,'desktop.png'),fullPage:true});
  for(const width of [820,390,320]){await owner.setViewportSize({width,height:1000});const size=await owner.evaluate(()=>({w:document.documentElement.clientWidth,s:document.documentElement.scrollWidth}));assert.ok(size.s<=size.w+1,`width ${width}: ${JSON.stringify(size)}`);}
  await owner.screenshot({path:join(out,'mobile.png'),fullPage:true});checks.push('820/390/320px无横向溢出');
  assert.deepEqual(errors,[]);writeFileSync(join(out,'report.json'),JSON.stringify({checks,browserErrors:errors,realCloudVerified:false},null,2));console.log(JSON.stringify({passed:checks,browserErrors:errors,realCloudVerified:false}));
}finally{await browser.close();await app.close();rmSync(dir,{recursive:true,force:true});}
