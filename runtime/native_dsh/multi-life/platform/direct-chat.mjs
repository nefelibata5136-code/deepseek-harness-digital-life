// A temporary human-facing view of one durable Room. Native Sessions stay private
// to the Host. Opening this page only reads; the Host chooses inbox processing.
const scriptJSON = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,
  character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));

export function renderDirectChat({token, roomId, lifeId, displayName, readOnly = false, peerUrl}) {
  if (typeof token !== 'string' || token.length < 32 ||
      typeof roomId !== 'string' || !roomId || typeof lifeId !== 'string' || !lifeId ||
      displayName !== undefined && typeof displayName !== 'string' || typeof readOnly !== 'boolean' ||
      peerUrl !== undefined && peerUrl !== null && !['/peer-chat', '/chat'].includes(peerUrl)) {
    throw new Error('DIRECT_CHAT_BINDING_REQUIRED');
  }
  const config = scriptJSON({token, roomId, lifeId, displayName: displayName || '未命名主体', readOnly});
  const navigation = readOnly ? '<a id="peer-link" href="/chat">返回私聊</a>' :
    peerUrl ? '<a id="peer-link" href="' + peerUrl + '">查看双方聊天</a>' : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>数字生命私聊</title>
<style>
:root{color-scheme:light;font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#263242;background:#f4f6fa}
*{box-sizing:border-box}body{margin:0}button,textarea{font:inherit}button{cursor:pointer;border:1px solid #ccd5e1;border-radius:9px;background:white;color:inherit;padding:9px 14px}button:disabled{cursor:wait;opacity:.6}
.chat{width:min(900px,100%);height:100dvh;margin:auto;display:flex;flex-direction:column;background:#fff;border-inline:1px solid #e2e7ef}
.top{padding:20px 24px 14px;border-bottom:1px solid #e2e7ef;display:flex;align-items:center;gap:18px}.heading{min-width:0;flex:1}h1{font-size:21px;margin:0 0 7px;overflow-wrap:anywhere}.state{font-size:13px;color:#536278;display:flex;gap:8px;align-items:center}.dot{width:8px;height:8px;border-radius:50%;background:#96a4b6;flex:none}.dot[data-busy="true"]{background:#be832a}.dot[data-busy="false"]{background:#3c896b}
.navigation{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end;flex:none}.navigation a{font-size:13px;color:#315f90;text-decoration:none}.navigation a:hover{text-decoration:underline}.view-mode{font-size:13px;color:#718095;margin:0 0 8px}
.billing{display:block;font-size:12px;line-height:1.6;color:#536278;margin-top:5px;overflow-wrap:anywhere}.billing[data-stale="true"]{color:#856a41}
.activity{padding:12px 24px;border-bottom:1px solid #e2e7ef;background:#f8fafc}.activity-text{font-size:14px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;max-height:88px;overflow:auto}.activity-meta{display:flex;gap:7px 14px;flex-wrap:wrap;font-size:12px;line-height:1.5;color:#718095;margin-top:5px}.activity-meta:empty{display:none}
.history{flex:1;overflow:auto;padding:22px 24px;min-height:0}.empty{color:#66768b;text-align:center;margin:40px 0;font-size:14px}.message{margin-bottom:20px;max-width:100%;border-left:3px solid #d6dfe9;padding-left:13px}.message[data-sender-type="life"]{border-color:#567fa8}.author{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px}.name{font-weight:600;font-size:14px;overflow-wrap:anywhere}.kind,.time{font-size:12px;color:#718095}.body{white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px;line-height:1.65}
.composer{padding:14px 24px 20px;border-top:1px solid #e2e7ef}.notice{font-size:13px;min-height:22px;color:#54647b;line-height:1.55;margin:0 0 9px}.notice[data-error="true"]{color:#a54135}.input-row{display:flex;gap:10px;align-items:flex-end}textarea{width:100%;resize:vertical;min-height:64px;max-height:200px;padding:10px 12px;border:1px solid #cbd5e2;border-radius:10px;line-height:1.5;color:inherit;background:#fff}textarea:focus{outline:2px solid #b6cce5;outline-offset:1px}.send{background:#315f90;color:white;border-color:#315f90;flex:none;min-height:42px}.hint{font-size:12px;color:#748197;margin-top:8px}
@media(max-width:600px){.chat{border:0}.top{padding:16px}.navigation{flex-direction:column;align-items:flex-end;gap:8px}.activity{padding:10px 16px}.history{padding:18px 16px}.composer{padding:12px 16px 16px}h1{font-size:19px}.top button{padding:8px 11px}.input-row{gap:8px}.send{padding:10px 13px}.body{font-size:15px}}
</style>
</head>
<body>
<main class="chat">
  <header class="top"><div class="heading"><h1 id="title">数字生命私聊</h1>${readOnly ? '<p class="view-mode">只读旁观</p>' : ''}<div class="state" role="status"><span class="dot" id="busy-dot"></span><span id="busy">正在读取状态…</span></div>${readOnly ? '' : '<span id="billing" class="billing" role="status" tabindex="0">今日花费 -- · 官方账单暂不可用</span>'}</div><nav class="navigation" aria-label="聊天页面">${navigation}<button id="refresh" type="button">刷新</button></nav></header>
  <section class="activity" id="activity" hidden aria-label="公开活动" aria-live="polite"><div class="activity-text" id="activity-text"></div><div class="activity-meta"><span id="activity-source"></span><span id="activity-phase"></span><span id="activity-tool" hidden></span><time id="activity-time" hidden></time></div></section>
  <section class="history" id="history" aria-label="聊天消息"><p class="empty" id="empty">正在读取消息…</p><div id="messages" role="log" aria-live="polite" aria-relevant="additions"></div></section>
  ${readOnly ? '' : '<form class="composer" id="composer"><p class="notice" id="notice" role="status">消息会进入对方收件箱；对方可以回复、延后或忽略。</p><div class="input-row"><textarea id="input" rows="2" aria-label="发送消息" placeholder="写一条消息…"></textarea><button class="send" id="send" type="submit">发送</button></div><div class="hint">Enter 换行 · Ctrl / ⌘ + Enter 发送</div></form>'}
</main>
<script>
'use strict';
(() => {
  const config = ${config};
  const element = id => document.getElementById(id);
  const history = element('history');
  const roomPath = '/v1/rooms/' + encodeURIComponent(config.roomId) + '/messages';
  const seen = new Set();
  let after = 0, loading = null, canSend = !config.readOnly;
  element('title').textContent = config.readOnly ? '人格与新生命的聊天记录' : '与 ' + config.displayName + ' 的私聊';
  async function request(path, body) {
    if (body !== undefined && !canSend) throw new Error('READ_ONLY_ROOM');
    const response = await fetch(path, {method: body === undefined ? 'GET' : 'POST',
      headers: {authorization: 'Bearer ' + config.token, 'content-type': 'application/json'},
      cache: 'no-store', credentials: 'omit', redirect: 'error',
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    if (!response.ok) throw new Error('REQUEST_FAILED');
    return response.json();
  }
  function showMessage(message) {
    const id = message.message_id ?? message.messageId;
    if (typeof id !== 'string' || typeof message.body !== 'string') throw new Error('INVALID_MESSAGE');
    if (seen.has(id)) return;
    const sender = message.sender ?? message;
    const type = sender.sender_type;
    const article = document.createElement('article');
    article.className = 'message';
    article.dataset.senderType = type === 'human' || type === 'life' ? type : 'unknown';
    article.dataset.senderId = typeof sender.sender_id === 'string' ? sender.sender_id : '';
    const author = document.createElement('div'); author.className = 'author';
    const name = document.createElement('span'); name.className = 'name';
    name.textContent = typeof sender.display_name === 'string' && sender.display_name.trim() ? sender.display_name :
      type === 'life' ? '未命名数字生命' : type === 'human' ? '未命名人类' : '未知发送者';
    const kind = document.createElement('span'); kind.className = 'kind';
    kind.textContent = type === 'human' ? '人类' : type === 'life' ? '数字生命' : '身份未确认';
    author.append(name, kind);
    const timestamp = message.timestamp;
    if (typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp))) {
      const time = document.createElement('time'); time.className = 'time'; time.dateTime = timestamp;
      time.textContent = new Date(timestamp).toLocaleString('zh-CN'); author.append(time);
    }
    const body = document.createElement('div'); body.className = 'body'; body.textContent = message.body;
    article.append(author, body); element('messages').append(article); seen.add(id);
  }
  async function readMessages() {
    const nearBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 100 || seen.size === 0;
    let more;
    do {
      const page = await request(roomPath + '?after=' + after + '&limit=50');
      if (!Array.isArray(page.messages) || !Number.isSafeInteger(page.nextAfter) || page.nextAfter < after ||
          page.hasMore && page.nextAfter <= after) throw new Error('INVALID_PAGE');
      if (page.room?.access?.can_send === false) {
        canSend = false; element('composer')?.remove();
      }
      for (const message of page.messages) showMessage(message);
      after = page.nextAfter; more = page.hasMore === true;
    } while (more);
    element('empty').hidden = seen.size > 0;
    if (!seen.size) element('empty').textContent = config.readOnly ? '还没有双方聊天记录。' : '还没有消息。可以从你想说的事情开始。';
    if (nearBottom) history.scrollTop = history.scrollHeight;
  }
  function clearActivity() {
    element('activity').hidden = true;
    for (const id of ['activity-text', 'activity-source', 'activity-phase', 'activity-tool', 'activity-time'])
      element(id).textContent = '';
    element('activity-tool').hidden = true; element('activity-time').hidden = true;
    element('activity-time').removeAttribute('datetime');
  }
  function showActivity(status) {
    clearActivity();
    // Treat either privacy flag as sufficient. Never retain a previous public
    // tool or summary while a newer observation reports private activity.
    const privateActivity = status.phase === 'private' || status.visibility === 'private';
    const phaseText = {idle: '目前空闲', thinking: '正在思考', tool: '使用公共工具'};
    const validTime = typeof status.updated_at === 'string' && Number.isFinite(Date.parse(status.updated_at));
    const metadata = Object.hasOwn(phaseText, status.phase) && status.visibility === 'public' &&
      ['self', 'host'].includes(status.summary_source) &&
      (status.activity_text === null || typeof status.activity_text === 'string') &&
      (status.last_public_tool === null || typeof status.last_public_tool === 'string') &&
      (status.updated_at === null || validTime);
    if (!privateActivity && !metadata) return;
    element('activity').hidden = false;
    if (privateActivity) {
      element('activity-text').textContent = '私人活动';
      element('activity-source').textContent = '运行状态';
    } else {
      const selfSummary = status.summary_source === 'self' && typeof status.activity_text === 'string' && status.activity_text.trim();
      element('activity-text').textContent = selfSummary ? status.activity_text : phaseText[status.phase];
      element('activity-source').textContent = selfSummary ? '本人公开说明' : '运行状态';
      if (selfSummary) element('activity-phase').textContent = phaseText[status.phase];
      if (typeof status.last_public_tool === 'string' && /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/.test(status.last_public_tool) &&
          !/^private_/i.test(status.last_public_tool)) {
        element('activity-tool').hidden = false;
        element('activity-tool').textContent = '最近公共工具：' + status.last_public_tool;
      }
    }
    if (validTime) {
      const time = element('activity-time'); time.hidden = false; time.dateTime = status.updated_at;
      time.textContent = '更新于 ' + new Date(status.updated_at).toLocaleString('zh-CN');
    }
  }
  async function readStatus() {
    try {
      const status = await request('/v1/status?life_id=' + encodeURIComponent(config.lifeId));
      if (typeof status.busy !== 'boolean') throw new Error('INVALID_STATUS');
      element('busy').textContent = status.busy ? config.readOnly ? '正在活动' : '正在活动 · 新消息会等待处理' : '目前空闲';
      element('busy-dot').dataset.busy = String(status.busy);
      showActivity(status);
      showBilling(status.billing);
    } catch {
      clearActivity();
      element('busy').textContent = '暂时无法读取状态'; delete element('busy-dot').dataset.busy;
      showBilling(lastBilling, true);
    }
  }
  let lastBilling = null;
  function showBilling(billing, failed = false) {
    const target = element('billing'); if (!target || config.readOnly) return;
    if (!failed) lastBilling = billing;
    const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const raw = billing?.today_cost_cny;
    const available = billing?.source === 'deepseek_platform' && billing.date === today && typeof raw === 'string' && /^\\d+(\\.\\d+)?$/.test(raw);
    const stale = failed || billing?.stale === true;
    let amount = null;
    if (available) {const [whole, fraction = ''] = raw.split('.'); const digits = whole === '0' && fraction.startsWith('00') ? 6 : 2; amount = whole + '.' + fraction.padEnd(digits, '0').slice(0, digits);}
    target.textContent = amount === null ? '今日花费 -- · 官方账单暂不可用' : '今日花费 ¥' + amount + (stale ? ' · 数据过期' : '');
    target.dataset.stale = String(stale);
    const validTime = billing?.updated_at && Number.isFinite(Date.parse(billing.updated_at));
    target.title = '官方账单 · 更新于 ' + (validTime ? new Date(billing.updated_at).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai',hour12:false}) : '尚未取得') + '（北京时间）' + (available ? ' · 精确金额 ¥' + raw : '') + (stale ? ' · 数据已过期' : '') + ' · 每 5 分钟后台刷新，官方入账可能延迟';
  }
  function refresh() {
    if (loading) return loading;
    element('refresh').disabled = true;
    loading = Promise.all([readStatus(), readMessages().catch(() => {
      if (!seen.size) element('empty').textContent = '暂时无法读取消息，请刷新重试。';
    })]).finally(() => {loading = null; element('refresh').disabled = false;});
    return loading;
  }
  element('refresh').addEventListener('click', refresh);
  ${readOnly ? '' : `const input = element('input'), send = element('send');
  let pendingSend = null;
  function notice(text, error = false) {
    const target = element('notice'); if (!target) return;
    target.textContent = text;
    target.dataset.error = String(error);
  }
  element('composer').addEventListener('submit', async event => {
    event.preventDefault(); if (!canSend || send.disabled || !input.value.trim()) return;
    const body = input.value;
    if (!pendingSend || pendingSend.body !== body) pendingSend = {body, message_id: crypto.randomUUID()};
    const attempt = pendingSend; send.disabled = true; input.disabled = true; notice('正在保存消息…');
    try {
      const result = await request(roomPath, attempt);
      if (result.state !== 'saved' || (result.message?.message_id ?? result.message?.messageId) !== attempt.message_id)
        throw new Error('SAVE_NOT_CONFIRMED');
      input.value = ''; pendingSend = null; notice('已进入收件箱');
      await refresh();
    } catch {
      notice('发送结果尚未确认，请先刷新。重试相同内容会沿用同一条消息。', true);
    } finally {send.disabled = false; input.disabled = false; input.focus();}
  });
  input.addEventListener('keydown', event => {
    if (canSend && event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault(); element('composer').requestSubmit();
    }
  });
  `}
  refresh();
  const timer = setInterval(refresh, 2000);
  addEventListener('pagehide', () => clearInterval(timer), {once: true});
})();
</script>
</body>
</html>`;
}
