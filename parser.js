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
  // 去重拦截：summary_entries 只保留最后一条标准格式状态追踪
  // ① 丢弃非标准格式的自由状态块（无 [第N轮]状态追踪： 前缀，AI 自由发挥的残次品）
  // ② 丢弃重复的旧轮次状态追踪（指引文案诱导 AI 复述的旧状态，如 [第9轮] + [第10轮] 并存时只留 [第10轮]）
  result.summary_entries = dedupeStateTracking(result.summary_entries);
  return result;
}

// 状态追踪去重：只保留最后一条标准格式（[第N轮]状态追踪： 前缀）的状态追踪
// 其余状态类条目（自由格式残次品 / 重复旧轮次）全部丢弃
function dedupeStateTracking(entries) {
  if (!Array.isArray(entries)) return entries;
  const out = [];
  let lastTrackingIndex = -1;
  // 先找最后一条标准格式状态追踪的位置
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (typeof e === "string" && /^\s*\[\u7b2c\s*\d+\s*\u8f6e\]\s*\u72b6\u6001\u8ffd\u8e2a[\uff1a:]/.test(e)) {
      lastTrackingIndex = i;
      break;
    }
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (typeof e !== "string") { out.push(e); continue; }
    const isStandardTracking = /^\s*\[\u7b2c\s*\d+\s*\u8f6e\]\s*\u72b6\u6001\u8ffd\u8e2a[\uff1a:]/.test(e);
    if (isStandardTracking) {
      // 只保留最后一条标准状态追踪
      if (i === lastTrackingIndex) out.push(e);
      else console.warn("[NA] 丢弃重复状态追踪条目:", e.substring(0, 30).replace(/\n/g, " "));
      continue;
    }
    // 自由格式状态块判定（无标准前缀但含状态字段标记）
    const freeMarkers = [/地\u70b9[\uff1a:]/, /在\u573a\u89d2\u8272[\uff1a:]/, /当\u524d\u72b6\u6001/, /处\u5973\u819c\u72b6\u6001/, /做\u7231\u6b21\u6570/, /回\u6eaf\u9b54\u6cd5/, /好\u611f\u5ea6[\uff1a:]/];
    const looksLikeState = /^\s*\u65f6\u95f4[\uff1a:]/.test(e) || freeMarkers.some(re => re.test(e));
    if (looksLikeState) {
      console.warn("[NA] 丢弃自由格式状态块:", e.substring(0, 50).replace(/\n/g, " "));
      continue;
    }
    out.push(e);
  }
  return out;
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
// 重要性评分关键词（移植自 WST，用于记忆取舍：每角色只保留最重要的 6 条）
const IMPORTANCE_KEYWORDS = [
  { re: /死[亡去]|丧命|逝世|去世|牺牲|杀死|杀害|处死/, weight: 100 },
  { re: /失去|丧失|永别|再也.*见不到|不复存在/, weight: 90 },
  { re: /人生.*改变|改变.*人生|命运.*转折|生命.*转折/, weight: 85 },
  // 性格/心态改变事件（按改变程度分级）：
  { re: /性格大变|性情大变|性格转变|性格改变|性情改变|性格突变|判若两人|换了一个人/, weight: 90 },   // 性格彻底改变（开朗→沉默等）
  { re: /变得沉默|沉默寡言|郁郁寡欢|消沉|萎靡|一蹶不振|自暴自弃|变得冷漠|不再说笑|笑容消失/, weight: 85 }, // 明显性格转变（沉默寡言等）
  { re: /心态变化|心理变化|心态转变|心性变化|心境变化|心态崩塌|心态崩溃/, weight: 80 },                 // 心态明显变化
  { re: /蜕变|脱胎换骨|涅槃|重获新生|破茧成蝶|走出阴影|振作|重拾信心|心结解开/, weight: 75 },           // 积极心态转变
  { re: /觉醒|发现.*能力|获得.*力量|突破.*极限|领悟/, weight: 80 },
  { re: /第一次|初次|破处|初夜|初吻|首次/, weight: 75 },
  { re: /结婚|离婚|订婚|分手|求婚|表白|告白/, weight: 70 },
  { re: /决定.*重要|重大.*决定|选择.*道路|抉择/, weight: 65 },
  { re: /受伤|重伤|濒死|险些.*死|差点.*死|遇难/, weight: 60 },
  { re: /背叛|出卖|欺骗|被.*骗|利用/, weight: 60 },
  { re: /怀孕|生子|产子|流产|堕胎|生下/, weight: 55 },
  { re: /崩溃|绝望|无法.*接受|精神.*摧毁|心理.*阴影/, weight: 50 },
  { re: /永远.*记住|铭记|终生难忘|刻骨铭心|永生难忘/, weight: 45 },
  { re: /亲人|父母|母亲|父亲|兄妹|姐弟|子女|孩子|家庭/, weight: 35 },
  { re: /拯救|拯救者|救命之恩|救了/, weight: 35 },
  { re: /毁灭|摧毁|破坏|覆灭|灭亡/, weight: 35 },
];

// 记忆重要性评分：关键词命中加权（主） + 长度微加成（上限 5 分）
// 关键词权重已足够区分（100=死亡类 / 75=第一次类 / 35=救命类 / 0=日常）
// 长度加成只做微调，避免普通长句盖过真正的重大事件
function scoreMemory(memory) {
  if (!memory) return 0;
  let score = 0;
  for (let i = 0; i < IMPORTANCE_KEYWORDS.length; i++) {
    if (IMPORTANCE_KEYWORDS[i].re.test(memory)) score += IMPORTANCE_KEYWORDS[i].weight;
  }
  score += Math.min(String(memory).length * 0.1, 5);
  return score;
}


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
    const items = m[2].split(/[|\uff5c\u3001\uff0f\/\n]/).map(s => s.trim()).filter(s => s && s !== "-" && s !== "\u2022");
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
    if (/^\u65f6\u95f4|\u533a\u57df|\u5728\u573a\u89d2\u8272|\u4e0d\u5728\u573a\u89d2\u8272|\u5904\u5973\u819c|\u505a\u7231|(?:\u5f53\u524d\u597d\u611f|\u89d2\u8272\u597d\u611f)|\u8eab\u4f53\u5916\u8c8c/.test(line)) break;
    // 角色名：记忆内容（支持 - 前缀）
    addMemory(line);
  }
  return memories;
}

// 记忆截断：优先在分隔符（/ ／ 、 | ｜）处断开，避免把一条记忆切成残句；无分隔符时硬截断
function truncateMemory(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSep = Math.max(
    cut.lastIndexOf("\/"),
    cut.lastIndexOf("\uff0f"),
    cut.lastIndexOf("\u3001"),
    cut.lastIndexOf("|"),
    cut.lastIndexOf("\uff5c")
  );
  if (lastSep > 0) return text.slice(0, lastSep);
  return cut;
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
    // 新记忆优先收集（标记得分加成：新发生的事件 AI 认为值得记录，给予保底优势）
    for (const m of newList) {
      const t = String(m).trim();
      if (t && !seen.has(t)) { seen.add(t); combined.push({ text: t, score: scoreMemory(t) + 20 }); }
    }
    // 旧记忆补充（无加成）
    for (const m of oldList) {
      const t = String(m).trim();
      if (t && !seen.has(t)) { seen.add(t); combined.push({ text: t, score: scoreMemory(t) }); }
    }
    // 取舍：按分数降序，每角色最多保留最重要的 6 条
    combined.sort((a, b) => b.score - a.score);
    merged[ch] = combined.slice(0, 6).map(item => {
      // 字数限制：每条记忆 ≤20 字（分隔符感知截断，防止切出残句）
      return truncateMemory(item.text, 20);
    });
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
          /^时间|区域|在场角色|不在场角色|处女膜|做爱|(?:当前好感|角色好感)|身体外貌/.test(t)) {
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

// ==================== 做爱次数累计保障 ====================
// 目的：做爱次数是终身累计数字（跨天/月/年永不归零），即使 AI 误清零也以历史最大值为准合并

// 从状态追踪条目文本中提取「做爱次数」字段 → { 角色名: 次数 }
// 支持格式：琴：0次、芭芭拉：3次；也支持单角色裸数字（0次 / 3）
export function extractSexCountsFromTracking(entryText) {
  const counts = {};
  if (!entryText || typeof entryText !== "string") return counts;
  const m = entryText.match(/做爱次数[：:][^\n]*/);
  if (!m) return counts;
  const raw = m[0].replace(/^做爱次数[：:]/, "").trim();
  if (!raw || raw === "无" || raw === "无记录" || raw === "无性行为") return counts;
  const parts = raw.split(/[、，,|；;\/]/).map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const pm = part.match(/^([^：:]{1,12})[：:]\s*(\d+)\s*次?$/);
    if (pm) {
      counts[pm[1].trim()] = parseInt(pm[2], 10);
      continue;
    }
    // 裸数字：0次 / 3 → 暂存（角色归属待定）
    const bm = part.match(/^(\d+)\s*次?$/);
    if (bm) counts.__bare__ = parseInt(bm[1], 10);
  }
  return counts;
}

// 合并做爱次数：每角色取新旧最大值（只增不减，杜绝归零）
export function mergeSexCounts(oldCounts, newCounts) {
  const merged = {};
  const allChars = new Set([
    ...Object.keys(oldCounts || {}),
    ...Object.keys(newCounts || {}),
  ]);
  for (const ch of allChars) {
    if (ch === "__bare__") continue;
    const oldV = (oldCounts && typeof oldCounts[ch] === "number") ? oldCounts[ch] : 0;
    const newV = (newCounts && typeof newCounts[ch] === "number") ? newCounts[ch] : 0;
    merged[ch] = Math.max(oldV, newV);
  }
  // 裸数字归属：上一状态只有一个角色时，裸数字视为该角色的次数（如 0次 → 琴）
  const bare = (newCounts && typeof newCounts.__bare__ === "number") ? newCounts.__bare__ : null;
  if (bare !== null && Object.keys(merged).length === 1 && Object.keys(oldCounts || {}).length === 1) {
    const ch = Object.keys(merged)[0];
    merged[ch] = Math.max(merged[ch], bare);
  }
  return merged;
}

// 把合并后的做爱次数写回状态追踪条目（替换原「做爱次数」行）
export function replaceSexCountsInTracking(entryText, counts) {
  if (!entryText || typeof entryText !== "string") return entryText;
  if (!counts || Object.keys(counts).length === 0) return entryText;
  const names = Object.keys(counts);
  // 仅当原行是「裸数字」格式（如 0次）且单角色时保持裸格式，其余一律用「角色：N次」命名格式（更稳健）
  const named = names.length > 1 || !/^做爱次数[：:]\s*\d+\s*次?\s*$/.test(entryText);
  const line = named
    ? "做爱次数：" + names.map(n => n + "：" + counts[n] + "次").join("、")
    : "做爱次数：" + counts[names[0]] + "次";
  return entryText.replace(/做爱次数[：:][^\n]*/, line);
}

// ==================== 当前态度（20级）保障 ====================
// 目的：①态度跨轮惯性（上轮服软本轮延续，不无故横跳）②态度与好感度档位一致性
// （无修饰符时态度级别必须落在好感度对应档位内，禁止好感度-90却态度温和的矛盾）

// 20级态度表：级别/名称/绑定好感度档位区间
// 每好感度档 2 级：常态级 + 波动级
const ATTITUDE_LEVELS = [
  { level: 1,  name: "杀意", minA: -100, maxA: -81 },
  { level: 2,  name: "敌视", minA: -100, maxA: -81 },
  { level: 3,  name: "厌恶", minA: -80,  maxA: -61 },
  { level: 4,  name: "冷拒", minA: -80,  maxA: -61 },
  { level: 5,  name: "对抗", minA: -60,  maxA: -41 },
  { level: 6,  name: "疏远", minA: -60,  maxA: -41 },
  { level: 7,  name: "冷淡", minA: -40,  maxA: -21 },
  { level: 8,  name: "不满", minA: -40,  maxA: -21 },
  { level: 9,  name: "警惕", minA: -20,  maxA: -1 },
  { level: 10, name: "戒备", minA: -20,  maxA: -1 },
  { level: 11, name: "中立", minA: 0,    maxA: 20 },
  { level: 12, name: "缓和", minA: 0,    maxA: 20 },
  { level: 13, name: "友好", minA: 21,   maxA: 40 },
  { level: 14, name: "服软", minA: 21,   maxA: 40 },
  { level: 15, name: "信任", minA: 41,   maxA: 60 },
  { level: 16, name: "顺从", minA: 41,   maxA: 60 },
  { level: 17, name: "依赖", minA: 61,   maxA: 80 },
  { level: 18, name: "讨好", minA: 61,   maxA: 80 },
  { level: 19, name: "依恋", minA: 81,   maxA: 100 },
  { level: 20, name: "痴缠", minA: 81,   maxA: 100 },
];

// 好感度 10 档区间（与状态追踪提示词一致）
export function affectionTier(aff) {
  if (aff >= -100 && aff <= -81) return { min: -100, max: -81 };
  if (aff >= -80 && aff <= -61) return { min: -80, max: -61 };
  if (aff >= -60 && aff <= -41) return { min: -60, max: -41 };
  if (aff >= -40 && aff <= -21) return { min: -40, max: -21 };
  if (aff >= -20 && aff <= -1) return { min: -20, max: -1 };
  if (aff >= 0 && aff <= 20) return { min: 0, max: 20 };
  if (aff >= 21 && aff <= 40) return { min: 21, max: 40 };
  if (aff >= 41 && aff <= 60) return { min: 41, max: 60 };
  if (aff >= 61 && aff <= 80) return { min: 61, max: 80 };
  if (aff >= 81 && aff <= 100) return { min: 81, max: 100 };
  return null;
}

// 从状态追踪条目文本中提取「当前态度」字段 → { 角色名: { level, name, mod, modText, real } }
// 支持格式：琴：L14服软（暂时，受胁迫）/ 芭芭拉：L16顺从 / 优菈：服软（无级别号按名称查表）
// 用全局正则直接匹配条目（角色名排除分隔符），避免括号内逗号被 split 误切
export function extractAttitudesFromTracking(entryText) {
  const attitudes = {};
  if (!entryText || typeof entryText !== "string") return attitudes;
  const m = entryText.match(/当前态度[：:][^\n]*/);
  if (!m) return attitudes;
  const raw = m[0].replace(/^当前态度[：:]/, "").trim();
  if (!raw || raw === "无" || raw === "无变化") return attitudes;
  const re = /([^：:、，,|；;\n]{1,12})[：:]\s*(?:(?:L|l)(\d{1,2}))?\s*([^（(、，,|；;：:\n]+)(?:（([^）)]*)）)?/g;
  let pm;
  while ((pm = re.exec(raw)) !== null) {
    const name = pm[1].trim();
    const attName = (pm[3] || "").trim();
    if (!name || !attName) continue;
    const modText = pm[4] ? pm[4].trim() : "";
    const mod = /暂时/.test(modText) ? "temporary" : (/伪装|假装|欺骗|假意/.test(modText) ? "fake" : "");
    const real = modText.includes("内心") ? modText : "";
    if (pm[2]) {
      const level = parseInt(pm[2], 10);
      if (level >= 1 && level <= 20) attitudes[name] = { level, name: attName, mod, modText, real };
    } else {
      const byName = ATTITUDE_LEVELS.find(l => l.name === attName);
      if (byName) attitudes[name] = { level: byName.level, name: attName, mod, modText, real };
    }
  }
  return attitudes;
}

// 从状态追踪条目文本中提取「角色好感度」字段 → { 角色名: 数值 }
export function extractAffectionsFromTracking(entryText) {
  const aff = {};
  if (!entryText || typeof entryText !== "string") return aff;
  const m = entryText.match(/(?:当前好感度|角色好感度)[：:][^\n]*/);
  if (!m) return aff;
  const raw = m[0].replace(/(?:当前好感度|角色好感度)[：:]/, "").trim();
  const parts = raw.split(/[、，,|；;]/).map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const pm = part.match(/^([^：:]{1,12})[：:]\s*(-?\d+)/);
    if (pm) aff[pm[1].trim()] = parseInt(pm[2], 10);
  }
  return aff;
}

// 合并两轮态度：上轮全部保留 + 本轮覆盖（惯性优先，缺失角色自动补上轮值）
export function mergeAttitudes(oldAttitudes, newAttitudes) {
  const merged = {};
  for (const [n, v] of Object.entries(oldAttitudes || {})) merged[n] = v;
  for (const [n, v] of Object.entries(newAttitudes || {})) merged[n] = v;
  return merged;
}

// 态度-好感度一致性校验：无修饰符（真诚）的态度级别必须落在好感度档位的 2 级区间内
// 不匹配 → 校正到档位内离当前级别最近的级别（带 corrected 标记）；无好感度可查时不做干预
// 带修饰符（暂时/伪装）的态度允许脱离档位（情境性/欺骗性态度），不校正
// 好感度缺失/无效时返回校正后的结果（该角色按无好感度处理，不干预）
export function reconcileAttitudes(attitudes, affections) {
  const out = {};
  for (const [name, at] of Object.entries(attitudes || {})) {
    if (!at || !at.level) { out[name] = at; continue; }
    if (at.mod === "temporary" || at.mod === "fake") { out[name] = at; continue; }
    const aff = (affections && typeof affections[name] === "number") ? affections[name] : null;
    if (aff === null) { out[name] = at; continue; }
    const tier = affectionTier(aff);
    if (!tier) { out[name] = at; continue; }
    const valid = ATTITUDE_LEVELS.filter(l => l.minA === tier.min && l.maxA === tier.max);
    if (valid.some(l => l.level === at.level)) { out[name] = at; continue; }
    // 校正：取档位内离当前级别最近的级别
    let best = null;
    for (const l of valid) {
      const d = Math.abs(l.level - at.level);
      if (!best || d < best.d) best = { l, d };
    }
    if (best) out[name] = { ...at, level: best.l.level, name: best.l.name, corrected: true };
    else out[name] = at;
  }
  return out;
}

// 把合并后的态度写回状态追踪条目（替换原「当前态度」行；无该行时插到「身体外貌」之前）
export function replaceAttitudesInTracking(entryText, attitudes) {
  if (!entryText || typeof entryText !== "string") return entryText;
  if (!attitudes || Object.keys(attitudes).length === 0) return entryText;
  const names = Object.keys(attitudes);
  const line = "当前态度：" + names.map(n => {
    const at = attitudes[n];
    const modText = at.modText ? "（" + at.modText + "）" : "";
    return n + "：L" + at.level + (at.name || "") + modText;
  }).join("、");
  if (/当前态度[：:]/.test(entryText)) {
    return entryText.replace(/当前态度[：:][^\n]*/, line);
  }
  // 无该行 → 插到「身体外貌」行之前（即「角色好感度」之后）
  const lines = entryText.split("\n");
  const out = [];
  let inserted = false;
  for (const l of lines) {
    if (!inserted && /^身体外貌/.test(l)) {
      out.push(line);
      inserted = true;
    }
    out.push(l);
  }
  if (!inserted) out.push(line);
  return out.join("\n");
}
