import {spawn} from 'node:child_process';
import {closeSync,existsSync,mkdirSync,openSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const data=join(root,'.local'),base='http://127.0.0.1:8796';
mkdirSync(data,{recursive:true,mode:0o700});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{if(!Number.isInteger(pid)||pid<2)return false;process.kill(pid,0);return true;}catch{return false;}};
async function healthy(origin){
  try{const r=await fetch(origin+'/api/health',{redirect:'error',signal:AbortSignal.timeout(4000)});return r.ok&&(await r.json()).version==='0.1.0';}catch{return false;}
}
function background(command,args,logName){
  const fd=openSync(join(data,logName),'a',0o600);
  const child=spawn(command,args,{cwd:root,detached:true,stdio:['ignore',fd,fd],env:{...process.env,HOST:'127.0.0.1',PORT:'8796',TONGZHUO_DATA_DIR:data}});
  closeSync(fd);
  return new Promise((resolve,reject)=>{child.once('error',reject);child.once('spawn',()=>{child.unref();resolve(child.pid);});});
}
async function localStart(){
  if(!await healthy(base)){
    await background(process.execPath,['server.mjs'],'server.log');
    for(let i=0;i<30;i++){await pause(200);if(await healthy(base))break;}
    if(!await healthy(base))throw Error('服务未能启动，请查看 .local/server.log。');
  }
  console.log('同桌已就绪：'+base+'/');
}
async function publicStart(){
  let saved;try{saved=JSON.parse(readFileSync(join(data,'tunnel.json'),'utf8'));}catch{
    try{saved={...JSON.parse(readFileSync(join(data,'public-origin.json'),'utf8')),pid:Number(readFileSync(join(data,'tunnel.pid'),'utf8'))};}catch{}
  }
  let origin=saved?.url;
  // Reuse a tunnel only after checking the live endpoint, never just its saved URL.
  if(!origin&&saved?.logName){
    try{origin=(readFileSync(join(data,saved.logName),'utf8').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)||[]).find(url=>new URL(url).hostname!=='api.trycloudflare.com');}catch{}
  }
  let ready=origin&&await healthy(origin);
  if(!ready&&alive(saved?.pid)){
    for(let i=0;i<2&&!ready;i++){await pause(1000);ready=origin&&await healthy(origin);}
    if(!ready)throw Error('本机页面已启动；对外通道仍在运行，但网络检查暂未通过。请稍后重试。');
  }
  if(!ready){
    const binary=join(data,'bin','cloudflared');
    if(!existsSync(binary))throw Error('本机页面已启动；缺少对外访问工具。请在连接设置填写已有的 HTTPS 入口。');
    const logName='tunnel-'+Date.now()+'.log';
    const pid=await background(binary,['tunnel','--no-autoupdate','--url',base,'--protocol','quic'],logName);
    writeFileSync(join(data,'tunnel.pid'),String(pid),{mode:0o600});
    saved={pid,logName,url:''};
    writeFileSync(join(data,'tunnel.json'),JSON.stringify(saved),{mode:0o600});
    origin='';
    for(let i=0;i<50;i++){
      await pause(500);
      const log=readFileSync(join(data,logName),'utf8');
      const urls=log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)||[];
      const candidate=urls.find(url=>new URL(url).hostname!=='api.trycloudflare.com');
      if(candidate){origin=candidate;saved.url=origin;writeFileSync(join(data,'tunnel.json'),JSON.stringify(saved),{mode:0o600});break;}
      if(log.includes('failed to request quick Tunnel'))throw Error('本机页面已启动；创建对外入口时网络中断。请稍后重试，详情见 .local/'+logName+'。');
    }
    if(!origin)throw Error('本机页面已启动；对外入口暂未建立。可稍后重新运行，详情见 .local/'+logName+'。');
    ready=false;
    for(let i=0;i<8;i++){if(await healthy(origin)){ready=true;break;}await pause(500);}
    if(!ready)throw Error('本机页面已启动；对外入口尚未连通。详情见 .local/'+logName+'。');
  }
  writeFileSync(join(data,'tunnel.json'),JSON.stringify({...saved,url:origin}),{mode:0o600});
  const token=readFileSync(join(data,'owner.secret'),'utf8').trim();
  const r=await fetch(base+'/api/admin/settings',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({public_url:origin}),signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw Error('对外入口可达，但保存连接设置失败。');
  writeFileSync(join(data,'public-origin.json'),JSON.stringify({url:origin,verified:true,at:new Date().toISOString()},null,2),{mode:0o600});
  console.log('外部入口已验证：'+origin+'/');
  console.log('在房间内点击「邀请同事」，分享新生成的邀请链接。');
}

try{
  await localStart();
  if(process.argv.includes('--open')){
    const child=spawn('open',[base+'/'],{stdio:'ignore'});
    child.on('error',()=>console.error('请在浏览器打开 '+base+'/'));
  }
  if(process.argv.includes('--share'))await publicStart();
}catch(e){console.error(e.message);process.exitCode=1;}
