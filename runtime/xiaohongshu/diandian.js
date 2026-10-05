const dc = unwrap(initial().conversation?.activeConversation);
const rounds = unwrap(dc?.rounds) || [];
const arr = x => Array.isArray(unwrap(x)) ? unwrap(x) : [];
const answer = r => {
  const ai = unwrap(r.aiMessage) || {};
  const elements=arr(ai.agentElements);
  const markdown=elements.filter(e=>unwrap(e.elementType)==='markdown'||unwrap(e.type)==='markdown');
  const full=markdown.map(e=>{const c=unwrap(e.content);return typeof c==='string'?c:typeof unwrap(c?.content)==='string'?unwrap(c.content):'';}).filter(Boolean).join('\n');
  return full || unwrap(ai.text) || '';
};
const links=[...document.querySelectorAll('.markdown-block u,.markdown-block a')]
  .filter(e=>e.getBoundingClientRect().width>0)
  .map((e,index)=>({index,label:e.textContent.trim(),href:e.tagName==='A'?e.getAttribute('href'):null}));
return {cid:unwrap(dc?.conversationId)||null,title:document.title.replace(/-点点$/,''),
  rounds:rounds.map((r,index)=>({index,question:unwrap(unwrap(r.userMessage)?.text)||'',answer:answer(r),
    complete:!!(unwrap(r.isComplete)||unwrap(unwrap(r.aiMessage)?.isFinished)),timed_out:!!unwrap(unwrap(r.aiMessage)?.isTimeout),
    created_at_ms:unwrap(r.createdAt),element_types:arr(unwrap(r.aiMessage)?.agentElements).map(e=>unwrap(e.elementType)||unwrap(e.type))})),
  history_has_more:!!unwrap(dc?.historyHasMore),links};
