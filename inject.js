// 自动注入层：让本扩展在「完全不动预设」的前提下也能跑起来。
//
// 依赖 ST 的 setExtensionPrompt()（getContext() 已暴露），把两段内容塞进 prompt：
//   ① 状态规格   → IN_PROMPT(0)：放进 prompt 收集的末尾（system 区、chat 之前），不碰 chat 尾部
//   ② 上一轮状态 → IN_CHAT(1) + depth≥1：落在最后一条消息之前，保住预设的「末位锚点」
//
// 为什么不用 BEFORE_PROMPT：那会插到 prompt 最开头，顶掉预设的第一条 system
//（许多破甲栈依赖「首条 system 的任务框架」）。IN_PROMPT 不会。
//
// 为什么只写 prompt：破甲栈寄生在「prompt 组装」与「正则清洗」两条管线上。本层不碰
// chat 数组、不碰消息文本，因此与只读原则一致。
//
// 双通道：预设里若已经手工加了同样的条目（判定见下），本层自动跳过对应的一段，
// 避免同一份要求被注入两次。这样「手工适配过的预设」与「没配过的预设」都能正常工作。

import { getSTContext } from "./utils.js";
import { buildStateSpecText } from "./constants.js";

// ST 的枚举没有暴露在 getContext() 上，这里按 script.js 里的数值固定：
//   extension_prompt_types = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 }
//   extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 }
const IN_PROMPT = 0;
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;

export const SPEC_KEY = "na_state_spec";
export const PREV_KEY = "na_prev_state";

// 预设自带条目的识别标记
const SPEC_MARKER = "<state_tracking_spec>";
// 用完整宏写法而不是裸变量名：避免预设里只是「提到过」na_state（比如注释）就被误判成
// 已经注入，从而导致我们跳过注入、状态再也进不了 prompt（静默失效）。
const PREV_MARKER = "getvar::na_state";

function presetContents() {
  try {
    const ctx = getSTContext();
    const prompts = ctx?.chatCompletionSettings?.prompts;
    if (!Array.isArray(prompts)) return [];
    return prompts.map((p) => (p?.content ? String(p.content) : "")).filter(Boolean);
  } catch {
    return [];
  }
}

/** 预设里是否已自带状态规格条目。 */
export function presetHasSpec() {
  try {
    return presetContents().some((t) => t.includes(SPEC_MARKER));
  } catch {
    return false;
  }
}

/** 预设里是否已自带上一轮状态注入（读 na_state 变量）。 */
export function presetHasPrevInjection() {
  try {
    return presetContents().some((t) => t.includes(PREV_MARKER));
  } catch {
    return false;
  }
}

/** 当前生效的注入模式，供设置面板显示。 */
export function injectionMode(config) {
  const specAuto = config?.autoInjectSpec !== false && !presetHasSpec();
  const prevAuto = config?.autoInjectPrev !== false && !presetHasPrevInjection();
  if (specAuto && prevAuto) return "全部由扩展自动注入";
  if (!specAuto && !prevAuto) return "全部由预设提供（扩展不注入）";
  return `规格=${specAuto ? "扩展" : "预设"}｜上一轮状态=${prevAuto ? "扩展" : "预设"}`;
}

/**
 * 写入 / 刷新注入内容。应在每次用户生成之前调用（此时轮次号已确定）。
 *
 * @param {object} engine
 * @param {object} config
 * @param {number} turn 本轮轮次
 * @returns {boolean} 是否写入成功
 */
export function applyInjection(engine, config, turn) {
  const ctx = getSTContext();
  if (!ctx || typeof ctx.setExtensionPrompt !== "function") {
    console.warn("[NarrativeAgent] setExtensionPrompt 不可用，自动注入跳过（需要 ST 1.12+）");
    return false;
  }

  const set = (key, value, position, depth) => {
    try {
      ctx.setExtensionPrompt(key, value || "", position, depth, false, ROLE_SYSTEM);
    } catch (e) {
      console.warn(`[NarrativeAgent] 注入失败（${key}）:`, e?.message);
    }
  };

  const specAuto = config?.autoInjectSpec !== false && !presetHasSpec();
  const prevAuto = config?.autoInjectPrev !== false && !presetHasPrevInjection();
  const depth = Math.max(1, Number(config?.prevInjectDepth) || 1);

  set(SPEC_KEY, specAuto ? buildStateSpecText(turn) : "", IN_PROMPT, 0);

  const prev = (engine?.prevState?.() || "").trim();
  set(PREV_KEY, prevAuto && prev ? `<previous_state>\n${prev}\n</previous_state>` : "", IN_CHAT, depth);

  return true;
}

/**
 * 撤掉本扩展的注入。
 * 用途：扩展被关闭时；以及其它扩展发起的 quiet 生成之前（避免污染它们的 prompt）。
 */
export function clearInjection() {
  const ctx = getSTContext();
  if (!ctx || typeof ctx.setExtensionPrompt !== "function") return;
  try {
    ctx.setExtensionPrompt(SPEC_KEY, "", IN_PROMPT, 0, false, ROLE_SYSTEM);
    ctx.setExtensionPrompt(PREV_KEY, "", IN_CHAT, 1, false, ROLE_SYSTEM);
  } catch {
    /* ignore */
  }
}
