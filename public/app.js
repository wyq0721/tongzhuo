const $ = id => document.getElementById(id);
const el = (tag, cls, content) => { const e=document.createElement(tag);if(cls)e.className=cls;if(content!==undefined)e.textContent=content;return e; };
const savedBackend = localStorage.getItem('tongzhuo.backend') || '';
let backend = new URLSearchParams(location.search).get('backend') || savedBackend || location.origin;
try { const u=new URL(backend);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error();backend=u.origin; } catch { backend=location.origin; }
const storageKey='tongzhuo.sessions:'+backend;
let sessions;try {sessions=JSON.parse(localStorage.getItem(storageKey)||'{}');}catch{sessions={};}
let adminToken=sessionStorage.getItem('tongzhuo.admin:'+backend)||'';
let current=null,state=null,reply=null,mention=false,selected=new Set(),lastSignature='',polling=false,pollTimer,toastTimer,publicUrl='';
const drafts=new Map(),pendingMessages=new Map();
const launchRequests=new Map(),startingRooms=new Set();
const typedMention=value=>/^@agent\b/i.test(value.trimStart());
const wantsAgent=()=>mention||typedMention($('message-input').value);
const persist=()=>localStorage.setItem(storageKey,JSON.stringify(sessions));
const button=(label, cls, action)=>{const b=el('button',cls,label);b.type='button';b.onclick=action;return b;};
const fmtTime=t=>new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit'}).format(new Date(t));
const fmtContact=t=>new Intl.DateTimeFormat('zh-CN',{...(new Date(t).toDateString()===new Date().toDateString()?{}:{month:'2-digit',day:'2-digit'}),hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(t));
const fmtBytes=n=>n<1024?`${n} B`:n<1024*1024?`${(n/1024).toFixed(1)} KB`:`${(n/1024/1024).toFixed(1)} MB`;
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}
async function api(path,{method='GET',data,raw,token,headers={}}={}) {
  const h={...headers};if(token)h.Authorization='Bearer '+token;if(data!==undefined)h['Content-Type']='application/json';
  const response=await fetch(backend+path,{method,headers:h,body:raw??(data===undefined?undefined:JSON.stringify(data)),cache:'no-store',signal:AbortSignal.timeout(25000)});
  if(!response.ok){let e;try{e=await response.json();}catch{}const error=Error(e?.error||`服务返回 ${response.status}`);error.code=e?.code;error.httpStatus=response.status;throw error;}
  return response.json();
}
const roomApi=(suffix='',opts={})=>api(`/api/rooms/${current}${suffix}`,{token:sessions[current]?.token,...opts});
function modal(title, content, submitLabel, onSubmit){
  $('modal-title').textContent=title;$('modal-content').replaceChildren(...content);$('modal-error').hidden=true;
  $('modal-cancel').hidden=false;
  $('modal-submit').textContent=submitLabel;$('modal-submit').hidden=!submitLabel;
  $('modal-form').onsubmit=async e=>{e.preventDefault();$('modal-error').hidden=true;$('modal-submit').disabled=true;try{await onSubmit();}catch(err){$('modal-error').textContent=err.message;$('modal-error').hidden=false;}finally{$('modal-submit').disabled=false;}};
  if(!$('modal').open)$('modal').showModal();
}
function field(label,name,value='',{area=false,hint='',placeholder='',type='text'}={}){
  const l=el('label','field');l.append(el('span','',label));const input=el(area?'textarea':'input');input.name=name;input.value=value;
  if(!area)input.type=type;input.placeholder=placeholder;l.append(input);if(hint)l.append(el('small','',hint));return l;
}
const values=()=>Object.fromEntries(new FormData($('modal-form')));
const note=s=>el('p','modal-note',s);
const closeModal=()=>$('modal').close();
$('modal-close').onclick=closeModal;$('modal-cancel').onclick=closeModal;

function renderRooms(){
  const list=$('room-list');list.replaceChildren();
  for(const [rid,s] of Object.entries(sessions)){
    const b=button('',`room-nav${rid===current?' active':''}`,()=>openRoom(rid));
    b.append(el('strong','',s.title||'任务房间'),el('small','',s.is_owner?'房主 · 共享云端会话':'成员 · 共同讨论'));list.append(b);
  }
  if(!Object.keys(sessions).length)list.append(el('p','empty-section','创建或通过邀请加入一个房间'));
}
async function openRoom(rid){
  if(current)drafts.set(current,{text:$('message-input').value,reply,mention,files:[...selected]});
  const draft=drafts.get(rid);current=rid;state=null;selected=new Set(draft?.files||[]);reply=draft?.reply||null;mention=draft?.mention||false;$('message-input').value=draft?.text||'';lastSignature='';renderComposer();
  $('welcome').hidden=true;$('room-view').hidden=false;renderRooms();
  history.replaceState({},'',location.pathname+location.search+'#room='+rid);
  await refresh();
}
async function refresh(){
  if(!current||polling)return;const rid=current;polling=true;
  try{
    const next=await roomApi();if(current!==rid)return;state=next;publicUrl=next.room.public_url||'';
    $('service-status').textContent='群聊服务：在线';$('service-status').classList.remove('offline');
    $('chat-status').textContent=`已同步 · ${fmtTime(new Date())} · 普通发言不会唤起 Agent`;
    sessions[rid]={...sessions[rid],title:next.room.title,is_owner:next.me.is_owner};persist();
    const signature=JSON.stringify(next);if(signature!==lastSignature){renderRoom(next);lastSignature=signature;}
  }catch(e){$('service-status').textContent='群聊服务：离线';$('service-status').classList.add('offline');$('chat-status').textContent=e.message+'；未收到服务确认的消息不会标记为已发送。';$('cloud-status').textContent='Agent 状态无法确认';$('cloud-status').classList.remove('online');$('cloud-status').dataset.tone='danger';$('agent-status-panel').dataset.tone='danger';$('agent-status-title').textContent='无法确认 Agent 状态';$('agent-status-detail').textContent='群聊服务暂时不可达，无法确认 Agent 是否在线。请恢复连接后再试；输入内容会保留。';$('agent-status-action').hidden=true;}
  finally{polling=false;}
}
function connectionPresentation(a){
  const phase=a.connection_state||(['online','busy'].includes(a.status)?'connected':'not_configured');
  const labels={not_configured:'Agent 未连接',expired:'Agent 未连接 · 连接已过期',address_changed:'Agent 未连接 · 访问地址已变化',starting:'正在启动 Agent',start_uncertain:'启动结果待核实',start_failed:'Agent 启动失败',task_ended:'云任务已结束',awaiting_agent:a.launch?'云任务已创建 · 等待 Agent 接入':'Agent 未连接 · 尚无云任务',connection_lost:'Agent 状态待确认',connected:a.status==='busy'?'Agent 正在处理':'Agent 已连接'};
  const action=phase==='starting'?'正在启动…':['awaiting_agent','connection_lost','connected','start_uncertain'].includes(phase)&&a.launch?'查看云任务':a.has_connection?'重新启动 Agent':'启动 Agent';
  return{phase,label:labels[phase]||'Agent 未连接',tone:a.ready?'success':'warning',action};
}
function renderConnection(s){
  const a=s.agent,p=connectionPresentation(a),queued=s.jobs.filter(j=>j.status==='queued').length,running=s.jobs.some(j=>j.status==='running');
  $('cloud-status').textContent=p.label;$('cloud-status').dataset.tone=p.tone;$('cloud-status').classList.toggle('online',!!a.ready);
  $('agent-status-panel').dataset.tone=p.tone;$('agent-status-title').textContent=p.label;
  let detail=a.ready?(running?'Agent 已领取请求，正在等待它回传结果。':'已收到 Agent 连接确认，可以发送分析请求。'):(a.reason||'尚未收到 Agent 的连接确认。');
  if(!a.ready&&running)detail+=' 有请求已被领取，执行结果暂时无法确认，请先到 Codex 查看。';
  if(!a.ready&&queued)detail+=` ${queued} 条请求已保存、尚未开始；接通后会继续，无需重复发送。`;
  $('agent-status-detail').textContent=detail;$('agent-status-action').hidden=a.ready||!s.me.is_owner;$('agent-status-action').textContent=p.action;
  const starting=p.phase==='starting'||startingRooms.has(current);$('connect-button').disabled=starting;$('agent-status-action').disabled=starting;
  $('connect-button').textContent=starting?'正在启动…':p.action;
  $('environment-label').textContent=a.environment_bound?'目标环境：'+(a.environment_label||'已绑定云端环境'):'启动时查询可复用的环境';
  $('agent-description').textContent=a.ready?'Agent 已确认接入这个房间，按房主批准的队列领取请求。':p.phase==='connection_lost'?'最近联系暂未更新，Agent 可能仍在分析。请先打开云任务核实状态。':a.environment_bound?'由房主在本页启动，Mac 会使用已登录的 Codex 自动创建云任务。':'查询近期云任务使用的环境；只有一个时自动复用，有多个时再选择。';
  $('agent-setup-steps').hidden=!!a.ready||p.phase==='connection_lost';
  $('connection-step-1').textContent=a.environment_bound?'云端环境已绑定':'查询并复用已有环境';$('connection-step-1').dataset.done=String(!!a.environment_bound);
  $('connection-step-2').textContent=a.launch?'网页已提交云任务启动请求':'在本页点击「启动 Agent」';$('connection-step-2').dataset.done=String(!!a.launch&&a.launch.status!=='failed');
  $('connection-step-3').textContent='等待 Agent 接入确认';$('connection-step-3').dataset.done=String(!!a.ready);
  $('agent-connection-meta').textContent=(a.connected_at?'连接确认：'+fmtContact(a.connected_at):'当前连接：尚未收到 Agent 确认')+'\n'+(a.last_seen?'最近联系：'+fmtContact(a.last_seen):'最近联系：无')+(a.expires_at?'\n'+(a.expires_at<=Date.now()?'连接已过期于：':'本次连接有效至：')+fmtContact(a.expires_at):'');
  $('cloud-task-link').hidden=!a.task_url||!s.me.is_owner;if(a.task_url)$('cloud-task-link').href=a.task_url;
}
function requestPresentation(j){
  const phase=j.delivery_state||(j.status==='queued'&&!state?.agent.ready?'waiting_agent':j.status);
  const views={
    awaiting_owner:{label:'等待房主批准',detail:'请求已保存，房主批准后才能交给 Agent。',tone:'warning',step:1},
    waiting_agent:{label:'等待 Agent 连接',detail:'尚未开始。'+(j.blocked_reason||state?.agent.reason||'Agent 当前未连接。')+' 请求已保存，连接后会继续，无需重复发送。',tone:'warning',step:1},
    queued:{label:'等待 Agent 领取',detail:'Agent 已连接，这条请求尚未被领取。',tone:'info',step:1},
    running:{label:'Agent 正在处理',detail:'已于 '+fmtTime(j.updated_at)+' 被领取，等待 Agent 返回结果。',tone:'info',step:2},
    done:{label:'Agent 已回复',detail:'本次请求已完成。',tone:'success',step:4},
    failed:{label:'Agent 处理失败',detail:j.error||'请房主检查失败原因后重试。',tone:'danger',step:2},
    cancelled:{label:'请求已取消',detail:'这条请求不会继续交给 Agent。',tone:'muted',step:-1},
    unknown:{label:'执行结果待核实',detail:j.error||'请求曾被领取，请先到 Codex 核实执行情况。',tone:'danger',step:2},
    connection_lost:{label:'已领取 · 状态待确认',detail:'请求已被领取，Agent 可能仍在分析，当前无法确认执行结果。'+(j.blocked_reason||'请先在 Codex 查看任务。'),tone:'warning',step:2}
  };
  return{phase,...views[phase]};
}
function requestReceipt(j){
  const p=requestPresentation(j),card=el('section','request-receipt');card.dataset.requestState=p.phase;card.dataset.tone=p.tone;card.setAttribute('aria-label','Agent 请求状态');
  card.append(el('strong','',p.label),el('p','',p.detail));
  if(p.step>=0){const steps=el('ol','request-progress');steps.setAttribute('aria-label','请求进度');const labels=['已保存',p.phase==='awaiting_owner'?'待房主批准':p.phase==='waiting_agent'?'待连接':p.step>=2?'已领取':'待领取',p.phase==='done'?'已处理':'处理中','已回复'];for(const [i,label] of labels.entries()){const li=el('li','',label);li.dataset.done=String(i<p.step);li.dataset.current=String(i===p.step);steps.append(li);}card.append(steps);}
  if(p.phase==='waiting_agent'&&state.me.is_owner)card.append(button(connectionPresentation(state.agent).action,'quiet',()=>$('connect-button').click()));
  return card;
}
function renderRoom(s){
  $('room-title').textContent=s.room.title;$('room-goal').textContent=s.room.goal;
  $('room-eyebrow').textContent=s.me.is_owner?'任务协作间 / 房主控制':'任务协作间 / 共同讨论';
  $('identity-label').textContent=s.me.name+' · '+s.me.role;
  $('invite-button').hidden=!s.me.is_owner;$('connect-button').hidden=!s.me.is_owner;
  $('cloud-config-button').hidden=!s.me.is_owner;
  $('disconnect-button').hidden=!s.me.is_owner||!s.agent.has_connection;
  renderConnection(s);
  $('read-through').textContent=s.agent.read_through?`Agent 已处理至 #${s.agent.read_through}`:'Agent 尚未处理消息';
  $('members').replaceChildren(...s.members.map(m=>{const p=el('div','person');p.append(el('span','avatar',m.name.slice(0,1)));const info=el('div');const title=el('strong','',m.name);if(m.is_owner)title.append(el('span','owner-badge','房主'));info.append(title,el('small','',m.role+(m.id===s.me.id?' · 我':'')));p.append(info);return p;}));
  $('messages').replaceChildren(...s.messages.map(renderMessage));$('empty-chat').hidden=s.messages.length>0;
  renderJobs(s);renderFiles(s);renderComposer();
}
function renderMessage(m){
  const item=el('article','message'+(m.kind==='agent'?' agent':''));item.dataset.messageId=m.id;
  const header=el('div','message-top');header.append(el('strong','',m.kind==='agent'?'Codex':m.name||'房间'));
  header.append(el('small','',m.kind==='agent'?'云端 Agent':m.role||''),el('time','',fmtTime(m.created_at)));item.append(header);
  if(m.reply_to){const ref=state.messages.find(v=>v.id===m.reply_to);if(ref)item.append(el('div','reply-reference',`回复 ${ref.kind==='agent'?'Codex':ref.name} · #${ref.id}：${ref.text.slice(0,130)}`));}
  if(['file','artifact'].includes(m.kind)){
    let meta;try{meta=JSON.parse(m.text);}catch{meta={};}
    const row=el('div','file-message');row.append(el('span','file-symbol',m.kind==='artifact'?'OUT':'FILE'));
    const info=el('div');info.append(el('div','',meta.name||'附件'),el('small','muted',`v${meta.version||1}${m.kind==='artifact'?' · Agent 产物':' · 房间文件'}`));row.append(info,button('下载','quiet',()=>download(meta.id)));item.append(row);
  }else item.append(el('p','message-body',m.text));
  const request=state.jobs.find(j=>j.trigger_id===m.id);if(request)item.append(requestReceipt(request));
  item.append(button('回复 · #'+m.id,'message-reply',()=>{reply=m.id;renderComposer();$('message-input').focus();}));return item;
}
function renderJobs(s){
  const active=s.jobs.filter(j=>!['done','cancelled'].includes(j.status));$('job-count').textContent=active.length?String(active.length):'';
  const visible=[...active,...s.jobs.filter(j=>['done','cancelled'].includes(j.status)).slice(-2)];
  $('jobs').replaceChildren(...visible.map(j=>{
    const p=requestPresentation(j),div=el('div','job');div.append(el('span','job-state '+j.status,p.label));
    const msg=s.messages.find(m=>m.id===j.trigger_id);div.append(el('p','',`#${j.trigger_id} · ${msg?.name||'成员'}：${msg?.text.slice(0,100)||'请求分析'}`));if(j.error)div.append(el('p','',j.error));if(j.delivery_state==='waiting_agent')div.append(el('p','job-reason','尚未开始 · Agent 未连接'));
    if(s.me.is_owner){const actions=el('div','job-actions');if(j.status==='awaiting_owner')actions.append(button('批准执行','quiet',()=>jobAction(j.id,'approve')));if(['queued','awaiting_owner'].includes(j.status))actions.append(button('取消','quiet',()=>jobAction(j.id,'cancel')));if(j.status==='failed')actions.append(button('重试','quiet',()=>jobAction(j.id,'retry')));div.append(actions);}return div;
  }));if(!visible.length)$('jobs').append(el('p','empty-section','还没有 Agent 请求'));
}
async function jobAction(jid,action){try{await roomApi(`/jobs/${jid}/${action}`,{method:'POST',data:{}});await refresh();}catch(e){toast(e.message);}}
function renderFiles(s){
  const files=$('files');files.replaceChildren();
  for(const f of s.files){const row=el('div','file-row'),check=el('input');check.type='checkbox';check.id='file-'+f.id;check.checked=selected.has(f.id);check.onchange=()=>{if(check.checked)selected.add(f.id);else selected.delete(f.id);renderComposer();};
    const label=el('label');label.htmlFor=check.id;label.append(document.createTextNode(f.name),el('small','',`v${f.version} · ${fmtBytes(f.size)} · ${f.source==='agent'?'Agent 产物':f.read_at?'云端已取回':'房间已保存'}`));
    row.append(check,label,button('↓','quiet',()=>download(f.id)));row.lastChild.setAttribute('aria-label','下载 '+f.name);files.append(row);
  }if(!s.files.length)files.append(el('p','empty-section','上传提案、图片或其他参考资料'));
}
function renderComposer(){
  $('reply-strip').hidden=!reply;if(reply){const m=state?.messages.find(m=>m.id===reply);$('reply-label').textContent=`回复 ${m?.kind==='agent'?'Codex':m?.name||'消息'} · #${reply}`;}
  const requested=wantsAgent();$('mention-strip').hidden=!requested;$('mention-button').setAttribute('aria-pressed',String(requested));$('mention-help').textContent=state?.me.is_owner?(state.agent.ready?'发送后交给 Agent 分析':'请求将保存；Agent 未连接，暂不会执行'):'提交给房主，等待批准';
  $('selected-files').textContent=selected.size?`本轮关联 ${selected.size} 个文件`:'';
  $('send-button').textContent=requested?(state?.me.is_owner?(state.agent.ready?'发送给 Agent':'保存请求'):'请房主批准'):'发送';
}
$('mention-button').onclick=()=>{mention=true;renderComposer();$('message-input').focus();};
$('cancel-mention').onclick=()=>{mention=false;$('message-input').value=$('message-input').value.replace(/^\s*@agent\b[\s,，:：]*/i,'');renderComposer();};$('cancel-reply').onclick=()=>{reply=null;renderComposer();};
$('message-input').oninput=renderComposer;
let sending=false;
$('compose').onsubmit=async e=>{
  e.preventDefault();if(sending||!current)return;const input=$('message-input'),content=input.value.trim();if(!content)return;
  const requested=wantsAgent(),rid=current,candidate={text:requested&&!typedMention(content)?'@Agent '+content:content,mention_agent:requested,reply_to:reply,file_ids:[...selected]},fingerprint=JSON.stringify(candidate);
  const prior=pendingMessages.get(rid),payload=prior?.fingerprint===fingerprint?prior.payload:{...candidate,client_id:crypto.randomUUID()};
  pendingMessages.set(rid,{fingerprint,payload});
  sending=true;$('send-button').disabled=true;
  try{const sent=await api(`/api/rooms/${rid}/messages`,{method:'POST',data:payload,token:sessions[rid].token});pendingMessages.delete(rid);if(current===rid){if(input.value.trim()===content)input.value='';reply=null;mention=false;renderComposer();await refresh();const receipt=sent.request?requestPresentation(sent.request):null;$('chat-status').textContent=receipt?'请求已保存 · '+receipt.label:'消息已保存；其他成员可见。';if(receipt)toast('请求已保存 · '+receipt.label);}else if(drafts.get(rid)?.text.trim()===content)drafts.delete(rid);}
  catch(e){toast(e.message);$('chat-status').textContent='发送未确认，输入内容已保留。';}
  finally{sending=false;$('send-button').disabled=false;}
};
$('message-input').onkeydown=e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter')$('compose').requestSubmit();};
async function download(fid){try{
  const response=await fetch(backend+`/api/rooms/${current}/files/${fid}`,{headers:{Authorization:'Bearer '+sessions[current].token},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error('文件下载失败');const f=state.files.find(f=>f.id===fid),blob=await response.blob(),url=URL.createObjectURL(blob);const a=el('a');a.href=url;a.download=f?.name||'文件';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}catch(e){toast(e.message);}}
const upload=()=>$('file-input').click();$('upload-button').onclick=upload;$('attach-button').onclick=upload;
$('file-input').onchange=async e=>{const rid=current;for(const f of e.target.files){if(f.size>20*1024*1024){toast(f.name+' 超过20MB限制');continue;}try{toast('正在上传 '+f.name);const stored=await api(`/api/rooms/${rid}/files`,{method:'POST',token:sessions[rid].token,raw:f,headers:{'Content-Type':f.type||'application/octet-stream','X-Filename':encodeURIComponent(f.name)}});if(current===rid){selected.add(stored.id);await refresh();}toast(f.name+' 已保存到上传时所在的房间');}catch(err){toast(err.message);}}e.target.value='';};

async function createRoom(){
  if(!adminToken){toast('请在房主 Mac 上打开本机管理页面创建房间');return;}
  modal('创建任务房间',[
    field('任务标题','title','兼容模式提案'),field('这次要完成什么','goal','围绕兼容模式提案，讨论版本基准、部署目标与依赖范围，形成可引用的结论和待办。',{area:true}),
    field('你的昵称','name','房主'),field('你的角色','role','评审者'),note('可以先邀请同事讨论。首次使用 Agent 时，由房主选择云端环境。')
  ],'创建房间',async()=>{const b=values();const result=await api('/api/rooms',{method:'POST',data:b,token:adminToken});sessions[result.id]={token:result.token,title:b.title,is_owner:true,invite:result.invite};persist();closeModal();await openRoom(result.id);});
}
$('new-room').onclick=createRoom;$('welcome-create').onclick=createRoom;
function joinRoom(rid,invite,info){
  modal('加入「'+info.title+'」',[note(info.goal),field('怎么称呼你','name',''),field('你在这次讨论中的角色','role','开发者',{hint:'例如设计者、开发者、评审者、使用者，也可以填写自己的角色。'}),note('加入后可见房间的共享历史与文件。角色是自我介绍；Agent 的执行控制归房主。')],'加入讨论',async()=>{
    const b=values(),r=await api(`/api/rooms/${rid}/join`,{method:'POST',data:{...b,invite}});sessions[rid]={token:r.token,title:info.title,is_owner:false};persist();closeModal();await openRoom(rid);
  });$('modal-cancel').hidden=true;
}
$('invite-button').onclick=async()=>{
  try{
    const rid=current,r=await roomApi('/invite',{method:'POST',data:{}});sessions[rid].invite=r.invite;persist();
    const link=r.invite_url;if(!link)throw Error('请刷新页面后重新生成邀请链接');const base=new URL(link).origin;
    const box=el('div','invite-link',link);
    modal('邀请同事加入',[note('对方打开链接，填写昵称和角色即可参与。新成员可见房间完整共享历史。'),box,note(base.includes('127.0.0.1')||base.includes('localhost')?'当前是本机地址，其他设备还不能访问。先在连接设置中填写对外 HTTPS 地址。':'这次生成会撤销旧邀请链接，已经加入的成员不受影响。'),...(new URL(link).hostname.endsWith('.trycloudflare.com')?[note('当前是临时访问地址。对外通道重建后，请重新生成并分享邀请链接。')]:[])],'复制邀请链接',async()=>{await navigator.clipboard.writeText(link);toast('邀请链接已复制');closeModal();});
  }catch(e){toast(e.message);}
};
$('identity-button').onclick=()=>modal('我的身份',[field('昵称','name',state.me.name),field('本次讨论的角色','role',state.me.role),note('角色变化不会改写先前消息的发言身份。')],'保存',async()=>{await roomApi('/identity',{method:'POST',data:values()});closeModal();await refresh();});
$('settings-button').onclick=async()=>{
  let p='';if(adminToken){try{p=(await api('/api/admin/settings',{token:adminToken})).public_url;}catch{}}
  modal('连接设置',[
    field('Mac 服务地址','backend',backend,{hint:'本机使用默认地址；站点托管页面需要连接能够访问 Mac 的 HTTPS 地址。'}),
    ...(adminToken?[field('对外 HTTPS 地址','public_url',p,{placeholder:'https://你的访问域名',hint:'用于邀请和云端文件传输。地址应把请求转发到本机服务；不会把执行环境改为自建服务器。'})]:[]),
    note('Mac 离线或访问通道关闭后，群聊与文件服务会暂时不可用。')
  ],'保存设置',async()=>{
    const b=values(),u=new URL(b.backend);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('服务地址格式不正确');
    if(adminToken&&b.public_url!==undefined){const result=await api('/api/admin/settings',{method:'POST',data:{public_url:b.public_url},token:adminToken});publicUrl=result.public_url;}
    localStorage.setItem('tongzhuo.backend',u.origin);closeModal();if(u.origin!==backend)location.reload();else toast('连接设置已保存');
  });
};
function externalLink(label,url){const a=el('a','external-link',label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;}
async function configureCloud({startAfterSelection=false,roomId=current}={}){
  if(!adminToken){toast('请在房主 Mac 的本机页面选择已有环境。');return;}
  try{
    const c=await api('/api/admin/cloud',{token:adminToken}),recent=el('div','cloud-recent'),advanced=el('details','cloud-advanced');
    advanced.append(el('summary','','高级：手工绑定或指定分支'),field('环境 ID 或设置页链接','environment_id',c.environment_id),field('显示名称','label',c.label),field('分支（可选）','branch',c.branch,{hint:'留空时当前 CLI 使用 main；环境仓库使用其他分支时填写实际分支。'}));
    const finish=async()=>{closeModal();await refresh();if(startAfterSelection&&current===roomId)await startAgent();else toast('已选用已有环境，现在可以启动 Agent。');};
    const readButton=button('刷新已有环境','secondary',async()=>{
      readButton.disabled=true;recent.replaceChildren(note('正在查询已登录 Codex 的近期云任务…'));
      try{
        const r=await api('/api/admin/cloud/discover',{method:'POST',data:{},token:adminToken});recent.replaceChildren();
        if(!r.environments.length)recent.append(note('没有读到可复用的环境标识。这不代表 App 中没有环境；当前接口不能读取 App 的当前选择，也不能列出完整环境目录。'));
        for(const env of r.environments){const choice=button(env.label,'environment-choice',async()=>{choice.disabled=true;try{await api('/api/admin/cloud/select',{method:'POST',data:{environment_id:env.id,branch:values().branch||''},token:adminToken});await finish();}catch(e){toast(e.message);choice.disabled=false;}});recent.append(choice);}
      }catch(e){recent.replaceChildren(note('查询失败：'+e.message));}finally{readButton.disabled=false;}
    });
    modal('选择已有云端环境',[
      note('复用已有环境，无需重复创建。点击列表中的环境即可选择。'),
      recent,readButton,note('来源是近期云任务记录；这里尚不能同步 Codex App 当前选中的环境。'),advanced
    ],'保存手工绑定',async()=>{await api('/api/admin/cloud',{method:'POST',data:values(),token:adminToken});await finish();});
    $('modal-submit').hidden=true;advanced.ontoggle=()=>{$('modal-submit').hidden=!advanced.open;};
    await readButton.onclick();
  }catch(e){toast(e.message);}
}
function showLaunch(){
  const a=state.agent,l=a.launch,content=[note(a.reason||'云任务启动记录'),externalLink(a.task_url?'打开这次云任务':'打开 Codex 云任务记录',a.task_url||'https://chatgpt.com/codex/cloud')];
  if(l?.status==='unknown'){
    content.push(note('提交结果不确定，系统不会自动再次创建。请先在 Codex 核实是否已有本房间的云任务。'));
    modal('启动结果待核实',content,'已核实未创建，允许重试',async()=>{await roomApi('/agent/launch/reset',{method:'POST',data:{confirm_no_task:true}});launchRequests.delete(current);closeModal();await refresh();toast('现在可以重新启动 Agent。');});
  }else modal('云任务启动进度',content,null,async()=>{});
}
async function startAgent(){
  const rid=current;if(!rid||startingRooms.has(rid))return;
  if(!launchRequests.has(rid))launchRequests.set(rid,crypto.randomUUID());startingRooms.add(rid);renderConnection(state);
  try{await api(`/api/rooms/${rid}/agent/start`,{method:'POST',data:{client_id:launchRequests.get(rid)},token:sessions[rid].token});launchRequests.delete(rid);if(current===rid){await refresh();toast('启动请求已保存，正在等待云任务创建和 Agent 接入确认。');}}
  catch(e){if(current===rid&&['cloud_environment_not_found','cloud_environment_selection_required'].includes(e.code))await configureCloud({startAfterSelection:true,roomId:rid});else toast(e.message);}
  finally{startingRooms.delete(rid);if(current===rid&&state)renderConnection(state);}
}
$('connect-button').onclick=()=>{const a=state?.agent;if(!a)return;if(a.launch&&['submitting','submitted','connected','unknown'].includes(a.launch.status)&&!['expired','address_changed'].includes(a.connection_state)){showLaunch();return;}void startAgent();};
$('cloud-config-button').onclick=()=>void configureCloud();
$('agent-status-action').onclick=()=>$('connect-button').click();
$('disconnect-button').onclick=()=>modal('撤销云端连接',[note('撤销后，云端不能再领取请求或访问房间文件。已经开始的云端命令可能仍在执行，请同时到 Codex 确认并停止任务。')],'撤销连接',async()=>{const r=await roomApi('/agent/disconnect',{method:'POST',data:{}});closeModal();toast(r.note);await refresh();});
$('export-button').onclick=()=>{
  const lines=[`# ${state.room.title}`,'',state.room.goal,'',...state.messages.map(m=>`## #${m.id} ${m.kind==='agent'?'Codex':m.name||'房间'}${m.role?' · '+m.role:''}\n\n${m.created_at}\n\n${m.text}\n`)];
  const url=URL.createObjectURL(new Blob([lines.join('\n')],{type:'text/markdown;charset=utf-8'}));const a=el('a');a.href=url;a.download=state.room.title.replace(/[\\/:*?"<>|]/g,'_')+'-讨论记录.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
};
async function init(){
  const h=new URLSearchParams(location.hash.slice(1));
  renderRooms();
  try{
    await api('/api/health');localStorage.setItem('tongzhuo.backend',backend);$('service-status').textContent='群聊服务：在线';
    if(!h.get('join')&&['127.0.0.1','localhost','[::1]'].includes(location.hostname)&&backend===location.origin){
      const a=await api('/api/local-owner',{method:'POST',data:{}});adminToken=a.token;sessionStorage.setItem('tongzhuo.admin:'+backend,adminToken);
      const list=await api('/api/admin/rooms',{token:adminToken});publicUrl=(await api('/api/admin/settings',{token:adminToken})).public_url;
      for(const r of list.rooms)if(!sessions[r.id])sessions[r.id]={title:r.title,token:adminToken,is_owner:true};persist();renderRooms();
    }
    if(h.get('join')&&h.get('invite')){const rid=h.get('join'),invite=h.get('invite');if(sessions[rid])await openRoom(rid);else{const info=await api(`/api/rooms/${rid}/invite-info`,{method:'POST',data:{invite}});joinRoom(rid,invite,info);}}
    else if(h.get('room')&&sessions[h.get('room')])await openRoom(h.get('room'));
    else if(Object.keys(sessions).length)await openRoom(Object.keys(sessions)[0]);
    else if(!adminToken){$('welcome-status').hidden=false;$('welcome-status').textContent='通过房主发来的邀请链接加入房间。房主请在 Mac 本机管理页面创建任务。';$('welcome-create').hidden=true;}
  }catch(e){$('service-status').textContent='群聊服务：离线';$('service-status').classList.add('offline');$('welcome-status').hidden=false;$('welcome-status').textContent=e.message+'。请打开连接设置，确认 Mac 服务地址。';}
  pollTimer=setInterval(refresh,1800);
}
window.addEventListener('online',refresh);window.addEventListener('beforeunload',()=>clearInterval(pollTimer));
init();
