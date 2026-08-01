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

// ==================== 重要记忆点长期记忆保障 ====================
// 目的：确保每个角色最多保留 6 条重要记忆，且记忆不依赖最新消息——
//      即使本轮完全没有新记忆，上一轮的全部记忆也必须完整保留（代码层合并，不依赖 AI 自觉）

// 从状态追踪条目文本中提取「重要记忆点」段落 → { 角色名: [记忆...] }
// 支持格式：- 琴：记忆1|记忆2   或   琴：记忆1|记忆2   或   重要记忆点：- 琴：记忆1（同行）
export function extractMemoriesFromTracking(entryText) {
  const memories = {};
  if (!entryText || typeof entryText !== "string") return memories;
  const lines = entryText.split("\n");
  let inMemSection = false;

  function addMemory(line) {
    const m = line.match(/^[-\u2022\u25cf\u25c6\u25a0\u25b8\u25c2]?[ \t]*([^\uff1a:\n]{1,12})\uff1a\s*(.+)$/);
    if (!m) return false;
    const charName = m[1].trim();
    const items = m[2].split(/[|\uff5c\u3001\n]/).map(s => s.trim()).filter(s => s && s !== "-" && s !== "\u2022");
    if (charName && items.length > 0) {
      if (!memories[charName]) memories[charName] = [];
      for (const it of items) {
        if (memories[charName].indexOf(it) === -1) memories[charName].push(it);
      }
      return true;
    }
    return false;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.indexOf("\u91cd\u8981\u8bb0\u5fc6\u70b9") === 0) {
      inMemSection = true;
      // 同行格式：重要记忆点：- 琴：xxx   或   重要记忆点：琴：xxx
      const inline = line.substring(line.indexOf("\u91cd\u8981\u8bb0\u5fc6\u70b9") + 6).trim();
      if (inline) {
        addMemory(inline);
      }
      continue;
    }
    if (!inMemSection) continue;
    // 遇到非记忆格式行（[第N轮] 开头 / 其他字段标签）→ 记忆段结束
    if (/^\s*\[\u7b2c\s*\d+\s*\u8f6e\]/.test(line)) break;
    if (/^\u65f6\u95f4|\u533a\u57df|\u5728\u573a\u89d2\u8272|\u4e0d\u5728\u573a\u89d2\u8272|\u5904\u5973\u819c|\u505a\u7231|\u5f53\u524d\u597d\u611f|\u8eab\u4f53\u5916\u8c8c/.test(line)) break;
    // 角色名：记忆内容（支持 - 前缀）
    addMemory(line);
  }
  return memories;
}

// 合并两轮记忆：旧记忆完整保留 + 新记忆追加（去重），每角色最多 6 条
// 新记忆插入到前面（优先保留最新），超过 6 条时丢弃最旧的
export function mergeMemories(oldMemories, newMemories) {
  const merged = {};
  const allChars = new Set([
    ...Object.keys(oldMemories || {}),
    ...Object.keys(newMemories || {}),
  ]);
  for (const ch of allChars) {
    const oldList = Array.isArray(oldMemories?.[ch]) ? oldMemories[ch] : [];
    const newList = Array.isArray(newMemories?.[ch]) ? newMemories[ch] : [];
    const seen = new Set();
    const combined = [];
    // 新记忆优先（最新事件放前面）
    for (const m of newList) {
      const t = String(m).trim();
      if (t && !seen.has(t)) { seen.add(t); combined.push(t); }
    }
    // 旧记忆补充（保留长期记忆）
    for (const m of oldList) {
      const t = String(m).trim();
      if (t && !seen.has(t)) { seen.add(t); combined.push(t); }
    }
    merged[ch] = combined.slice(0, 6); // 每角色最多 6 条
  }
  return merged;
}

// 把记忆点对象格式化为「重要记忆点」段落文本
export function formatMemoriesSection(memories) {
  if (!memories || Object.keys(memories).length === 0) return "";
  const chars = Object.keys(memories);
  const lines = ["重要记忆点："];
  for (const ch of chars) {
    const list = memories[ch];
    if (list && list.length > 0) lines.push("- " + ch + "：" + list.join("|"));
  }
  return lines.join("\n");
}

// 将合并后的记忆写回状态追踪条目（替换原「重要记忆点」段落）
export function replaceMemoriesInTracking(entryText, memories) {
  if (!entryText || typeof entryText !== "string") return entryText;
  const memSection = formatMemoriesSection(memories);
  const lines = entryText.split("\n");
  const out = [];
  let inMemSection = false;
  let memWritten = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf("重要记忆点") === 0) {
      inMemSection = true;
      if (!memWritten) {
        if (memSection) {
          out.push(memSection);
          memWritten = true;
        }
        // 若本轮无任何记忆，直接跳过原记忆段所有行
      }
      continue;
    }
    if (inMemSection) {
      const t = line.trim();
      // 记忆段结束：下一个字段标签 / [第N轮] 行
      if (!t || /^\s*\[\u7b2c\s*\d+\s*\u8f6e\]/.test(t) ||
          /^时间|区域|在场角色|不在场角色|处女膜|做爱|当前好感|身体外貌/.test(t)) {
        inMemSection = false;
        // 注意：这里不 push 当前行，由下面统一 push（避免重复）
      } else {
        continue; // 跳过原记忆行（已被合并版替换）
      }
    }
    out.push(line);
  }
  // 若原条目没有记忆段但有合并记忆 → 追加到末尾
  if (!memWritten && memSection) out.push(memSection);
  return out.join("\n");
}
