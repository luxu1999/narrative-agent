// 配置与每聊天状态的持久化。存储位置：ctx.extensionSettings["narrative-agent"]。
// 每聊天的状态只有两个字段：tracking（最近一轮状态追踪）与 turn（已完成轮次）。

import { getSTContext, deepMerge } from "./utils.js";
import { DEFAULT_CONFIG, EXTENSION_ID } from "./constants.js";

function extRoot() {
  const ctx = getSTContext();
  if (!ctx) return null;
  if (!ctx.extensionSettings) ctx.extensionSettings = {};
  if (!ctx.extensionSettings[EXTENSION_ID]) ctx.extensionSettings[EXTENSION_ID] = {};
  return ctx.extensionSettings[EXTENSION_ID];
}

function flush() {
  const ctx = getSTContext();
  try {
    if (ctx && typeof ctx.saveSettingsDebounced === "function") ctx.saveSettingsDebounced();
  } catch {
    /* ignore */
  }
}

export function loadConfig() {
  try {
    const root = extRoot();
    const saved = root?.config;
    if (saved && typeof saved === "object") return deepMerge({ ...DEFAULT_CONFIG }, saved);
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config) {
  try {
    const root = extRoot();
    if (!root) return;
    root.config = config;
    root.enabled = config.enabled === true;
    flush();
  } catch {
    /* ignore */
  }
}

export function extractTurnFromText(text) {
  const m = String(text || "").match(/\[\s*第\s*(\d+)\s*轮\s*\]/);
  return m ? parseInt(m[1], 10) : 0;
}

/** 读取某聊天状态；兼容旧版 chatStates[chatId].summaryStore 结构。 */
export function loadChatState(chatId) {
  try {
    const root = extRoot();
    const raw = root?.chatStates?.[chatId];
    if (raw && typeof raw === "object") {
      if (typeof raw.tracking === "string" && raw.tracking.includes("状态追踪")) {
        return { tracking: raw.tracking, turn: Number(raw.turn) || extractTurnFromText(raw.tracking) };
      }
      const legacyEntries = raw.summaryStore?.entries ?? raw.summaryStore?._entries;
      if (Array.isArray(legacyEntries)) {
        for (let i = legacyEntries.length - 1; i >= 0; i--) {
          const entry = legacyEntries[i];
          if (typeof entry === "string" && entry.includes("状态追踪")) {
            return { tracking: entry.trim(), turn: extractTurnFromText(entry) };
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return { tracking: "", turn: 0 };
}

export function saveChatState(chatId, state) {
  try {
    const root = extRoot();
    if (!root) return;
    if (!root.chatStates) root.chatStates = {};
    root.chatStates[chatId] = {
      tracking: typeof state?.tracking === "string" ? state.tracking : "",
      turn: Number(state?.turn) || 0,
    };
    root.enabled = root.config?.enabled === true;
    flush();
  } catch {
    /* ignore */
  }
}

export function deleteChatState(chatId) {
  try {
    const root = extRoot();
    if (root?.chatStates && root.chatStates[chatId]) {
      delete root.chatStates[chatId];
      flush();
    }
  } catch {
    /* ignore */
  }
}

/** 清掉旧版遗留的全局键（gameState / summaryStore），只做一次。 */
export function purgeLegacyGlobals() {
  try {
    const root = extRoot();
    if (!root) return;
    let changed = false;
    for (const key of ["gameState", "summaryStore"]) {
      if (key in root) {
        delete root[key];
        changed = true;
      }
    }
    if (changed) flush();
  } catch {
    /* ignore */
  }
}
