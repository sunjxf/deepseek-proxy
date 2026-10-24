/**
 * tools/index.js - tools 层聚合入口
 *
 * 对外保持与原 tools.js 相同的导出面，上层只需把 `./tools.js` 改成
 * `./tools/index.js`，不必关心内部拆分。
 */

export {
  buildPromptFromMessages,
  extractSystemText,
  formatToolsInstruction,
  extractImagesFromMessages,
} from './prompt.js';

export { ToolCallBuffer } from './buffer.js';

export { newMessageId, newToolUseId } from './ids.js';

export { setToolLogger } from './log.js';

// 便于测试/调试的底层能力，原 tools.js 未导出，这里保持不导出以维持 API 面一致
// export { parseToolCallsJson, parseDsmlCalls, balanceBrackets, coerceDsmlValue } from './parse.js';
// export {
//   TOOL_CALL_START,
//   TOOL_CALL_END,
//   sanitizeText,
//   stripToolCallResidue,
// } from './residue.js';
