import { callLLM } from "./llm.js";
import { parseExtractionOutput, parseMergedOutput } from "./parser.js";
import { EXTRACTION_SYSTEM_SUFFIX, MERGED_ANALYSIS_SYSTEM, SHARED_ANALYSIS_PREFIX } from "./constants.js";

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
  // 4000 在模型带思考（reasoning 计入 token 额度）时可能不够——第二条起要参考完整状态演化，输出+思考更长，
  // 截断会导致 JSON 解析失败 → summary 空（用户反馈「第一条有第二条没有」）；提到 8000 并放宽超时到 240s
  let parsed = parseMergedOutput(await callLLM(messages, { label: "merged-analysis", responseLength: 8000, timeoutMs: 240000 }));

  // 兜底重试：输出为空（JSON 解析失败/模型省略状态条目）时，追加强制指令重试一次
  if (parsed.summary_entries.length === 0) {
    console.warn("[NarrativeAgent] merged-analysis 未输出状态追踪条目，重试一次（强制输出）");
    const retryMessages = [
      { role: "system", content: systemContent },
      { role: "user", content: userContent + "\n\n【重试警告】上一次输出中没有 [第N轮]状态追踪 条目，本次必须输出：\n1. 只输出 JSON\n2. summary_entries 必须包含 1 条完整 [第N轮]状态追踪 条目（无变化就严格复制 <state_tracking> 中的上一状态，首次则初始化完整状态）\n3. 禁止省略、禁止空数组" },
    ];
    parsed = parseMergedOutput(await callLLM(retryMessages, { label: "merged-analysis-retry", responseLength: 8000, timeoutMs: 240000 }));
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