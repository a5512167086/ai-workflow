/** Only classify CLI failure output, never a successful model response. */
export function usageLimit(error) {
  const message = String(error || '');
  if (!/(?:you['’]ve|you have) (?:hit|reached) your (?:session|usage|weekly) limit|usage limit (?:has been )?(?:reached|exceeded)|(?:insufficient_quota|usage_limit_reached)|exceeded your current quota/i.test(message)) return null;
  const reset = message.match(/\bresets?\s+(?:at\s+)?([^\n|·]+)/i)?.[1]?.trim() || null;
  return { kind: 'usage_limit', reset, original: message };
}

export function explainUsageLimit(provider, limit) {
  return `${provider === 'claude' ? 'Claude Code' : 'Codex'} 用量已達上限${limit.reset ? `；CLI 回報重設時間：${limit.reset}` : ''}。重開 session 不會重設訂閱額度`;
}
