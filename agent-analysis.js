import { callLLM } from "./llm.js";
import { parseExtractionOutput, parseMergedOutput } from "./parser.js";
import { EXTRACTION_SYSTEM_SUFFIX, MERGED_ANALYSIS_SYSTEM, SHARED_ANALYSIS_PREFIX } from "./constants.js";

// 合并分析输出上限：8000 对带思考（reasoning 计入 token 额度）的模型仍不够——
// 第二条起参考完整状态演化，思考+JSON 输出更容易触顶 → 截断 → JSON 解析失败 → summary 空（隔轮消失 bug 根因）。
// 提到 16000（与写作 Agent 同档，约支持 3000+ 字输出 + 充足思考余量），超时保持 240s
const MERGED_ANALYSIS_RESPONSE_LENGTH = 16000;
const MERGED_ANALYSIS_TIMEOUT_MS = 240000;

async function callMergedAnalysis(messages, label) {
  return callLLM(messages, { label, responseLength: MERGED_ANALYSIS_RESPONSE_LENGTH, timeoutMs: MERGED_ANALYSIS_TIMEOUT_MS });
}

// 失败降级：合并分析两次调用都失败（截断/超时/解析失败）时，将「上一状态」严格复制为本轮摘要条目
// （仅归一化轮次编号），保证状态追踪链不断裂——即使本轮状态没推进，也远好于整轮消失触发隔轮交替。
// 无上一状态（首次初始化失败）时返回 null → 调用方返回空数组（此时无可复制，只能放弃本轮）
export function buildStateFallbackEntry(ctx) {
  const prev = ctx && ctx.stateTracking ? String(ctx.stateTracking).trim() : "";
  if (!prev || !prev.includes("状态追踪：") || /（无，首次初始化状态）|（以上一状态为准/.test(prev)) return null;
  let round = null;
  if (ctx.turnId) {
    const n = parseInt(String(ctx.turnId).replace(/^turn_/, ""), 10);
    if (!isNaN(n)) round = n;
  }
  if (round == null) return prev; // 无轮次信息时原样保留（不剥前缀）
  return prev.replace(/^\s*\[第\s*\d+\s*轮\]/, "[第" + round + "轮]");
}

export async function runExtractionAgent(ctx) {
  const systemContent = EXTRACTION_SYSTEM_SUFFIX;
  const userContent = `<narrative_text>\n${ctx.narrativeText}\n</narrative_text>\n\n<existing_state>\n${ctx.stateSummary}\n</existing_state>\n\n\u8bf7\u63d0\u53d6\u4e8b\u4ef6`;

  const messages = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  return parseExtractionOutput(await callLLM(messages, { label: "extraction" }));
}

export async function runMergedAnalysisAgent(ctx) {
  const eventsText = ctx.events
    .map((e) => `- [${e.type}] ${e.summary || "无描述"} ${e.detail ? "(" + e.detail + ")" : ""}`)
    .join("\n");

  let systemContent = MERGED_ANALYSIS_SYSTEM;

  if (ctx.postPipelineToolSuffix) {
    systemContent += "\n\n" + ctx.postPipelineToolSuffix;
  }

  const roundNum = ctx.turnId ? parseInt(String(ctx.turnId).replace(/^turn_/, ""), 10) : null;
  let userContent = roundNum != null ? `【当前轮次：第${roundNum}轮（摘要条目必须使用此编号）】\n\n` : "";
  userContent += `<user_input>\n${ctx.userInput}\n</user_input>\n\n`;
  userContent += `<narrative_output>\n${ctx.narrativeText}\n</narrative_output>\n\n`;
  userContent += `<events_extracted>\n${eventsText}\n</events_extracted>\n\n`;
  userContent += `<state_summary>\n${ctx.stateSummary}\n</state_summary>\n\n`;
  if (ctx.stateTracking && ctx.stateTracking.trim()) {
    userContent += `<state_tracking>\n${ctx.stateTracking}\n</state_tracking>\n\n`;
  } else if (ctx.userInput && ctx.userInput.includes("<current_state>")) {
    // 状态已随 <current_state> 注入 user_input（方案A去重后），以 user_input 中的为准
    userContent += `<state_tracking>（以上一状态为准，见 <user_input> 中的 <current_state>）</state_tracking>\n\n`;
  } else {
    userContent += `<state_tracking>（无，首次初始化状态）</state_tracking>\n\n`;
  }
  if (ctx.changedPatches && ctx.changedPatches.trim()) {
    userContent += `<world_state_changes>\n${ctx.changedPatches}\n</world_state_changes>\n\n`;
  }
  // 硬性要求：状态追踪条目是必选项，禁止省略（提示词层强制）
  userContent += "请输出分析结果。\n【硬性要求】summary_entries 必须包含 1 条 [第N轮]状态追踪 条目（即使状态无变化也要完整复制上一状态输出），禁止省略、禁止输出空数组。";

  const messages = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  // 合并分析输出状态块较长，显式传 responseLength 防被 ST Response Length 截断（同写作 Agent）
  // 8000 在模型带思考（reasoning 计入 token 额度）时可能不够——第二条起参考完整状态演化，输出+思考更长，
  // 截断会导致 JSON 解析失败 → summary 空（用户反馈「第一条有第二条没有」）→ 提到 16000 并放宽超时到 240s
  // 调用与解析均包在 try/catch 中：超时/异常（旧逻辑直接 reject 绕过兜底重试）与解析为空一样走重试；
  // 两次都失败时降级为「上一状态严格复制」，保证状态追踪链不断（隔轮消失/交替 bug 根治）
  let parsed = null;
  let firstErr = null;
  try {
    parsed = parseMergedOutput(await callMergedAnalysis(messages, "merged-analysis"));
  } catch (e) {
    firstErr = e;
    parsed = null;
  }

  if (!parsed || parsed.summary_entries.length === 0) {
    if (firstErr) {
      console.warn("[NarrativeAgent] merged-analysis 调用失败(" + firstErr.message + ") ，重试一次（强制输出）");
    } else {
      console.warn("[NarrativeAgent] merged-analysis 未输出状态追踪条目，重试一次（强制输出）");
    }
    const retryMessages = [
      { role: "system", content: systemContent },
      { role: "user", content: userContent + "\n\n【重试警告】上一次输出中没有 [第N轮]状态追踪 条目，本次必须输出：\n1. 只输出 JSON\n2. summary_entries 必须包含 1 条完整 [第N轮]状态追踪 条目（无变化就严格复制 <state_tracking> 中的上一状态，首次则初始化完整状态）\n3. 简短直接，避免超长思考；记忆点可以省略（系统会自动合并上轮记忆）\n4. 禁止省略、禁止空数组" },
    ];
    try {
      parsed = parseMergedOutput(await callMergedAnalysis(retryMessages, "merged-analysis-retry"));
    } catch (e2) {
      firstErr = e2;
      parsed = null;
    }
  }

  if (!parsed || parsed.summary_entries.length === 0) {
    const fallback = buildStateFallbackEntry(ctx);
    if (fallback) {
      console.warn("[NarrativeAgent] merged-analysis 最终失败" + (firstErr ? "(" + firstErr.message + ")" : "") + "，降级为上一状态严格复制（状态链保持）");
      return { events: [], summary_entries: [fallback] };
    }
    return { events: [], summary_entries: [] };
  }

  return parsed;
}

export async function runMergedAnalysisAntiHallucination(ctx) {
  const eventsText = ctx.events
    .map((e) => `- [${e.type}] ${e.summary || "无描述"} ${e.detail ? "(" + e.detail + ")" : ""}`)
    .join("\n");

  let systemContent = SHARED_ANALYSIS_PREFIX;
  if (ctx.postPipelineToolSuffix) {
    systemContent += "\n\n" + ctx.postPipelineToolSuffix;
  }

  const roundNum = ctx.turnId ? parseInt(String(ctx.turnId).replace(/^turn_/, ""), 10) : null;
  let userContent = roundNum != null ? `【当前轮次：第${roundNum}轮（摘要条目必须使用此编号）】\n\n` : "";
  userContent += `<user_input>\n${ctx.userInput}\n</user_input>\n\n`;
  userContent += `<narrative_text>\n${ctx.narrativeText}\n</narrative_text>\n\n`;
  userContent += `<events_extracted>\n${eventsText}\n</events_extracted>\n\n`;
  userContent += `<state_summary>\n${ctx.stateSummary}\n</state_summary>\n\n`;
  if (ctx.changedPatches && ctx.changedPatches.trim()) {
    userContent += `<world_state_changes>\n${ctx.changedPatches}\n</world_state_changes>\n\n`;
  }
  userContent += "请输出分析结果。";

  const messages = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  return parseMergedOutput(await callLLM(messages, { label: "merged-analysis-anti-hallucination" }));
}