/** Fixed-channel official Slack UI sender; no browser storage or generic UI tool. */
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const sdk='./runtime/native_dsh/node_modules/@trycua/cua-driver/dist/index.js';
const fail=code=>{throw new Error(code);};
// Slack's editor removes horizontal whitespace at line ends during plain paste.
// Preserve every interior character and newline when comparing the full draft.
export const normalizeDraft=text=>text.replace(/\r\n/g,'\n').replace(/[ \t]+(?=\n|$)/g,'');
const canonical=text=>normalizeDraft(text).replace(/\n{2,}/g,'\n').replace(/\n+$/,'');
export function selectSendControl(elements,editor){
  const byId=new Map(elements.map(e=>[e.element_index,e]));
  const descendant=(element,index)=>{for(let cur=element;cur;cur=byId.get(cur.parent_index))if(cur.element_index===index)return true;return false;};
  for(let cur=editor;cur&&cur.role!=='Document';cur=byId.get(cur.parent_index)){
    const controls=elements.filter(e=>e.role==='Button'&&e.label==='现在发送'&&e.enabled&&descendant(e,cur.element_index));
    if(controls.length)return controls.length===1?controls[0]:null;
  }
  return null;
}
export function threadConfirmed(elements,thread){
  const refs=elements.filter(e=>e.role==='Hyperlink'&&e.value?.includes('thread_ts='));
  const ids=refs.map(e=>{try{return new URL(e.value).searchParams.get('thread_ts');}catch{return null;}});
  return ids.length>0&&ids.every(id=>id===thread);
}
export class SlackUiSender {
  constructor(connection,{driver}={}){this.connection=connection;this.driver=driver;this.session='persona-slack-ui-'+randomUUID();this.started=false;}
  async call(name,args={}){
    if(!this.driver){const {CuaDriver}=await import(pathToFileURL(sdk));this.driver=CuaDriver.create(undefined);}
    if(!this.started){
      const start=JSON.parse((await this.driver.callTool('start_session',JSON.stringify({session:this.session}))).rawJson);
      if(start.isError)fail('SLACK_UI_SESSION_UNAVAILABLE');this.started=true;
    }
    const r=JSON.parse((await this.driver.callTool(name,JSON.stringify({...args,session:this.session}))).rawJson);
    if(r.isError){
      if(r.structuredContent?.code==='background_unavailable'){
        return this.call(name,{...args,delivery_mode:'foreground'});
      }
      const reason=r.structuredContent?.code??r.structuredContent?.refusal?.code;
      fail(reason&&/^[a-z_]+$/.test(reason)?'SLACK_UI_'+reason.toUpperCase():'SLACK_UI_OPERATION_REFUSED');
    }
    return r.structuredContent;
  }
  async close(){if(this.started){
    if(this.restoreWindow)await this.call('bring_to_front',{pid:this.restoreWindow.pid,window_id:this.restoreWindow.window_id});
    await this.driver.callTool('end_session',JSON.stringify({session:this.session}));this.started=false;
  }}
  async restoreMinimizedTarget(){
    const {windows}=await this.call('list_windows');const target=windows?.find(w=>w.pid===this.connection.ui_pid&&w.window_id===this.connection.ui_window_id);
    if(!target)fail('SLACK_UI_WINDOW_UNAVAILABLE');
    if(target.minimized){
      // Repeated action-scoped activation of this minimized Chromium surface
      // prevented its renderer from accepting the multi-call operation in live
      // tests. Use the driver's documented persistent-focus exception only here.
      const r=await this.call('bring_to_front',this.target());
      if(!r.landed_on_target)fail('SLACK_UI_WINDOW_RESTORE_UNCONFIRMED');
      const previous=Number(r.previous_fg_hwnd);
      this.restoreWindow=windows.find(w=>w.window_id===previous&&w.window_id!==target.window_id);
    }
  }
  target(){return {pid:this.connection.ui_pid,window_id:this.connection.ui_window_id};}
  async snapshot(){
    const r=await this.call('get_window_state',{...this.target(),include_screenshot:false,max_elements:1800});
    if(!r?.elements||r.elements_complete===false&&r.element_count>=1800)fail('SLACK_UI_SNAPSHOT_INCOMPLETE');
    return r.elements;
  }
  async click(element){if(!element?.enabled)fail('SLACK_UI_CONTROL_UNAVAILABLE');return this.call('click',{...this.target(),element_token:element.element_token});}
  async focusEditor(editor){
    // Current Driver hotkeys can preserve the previously focused Chromium
    // composer despite an element token. UIA SetFocus has an independent exact
    // runtime-ID readback and does not depend on screen/DPI coordinates.
    const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
      fileURLToPath(new URL('./focus-editor.ps1',import.meta.url)),
      '-TargetPid',String(this.connection.ui_pid),'-TargetWindow',String(this.connection.ui_window_id),'-EditorLabel',editor.label],
      {windowsHide:true,encoding:'utf8',timeout:8000,maxBuffer:8192});
    let proof;try{proof=JSON.parse(r.stdout);}catch{fail('SLACK_UI_EDITOR_FOCUS_UNCONFIRMED');}
    if(r.status!==0||!proof.confirmed||proof.editor_label!==editor.label)fail('SLACK_UI_EDITOR_FOCUS_UNCONFIRMED');
  }
  async navigate(thread,signal,rootId){
    const c=this.connection;
    const base=`https://app.slack.com/client/${c.team_id}/${c.channel_id}`;
    // Open a thread through the verified root's actual reply control.
    // Archive permalinks redirect to a workspace host and can stall the client.
    const url=base;
    const before=await this.snapshot();
    const already=before.some(e=>e.role==='Document'&&e.value?.startsWith(base))&&before.some(e=>e.label===`用户：${c.ui_owner_label}`);
    if(!already){
      const address=before.find(e=>e.role==='Edit'&&e.label==='地址和搜索栏');
      if(!address)fail('SLACK_UI_ADDRESS_UNAVAILABLE');
      await this.call('set_value',{...this.target(),element_token:address.element_token,value:url});
      await this.click(address);await this.call('press_key',{...this.target(),key:'enter'});
    }
    for(let i=0;i<48;i++){
      if(signal?.aborted)fail('SLACK_UI_ABORTED');
      await new Promise(done=>setTimeout(done,250));const elements=await this.snapshot();
      const doc=elements.find(e=>e.role==='Document'&&e.value?.startsWith(base));
      const owner=elements.find(e=>e.label===`用户：${c.ui_owner_label}`);
      if(doc&&owner&&thread){
        if(!rootId)fail('SLACK_UI_THREAD_UNCONFIRMED');
        const roots=elements.filter(e=>e.role==='ListItem'&&e.label?.includes(`[DL_DOTS_REQUEST ${rootId}]`));
        const buttons=elements.filter(e=>e.role==='Button'&&/^\d+ 条回复$/.test(e.label??'')&&roots.some(root=>e.parent_index===root.element_index));
        if(buttons.length!==1)fail('SLACK_UI_THREAD_REPLY_CONTROL_UNCONFIRMED');
        const beforeThread=elements.filter(e=>e.role==='Hyperlink'&&e.value?.includes('thread_ts=')).map(e=>e.value);
        const action=await this.click(buttons[0]);let escalated=false;
        for(let j=0;j<24;j++){
          await new Promise(done=>setTimeout(done,250));const opened=await this.snapshot();
          const editors=opened.filter(e=>e.role==='Edit'&&e.label===`回复 ${c.ui_channel_label} 中的消息列`);
          if(editors.length===1&&threadConfirmed(opened,thread))return {elements:opened,editor:editors[0]};
          const afterThread=opened.filter(e=>e.role==='Hyperlink'&&e.value?.includes('thread_ts=')).map(e=>e.value);
          if(!escalated&&j>=2&&action.effect==='unverifiable'&&JSON.stringify(beforeThread)===JSON.stringify(afterThread)){
            // Verified navigation no-op permits retrying this READ/navigation
            // action in foreground under the Driver's input contract. Never
            // apply this ladder to a send click whose outcome is unknown.
            const roots=opened.filter(e=>e.role==='ListItem'&&e.label?.includes(`[DL_DOTS_REQUEST ${rootId}]`));
            const retry=opened.filter(e=>e.role==='Button'&&/^\d+ 条回复$/.test(e.label??'')&&roots.some(root=>e.parent_index===root.element_index));
            if(retry.length!==1)fail('SLACK_UI_THREAD_REPLY_CONTROL_UNCONFIRMED');
            await this.call('click',{...this.target(),element_token:retry[0].element_token,delivery_mode:'foreground'});escalated=true;
          }
        }
        fail('SLACK_UI_THREAD_EDITOR_UNCONFIRMED');
      }
      const label=`发送消息至 ${c.ui_channel_label}`;
      const editors=elements.filter(e=>e.role==='Edit'&&e.label===label);
      if(doc&&owner&&editors.length===1){
        return {elements,editor:editors[0]};
      }
    }
    fail('SLACK_UI_TARGET_OR_OWNER_UNCONFIRMED');
  }
  async send(task,text,signal){
    const c=this.connection;
    if(!Number.isSafeInteger(c.ui_pid)||!Number.isSafeInteger(c.ui_window_id)||!c.ui_dot_label||!c.ui_owner_label||!c.ui_channel_label)
      fail('SLACK_UI_CONFIGURATION_REQUIRED');
    await this.restoreMinimizedTarget();
    // Slack plain-paste collapses empty lines. Canonicalize BEFORE writing,
    // retain the original wire_text in the audit store, and compare all bytes.
    text=canonical(text);
    let {elements,editor}=await this.navigate(task.thread,signal,task.correlation_id);
    if(editor.value?.trim())fail('SLACK_UI_EXISTING_DRAFT_PRESERVED');
    await this.call('clipboard_write',{text:'@'+c.ui_dot_label});
    await this.focusEditor(editor);
    // Bind each paste to the fresh editor handle. A separate background click
    // can be a no-op while Chromium retains focus in the main channel composer.
    await this.call('hotkey',{...this.target(),element_token:editor.element_token,keys:['ctrl','v']});
    let candidates=[];
    for(let i=0;i<10;i++){
      await new Promise(done=>setTimeout(done,150));elements=await this.snapshot();
      candidates=elements.filter(e=>e.role==='ListItem'&&e.label===`${c.ui_dot_label} (应用)`);
      if(candidates.length>1)fail('SLACK_UI_DOT_MENTION_AMBIGUOUS');
      if(candidates.length===1)break;
    }
    if(candidates.length!==1)fail('SLACK_UI_DOT_MENTION_AMBIGUOUS');
    await this.click(candidates[0]);
    elements=await this.snapshot();
    editor=elements.find(e=>e.role==='Edit'&&e.label===(task.thread?`回复 ${c.ui_channel_label} 中的消息列`:`发送消息至 ${c.ui_channel_label}`));
    if(!editor||normalizeDraft(editor.value??'')!==normalizeDraft('@'+c.ui_dot_label+' '))fail('SLACK_UI_DOT_MENTION_UNCONFIRMED');
    if(task.thread&&!threadConfirmed(elements,task.thread))fail('SLACK_UI_THREAD_UNCONFIRMED');
    const body=' 【人格经用户授权自动发起；Slack界面发送，非本人手动输入】\n'+text;
    await this.call('clipboard_write',{text:body});await this.focusEditor(editor);
    await this.call('hotkey',{...this.target(),element_token:editor.element_token,keys:['ctrl','v']});
    for(let i=0;i<6;i++){
      await new Promise(done=>setTimeout(done,100));elements=await this.snapshot();editor=elements.find(e=>e.role==='Edit'&&e.label===(task.thread?`回复 ${c.ui_channel_label} 中的消息列`:`发送消息至 ${c.ui_channel_label}`));
      if(editor?.value&&normalizeDraft(editor.value)===normalizeDraft('@'+c.ui_dot_label+' '+body))break;
    }
    if(!editor?.value||normalizeDraft(editor.value)!==normalizeDraft('@'+c.ui_dot_label+' '+body))fail('SLACK_UI_DRAFT_READBACK_MISMATCH');
    if(task.thread&&!threadConfirmed(elements,task.thread))fail('SLACK_UI_THREAD_UNCONFIRMED');
    const send=selectSendControl(elements,editor);
    if(!send)fail('SLACK_UI_SEND_CONTROL_AMBIGUOUS');
    if(signal?.aborted)fail('SLACK_UI_ABORTED');
    // From this point onward the caller treats every error as unknown, never resend.
    await this.click(send);await this.call('clipboard_write',{text:''});
    return {clicked:true};
  }
  // Maintainer/test recovery only: finish a draft already proven to have failed
  // BEFORE the click. No navigation, typing, paste, or replay of unknown sends.
  async commitVerifiedDraft(task,text,signal){
    await this.restoreMinimizedTarget();
    const c=this.connection,elements=await this.snapshot();
    if(task.thread&&!threadConfirmed(elements,task.thread))fail('SLACK_UI_THREAD_UNCONFIRMED');
    if(!elements.some(e=>e.role==='Document'&&e.value?.startsWith(`https://app.slack.com/client/${c.team_id}/${c.channel_id}`))||!elements.some(e=>e.label===`用户：${c.ui_owner_label}`))fail('SLACK_UI_TARGET_OR_OWNER_UNCONFIRMED');
    const editors=elements.filter(e=>e.role==='Edit'&&e.label===(task.thread?`回复 ${c.ui_channel_label} 中的消息列`:`发送消息至 ${c.ui_channel_label}`));
    const expected='@'+c.ui_dot_label+'  【人格经用户授权自动发起；Slack界面发送，非本人手动输入】\n'+canonical(text);
    if(editors.length!==1||normalizeDraft(editors[0].value??'')!==normalizeDraft(expected))fail('SLACK_UI_DRAFT_READBACK_MISMATCH');
    const send=selectSendControl(elements,editors[0]);if(!send)fail('SLACK_UI_SEND_CONTROL_AMBIGUOUS');
    if(signal?.aborted)fail('SLACK_UI_ABORTED');
    await this.click(send);await this.call('clipboard_write',{text:''});return {clicked:true};
  }
}
