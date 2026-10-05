import { createRequire } from 'node:module';
import { redact } from './protocol.mjs';
import { SlackUiSender } from './slack-ui.mjs';
export const SECRET_REF = 'DL_DOTS_SLACK_TOKEN';
export const USER_SEND_REF = 'DL_DOTS_SLACK_USER_TOKEN';
export class TransportError extends Error {
  constructor(code, { uncertain = false, retryAfter = null } = {}) { super(code); this.code = code; this.uncertain = uncertain; this.retryAfter = retryAfter; }
}
export class SlackTransport {
  constructor(connection, credentials, { fetchImpl, proxy = 'http://127.0.0.1:7897' } = {}) {
    this.kind = 'slack'; this.connection = connection; this.credentials = credentials;
    this.fetchImpl = fetchImpl; this.proxy = proxy; this.secrets = [];
  }
  configured() { return this.connection.team_id && this.connection.channel_id && this.connection.dot_user_id; }
  async token(reference = SECRET_REF) {
    const record = await this.credentials.resolve(reference);
    if (!record?.value) throw new TransportError('SLACK_CREDENTIAL_NOT_CONFIGURED');
    if (!this.secrets.includes(record.value)) this.secrets.push(record.value);
    return record.value;
  }
  safe(value) { return redact(value, this.secrets); }
  async api(method, input = {}, signal, write = false, reference = SECRET_REF) {
    const token = await this.token(reference);
    if (!this.fetchImpl) {
      const require = createRequire(new URL('../../native_dsh/package.json', import.meta.url));
      const http = require('undici'); this.fetchImpl = http.fetch;
      if (this.proxy) this.dispatcher = new http.ProxyAgent(this.proxy);
    }
    let response;
    for(let attempt=0;attempt<(write?1:2);attempt++)try {
      const encoded = new URLSearchParams(Object.entries(input).map(([key,value]) =>
          [key, typeof value === 'object' ? JSON.stringify(value) : String(value)])).toString();
      // GET queries preserve all lookup parameters on the current proxy route.
      response = await this.fetchImpl('https://slack.com/api/' + method + (!write && encoded ? '?' + encoded : ''), { method: write ? 'POST' : 'GET',
        headers: { authorization: 'Bearer ' + token, ...(write ? {'content-type': 'application/x-www-form-urlencoded; charset=utf-8'} : {}) },
        ...(write ? {body: encoded} : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(9000)]) : AbortSignal.timeout(9000),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}), redirect: 'error' });
      if(!write&&response.status>=500&&attempt===0)continue;
      break;
    } catch {
      if(!write&&attempt===0&&!signal?.aborted)continue;
      throw new TransportError(write?'SLACK_NETWORK_OUTCOME_UNKNOWN':'SLACK_NETWORK_READ_FAILED', { uncertain: write });
    }
    if (response.status === 429) throw new TransportError('SLACK_RATE_LIMITED', { retryAfter: Number(response.headers.get('retry-after') ?? 60) });
    if (response.status >= 500) throw new TransportError('SLACK_SERVER_OUTCOME_UNKNOWN', { uncertain: write });
    if (!response.ok) throw new TransportError('SLACK_HTTP_' + response.status);
    // Stream bounded bytes; never allocate an unbounded Slack response.
    const chunks = []; let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length; if (bytes > 2097152) throw new Error(); chunks.push(Buffer.from(chunk));
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data.ok) throw new TransportError('SLACK_' + (/^[a-z_]+$/.test(data.error) ? data.error.toUpperCase() : 'API_REJECTED'));
      return data;
    } catch (error) {
      if (error instanceof TransportError) throw error;
      throw new TransportError('SLACK_INVALID_OR_OVERSIZE_RESPONSE', { uncertain: write });
    }
  }
  async health(signal) {
    if (!this.configured()) return { ready: false, code: 'SLACK_CONNECTION_NOT_CONFIGURED' };
    const auth = await this.api('auth.test', {}, signal);
    if (auth.team_id !== this.connection.team_id) throw new TransportError('SLACK_WORKSPACE_MISMATCH');
    const { channel } = await this.api('conversations.info', { channel: this.connection.channel_id }, signal);
    if (!channel?.is_private || channel.is_shared || channel.is_ext_shared || channel.is_archived || !channel.is_member)
      throw new TransportError('REQUIRES_PRIVATE_UNSHARED_CHANNEL_MEMBERSHIP');
    const members = await this.api('conversations.members', { channel: channel.id, limit: 200 }, signal);
    if (!members.members?.includes(this.connection.dot_user_id)) throw new TransportError('DOT_NOT_IN_CHANNEL');
    const sender = await this.sender(signal);
    if(this.connection.sender_mode==='delegated_ui'){
      const {user}=await this.api('users.info',{user:this.connection.dot_user_id},signal);
      if(![user.name,user.profile?.display_name,user.profile?.real_name].includes(this.connection.ui_dot_label))
        throw new TransportError('SLACK_UI_DOT_LABEL_MISMATCH');
    }
    return { ready: true, team_id: auth.team_id, channel_id: channel.id, channel_name: channel.name,
      sending_available: this.connection.sender_mode!=='delegated_ui'||this.connection.ui_sending_enabled!==false,
      ...(this.connection.sender_mode==='delegated_ui'&&this.connection.ui_sending_enabled===false?{send_blocker:'SLACK_UI_DISABLED_BY_USER'}:{}),
      sender_mode: this.connection.sender_mode ?? 'bot', sender_user_id: sender.user_id,
      sender_bot_id: sender.bot_id ?? null, reader_bot_user_id: auth.user_id,
      bot_trigger: this.connection.bot_trigger_verified === true ? 'previously_verified_requires_live_confirmation' : 'unverified' };
  }
  async sender(signal) {
    if(this.connection.sender_mode==='delegated_ui'){
      const {user}=await this.api('users.info',{user:this.connection.sender_user_id},signal);
      if(!user||user.is_bot||user.deleted||user.id!==this.connection.sender_user_id)
        throw new TransportError('SLACK_DELEGATED_SENDER_MISMATCH');
      return {team_id:this.connection.team_id,user_id:user.id};
    }
    const delegated = ['delegated_user','delegated_ui'].includes(this.connection.sender_mode);
    const auth = await this.api('auth.test', {}, signal, false, delegated ? USER_SEND_REF : SECRET_REF);
    if (auth.team_id !== this.connection.team_id) throw new TransportError('SLACK_WORKSPACE_MISMATCH');
    if (delegated && (!this.connection.sender_user_id || auth.user_id !== this.connection.sender_user_id || auth.bot_id))
      throw new TransportError('SLACK_DELEGATED_SENDER_MISMATCH');
    return auth;
  }
  async send(task, text, signal) {
    if(this.connection.sender_mode==='delegated_ui'&&this.connection.ui_sending_enabled===false)
      throw new TransportError('SLACK_UI_DISABLED_BY_USER');
    const sender = await this.sender(signal);
    if(this.connection.sender_mode==='delegated_ui'){
      let clicked=false;
      try{
        // Sender never calls postMessage; API is only used to verify/read the UI message.
        await (this.uiSender??=new SlackUiSender(this.connection)).send(task,text,signal);clicked=true;
        return await this.uiReceipt(task,sender,signal);
      }catch(error){
        // A UI refusal can occur after clicking but before readback; preserve unknown.
        throw new TransportError(/^[A-Z0-9_]+$/.test(error.message)?error.message:'SLACK_UI_OUTCOME_UNKNOWN',{uncertain:clicked||!/^SLACK_UI_(CONFIGURATION_REQUIRED|EXISTING_DRAFT_PRESERVED|TARGET_OR_OWNER_UNCONFIRMED|DOT_MENTION_AMBIGUOUS|DOT_LABEL_MISMATCH|ADDRESS_UNAVAILABLE|THREAD_UNCONFIRMED)$/.test(error.message)});
      }
    }
    const delegated = this.connection.sender_mode === 'delegated_user';
    const data = await this.api('chat.postMessage', { channel: this.connection.channel_id,
      text: `<@${this.connection.dot_user_id}>\n${delegated ? '【人格经用户授权自动发起；OAuth代表本人发送，非本人手动输入】\n' : ''}${text}`,
      ...(task.thread ? { thread_ts: task.thread } : {}), client_msg_id: task.id.slice(4),
      unfurl_links: false, unfurl_media: false }, signal, true, delegated ? USER_SEND_REF : SECRET_REF);
    if (data.channel !== this.connection.channel_id || !/^\d+\.\d+$/.test(data.ts ?? '')
      || (data.warning === 'message_truncated') || (data.response_metadata?.warnings ?? []).includes('message_truncated'))
      throw new TransportError('SLACK_RECEIPT_UNKNOWN_OR_TRUNCATED', { uncertain: true });
    return { provider: 'slack', channel_id: data.channel, thread: task.thread ?? data.ts, message_ts: data.ts,
      sender_mode: delegated ? 'delegated_user' : 'bot', sender_user_id: sender.user_id,
      message_url: `https://app.slack.com/archives/${data.channel}/p${data.ts.replace('.', '')}` };
  }
  async uiReceipt(task,sender,signal){
    let matches=[];
    for(let i=0;i<4;i++){
      const response=await this.api(task.thread?'conversations.replies':'conversations.history',
        {channel:this.connection.channel_id,...(task.thread?{ts:task.thread}:{}),limit:30},signal);
      matches=(response.messages??[]).filter(m=>m.user===sender.user_id&&!m.bot_id&&m.text?.includes(`[DL_DOTS_REQUEST ${task.id}]`)
        &&m.text.startsWith(`<@${this.connection.dot_user_id}>`));
      if(matches.length)break;
      await new Promise(done=>setTimeout(done,200));
    }
    if(matches.length!==1)throw new Error('SLACK_UI_RECEIPT_UNCONFIRMED');
    const message=matches[0];
    if(task.thread&&message.thread_ts!==task.thread)throw new Error('SLACK_UI_THREAD_RECEIPT_MISMATCH');
    return {provider:'slack',channel_id:this.connection.channel_id,thread:task.thread??message.ts,message_ts:message.ts,
      sender_mode:'delegated_ui',sender_user_id:sender.user_id,message_url:`https://app.slack.com/archives/${this.connection.channel_id}/p${message.ts.replace('.','')}`};
  }
  async poll(task, cursor, signal) {
    return this.api('conversations.replies', { channel: task.receipt.channel_id, ts: task.thread,
      limit: 15, ...(cursor ? { cursor } : {}) }, signal);
  }
  matches(task) {
    return task.receipt?.channel_id === this.connection.channel_id && task.team_id === this.connection.team_id
      && task.dot_user_id === this.connection.dot_user_id
      && (task.receipt.sender_mode ?? 'bot') === (this.connection.sender_mode ?? 'bot')
      && (!['delegated_user','delegated_ui'].includes(this.connection.sender_mode) || task.receipt.sender_user_id === this.connection.sender_user_id);
  }
  accepts(message, task) {
    // Pin BOTH user and bot (when configured); never trust text or an app's display name.
    return message.user === task.dot_user_id && (!task.dot_bot_id || message.bot_id === task.dot_bot_id)
      && message.thread_ts === task.thread && message.ts !== task.receipt.message_ts;
  }
  async close() { this.secrets = []; await this.uiSender?.close?.(); await this.dispatcher?.close(); }
}
