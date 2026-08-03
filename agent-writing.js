import { callLLM } from "./llm.js";
import { WRITING_SYSTEM_SUFFIX, MERGED_WRITING_SYSTEM_SUFFIX } from "./constants.js";
import { extractCharRange } from "./utils.js";

// 解析本轮有效正文字数区间，优先级：本轮用户输入 > 预设（system+user）> 面板默认值
// 返回 { min, max } 或 null（null = 不限制）
export function resolveCharRange(ctx) {
  if (ctx.userInput) {
    const r = extractCharRange(ctx.userInput);
    if (r) return r;
  }
  const presetText = [ctx.writingSystemPreset, ctx.writingUserPreset, ctx.presetContext]
    .filter(v => typeof v === "string" && v.length > 0)
    .join("\n");
  if (presetText) {
    const r = extractCharRange(presetText);
    if (r) return r;
  }
  const min = Number(ctx.minReplyChars);
  const max = Number(ctx.maxReplyChars);
  if (min > 0 || max > 0) return { min: min > 0 ? min : 0, max: max > 0 ? max : 0 };
  return null;
}

function appendCharRangeConstraint(systemContent, ctx) {
  const r = resolveCharRange(ctx);
  if (!r) return systemContent;
  let text;
  if (r.min > 0 && r.max > 0) text = `\u63a7\u5236\u5728 ${r.min}~${r.max} \u5b57\u4e4b\u95f4`;
  else if (r.min > 0) text = `\u4e0d\u5c11\u4e8e ${r.min} \u5b57`;
  else text = `\u4e0d\u8d85\u8fc7 ${r.max} \u5b57`;
  systemContent += `\n- \u56de\u590d\u6b63\u6587\u5b57\u6570\u9650\u5236\uff1a\u672c\u6b21\u56de\u590d\u6b63\u6587\uff08\u72b6\u6001\u8ffd\u8e2a\u5757\u4e0d\u8ba1\u5165\uff09\u5fc5\u987b\u4e25\u683c${text}\uff0c\u4e0d\u5f97\u8d85\u51fa\u8be5\u8303\u56f4`;
  return systemContent;
}

export async function runWritingAgent(ctx) {
  const guide = ctx.writingGuide;
  const hasToolResults = ctx.toolResultsText && ctx.toolResultsText.length > 0;

  let systemContent = "";

  if (ctx.writingSystemPreset) {
    systemContent += ctx.writingSystemPreset;
  }

  if (ctx.systemEntries && ctx.systemEntries.length > 0) {
    if (systemContent) systemContent += "\n\n";
    systemContent += "<worldinfo1>\n" + ctx.systemEntries.join("\n\n") + "\n</worldinfo1>";
  }

  if (systemContent) systemContent += "\n\n";
  systemContent += WRITING_SYSTEM_SUFFIX;

  if (hasToolResults) {
    systemContent += "\n- \u5de5\u5177\u6267\u884c\u7ed3\u679c\u5df2\u7531\u7cfb\u7edf\u786e\u5b9a\uff0c\u5fc5\u987b\u4e25\u683c\u6309\u7167\u7ed3\u679c\u4e2d\u7684\u8d70\u5411\u6765\u5199\u4f5c\uff0c\u4e0d\u5f97\u81ea\u884c\u6539\u53d8\u5de5\u5177\u6267\u884c\u7ed3\u679c";
  }

  systemContent = appendCharRangeConstraint(systemContent, ctx);

  const formatTurn = (t) => {
    if (!t.user) {
      return `[\u8f6e${t.turnNum}] AI: ${t.assistant}`;
    }
    return `[\u8f6e${t.turnNum}] \u7528\u6237: ${t.user}\n[\u8f6e${t.turnNum}] AI: ${t.assistant}`;
  };
  const recentText = ctx.recentNarratives.map(formatTurn).join("\n\n");

  let userContent = "";

  if (ctx.writingUserPreset) {
    userContent += "<user_preset>\n" + ctx.writingUserPreset + "\n</user_preset>";
  }

  if (ctx.beforeCharEntries && ctx.beforeCharEntries.length > 0) {
    if (userContent) userContent += "\n\n";
    userContent += "<worldinfo2>\n" + ctx.beforeCharEntries.join("\n\n") + "\n</worldinfo2>";
  }

  if (ctx.userPersona) {
    if (userContent) userContent += "\n\n";
    userContent += `<user_persona>\n${ctx.userPersona}\n</user_persona>`;
  }

  if (userContent) userContent += "\n\n";
  userContent += `<recent_turns>\n${recentText}\n</recent_turns>`;

    if (ctx.selectiveEntries && ctx.selectiveEntries.length > 0) {
    userContent += "\n\n<worldinfo3>\n" + ctx.selectiveEntries.join("\n\n") + "\n</worldinfo3>";
  }

  if (ctx.textRecall) {
    userContent += "\n\n<text_recall>\n" + ctx.textRecall + "\n</text_recall>";
  }

  let guideBlock = "<writing_guide>\n\u53d9\u4e8b\u65b9\u5411\uff1a" + (guide.narrative_direction || "\uff08\u65e0\u7279\u5b9a\u65b9\u5411\uff0c\u5ef6\u7eed\u5f53\u524d\u53d9\u4e8b\uff09");
  if (guide.scene_setting) {
    guideBlock += "\n\u573a\u666f\u8bbe\u7f6e\uff1a" + guide.scene_setting;
  }
  guideBlock += "\n\u8981\u70b9\uff1a" + (guide.key_points.length > 0 ? guide.key_points.join("\uff1b") : "\u65e0\u7279\u5b9a\u8981\u70b9");
  guideBlock += "\n\u57fa\u8c03\uff1a" + guide.tone + "\uff0c\u8282\u594f\uff1a" + guide.pacing;
  guideBlock += "\n\u5ef6\u7eed\u7ec6\u8282\uff1a" + (guide.continuity_notes.length > 0 ? guide.continuity_notes.join("\uff1b") : "\u65e0");
  guideBlock += "\n</writing_guide>";
  userContent += "\n\n" + guideBlock;

  if (hasToolResults) {
    userContent += "\n\n" + ctx.toolResultsText;
  }

  userContent += `\n\n<user_input>\n${ctx.userInput}\n</user_input>`;

  const messages = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  const raw = await callLLM(messages, { label: "writing" });
  return raw.trim();
}

export async function runMergedWritingAgent(ctx) {
  let systemContent = "";

  if (ctx.presetContext) {
    systemContent += ctx.presetContext;
  }

  if (ctx.systemEntries && ctx.systemEntries.length > 0) {
    if (systemContent) systemContent += "\n\n";
    systemContent += "<worldinfo1>\n" + ctx.systemEntries.join("\n\n") + "\n</worldinfo1>";
  }

  if (systemContent) systemContent += "\n\n";
  systemContent += MERGED_WRITING_SYSTEM_SUFFIX;

  systemContent = appendCharRangeConstraint(systemContent, ctx);

  const formatTurn = (t) => {
    if (!t.user) {
      return `[\u8f6e${t.turnNum}] AI: ${t.assistant}`;
    }
    return `[\u8f6e${t.turnNum}] \u7528\u6237: ${t.user}\n[\u8f6e${t.turnNum}] AI: ${t.assistant}`;
  };
  const recentText = ctx.recentTurns.map(formatTurn).join("\n\n");

  let userContent = "";

  if (ctx.writingUserPreset) {
    userContent += "<user_preset>\n" + ctx.writingUserPreset + "\n</user_preset>";
  }

  if (ctx.beforeCharEntries && ctx.beforeCharEntries.length > 0) {
    if (userContent) userContent += "\n\n";
    userContent += "<worldinfo2>\n" + ctx.beforeCharEntries.join("\n\n") + "\n</worldinfo2>";
  }

  if (ctx.userPersona) {
    if (userContent) userContent += "\n\n";
    userContent += `<user_persona>\n${ctx.userPersona}\n</user_persona>`;
  }

  if (userContent) userContent += "\n\n";
  userContent += `<story_summary>\n<!-- 以下为故事摘要（仅供理解剧情，严禁在回复中输出或复述）：\n${ctx.storySummaries}\n-->\n</story_summary>`;

  userContent += `\n\n<recent_turns>\n${recentText}\n</recent_turns>`;

  if (ctx.selectiveEntries && ctx.selectiveEntries.length > 0) {
    userContent += "\n\n<worldinfo3>\n" + ctx.selectiveEntries.join("\n\n") + "\n</worldinfo3>";
  }

  if (ctx.textRecall) {
    userContent += "\n\n<text_recall>\n" + ctx.textRecall + "\n</text_recall>";
  }

  userContent += `\n\n<state_summary>\n${ctx.stateSummary}\n</state_summary>`;

  userContent += `\n\n<user_input>\n${ctx.userInput}\n</user_input>`;

  userContent += `\n\n\u3010\u601d\u7ef4\u6a21\u5f0f\u8981\u6c42\u3011\u5728\u4f60\u7684\u601d\u8003\u8fc7\u7a0b\uff08 thinking\u6807\u7b7e\u5185\uff09\u4e2d\uff0c\u8bf7\u9075\u5b88\u4ee5\u4e0b\u89c4\u5219\uff1a\n1. \u7981\u6b62\u4f7f\u7528\u5706\u62ec\u53f7\u5305\u88f9\u5185\u5fc3\u72ec\u767d\uff0c\u4f8b\u5982\u201c\uff08\u5fc3\u60f3\uff1a\u2026\u2026\uff09\u201d\u6216"(\u5185\u5fc3OS\uff1a\u2026\u2026)"\uff0c\u6240\u6709\u5206\u6790\u5185\u5bb9\u76f4\u63a5\u9648\u8ff0\u5373\u53ef\n2. \u7981\u6b62\u4ee5\u89d2\u8272\u7b2c\u4e00\u4eba\u79f0\u63cf\u5199\u5185\u5fc3\u6d3b\u52a8\uff0c\u4f8b\u5982"\u6211\u5fc3\u60f3""\u6211\u89c9\u5f97""\u6211\u6697\u81ea"\u7b49\uff0c\u8bf7\u7528\u5206\u6790\u6027\u8bed\u8a00\u66ff\u4ee3\n3. \u601d\u8003\u5185\u5bb9\u5e94\u805a\u7126\u4e8e\u5267\u60c5\u8d70\u5411\u5206\u6790\u548c\u56de\u590d\u5185\u5bb9\u89c4\u5212\uff0c\u4e0d\u8981\u5728\u601d\u8003\u4e2d\u8fdb\u884c\u89d2\u8272\u626e\u6f14\u5f0f\u7684\u5185\u5fc3\u620f\u8868\u6f14`;

  const messages = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  const raw = await callLLM(messages, { label: "merged-writing" });
  return raw.trim();
}