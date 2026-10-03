// 通用工具。只保留当前仍在被引用的函数：
//   truncate               → readers.js / index.js
//   deepMerge              → settings.js
//   getSTContext           → readers.js / index.js / settings.js / worldinfo.js / bridge.js
//   getConversationId      → index.js
//   getLatestUserInput     → bridge.js
//   _isToolEntryContent    → worldinfo.js（过滤 JSON 形式的工具/脚本条目）
//
// 旧多 Agent 架构遗留的函数（extractPresetContext / stripStatePanel / stripMvuTags /
// parseTextToVariables / withTimeout / isApiFailure / _stripFormattingContent /
// _isEntryExcluded / _buildPromptEnabledMap）已在本版删除：
// 预设提取改由 preset.js 负责，输出清洗改由 parse.js 负责，本版也不再自行发起 API 调用。

export function truncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text || "";
  return text.substring(0, maxLen) + "...";
}

export function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export function getSTContext() {
  try { return window.SillyTavern?.getContext() ?? null; } catch { return null; }
}

export function getConversationId() {
  try {
    const ctx = getSTContext();
    return ctx?.chatId || ctx?.characterId || "default";
  } catch {
    return "default";
  }
}

export function getLatestUserInput(chat) {
  if (!chat || !Array.isArray(chat) || chat.length === 0) return "";
  for (let i = chat.length - 1; i >= 0; i--) {
    const msg = chat[i];
    if (!msg) continue;
    const isUser = msg.is_user === true || msg.role === "user";
    const text = msg.mes || msg.content;
    if (isUser && text) return text;
  }
  return "";
}

/** 判断世界书条目是不是 JSON 形式的工具/脚本条目（{"type":"llm"|"code", function:{name:…}}）。 */
export function _isToolEntryContent(content) {
  if (!content || typeof content !== "string") return false;
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const validTypes = ["llm", "code"];
    return validTypes.includes(parsed.type)
      && parsed.function
      && typeof parsed.function === "object"
      && typeof parsed.function.name === "string";
  } catch {
    return false;
  }
}
