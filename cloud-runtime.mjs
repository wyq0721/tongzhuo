import {spawn} from 'node:child_process';
import {accessSync,constants} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

function codexBinary(){
  if(process.env.TONGZHUO_CODEX_PATH)return process.env.TONGZHUO_CODEX_PATH;
  const dirs=[...(process.env.PATH||'').split(':').filter(Boolean),join(homedir(),'.npm-global/bin'),'/opt/homebrew/bin','/usr/local/bin'];
  for(const dir of dirs){const file=join(dir,'codex');try{accessSync(file,constants.X_OK);return file;}catch{}}
  return 'codex';
}

export class CloudError extends Error {
  constructor(code,message,{uncertain=false}={}){super(message);this.code=code;this.uncertain=uncertain;}
}
export function cloudTaskUrl(value){
  try{const u=new URL(value);if(u.protocol!=='https:'||!['chatgpt.com','chat.openai.com'].includes(u.hostname)||u.username||u.password||!/^\/codex\/(?:cloud\/)?tasks?\/[^/]+\/?$/.test(u.pathname))return null;u.search='';u.hash='';return u.href;}catch{return null;}
}
export function environmentId(value){
  let id=typeof value==='string'?value.trim():'';
  if(id.startsWith('https://')){
    try{const u=new URL(id);if(!['chatgpt.com','chat.openai.com'].includes(u.hostname)||u.username||u.password)return null;id=u.searchParams.get('environment_id')||u.searchParams.get('env_id')||u.pathname.match(/\/environments\/([A-Za-z0-9_-]+)\/?$/)?.[1]||'';}catch{return null;}
  }
  return /^(?!default$)[A-Za-z0-9][A-Za-z0-9_-]{2,159}$/i.test(id)?id:null;
}

export class CodexCloud {
  constructor({binary=codexBinary(),cwd=process.cwd(),timeout=60_000}={}){this.binary=binary;this.cwd=cwd;this.timeout=timeout;this.probeCache=null;this.children=new Set();}
  cancelPending(){for(const child of this.children)child.kill('SIGTERM');}
  run(args,{timeout=this.timeout}={}){
    return new Promise(resolve=>{
      const env={...process.env,NO_COLOR:'1',TERM:'dumb'};delete env.OPENAI_API_KEY;delete env.CODEX_API_KEY;
      let child,stdout='',stderr='',finished=false,timedOut=false,started=false;
      const done=result=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(force);if(child)this.children.delete(child);resolve({stdout,stderr,started,timedOut,...result});};
      let timer,force;
      try{child=spawn(this.binary,args,{cwd:this.cwd,env,stdio:['ignore','pipe','pipe']});}catch(e){done({error:e.code});return;}
      this.children.add(child);
      child.once('spawn',()=>started=true);
      child.once('error',e=>done({error:e.code}));
      child.stdout.on('data',b=>{stdout=(stdout+b.toString()).slice(0,1024*1024);});
      child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(0,128*1024);});
      child.once('close',(code,signal)=>done({code,signal}));
      timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');force=setTimeout(()=>child.kill('SIGKILL'),1000);force.unref();},timeout);timer.unref();
    });
  }
  async probe(){
    if(this.probeCache&&Date.now()-this.probeCache.at<30_000)return this.probeCache.value;
    const [version,login]=await Promise.all([this.run(['--version'],{timeout:5000}),this.run(['login','status'],{timeout:5000})]);
    if(version.error||version.code!==0)throw new CloudError('cli_unavailable','Mac 上的 Codex CLI 不可用，请先完成安装或修复启动路径。');
    if(login.code!==0||!/(logged in using|authenticated).*chatgpt/i.test(login.stdout+'\n'+login.stderr))throw new CloudError('chatgpt_login_required','请先在 Mac 上通过 ChatGPT 账号登录 Codex；此功能使用订阅登录。');
    const value={available:true,authentication:'chatgpt',version:(version.stdout+'\n'+version.stderr).match(/codex-cli\s+[\w.+-]+/)?.[0]||'Codex CLI'};
    this.probeCache={at:Date.now(),value};return value;
  }
  async list(){
    const result=await this.run(['cloud','list','--json','--limit','20'],{timeout:20_000});
    if(result.code!==0||result.timedOut)throw new CloudError('cloud_list_unavailable','暂时无法读取云任务记录，请稍后刷新。');
    let parsed;try{parsed=JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));}catch{throw new CloudError('cloud_list_invalid','Codex CLI 返回了无法识别的云任务记录。');}
    if(!Array.isArray(parsed.tasks))throw new CloudError('cloud_list_invalid','Codex CLI 未返回云任务列表。');
    return parsed.tasks.map(t=>({id:String(t.id||''),url:cloudTaskUrl(t.url),title:String(t.title||''),status:String(t.status||''),environment_id:environmentId(t.environment_id),environment_label:String(t.environment_label||'')}));
  }
  async discover(){
    await this.probe();const tasks=await this.list(),seen=new Map();
    for(const t of tasks)if(t.environment_id&&!seen.has(t.environment_id))seen.set(t.environment_id,{id:t.environment_id,label:t.environment_label||t.environment_id,source:'recent_task'});
    return [...seen.values()];
  }
  async submit({environment_id,branch='',prompt}){
    const envId=environmentId(environment_id);if(!envId)throw new CloudError('environment_required','请先绑定一个具体的 Codex 云端环境。');
    const args=['cloud','exec','--env',envId,'--attempts','1'];if(branch)args.push('--branch',branch);args.push(prompt);
    const result=await this.run(args);
    if(!result.started)throw new CloudError('submit_not_started','Codex CLI 未能启动，没有提交云任务。');
    const candidates=(result.stdout+'\n'+result.stderr).match(/https:\/\/(?:chatgpt\.com|chat\.openai\.com)\/codex\/[^\s<>"']+/g)||[];
    const url=candidates.map(s=>cloudTaskUrl(s.replace(/[),.;]+$/,''))).find(Boolean);
    if(result.code===0&&url)return{url,id:new URL(url).pathname.split('/').filter(Boolean).at(-1)};
    // A timeout or nonzero exit can happen after the remote task was created.
    // Never silently resubmit an ambiguous launch.
    throw new CloudError('submission_uncertain',result.timedOut?'云任务提交超时，创建结果待核实。请检查云任务记录，系统不会自动重复提交。':'未能确认云任务创建结果。请检查云任务记录，系统不会自动重复提交。',{uncertain:true});
  }
}
