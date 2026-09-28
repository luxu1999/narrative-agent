// Prompt 组装：把世界书条目、角色卡、用户 persona、上一轮状态、历史轮次、用户输入
// 拼成「一次调用」的 messages。稳定内容放前面、易变内容放后面，尽量吃到前缀缓存。

import { buildBaseRules, buildOutputFormat, DIALOGUE_RULE, STATE_SPEC } from "./constants.js";

/** 按 n + m 生长窗口截取最近历史（与原版一致的稳定前缀策略）。 */
export function selectHistory(turns, n, m) {
  const list = Array.isArray(turns) ? turns : [];
  const nn = Math.max(1, Number(n) || 1);
  const mm = Math.max(0, Number(m) || 0);
  const win = [];
  for (const turn of list) {
    win.push(turn);
    if (win.length > nn + mm) win.splice(0, mm + 1);
  }
  return win;
}

/** 历史轮次转文本。正文已在写回时剥离干净，所以这里就是纯叙事。 */
export function formatTurns(turns) {
  const lines = [];
  for (const t of turns || []) {
    const num = Number(t?.turnNum);
    const label = Number.isFinite(num) && num > 0 ? `第${num}轮` : "轮次不详";
    const user = (t?.user || "").trim();
    const assistant = (t?.assistant || "").trim();
    if (user) lines.push(`[${label}] 用户：${user}`);
    if (assistant) lines.push(`[${label}] 叙事：${assistant}`);
  }
  return lines.join("\n\n");
}

/**
 * 构造本次（唯一一次）API 调用的 messages。
 * @returns {{ messages: Array<{role:string,content:string}>, systemChars: number, userChars: number }}
 */
export function buildMessages({
  config,
  turn,
  worldEntries = [],
  characterInfo = "",
  personaText = "",
  prevState = "",
  history = [],
  userInput = "",
}) {
  const systemParts = [buildBaseRules(config)];
  if (config?.dialogueDriven !== false) systemParts.push(DIALOGUE_RULE);
  if (worldEntries.length > 0) systemParts.push("<world>\n" + worldEntries.join("\n\n") + "\n</world>");
  if (characterInfo) systemParts.push("<character>\n" + characterInfo + "\n</character>");
  if (personaText) systemParts.push("<user_persona>\n" + personaText + "\n</user_persona>");
  systemParts.push(STATE_SPEC);
  systemParts.push(buildOutputFormat(turn));

  const userParts = [];
  if (prevState) userParts.push("<previous_state>\n" + prevState + "\n</previous_state>");
  const historyText = formatTurns(history);
  if (historyText) userParts.push("<recent_turns>\n" + historyText + "\n</recent_turns>");
  userParts.push("<user_input>\n" + (userInput || "").trim() + "\n</user_input>");

  const system = systemParts.join("\n\n");
  const user = userParts.join("\n\n");

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    systemChars: system.length,
    userChars: user.length,
  };
}
