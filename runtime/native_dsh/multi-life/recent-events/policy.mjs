// Behaviour budgets, not a required writing format. Changes take effect at
// the next explicit epoch boundary; never rewrite an existing event block.
export const recentPolicy=Object.freeze({
  segmentEvents:1000,
  targetEvents:100,
  highWaterEvents:150,
  targetChars:160000,
  highWaterChars:240000,
  stageMemoryHardChars:24000,
  stageMemoryWarnChars:20000,
});
export function validateRecentPolicy(value) {
  for(const key of Object.keys(recentPolicy))if(!Number.isSafeInteger(value[key])||value[key]<1)throw Error('RECENT_POLICY_INVALID');
  if(value.targetEvents>=value.highWaterEvents||value.targetChars>=value.highWaterChars||value.stageMemoryWarnChars>=value.stageMemoryHardChars)throw Error('RECENT_POLICY_INVALID');
  return Object.freeze({...value});
}
