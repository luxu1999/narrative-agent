// Prompt 组装：把「预设写作规则 + 世界书 + 角色卡 + 用户 persona + 上一轮状态 + 历史轮次 + 用户输入」
// 拼成「一次调用」的 messages。稳定内容放前面、易变内容放后面，尽量吃到前缀缓存。
//
// 字数 / 文风 / 句式 / 对话驱动等写作规范一律来自预设（preset.js），本文件不做任何风格约定。

import { buildBaseRules, buildOutputFormat, STATE_SPEC } from "./constants.js";

const MIN_BUDGET = 4000;

/** 按 n + m 生长窗口截取最近历史（保持前缀稳定以提高缓存命中）。 */
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
 *
 * 超预算时的裁剪顺序：关键词世界书（从末尾开始）→ 最老的历史轮次 → user 段兜底截断。
 * 之所以必须裁：本插件是「整段替换」ST 的 prompt，替换之后 ST 不会再做 token 预算检查，
 * 不裁就会把超长请求直接丢给 API，表现为「断联」。
 *
 * @returns {{ messages: Array<{role:string,content:string}>, systemChars: number, userChars: number, trimmed: string[] }}
 */
export function buildMessages({
  config,
  turn,
  worldEntries = [],
  presetRules = "",
  characterInfo = "",
  personaText = "",
  prevState = "",
  history = [],
  userInput = "",
}) {
  const budget = Math.max(MIN_BUDGET, Number(config?.maxPromptChars) || 40000);
  const world = Array.isArray(worldEntries) ? worldEntries.slice() : [];
  const hist = Array.isArray(history) ? history.slice() : [];
  const worldTotal = world.length;
  const historyTotal = hist.length;
  const trimmed = [];

  const assemble = () => {
    const systemParts = [buildBaseRules()];
    if (presetRules) systemParts.push("<preset_rules>\n" + presetRules + "\n</preset_rules>");
    if (world.length > 0) systemParts.push("<world>\n" + world.join("\n\n") + "\n</world>");
    if (characterInfo) systemParts.push("<character>\n" + characterInfo + "\n</character>");
    if (personaText) systemParts.push("<user_persona>\n" + personaText + "\n</user_persona>");
    systemParts.push(STATE_SPEC);
    systemParts.push(buildOutputFormat(turn));

    const userParts = [];
    if (prevState) userParts.push("<previous_state>\n" + prevState + "\n</previous_state>");
    const historyText = formatTurns(hist);
    if (historyText) userParts.push("<recent_turns>\n" + historyText + "\n</recent_turns>");
    userParts.push("<user_input>\n" + (userInput || "").trim() + "\n</user_input>");

    return { system: systemParts.join("\n\n"), user: userParts.join("\n\n") };
  };

  let { system, user } = assemble();
  const size = () => system.length + user.length;

  while (size() > budget && world.length > 0) {
    world.pop();
    ({ system, user } = assemble());
  }
  if (world.length < worldTotal) trimmed.push(`世界书裁到 ${world.length}/${worldTotal} 条`);

  while (size() > budget && hist.length > 1) {
    hist.shift();
    ({ system, user } = assemble());
  }
  if (hist.length < historyTotal) trimmed.push(`历史裁到最近 ${hist.length}/${historyTotal} 轮`);

  if (size() > budget) {
    const room = Math.max(0, budget - system.length);
    if (user.length > room) {
      user = user.slice(user.length - room);
      trimmed.push("user 段被硬截断");
    }
  }

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    systemChars: system.length,
    userChars: user.length,
    trimmed,
  };
}
