/**
 * usage.js - token 估算
 *
 * 原样取自 server.js：estimateTokens / makeUsage。
 * 上游网页端 SSE 不提供 token 计数，这里按字符粗估：
 * CJK / 全角符号约 1 字符 1 token，其余（ASCII 等）约 4 字符 1 token。
 */

export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3000 && cp <= 0x303f) ||
      (cp >= 0xff00 && cp <= 0xffef) ||
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0xac00 && cp <= 0xd7af)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return cjk + Math.ceil(other / 4);
}

export function makeUsage(promptText, completionText) {
  const prompt_tokens = estimateTokens(promptText);
  const completion_tokens = estimateTokens(completionText);
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
  };
}
