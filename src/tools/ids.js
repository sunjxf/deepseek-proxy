/**
 * ids.js - ID 生成
 *
 * 原样取自 tools.js，供 adapters 生成 tool_use / message ID。
 */

export function newToolUseId() {
  const rand = Math.random().toString(36).slice(2, 12);
  return `toolu_${Date.now().toString(36)}${rand}`;
}

export function newMessageId() {
  const rand = Math.random().toString(36).slice(2, 12);
  return `msg_${Date.now().toString(36)}${rand}`;
}
