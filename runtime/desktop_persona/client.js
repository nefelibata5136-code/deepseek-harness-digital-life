window.__ModuleLoader__.load({id: '@local/dsh-desktop-persona', factory: require => {
  const React = require('react');
  const {MarkdownText} = require('@deepseek-ai/dsh-client-ui-primitives');
  const h = React.createElement;
  const {useState, useEffect, useRef} = React;
  const clockTime=value=>value?new Date(value).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}):'暂无';
  const elapsed=value=>{const seconds=Math.max(0,Math.floor(value/1000));return seconds<60?seconds+' 秒':Math.floor(seconds/60)+' 分 '+seconds%60+' 秒';};
  const DISPLAY_LIMIT=200; // 主对话列表只渲染最近多少条（2026-10-05 用户要求；改数字即可调整）
  function useClock(active=true){const [now,setNow]=useState(Date.now());useEffect(()=>{setNow(Date.now());if(!active)return;const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[active]);return now;}
  const panel = 'persona';
  let layoutController;
  // Keep a typed draft and a submitted request across plugin hot replacement.
  const retained = window.__personaDesktopState ??= {draft:'', pending:null, sending:false};
  retained.drafts ??= {};
  retained.requests ??= {};
  retained.attachments ??= {};
  retained.uploading ??= {};
  retained.dispatching ??= {};
  retained.cancelledRequests ??= {};
  if (retained.sending && retained.pending) retained.requests[retained.pending.sessionId] ??= retained.pending;
  let savedDraft = retained.draft;
  let pending = retained.pending;
  let sending = retained.sending;
  const labels = {code:{copyLabel:'复制',copiedLabel:'已复制'},footnotes:'注释'};
  const css = `
  .yb-actions{margin:0 0 18px}.yb-actions-heading{font-size:12px;color:#8796a7;margin-bottom:4px}.yb-action-card{margin:7px 0;border:1px solid #ffffff16;border-radius:8px;padding:10px 12px}.yb-action-card>summary{display:flex;align-items:flex-start;gap:10px;list-style:none;cursor:pointer}.yb-action-card>summary::-webkit-details-marker{display:none}.yb-action-heading{font-weight:600;color:#c2cddb}.yb-action-target{font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;margin:3px 0}.yb-action-facts{font-size:11px;color:#93a5b8;line-height:1.7}.yb-action-content{min-width:0;flex:1}.yb-action-card[open]>summary .yb-chevron{transform:rotate(90deg)}
  .yb-thinking{margin:0 0 18px;color:#a6b5c6;font-size:13px}.yb-thinking>summary{cursor:pointer;padding:8px 0;display:flex;align-items:center;gap:9px;list-style:none}.yb-thinking>summary::-webkit-details-marker{display:none}.yb-thinking[open]>summary .yb-chevron{transform:rotate(90deg)}.yb-thinking-text{white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;padding:12px 16px;border-left:1px solid #ffffff22;font:inherit;line-height:1.75;contain:content}
  .yb-root{height:100%;min-height:0;display:flex;flex-direction:column;color:var(--color-text-primary,#e8e9ed);background:var(--color-bg-primary,#17191e);font-family:system-ui,'Microsoft YaHei',sans-serif}
  .yb-workspace{height:100%;min-height:0;display:flex;background:var(--color-bg-primary,#17191e);color:var(--color-text-primary,#e8e9ed);font-family:system-ui,'Microsoft YaHei',sans-serif}.yb-workspace>.yb-root{flex:1;min-width:0}.yb-tasks{width:205px;min-height:0;overflow:hidden;box-sizing:border-box;flex-shrink:0;border-right:1px solid #ffffff16;display:flex;flex-direction:column;padding:22px 10px;gap:8px}.yb-tasks-head{font-size:14px;font-weight:600;padding:0 8px 8px}.yb-tasks> :not(.yb-task-list){flex-shrink:0}.yb-task-list{flex:1 1 0;overflow-y:auto;overflow-x:hidden;overscroll-behavior-y:contain;scrollbar-gutter:stable;min-height:0;display:flex;flex-direction:column;gap:6px}.yb-task{flex:0 0 auto;min-height:40px;box-sizing:border-box;line-height:20px;padding:10px 12px;background:transparent;color:#a8b6c6;border:1px solid transparent;text-align:left;border-radius:9px;cursor:pointer;font:inherit;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.yb-task.selected{background:#ffffff0d;border-color:#ffffff18;color:#e1e7ee}.yb-task:hover{background:#ffffff0a}.yb-taskform{display:flex;gap:6px;flex-wrap:wrap}.yb-taskform input{width:100%;box-sizing:border-box;background:#ffffff08;border:1px solid #ffffff28;border-radius:7px;color:inherit;padding:8px;font:inherit}.yb-taskform button{font-size:12px}.yb-tasks .yb-btn{font-size:13px}.yb-task-hint{font-size:11px;color:#8996a5;line-height:1.6;padding:7px 8px;margin-top:auto}
  .yb-head{padding:22px 28px 16px;border-bottom:1px solid #ffffff16;display:flex;justify-content:space-between;gap:16px;align-items:center}
  .yb-title{font-size:22px;font-weight:650}.yb-sub{font-size:12px;color:#a5adb9;margin-top:6px;line-height:1.7}.yb-good{color:#94dab6}.yb-warning{color:#f4c98c}
  .yb-list{flex:1;min-height:0;overflow:auto;padding:24px max(22px,calc((100% - 850px)/2));overflow-anchor:auto}
  .yb-message{margin:0 0 22px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px}.yb-user{padding:15px 20px;background:#ffffff08;border:1px solid #ffffff13;border-radius:14px}.yb-role{font-size:12px;color:#9babbf;margin-bottom:5px}
  .yb-message .yb-markdown{white-space:normal;font-size:15px;line-height:1.8}.yb-markdown p{margin:0 0 12px}.yb-markdown p:last-child{margin-bottom:0}
  .yb-activity{margin:12px 24px 0;padding:12px 16px;border:1px solid #94dab633;background:#94dab608;border-radius:10px;flex-shrink:0;max-height:30vh;overflow:auto;font-size:13px;line-height:1.65;overflow-wrap:anywhere}.yb-activity-heading{display:flex;justify-content:space-between;gap:12px;color:#bce8ce;font-weight:600;margin-bottom:5px}.yb-activity-clock{font-weight:400;color:#9babbf;font-variant-numeric:tabular-nums}.yb-latest-progress{margin-top:8px;padding-top:8px;border-top:1px solid #ffffff16}.yb-progress{border-left:3px solid #8bb6cb;padding:10px 14px;background:#8bb6cb08;border-radius:0 8px 8px 0}.yb-phase-list{padding:9px 0;color:#a4bcae;font-size:12px;line-height:1.8}
  .yb-tools{margin:0 0 18px;color:#a6b5c6;font-size:13px}.yb-tools>summary{cursor:pointer;padding:8px 0;display:flex;align-items:center;gap:9px;list-style:none}.yb-tools>summary::-webkit-details-marker{display:none}.yb-chevron{font-size:11px;transition:transform .15s}.yb-tools[open]>summary .yb-chevron{transform:rotate(90deg)}.yb-action-list{margin:5px 0 0 7px;padding-left:18px;border-left:1px solid #ffffff22}.yb-action{padding:7px 0;font-size:13px}.yb-action>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;min-width:0}.yb-action-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.yb-action-meta{font-size:11px;color:#8290a1;margin-left:auto;flex-shrink:0}.yb-tools pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;padding:12px;border:1px solid #ffffff15;border-radius:8px;background:#0002;font-size:12px}.yb-state-dot{width:6px;height:6px;display:inline-block;border-radius:50%;background:#7aaa8d;flex-shrink:0}.yb-state-dot.error{background:#e7917e}.yb-state-dot.running{background:#dcb973;animation:yb-pulse 1s infinite alternate}.yb-state-dot.unknown{background:#929cab}.yb-action-label{color:#8796a7;font-size:11px;margin-top:12px}.yb-diff{border-radius:8px;overflow:auto;max-height:320px}.yb-diff pre{margin:0;border:0;border-radius:0}.yb-diff .yb-minus{background:#862b2526;color:#e0aca4}.yb-diff .yb-plus{background:#1c61452b;color:#a8d2b7}.yb-run{font-size:13px;color:#b2c3d4;display:flex;gap:9px;align-items:center;margin:12px 0}@keyframes yb-pulse{from{opacity:.35}to{opacity:1}}
  .yb-foot{padding:14px 24px 22px;border-top:1px solid #ffffff16}.yb-composer{display:flex;gap:12px;max-width:850px;margin:auto;align-items:flex-end}.yb-input{flex:1;min-width:0;resize:vertical;min-height:64px;max-height:220px;padding:12px 16px;background:#ffffff08;border:1px solid #ffffff25;border-radius:12px;color:inherit;font:inherit;line-height:1.6}.yb-btn{border:1px solid #ffffff25;border-radius:10px;background:#ffffff09;color:inherit;padding:10px 16px;font:inherit;cursor:pointer}.yb-send{background:#476453;border-color:#649675}.yb-btn:disabled{opacity:.45;cursor:default}.yb-tip{max-width:850px;margin:9px auto 0;color:#929cab;font-size:12px;line-height:1.6;overflow-wrap:anywhere}.yb-error{color:#f3b4a8}
  @media(max-width:780px){.yb-workspace{flex-direction:column}.yb-tasks{width:auto;flex:0 0 170px;max-height:170px;overflow:hidden;border-right:0;border-bottom:1px solid #ffffff16;padding:10px;gap:5px}.yb-task-list{flex:1 1 auto;flex-direction:column;overflow-y:auto;overflow-x:hidden}.yb-task{max-width:none;flex-shrink:0}.yb-tasks-head,.yb-task-hint{display:none}.yb-taskform{flex-wrap:nowrap}.yb-taskform input{min-width:0}.yb-tasks>.yb-btn{align-self:flex-start;padding:6px 12px}.yb-workspace>.yb-root{height:0}}
  @media(max-width:600px){.yb-head{padding:16px}.yb-foot{padding:12px}.yb-list{padding:18px 14px}.yb-composer{gap:8px}.yb-title{font-size:19px}}
  .yb-workspace,.yb-workspace *{box-sizing:border-box}
  .yb-workspace{position:relative;overflow:hidden}
  .yb-root{overflow:hidden;min-width:0}
  .yb-status-switch{display:flex;align-items:center;gap:8px;padding:6px 16px;min-height:44px;flex:0 0 auto;border-bottom:1px solid #ffffff12}
  .yb-status-switch .yb-title{flex:1;min-width:0;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .yb-status-switch .yb-btn{padding:5px 10px;font-size:12px;white-space:nowrap;border-radius:7px}
  .yb-tasks{width:224px;padding:14px 10px;gap:8px}
  .yb-tasks-head{padding:0 8px 4px;font-size:13px;color:#a8b6c6}
  .yb-task{min-height:36px;padding:8px 10px;font-size:12px}
  #yb-status-panel{max-height:30%;overflow:auto}
  .yb-head{padding:12px 18px;gap:10px}
  .yb-activity{margin:8px 16px 0;padding:9px 12px;max-height:120px;font-size:12px}
  .yb-list{padding:20px max(20px,calc((100% - 960px)/2));overscroll-behavior:contain}
  .yb-message{margin-bottom:20px;font-size:15px;line-height:1.75}
  .yb-user{padding:12px 16px}
  .yb-foot{flex:0 0 auto;padding:10px 18px;border-top:1px solid #ffffff12;background:var(--color-bg-primary,#17191e)}
  .yb-composer{max-width:960px;gap:8px;align-items:flex-end}
  .yb-input{height:58px;min-height:58px;max-height:160px;padding:8px 12px;line-height:1.5;font-size:14px;border-radius:10px}
  .yb-btn{padding:8px 12px;font-size:13px;line-height:1.4}
  .yb-btn:focus-visible,.yb-input:focus-visible{outline:2px solid #94dab6;outline-offset:2px}
  .yb-tip{max-width:960px;font-size:11px;margin-top:6px}
  .yb-earlier{display:block;margin:0 auto 18px;color:#9babbf;border-color:transparent;font-size:12px}
  .yb-action-card{background:#ffffff02}
  @media(max-width:780px){.yb-workspace{flex-direction:row}.yb-workspace>.yb-root{height:100%}.yb-tasks{position:absolute;z-index:10;inset:44px auto 0 0;width:min(280px,85%);max-height:none;border-right:1px solid #ffffff24;border-bottom:0;background:var(--color-bg-primary,#17191e);box-shadow:8px 0 24px #0004}.yb-tasks-head{display:block}.yb-taskform{flex-wrap:wrap}.yb-task-list{flex:1 1 0}.yb-task{max-width:none}.yb-status-switch{padding:6px 10px}.yb-list{padding:16px}.yb-foot{padding:8px 10px}}
  @media(max-width:460px){.yb-status-switch{gap:5px}.yb-status-switch .yb-btn{padding:5px 7px;font-size:11px}.yb-composer{flex-wrap:wrap;gap:6px}.yb-input{order:-1;flex-basis:100%;width:100%}.yb-send{margin-left:auto}.yb-list{padding:14px 12px}.yb-message .yb-markdown{font-size:14px}.yb-thinking-text{max-height:240px}}
  `;
  function operation(row) {
    const a=row.args??{};
    const path=a.file_path??a.path??'';
    const short=path.replaceAll('\\','/').split('/').slice(-2).join('/');
    if (['read','read_source','read_image'].includes(row.text)) return {label:'读取文件',category:'read',target:path,title:'读取 '+short,icon:'▤'};
    if (row.text==='write') return {label:'写入文件',category:'write',target:path,title:'写入 '+short,icon:'✎'};
    if (row.text==='edit') return {label:'编辑文件',category:'edit',target:path,title:'编辑 '+short,icon:'✎'};
    if (['terminal','bash','shell'].includes(row.text)) return {label:'执行命令',category:'terminal',target:a.command??a.cmd??'',title:a.command??'执行命令',icon:'›_'};
    if (['grep','search_text','search_history'].includes(row.text)) return {label:'搜索文本',category:'search',target:a.pattern??a.query??a.text??'',title:'搜索文本',icon:'⌕'};
    if (['glob','list_files'].includes(row.text)) return {label:'查看目录',category:'list',target:path||a.pattern||'',title:'查看目录',icon:'▱'};
    if (row.text.includes('browser_')) {
      const verb=row.text.slice(row.text.lastIndexOf('browser_'));
      const label=({browser_navigate:'打开网页',browser_click:'点击网页',browser_read_page:'读取页面',browser_get_state:'查看页面',browser_type:'输入文字',browser_scroll:'滚动页面',browser_screenshot:'截图页面',browser_go_back:'返回上一页',browser_switch_tab:'切换标签页',browser_list_tabs:'查看标签页',browser_status:'查看浏览器状态'})[verb]??'浏览器操作';
      return {label,category:'browser',target:a.url??a.element??a.text??(a.index!==undefined?'页面元素 #'+a.index:''),title:label,icon:'◉'};
    }
    if (row.text==='subagent'||row.text==='subagent_codex')return {label:row.text==='subagent_codex'?'启动 Codex 子任务':'启动子任务',category:'subagent',target:a.description??a.label??a.task??a.prompt?.split('\n')[0]?.slice(0,160)??'',title:'启动子任务',icon:'◇'};
    if (row.text.startsWith('cua_driver_native__')) {
      const verb=row.text.replace('cua_driver_native__','');
      const label=({get_desktop_state:'观察桌面',get_window_state:'观察软件',list_windows:'查看窗口',list_apps:'查看软件',
        click:'点击',double_click:'双击',right_click:'右键',drag:'拖拽',scroll:'滚动',move_cursor:'移动鼠标',
        type_text:'输入文字',hotkey:'组合键',press_key:'按键',launch_app:'打开软件',bring_to_front:'切换窗口',
        set_window_frame:'调整窗口',verify_state:'确认结果',zoom:'查看细节',check_permissions:'检查桌面权限'})[verb]??verb;
      const target=label+(a.name?' · '+a.name:a.keys?' · '+a.keys.join('+'):a.key?' · '+a.key:'');
      return {label:'操作 Windows',category:'computer',target,title:target,icon:'▣'};
    }
    if (row.text==='list_files') return {label:'查看目录',category:'list',title:'查看目录 '+(short||'.'),icon:'▱'};
    if (row.text==='search_history'||row.text.startsWith('session_')) return {label:'查询历史',category:'history',title:'查询历史 '+(a.query??a.text??''),icon:'⌕'};
    if (row.text==='budget_status') return {label:'查看预算',category:'budget',title:'查看今日预算',icon:'◷'};
    if (row.text.startsWith('schedule_')) return {label:'管理唤醒计划',category:'schedule',title:({schedule_create:'安排唤醒：',schedule_list:'查看唤醒计划',schedule_update:'修改唤醒计划',schedule_delete:'删除唤醒计划'}[row.text]??row.text)+(a.title??''),icon:'◷'};
    return {label:'调用工具',category:'other',target:row.text,title:row.text,icon:'◇'};
  }
  function groupTitle(rows) {
    const groups=new Map();
    for (const row of rows) {const op=operation(row);const g=groups.get(op.category)??{op,rows:[]};g.rows.push(row);groups.set(op.category,g);}
    return [...groups.values()].map(({op,rows})=> {
      if (['read','write','edit'].includes(op.category)) {
        const count=new Set(rows.map(row=>operation(row).target)).size;
        const verb={read:'读取',write:'写入',edit:'编辑'}[op.category];
        return verb+'了 '+count+' 个文件'+(rows.length>count?'（'+rows.length+' 次）':'');
      }
      if(op.category==='terminal') return '运行了 '+rows.length+' 条命令';
      return op.label+(rows.length>1?' ×'+rows.length:'');
    }).join(' · ');
  }
  function DesktopImage({image,sessionId}) {
    const target=useRef(null); const [url,setUrl]=useState(null);
    useEffect(()=>{
      const controller=new AbortController(); let blobUrl; let started=false;
      const observer=new IntersectionObserver(entries=>{
        if(started||!entries.some(entry=>entry.isIntersecting))return;
        started=true;
        fetch('api/persona.screenshot?'+new URLSearchParams({sessionId,attachmentId:image.attachmentId}),{signal:controller.signal})
          .then(r=>{if(!r.ok)throw new Error('截图暂不可用');return r.blob();})
          .then(blob=>{if(!controller.signal.aborted){blobUrl=URL.createObjectURL(blob);setUrl(blobUrl);}})
          .catch(()=>{});
      });
      observer.observe(target.current);
      return ()=>{observer.disconnect();controller.abort();if(blobUrl)URL.revokeObjectURL(blobUrl);};
    },[sessionId,image.attachmentId]);
    return h('div',{ref:target,style:{minHeight:48,marginTop:8}},url
      ?h('img',{src:url,alt:'人格此次观察的 Windows 画面',style:{maxWidth:'100%',height:'auto',borderRadius:8}})
      :h('span',{className:'yb-action-label'},'桌面截图 · '+image.width+'×'+image.height));
  }
  function ActionGroup({rows,expanded,sessionId}) {
    const running=rows.some(row=>row.status==='running');
    const now=useClock(running);
    return h('section',{className:'yb-tools yb-actions','data-action-group':rows[0].callId},
      h('div',{className:'yb-actions-heading'},'动作'),
      h('div',null,rows.map(row=> {
        const op=operation(row);const a=row.args??{};
        const status=op.category==='subagent'&&row.status==='completed'&&/^started (?:background subagent job|subagent) /i.test(row.result??'')?'已启动 · 子任务结果待返回':{completed:'完成',error:'失败',running:'执行中',unknown:'结果未知'}[row.status];
        const facts=actionFacts(row,now);
        return h(ActionCard,{key:row.id,row,expanded},
          h('summary',{title:op.title},h('span',{'aria-hidden':true},op.icon),h('div',{className:'yb-action-content'},
            h('div',{className:'yb-action-heading'},op.label),
            op.target?h('div',{className:'yb-action-target'},op.target):null,
            h('div',{className:'yb-action-facts'},[clockTime(row.time),status,...facts].join(' · '))),h('span',{className:'yb-chevron','aria-hidden':true},'▶')),
          (row.phases??[]).length?h('div',{className:'yb-phase-list'},row.phases.map((p,index)=>h('div',{key:p.id},clockTime(p.time)+' · '+p.label+(row.phases[index+1]?' · '+elapsed(row.phases[index+1].time-p.time):row.status==='running'?' · '+elapsed(now-p.time):'')))):null,
          row.text==='edit'&&typeof a.old_string==='string'&&typeof a.new_string==='string'?
            h('div',{className:'yb-diff'},h('pre',{className:'yb-minus'},a.old_string.split('\n').map(x=>'- '+x).join('\n')),h('pre',{className:'yb-plus'},a.new_string.split('\n').map(x=>'+ '+x).join('\n'))):null,
          h('div',{className:'yb-action-label'},'调用参数'),h('pre',null,row.detail),
          h('div',{className:'yb-action-label'},'执行结果'),h('pre',null,row.result??(row.status==='running'?'等待工具返回…':'未记录到结果；不推断成功。')),
          ...(row.images??[]).map(img=>h(DesktopImage,{key:img.attachmentId,image:img,sessionId})));
      })));
  }
  function ActionCard({row,expanded,children}) {
    const target=useRef(null);
    useEffect(()=>{if(target.current)target.current.open=expanded;},[expanded]);
    return h('details',{className:'yb-action yb-action-card',ref:target,'data-call-id':row.callId,'data-status':row.status},children);
  }
  function actionFacts(row,now) {
    const facts=[],a=row.args??{};let result;
    try{result=JSON.parse(row.result??'');}catch{}
    if(['read','read_source'].includes(row.text)&&row.result&&!row.isError) {
      const lines=[...row.result.matchAll(/^(\d+): /gm)];
      if(row.text==='read'&&lines.length)facts.push('第 '+lines[0][1]+'–'+lines.at(-1)[1]+' 行');
      if(row.text==='read_source'&&typeof result?.content==='string')facts.push('字符 '+result.offset+'–'+(result.offset+result.content.length)+'（从 0 开始）');
      const content=row.text==='read_source'?result?.content:lines.length?lines.map(line=>row.result.slice(line.index+line[0].length,row.result.indexOf('\n',line.index)<0?undefined:row.result.indexOf('\n',line.index))).join('\n'):undefined;
      if(typeof content==='string')facts.push('返回正文 '+(new TextEncoder().encode(content).length/1024).toFixed(1)+' KB');
      if(/Output capped|line truncated|Showing lines \d+-\d+ of/.test(row.result)||result?.next_offset!==undefined&&result.next_offset!==null)facts.push('部分返回');
    }
    if(['terminal','bash','shell'].includes(row.text)) {
      const code=result?.returncode??result?.exitCode??result?.exit_code;
      if(typeof code==='number')facts.push('exit '+code);
      if(result?.timeout)facts.push('已超时');
      if(result?.output_truncated)facts.push('输出已截断');
    }
    if(['grep','search_text','search_history'].includes(row.text)&&row.result) {
      const capped=row.result.match(/^Found (\d+) of (\d+) matches/m);
      const count=result?.matches?.length??result?.hits?.length??capped?.[1]??row.result.match(/^Found (\d+) matches?/m)?.[1]??(/No matches found/.test(row.result)?0:undefined);
      if(count!==undefined)facts.push('返回 '+count+' 处匹配');
      if(capped)facts.push('共 '+capped[2]+' 处');
      if(capped||result?.next_offset!==undefined&&result.next_offset!==null||result?.next_cursor||/truncated|Output capped/i.test(row.result))facts.push('还有结果／返回受限');
    }
    const executing=row.phases?.find(p=>p.phase==='executing');
    const returned=executing&&row.phases.find(p=>p.time>=executing.time&&p.phase==='waiting-after-backup');
    if(returned)facts.push('工具阶段 '+((returned.time-executing.time)/1000).toFixed(2)+' s');
    if(row.durationMs!==undefined)facts.push('总耗时 '+(row.durationMs/1000).toFixed(2)+' s');
    else if(row.status==='running')facts.push('运行中 '+elapsed(now-row.time));
    return facts;
  }
  function Thinking({sessionId,turn,text='',running=false,livePanel=false}) {
    const [open,setOpen]=useState(false);
    const [live,setLive]=useState(null);
    const body=useRef(null);
    const nearEnd=useRef(true);
    useEffect(()=>{
      if(!running)return;
      let disposed=false,timer,controller;
      const read=async()=>{
        controller=new AbortController();
        try {
          const response=await fetch('api/persona.thinking?'+new URLSearchParams({sessionId}),{signal:controller.signal});
          if(response.ok){const value=await response.json();if(!disposed&&value.sessionId===sessionId&&value.turn===turn)
            setLive(previous=>previous?.cursor===value.cursor&&previous?.revision===value.revision&&previous?.state===value.state?previous:value);}
        }catch{/* Keep received reasoning across a temporary disconnect. */}
        finally{if(!disposed)timer=setTimeout(read,350);}
      };
      read();
      return()=>{disposed=true;clearTimeout(timer);controller?.abort();};
    },[sessionId,turn,running]);
    const content=running?(live?.text ?? text):text;
    useEffect(()=>{
      if(!open||!nearEnd.current)return;
      const frame=requestAnimationFrame(()=>{if(body.current)body.current.scrollTop=body.current.scrollHeight;});
      return()=>cancelAnimationFrame(frame);
    },[open,content]);
    if(!content)return null;
    const state=running?live?.state??'thinking':'completed';
    const label=state==='tools'?'思考 · 执行工具中':state==='thinking'?'思考中':livePanel?'本轮思考':'思考';
    return h('details',{className:'yb-thinking',open,onToggle:e=>setOpen(e.currentTarget.open),'data-thinking-turn':turn,'data-thinking-live':livePanel?'true':undefined},
      h('summary',null,'🧠 '+label,h('span',{className:'yb-chevron','aria-hidden':true},'▶')),
      open?h('pre',{className:'yb-thinking-text',ref:body,onScroll:()=>{const el=body.current;nearEnd.current=el.scrollHeight-el.scrollTop-el.clientHeight<50;}},content):null);
  }
  function ActivityPanel({history,running,connected,lastConnected,quietSeconds=90,primary}) {
    const now=useClock(running||!connected);
    const [livePhases,setLivePhases]=useState(null);
    useEffect(()=>{
      setLivePhases(null);const id=history?.sessionId;
      if(!id||!running||!connected)return;
      let disposed=false,inFlight=false;
      const update=async()=>{if(inFlight)return;inFlight=true;try{const value=await api('activity?sessionId='+encodeURIComponent(id));if(!disposed)setLivePhases({sessionId:id,...value});}catch{/* Older Host: retain original call/result evidence. */}finally{inFlight=false;}};
      update();const timer=setInterval(update,2500);return()=>{disposed=true;clearInterval(timer);};
    },[history?.sessionId,running,connected]);
    if(!history)return null;
    const pending=(history.rows??[]).filter(r=>r.role==='tool'&&r.status==='running');
    const latest=(history.rows??[]).filter(r=>r.role==='tool').at(-1);
    const live=livePhases?.sessionId===history.sessionId?livePhases.events??[]:[];
    const lastAt=Math.max(history.lastActivityAt??history.lastEventAt??0,...live.map(p=>p.occurredAt));
    const silence=lastAt?now-lastAt:0;
    const freshPhase=live.filter(p=>p.callId===pending.at(-1)?.callId).at(-1);
    const phase=freshPhase?{time:freshPhase.occurredAt,label:['completed','failed'].includes(freshPhase.phase)?'操作阶段已结束，等待结果记录刷新':freshPhase.label??'阶段未知'}:pending.at(-1)?.phases?.at(-1);
    const reports=(history.rows??[]).filter(r=>r.role==='progress');
    const report=reports.at(-1);
    const currentReport=report&&(!history.currentTurn||report.turn===history.currentTurn);
    let summary=!connected?'连接暂时不可用，下面保留最近的活动记录':pending.length
      ?operation(pending.at(-1)).title+(pending.length>1?'（另有 '+(pending.length-1)+' 项操作等待结果）':'')
      :running?'正在处理下一步，尚无新的工具操作记录':latest?'上一项操作：'+operation(latest).title:'当前没有执行中的任务';
    return h('aside',{className:'yb-activity','aria-label':'实时活动'},
      h('div',{className:'yb-activity-heading'},report?(primary?'人格的进展':'活动进展'):'当前活动',h('span',{className:'yb-activity-clock'},clockTime(now))),
      report?h('div',{className:'yb-latest-progress',style:{marginTop:0,paddingTop:0,borderTop:0}},
        h('div',{className:'yb-sub'},(currentReport?'自己的说明':'最近一次说明')+' · '+clockTime(report.time)),report.text):null,
      h('div',{'data-testid':'activity-summary',className:report?'yb-sub':undefined},summary),
      running&&pending.length?h('div',{className:'yb-sub','data-testid':'activity-phase'},phase?phase.label+' · 此阶段 '+elapsed(now-phase.time):'已发起工具调用，尚无内部阶段记录；等待结果 '+elapsed(now-pending.at(-1).time)):null,
      running&&silence>=quietSeconds*1000?h('div',{className:'yb-sub','data-testid':'activity-quiet'},'已有 '+elapsed(silence)+' 没有新消息。'):null,
      h('details',{className:'yb-sub'},h('summary',{style:{cursor:'pointer'}},'连接与记录时间'),
        h('div',null,'最近活动 '+clockTime(lastAt)+' · 最近连接 '+clockTime(lastConnected)),
        history.activityError?h('div',null,history.activityError):null));
  }
  async function api(route, value) {
    const r = await fetch('api/persona.' + route, value ? {method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(value)} : {signal:AbortSignal.timeout(30000)});
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || body.errors?.join('\n') || ('请求失败 ' + r.status));
    return body;
  }
  function Page() {
    const [history, setHistory] = useState(null);
    const [status, setStatus] = useState(null);
    const [lastConnected,setLastConnected]=useState(null);
    const [error, setError] = useState('');
    const [connectionError, setConnectionError] = useState('');
    const [draft, setDraft] = useState(retained.draft);
    const [busy, setBusy] = useState(!!retained.requests[retained.selectedSessionId]);
    const [,refreshDispatch]=useState(0);
    const [echo, setEcho] = useState(retained.requests[retained.selectedSessionId]??null);
    const [tools, setTools] = useState(false);
    const [displayCount,setDisplayCount]=useState(DISPLAY_LIMIT);
    const [statusExpanded,setStatusExpanded]=useState(()=>{
      try{return localStorage.getItem('persona-status-expanded')==='true';}catch{return false;}
    });
    function toggleStatus(){setStatusExpanded(value=>{const next=!value;try{localStorage.setItem('persona-status-expanded',String(next));}catch{}return next;});}
    const [navigationExpanded,setNavigationExpanded]=useState(false);
    const frame=()=>document.querySelector('.yb-workspace')?.closest('[data-sidebar-collapsed], [data-rightbar-collapsed]');
    useEffect(()=>{
      // Use the native layout action, keeping its window controls and geometry intact.
      const el=frame();
      if(el&&!el.hasAttribute('data-sidebar-collapsed'))layoutController?.toggleSidebar();
    },[]);
    function toggleNavigation(){
      const next=!navigationExpanded;
      setNavigationExpanded(next);
      const el=frame();
      if(el&&el.hasAttribute('data-sidebar-collapsed')===next)layoutController?.toggleSidebar();
    }
    const [tasks,setTasks]=useState([]);
    const [selected,setSelected]=useState(retained.selectedSessionId??null);
    useEffect(()=>setDisplayCount(DISPLAY_LIMIT),[selected]);
    const [newTask,setNewTask]=useState(false);
    const [taskTitle,setTaskTitle]=useState('');
    const [creating,setCreating]=useState(false);
    const [,refreshAttachments]=useState(0);
    const picker=useRef(null);
    const pasteCount=useRef(0);
    const attachments=retained.attachments[selected]??[];
    const uploading=retained.uploading[selected]??0;
    function attach(target,files) {
      retained.attachments[target]=[...(retained.attachments[target]??[]),...files];
      if(alive.current)refreshAttachments(n=>n+1);
    }
    async function intake(files,clipboard=false) {
      const target=retained.selectedSessionId;if(!target)return;
      retained.uploading[target]=(retained.uploading[target]??0)+1;refreshAttachments(n=>n+1);setError('');
      try {
        if(clipboard) {
          const result=await api('clipboard',{sessionId:target});attach(target,result.files);
          if(result.errors.length)throw new Error(result.errors.map(e=>e.name+'：'+e.error).join('；'));
          if(!result.files.length&&!result.errors.length)throw new Error('剪贴板没有图片或文件。请先复制文件，或用附件按钮选择。');
        } else for(const file of files) {
          if(file.size>128*1024*1024)throw new Error(file.name+' 超过 128 MB');
          const form=new FormData();form.set('sessionId',target);form.set('file',file,file.name);
          const response=await fetch('api/persona.upload',{method:'POST',body:form});
          const receipt=await response.json();if(!response.ok)throw new Error(receipt.error||'上传失败');
          attach(target,[receipt]);
        }
      } catch(e){if(alive.current&&retained.selectedSessionId===target)setError(e.message);}
      finally{retained.uploading[target]--;if(alive.current)refreshAttachments(n=>n+1);}
    }
    function paste(event) {
      pasteCount.current++;
      const data=event.clipboardData;
      let files=Array.from(data.files??[]);
      if(!files.length)files=Array.from(data.items??[]).filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter(Boolean);
      if(files.length){event.preventDefault();intake(files);return;}
      if(data.getData('text/plain')||data.getData('text/html'))return;
      event.preventDefault();intake([],true);
    }
    function composerKey(event) {
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='v'&&!event.shiftKey&&!event.altKey) {
        // Windows file-drop clipboard formats can produce no DOM paste event.
        const before=pasteCount.current,target=selected;
        setTimeout(()=>{if(alive.current&&retained.selectedSessionId===target&&pasteCount.current===before)intake([],true);},100);
      }
      if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();send();}
    }
    const list = useRef(null);
    const alive = useRef(true);
    const lastCount = useRef(-1);
    const nearBottom = useRef(true);
    const update = useRef(null);
    const refreshing = useRef(false);
    update.current = async () => {
      if (refreshing.current) return;
      refreshing.current = true;
      try {
        const s = await api('status');
        if (!alive.current) return;
        setStatus(s);
        if(s.ready)setLastConnected(Date.now());
        if (!s.ready) { setConnectionError(s.connection?.message ?? '人格常驻服务尚未就绪。'); return; }
        const catalog = await api('tasks');
        let id=retained.selectedSessionId??catalog.primary;
        if(!catalog.tasks.some(task=>task.sessionId===id))id=catalog.primary;
        retained.selectedSessionId=id;
        const log=await api('historyState?sessionId='+encodeURIComponent(id));
        if (!alive.current) return;
        setStatus(s);setTasks(catalog.tasks);
        if(id===retained.selectedSessionId){setSelected(id);setHistory(log);setBusy(!!retained.requests[id]);setEcho(retained.requests[id]??null);}
        setConnectionError('');
      } catch (e) { if (alive.current) {setStatus(null); setConnectionError(['TypeError','TimeoutError','AbortError'].includes(e.name) || e.message === 'fetch failed' ? '连接暂时不可用，正在重新连接；已显示的会话记录会保留。' : e.message);} }
      finally { refreshing.current = false; }
    };
    useEffect(() => {
      alive.current = true;
      update.current();
      const timer = setInterval(() => update.current(), 2500);
      return () => {alive.current = false; clearInterval(timer);};
    }, []);
    useEffect(() => {
      if (history?.eventCount !== lastCount.current && nearBottom.current && list.current) list.current.scrollTop = list.current.scrollHeight;
      lastCount.current = history?.eventCount;
    }, [history, echo]);
    function selectTask(id) {
      if(selected)retained.drafts[selected]=draft;
      retained.selectedSessionId=id;setSelected(id);setHistory(null);setBusy(!!retained.requests[id]);setEcho(retained.requests[id]??null);setDraft(retained.drafts[id]??'');setError('');
      nearBottom.current=true;lastCount.current=-1;update.current();
    }
    async function createTask(e) {
      e.preventDefault();if(creating)return;setCreating(true);setError('');
      try{const task=await api('tasks',{title:taskTitle.trim()||'新任务',requestId:crypto.randomUUID()});setNewTask(false);setTaskTitle('');selectTask(task.sessionId);}
      catch(e){setError(e.message);}
      finally{if(alive.current)setCreating(false);}
    }
    async function send() {
      const originalDraft=draft;
      const text = draft.trim();
      if ((!text&&!attachments.length) || !selected || retained.dispatching[selected] || uploading || !status?.ready || status?.budget?.stop_reason) return;
      const target = selected;
      // Native steer also wakes an idle Agent. Use it whenever available, so
      // a stale idle poll cannot turn a quick second supplement into next-turn queue.
      const mode=status?.inputCapabilities?.steer?'steer':'queue';
      const requestId = crypto.randomUUID();
      const attachmentIds=attachments.map(file=>file.id);
      const submitted={text:text||'请查看我上传的附件。', requestId,sessionId:target,attachmentIds};
      sending = true; pending = submitted; savedDraft = '';
      retained.requests[target]=submitted;
      if(retained.drafts[target]===originalDraft)retained.drafts[target]='';
      retained.sending=true; retained.pending=pending;
      if(retained.selectedSessionId===target)retained.draft=retained.drafts[target]??'';
      retained.attachments[target]=(retained.attachments[target]??[]).filter(file=>!attachmentIds.includes(file.id));
      if(alive.current&&retained.selectedSessionId===target){setBusy(true);setEcho(submitted);setDraft(retained.drafts[target]??'');setError('');}
      nearBottom.current = true;
      try {
        const result = await api('prompt', {text, requestId,sessionId:target,attachmentIds,mode});
        if(retained.requests[target]?.requestId!==requestId||retained.cancelledRequests[requestId])return;
        if (!['completed','accepted'].includes(result.state)) throw new Error(result.errors?.join('\n') || '消息已送达，回合需要检查，请先查看记录');
        pending = null;
        retained.pending=null;
        retained.attachments[target]=(retained.attachments[target]??[]).filter(file=>!attachmentIds.includes(file.id));
        if (alive.current && retained.selectedSessionId===target) setEcho(null);
      } catch (e) {
        // Keep the original request identity visible; never silently resubmit it.
        if (alive.current && retained.selectedSessionId===target && retained.requests[target]?.requestId===requestId && !retained.cancelledRequests[requestId]) setError(e.message + '。请查看记录确认是否已送达，避免重复发送。');
      } finally {
        sending = false;
        if(retained.requests[target]?.requestId===requestId&&retained.cancelledRequests[requestId]){
          if(retained.pending?.requestId===requestId)retained.pending=null;
          if(alive.current&&retained.selectedSessionId===target)setEcho(null);
        }
        if(retained.requests[target]?.requestId===requestId)delete retained.requests[target];
        delete retained.cancelledRequests[requestId];
        retained.sending=Object.keys(retained.requests).length>0;
        if (alive.current) await update.current();
      }
    }
    async function stop() {
      const target=selected;if(!target||retained.dispatching[target])return;
      retained.dispatching[target]=true;refreshDispatch(n=>n+1);setError('');
      const previous=retained.requests[target]?.requestId;
      if(previous)retained.cancelledRequests[previous]=true;
      try{await api('cancel',{sessionId:target});await update.current();}
      catch(e){if(previous)delete retained.cancelledRequests[previous];if(alive.current&&retained.selectedSessionId===target)setError(e.message);}
      finally{delete retained.dispatching[target];if(alive.current)refreshDispatch(n=>n+1);}
    }
    const rows = history?.rows ?? [];
    const display=[];
    for(const row of rows) {
      if(row.role==='tool') {
        let group=display.at(-1);
        if(group?.role!=='actions'||group.turn!==row.turn) {group={role:'actions',id:row.id,turn:row.turn,rows:[]};display.push(group);}
        group.rows.push(row);
      } else display.push(row);
    }
    const activeEcho = echo && echo.sessionId===selected && !rows.some(row => row.requestId === echo.requestId);
    const budget = status?.budget;
    const accounting=history?.sessionId===selected?history.accounting:null;
    const daily=accounting?.daily;
    const sessionUsage=accounting?.session;
    const costText=value=>value.cost_lower_nano_cny===value.cost_upper_nano_cny
      ? '¥'+(value.cost_lower_nano_cny/1e9).toFixed(4)
      : '¥'+(value.cost_lower_nano_cny/1e9).toFixed(4)+'–'+(value.cost_upper_nano_cny/1e9).toFixed(4);
    const currentTask=tasks.find(task=>task.sessionId===selected);
    const currentRunning=busy||status?.activeSessionIds?.includes(selected)||history?.running;
    const wakeups=history?.sessionId===selected ? history.wakeups??[] : [];
    const wakeupTime=value=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
    return h('div',{className:'yb-workspace'},
      navigationExpanded?h('aside',{id:'yb-navigation',className:'yb-tasks','aria-label':'人格任务列表'},h('div',{className:'yb-tasks-head'},'对话'),
        h('button',{className:'yb-btn',onClick:()=>setNewTask(!newTask)},'+ 新对话'),
        newTask?h('form',{className:'yb-taskform',onSubmit:createTask},h('input',{'aria-label':'任务名称',placeholder:'任务名称',autoFocus:true,value:taskTitle,onChange:e=>setTaskTitle(e.target.value),maxLength:120}),
          h('button',{className:'yb-btn',type:'submit',disabled:creating},creating?'创建中…':'创建'),h('button',{className:'yb-btn',type:'button',onClick:()=>setNewTask(false)},'取消')):null,
        h('div',{className:'yb-task-list'},tasks.map(task=>h('button',{className:'yb-task'+(task.sessionId===selected?' selected':''),key:task.sessionId,'data-session-id':task.sessionId,onClick:()=>selectTask(task.sessionId),title:task.title,'aria-current':task.sessionId===selected?'page':undefined},task.title))),
        null):null,
      h('section', {className:'yb-root', 'aria-label':'人格正式对话'},
      h('div',{className:'yb-status-switch'},
        h('button',{className:'yb-btn',type:'button',onClick:toggleNavigation,'aria-label':navigationExpanded?'收起侧栏':'展开侧栏','aria-expanded':navigationExpanded,'aria-controls':'yb-navigation'},navigationExpanded?'◧':'☰'),
        h('div',{className:'yb-title'},currentTask?.title||'人格'),
        h('button',{className:'yb-btn',type:'button',onClick:()=>{if(!navigationExpanded)toggleNavigation();setNewTask(true);}},'+ 新对话'),
        connectionError?h('button',{className:'yb-btn yb-warning',type:'button',title:connectionError,onClick:()=>update.current()},'重新连接'):null,
        h('button',{className:'yb-btn',onClick:toggleStatus,'aria-expanded':statusExpanded,'aria-controls':'yb-status-panel',style:{flexShrink:0,borderColor:'#94dab688',background:'#94dab61a',color:'#bce8ce'}},statusExpanded?'▲ 收起状态栏':'▼ 展开状态栏')),
      h('div',{id:'yb-status-panel',style:{display:statusExpanded?'block':'none',flexShrink:0}},
      h('header', {className:'yb-head'}, h('div',null,
        status?.digitalLife?h('div',{className:'yb-sub','data-testid':'persona-digital-life'},
          currentTask?.primary?'意识席位 · 正式发言':'并行活动 · 结果属于建议',
          ' · 待接续 '+status.digitalLife.pendingCount+' 条',h('br'),
          status.digitalLife.settings.residentEnabled
            ? '周期性睁眼 · 下次 '+wakeupTime(status.digitalLife.clock.nextWakeAt)+'（北京时间）'
            : '自主睁眼暂时关闭',
          ' · 心境'+(status.digitalLife.mental.present?'由本人亲写':'为空或已过期')):null,
        h('div',{className:'yb-sub'}, currentTask?.title??'人格的空间', h('br'),
          h('span',{className:status?.ready ? 'yb-good' : 'yb-warning'}, status?.ready ? (currentRunning ? '人格正在执行' : (status.busy?'其他对话正在执行，可继续聊天':'已连接人格')) : (status?.connection?.message ?? '正在连接人格')),
          daily ? ' · 今日已知用量估算 '+costText(daily) : ' · 用量统计暂不可用'),
        daily?h('div',{className:'yb-sub'},
          daily.unknown_requests?'未知用量 '+daily.unknown_requests+' 笔，上限 ¥'+(daily.unknown_upper_nano_cny/1e9).toFixed(4)+'；':'',
          daily.pending_requests?'进行中／待确认 '+daily.pending_requests+' 笔，预留上限 ¥'+(daily.pending_upper_nano_cny/1e9).toFixed(4)+'；':'',
          h('span',{title:'已知用量按请求时段和记录单价估算，未知用量未计入。实际扣款以 DeepSeek 官方账单为准。预算保护另按高峰价与未知上限计算。'},'实际扣款以官方账单为准')):null,
        status?.recovery?h('div',{className:'yb-sub','data-testid':'persona-recovery'},
          '后台恢复人格：'+(({watching:'监测中',recovering:'正在自行修复','starting-recovery':'正在启动','recovery-finished':'本次恢复已结束','cooldown-or-handled':'监测中','recovery-needs-attention':'恢复未完成，证据已保留',maintenance:'维护中',paused:'已暂停','not-started':'尚未启动'})[status.recovery.standby?.phase]??'状态待确认'),
          status.recovery.mode?.mode==='light'?' · 主线处于轻量恢复模式':''):null,
        budget?.daily_limit_enforced===false?h('div',{className:'yb-sub'},'今天按用户授权暂不拦截日上限；保守预留持续记录，明天恢复原上限。'):null,
        status?.recovery?h('details',{className:'yb-tools','data-testid':'persona-diagnostic-log'},
          h('summary',null,'故障日志 · '+(status.recovery.incidents?.length??0)+' 条'),
          h('div',{className:'yb-sub'},'按故障编号保存。不同 Session 分开记录；副本复现不表示主对话又失败。'),
          ...(status.recovery.incidents??[]).map(d=>h('details',{key:d.id,className:'yb-action'},
            h('summary',null,(d.httpStatus?'HTTP '+d.httpStatus+' · ':'')+d.category+' · '+clockTime(Date.parse(d.observedAt))),
            h('pre',null,d.log+'\n本地文件：'+d.localFile)))):null,
        sessionUsage?h('div',{className:'yb-sub','data-session-usage':selected,
          title:'本对话全部已结算请求（含上下文整理）：缓存命中输入 token ÷（缓存命中 + 未命中输入 token），按 token 加权；不含其他对话。'},
          '本对话缓存命中率：'+(sessionUsage.cache_hit_rate===null?'暂无已知输入用量':(sessionUsage.cache_hit_rate*100).toFixed(2)+'%'),
          sessionUsage.input_tokens?'（'+sessionUsage.cache_hit_tokens.toLocaleString()+' / '+sessionUsage.input_tokens.toLocaleString()+' 输入 token）':'',
          ' · 本对话已知费用 '+costText(sessionUsage),
          sessionUsage.cache_coverage_complete?'':' · 仅已知用量，'+sessionUsage.unknown_requests+' 笔未知／'+sessionUsage.pending_requests+' 笔待结算'):null),
        h('div',{style:{display:'flex',gap:8,flexWrap:'wrap'}},
          status?.computer?h('button',{className:'yb-btn','aria-pressed':!status.computer.enabled,
            onClick:async()=>{try{await api('computer',{enabled:!status.computer.enabled});await update.current();}catch(e){setError(e.message);}}},
            status.computer.enabled?'暂停电脑操作':'恢复电脑操作'):null,
          currentRunning?h('button',{className:'yb-btn',disabled:!!retained.dispatching[selected],onClick:stop},'停止当前执行'):null,
          h('button',{className:'yb-btn', onClick:()=>setTools(!tools), 'aria-pressed':tools},tools?'收起执行详情':'展开执行详情'))),
      wakeups.length ? h('div',{className:'yb-wakeup',role:'status',style:{margin:'12px 24px 0',padding:'12px 16px',border:'1px solid #94dab644',borderRadius:10,background:'#94dab60b',lineHeight:1.7}},
        wakeups.map(w=>h('div',{key:w.id},h('strong',null,w.scheduledAt ? '人格设定于 '+wakeupTime(w.scheduledAt)+'（北京时间）唤醒自己' : '人格已设定周期唤醒计划'),
          h('div',{className:'yb-sub'},w.title),w.scheduledAt&&Date.parse(w.scheduledAt)<=Date.now()?h('div',{className:'yb-warning'},'计划时间已到，尚未确认送达'):null)),
        h('div',{className:'yb-sub'},currentRunning?'当前仍在执行；以上是后续唤醒计划。':'当前未执行，等待定时唤醒；你也可以继续发消息。')):null,
      history?.interrupted&&!currentRunning ? h('div',{className:'yb-tip yb-warning',role:'status',style:{padding:'10px 24px'}},'上一轮未正常结束，当前没有继续执行。最后记录：'+wakeupTime(history.lastEventAt)+'。已保存的唤醒计划仍保留。'):null,
      history?.scheduleError?h('div',{className:'yb-tip yb-warning'},history.scheduleError):null),
      statusExpanded?h(ActivityPanel,{history:history?.sessionId===selected?history:null,running:currentRunning,connected:!!status?.ready&&!connectionError,lastConnected,quietSeconds:status?.activityProgress?.quietWarningSeconds??90,primary:currentTask?.primary}):null,
      h('div',{className:'yb-list', ref:list, onScroll:()=>{const el=list.current; nearBottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<120;}},
        history ? [display.length>displayCount ? h('button',{className:'yb-btn yb-earlier',key:'display-limit',type:'button',onClick:()=>setDisplayCount(count=>count+DISPLAY_LIMIT)},'查看更早消息 · '+(display.length-displayCount)+' 条') : null, ...display.slice(-displayCount).map(row=> {
          if(row.role==='thinking')return h(Thinking,{key:selected+':'+row.id,sessionId:selected,turn:row.turn,text:row.text});
          if(row.role==='actions') return h(ActionGroup,{key:row.id,rows:row.rows,expanded:tools,sessionId:selected});
          const date = clockTime(row.time);
          if (['tool','result'].includes(row.role)) return h('details',{className:'yb-tools', key:row.id},h('summary',null, row.text + ' · ' + date + ' · #' + row.seq),h('pre',null,row.detail));
          const label = row.role==='progress'?(currentTask?.primary?'人格的进展说明':'活动的进展说明'):row.role==='assistant'?'人格':row.role==='advice'?'活动结果（建议）':row.role==='user'?'用户':row.role==='schedule'?'定时唤醒':'运行记录';
          return h('article',{className:'yb-message ' + (row.role==='user'?'yb-user':row.role==='progress'?'yb-progress':''), key:row.id, 'data-seq':row.seq,'data-progress-author':row.role==='progress'?'agent':undefined},h('div',{className:'yb-role'},label+' · '+date),
            row.role==='state'?(row.diagnostic?h('details',{className:'yb-tools yb-error'},h('summary',null,row.text.split('\n')[0]+' · 查看详细报错'),h('pre',null,row.text.split('\n').slice(1).join('\n'))):h('div',{className:'yb-error'},row.text)):h('div',{className:'yb-markdown'},h(MarkdownText,{text:row.text,labels})));
        })] : h('p',{className:'yb-sub'},connectionError ? '会话暂时无法载入。'+connectionError : '正在读取她的会话…'),
        history?h(Thinking,{key:selected+':live-thinking:'+history.currentTurn,sessionId:selected,turn:history.currentTurn,livePanel:true,
          text:rows.filter(row=>row.role==='thinking'&&row.turn===history.currentTurn).map(row=>row.text).join('\n\n'),running:!!currentRunning}):null,
        activeEcho ? h('article',{className:'yb-message yb-user'},h('div',{className:'yb-role'},'用户 · 正在送达'),echo.text) : null,
        busy || history?.running ? h('div',{className:'yb-run',role:'status'},h('span',{className:'yb-state-dot running'}),
          rows.some(row=>row.role==='tool'&&row.status==='running')?'工具正在执行，结果会自动出现在这里。':'人格正在处理这条消息…') : null),
      h('footer',{className:'yb-foot'},
        attachments.length||uploading?h('div',{className:'yb-tip','aria-label':'待发送附件'},attachments.map(file=>h('div',{key:file.id,'data-attachment-id':file.id},
          '📎 '+file.name+' · '+(file.size/1024).toFixed(1)+' KB · 已上传',
          /\.(mp3|wav|m4a|ogg|flac|aac|mp4|mov|webm|avi|mkv)$/i.test(file.name)||/^(audio|video)\//.test(file.type)?'（音视频识别暂未接入）':'',
          h('button',{className:'yb-btn',type:'button','aria-label':'移除附件 '+file.name,onClick:()=>{retained.attachments[selected]=attachments.filter(item=>item.id!==file.id);refreshAttachments(n=>n+1);}},'移除'))),
          uploading?h('div',{role:'status'},'正在上传附件…'):null):null,
        h('form',{className:'yb-composer',onSubmit:e=>{e.preventDefault();send();}},
          h('input',{type:'file',multiple:true,ref:picker,style:{display:'none'},onChange:e=>{intake(Array.from(e.target.files));e.target.value='';}}),
          h('button',{className:'yb-btn',type:'button',disabled:!selected||!!uploading,onClick:()=>picker.current.click(),'aria-label':'添加附件'},'附件'),
          h('textarea',{className:'yb-input',rows:2,'aria-label':'给人格的消息',placeholder:'给人格发消息…',title:'Ctrl+V 粘贴图片或文件 · Enter 发送 · Shift+Enter 换行',value:draft,onPaste:paste,onChange:e=>{retained.draft=e.target.value;retained.drafts[selected]=e.target.value;savedDraft=e.target.value;setDraft(e.target.value);},onKeyDown:composerKey}),
          currentRunning?h('button',{className:'yb-btn',type:'button',disabled:!!retained.dispatching[selected]||!status?.ready,onClick:stop},'停止执行'):null,
          h('button',{className:'yb-btn yb-send',type:'submit',disabled:!!retained.dispatching[selected]||!!uploading||!status?.ready||!selected||!!budget?.stop_reason||(!draft.trim()&&!attachments.length)},retained.dispatching[selected]?'正在停止…':currentRunning?(status?.inputCapabilities?.steer?'补充消息':'排队发送'):'发送')),
        error ? h('div',{className:'yb-tip yb-error',role:'alert'},error) : null,
        budget?.stop_reason ? h('div',{className:'yb-tip yb-warning'},'预算保护已停止新调用：'+budget.stop_reason) : null)));
  }
  function Icon({size=18}) {return h('span',{style:{fontSize:size,lineHeight:1},'aria-hidden':true},'☁');}
  function apply(ctx) {
    layoutController=ctx.layout;
    // Install the stylesheet for the plugin lifetime, independently of React remounts.
    ctx.effect(()=>{
      const tag=document.createElement('style');
      tag.dataset.plugin='@local/dsh-desktop-persona';
      tag.dataset.pluginCss='@local/dsh-desktop-persona/layout';
      tag.textContent=css;
      document.head.appendChild(tag);
      return()=>tag.remove();
    });
    ctx.slots.inject('main',()=>{
      const dispose=ctx.slots.register({name:'main',key:panel},Page);
      ctx.layout.selectPanel(panel);
      return dispose;
    });
    ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:panel,order:-10,label:()=> '人格'},Icon));
  }
  return {inject:['slots','layout'],apply};
}});
