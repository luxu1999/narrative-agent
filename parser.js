export function parsePlanningOutput(rawText) {
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[NA] parsePlanningOutput: \u672a\u627e\u5230JSON, rawText\u524d100\u5b57:", rawText?.substring(0, 100));
      return getDefaultPlan();
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      narrative_direction: parsed.narrative_direction || "",
      key_points: Array.isArray(parsed.key_points) ? parsed.key_points : [],
      tone: parsed.tone || "\u4e2d",
      pacing: ["\u5feb", "\u4e2d", "\u6162"].includes(parsed.pacing) ? parsed.pacing : "\u4e2d",
      continuity_notes: Array.isArray(parsed.continuity_notes) ? parsed.continuity_notes : [],
      tool_calls: Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [],
      text_recall: Array.isArray(parsed.text_recall) ? parsed.text_recall.filter(v => typeof v === "number" && v >= 0) : [],
    };
  } catch (e) {
    console.warn("[NA] parsePlanningOutput: JSON\u89e3\u6790\u5931\u8d25,", e.message, "rawText\u524d100\u5b57:", rawText?.substring(0, 100));
    return getDefaultPlan();
  }
}

export function getDefaultPlan() {
  return { narrative_direction: "", key_points: [], tone: "\u4e2d", pacing: "\u4e2d", continuity_notes: [], tool_calls: [], text_recall: [] };
}

export function parseExtractionOutput(rawText) {
  if (!rawText || typeof rawText !== "string") return { events: [] };
  let text = rawText.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { events: [] };
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { events: [] };
    if (!Array.isArray(parsed.events)) return { events: [] };
    return { events: parsed.events.filter(ev => ev && typeof ev === "object" && typeof ev.type === "string") };
  } catch { return { events: [] }; }
}

export function parseMergedOutput(rawText) {
  const result = { events: [], summary_entries: [] };
  if (!rawText || typeof rawText !== "string") return result;

  let text = rawText.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[NA] parseMergedOutput: \u672a\u627e\u5230JSON");
      return result;
    }
    const parsed = JSON.parse(jsonMatch[0]);
    if (Array.isArray(parsed.events)) {
      result.events = parsed.events.filter(ev => ev && typeof ev === "object" && typeof ev.type === "string");
    }
    if (Array.isArray(parsed.summary_entries)) {
      result.summary_entries = parsed.summary_entries.filter(s => typeof s === "string" && s.trim().length > 0);
    }
  } catch (e) {
    console.warn("[NA] parseMergedOutput: JSON\u89e3\u6790\u5931\u8d25", e.message);
  }

  // 兜底：AI 可能把「叙事要点」误附在状态追踪条目（重要记忆点）之后，
  // 此时截断丢弃该条目中第一个误附的 [第N轮]… 行及其后内容（状态追踪是唯一摘要条目）
  result.summary_entries = stripTrailingTurnLines(result.summary_entries);
  return result;
}

// 截断状态追踪条目末尾误附的 [第N轮]叙事要点 行（直接丢弃，不再拆成独立条目）
// 规则：仅当条目以「状态追踪：」包含时执行截断；找到第一个 [第N轮] 行（排除首行）即截断
function stripTrailingTurnLines(entries) {
  if (!Array.isArray(entries)) return entries;
  const out = [];
  for (const e of entries) {
    if (typeof e !== "string" || !e.includes("\u72b6\u6001\u8ffd\u8e2a\uff1a")) {
      // 非状态追踪条目：若是 [第N轮]叙事要点 等残留条目，直接丢弃
      if (/^\s*\[\u7b2c\s*\d+\s*\u8f6e\]/.test(e)) continue;
      out.push(e);
      continue;
    }
    const lines = e.split("\n");
    // 找第一个误附的 [第N轮] 行（排除条目自身首行 [第N轮]状态追踪：）
    let cutIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (/^\s*\[\u7b2c\s*\d+\s*\u8f6e\]/.test(lines[i])) { cutIdx = i; break; }
    }
    if (cutIdx <= 0) { out.push(e); continue; } // 没有误附，原样保留
    const head = lines.slice(0, cutIdx).join("\n").trim();
    if (head) out.push(head);
  }
  return out;
}