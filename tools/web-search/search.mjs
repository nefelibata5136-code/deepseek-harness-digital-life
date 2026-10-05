#!/usr/bin/env node
// web-search —— 人格的检索工具（稳定版，2026-10-04 建立）
//
// 用法：
//   search.cmd "查询词" [--n=8] [--json] [--src=bing,hn,se]
//   search.cmd --page=<url>            # 只取一页正文，当"打开链接"用
//
// 必须带 --preserve-symlinks-main 起 node（search.cmd 已经带好）。
// 原因：受限令牌下 node 解析入口脚本真实路径时要 lstat the user desktop，
// 会被 EPERM 挡下；这个开关让 node 跳过那步。不要因为报错就以为脚本坏了。
//
// 出口实况（2026-10-04 实测）：bing / hn.algolia / api.stackexchange 通；
// 维基百科、DuckDuckGo、Google 不通。所以不假装有通用搜索：拿到的报结果，拿不到的报失败。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
// User-adjustable policy is loaded on every invocation; no Host restart needed.
import { readFileSync } from 'node:fs';
const policy = JSON.parse(readFileSync(new URL('./policy.json', import.meta.url), 'utf8'));
for (const [key, min, max] of [['timeoutMs', 100, 120000], ['attempts', 1, 3],
  ['retryDelayMs', 0, 10000], ['defaultResults', 1, 20], ['pageChars', 1, 100000]]) {
  if (!Number.isSafeInteger(policy[key]) || policy[key] < min || policy[key] > max)
    throw new Error(`Invalid web-search policy: ${key} must be ${min}..${max}`);
}
const TIMEOUT = policy.timeoutMs;

const flags = new Map();
const words = [];
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z]+)(?:=(.*))?$/.exec(a);
  if (m) flags.set(m[1], m[2] === undefined ? 'true' : m[2]);
  else words.push(a);
}
const query = words.join(' ').trim();
const N = Math.max(1, Math.min(20, parseInt(flags.get('n') || String(policy.defaultResults), 10) || policy.defaultResults));
const asJson = flags.has('json');
const srcs = (flags.get('src') || 'bing,hn,se').split(',').map((s) => s.trim()).filter(Boolean);

function decode(s = '') {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/\s+/g, ' ').trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一次重试：hn/algolia 偶尔 fetch failed，不值得因此丢掉一个后端。
async function attempt(fn, tries = policy.attempts) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i + 1 < tries) await sleep(policy.retryDelayMs);
    }
  }
  throw last;
}

async function getText(url) {
  return attempt(async () => {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    });
    return { status: r.status, text: await r.text() };
  });
}

async function getJson(url) {
  return attempt(async () => {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { 'user-agent': UA, accept: 'application/json' } });
    return { status: r.status, json: await r.json() };
  });
}

async function bing(q, n) {
  const { status, text } = await getText('https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&count=' + n + '&setlang=zh-CN');
  if (status !== 200) return { items: [], note: 'bing HTTP ' + status };
  const out = [];
  const blocks = text.match(/<li class="b_algo"[\s\S]*?(?=<li class="b_algo"|<\/ol>)/g) || [];
  for (const b of blocks) {
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!a) continue;
    const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(b);
    out.push({ src: 'bing', title: decode(a[2]), url: a[1], snippet: p ? decode(p[1]) : '' });
    if (out.length >= n) break;
  }
  return { items: out, note: out.length ? '' : 'bing 返回 ' + text.length + ' 字符但没解析出结果（页面结构可能变了）' };
}

async function hn(q, n) {
  const { status, json } = await getJson('https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(q) + '&hitsPerPage=' + n);
  if (status !== 200) return { items: [], note: 'hn HTTP ' + status };
  const items = (json.hits || [])
    .filter((h) => h.title || h.story_title)
    .map((h) => ({
      src: 'hn',
      title: decode(h.title || h.story_title || '(无标题)'),
      url: h.url || h.story_url || 'https://news.ycombinator.com/item?id=' + h.objectID,
      snippet: decode(h.story_text || '') + ' [' + (h.points ?? 0) + '点 ' + (h.num_comments ?? 0) + '评论 ' + String(h.created_at || '').slice(0, 10) + ']',
    }));
  return { items, note: items.length ? '' : 'hn 没有命中' };
}

async function se(q, n) {
  const { status, json } = await getJson('https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=' + encodeURIComponent(q) + '&site=stackoverflow&pagesize=' + n);
  if (status !== 200) return { items: [], note: 'stackexchange HTTP ' + status };
  const items = (json.items || []).map((i) => ({
    src: 'se',
    title: decode(i.title),
    url: i.link,
    snippet: '[' + (i.is_answered ? '已解决' : '未解决') + ' 分数' + i.score + ' 回答' + i.answer_count + ' 标签:' + (i.tags || []).join(',') + ']',
  }));
  return { items, note: items.length ? '' : 'stackexchange 没有命中' };
}

async function page(url) {
  const { status, text } = await getText(url);
  const full = decode(text);
  const offset = Number(flags.get('offset') || 0);
  const limit = Number(flags.get('limit') || policy.pageChars);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100000)
    throw new Error('page offset must be nonnegative and limit must be 1..100000');
  const end = Math.min(full.length, offset + limit);
  return { status, text: full.slice(offset, end), offset, total_chars: full.length,
    next_offset: end < full.length ? end : null };
}

async function main() {
  if (flags.has('describe')) { console.log(JSON.stringify({ policy, sources: srcs, results: N }, null, 2)); return; }
  if (flags.has('page')) {
    const r = await page(flags.get('page'));
    if (asJson) console.log(JSON.stringify(r));
    else console.log('HTTP ' + r.status + '\n' + r.text + '\n' +
      JSON.stringify({offset:r.offset, total_chars:r.total_chars, next_offset:r.next_offset}));
    return;
  }
  if (!query) {
    console.error('用法: node search.mjs "查询词" [--n=8] [--json] [--src=bing,hn,se]');
    process.exit(2);
  }
  const items = [];
  const problems = [];
  for (const s of srcs) {
    try {
      const r = s === 'bing' ? await bing(query, N) : s === 'hn' ? await hn(query, N) : s === 'se' ? await se(query, N) : { items: [], note: '未知来源: ' + s };
      items.push(...r.items);
      if (r.note) problems.push(r.note);
    } catch (e) {
      problems.push(s + ' 失败: ' + (e && e.message));
    }
  }
  if (asJson) {
    console.log(JSON.stringify({ query, count: items.length, problems, items }, null, 2));
    return;
  }
  console.log('查询: ' + query + '  |  拿到 ' + items.length + ' 条  |  来源 ' + srcs.join(','));
  items.forEach((it, i) => {
    console.log('\n' + (i + 1) + '. [' + it.src + '] ' + it.title);
    console.log('   ' + it.url);
    if (it.snippet) console.log('   ' + it.snippet.slice(0, 400));
  });
  if (problems.length) console.log('\n注意: ' + problems.join(' / '));
}

main().catch((e) => {
  console.error('搜索失败: ' + (e && e.message));
  process.exit(1);
});
