// 输出解析：剥离思考块 → 切出状态块 → 把状态块补成完整 10 项（供展示与存档）。
// 思考块永不进消息；状态块保留在消息末尾展示（可在设置里关闭）。
// 设计原则：任何一个环节失败都不抛错、不吞内容。

const THINK_TAGS = "thinking|analysis|reasoning|thought|scratchpad|think";

const CLOSED_THINKING = new RegExp(
  `<\\s*(?:${THINK_TAGS})\\s*>[\\s\\S]*?<\\s*\\/\\s*(?:${THINK_TAGS})\\s*>`,
  "gi"
);
const FENCED_THINKING = /```[ \t]*(?:thinking|analysis|reasoning|thought)[ \t]*\r?\n[\s\S]*?```/gi;
// 未闭合的思考块（模型被截断）：思考一定在正文之前，从开标签起整段丢弃
const OPEN_THINKING = new RegExp(`<\\s*(?:${THINK_TAGS})\\s*>[\\s\\S]*$`, "i");

const STATE_CLOSED = /<\s*state\s*>([\s\S]*?)<\s*\/\s*state\s*>/i;
const STATE_OPEN_TAIL = /<\s*state\s*>([\s\S]*)$/i;
const STATE_HEAD_RE = /\[\s*第\s*(\d+)\s*轮\s*\]\s*状态追踪\s*[：:]/g;

// 模型可能沿用的包裹标签：只删标签、保留内容
const WRAPPER_TAGS = /<\/?\s*(?:context|narrative|story|正文|output)\s*>/gi;

/** 状态追踪的固定字段顺序（前 9 项单行，「重要记忆点」为末段）。 */
export const STATE_FIELD_ORDER = [
  "时间",
  "区域",
  "在场角色+BUFF",
  "不在场角色",
  "处女膜状态",
  "做爱次数",
  "角色好感度",
  "当前态度",
  "身体外貌",
];

const MEMORY_FIELD = "重要记忆点";
const PLACEHOLDER_VALUES = /^(不变|同上|同前|无变化|照旧|略|—|-|n\/a|N\/A)$/;

/** 剥离思考块。 */
export function stripThinking(text) {
  if (!text || typeof text !== "string") return "";
  let out = text;
  out = out.replace(CLOSED_THINKING, "");
  out = out.replace(FENCED_THINKING, "");
  out = out.replace(OPEN_THINKING, "");
  return out;
}

/** 正文清洗：删包裹标签、压缩空行、去首尾空白。 */
export function cleanBody(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(WRAPPER_TAGS, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 从（已剥离思考的）文本里切出状态块原文。 */
export function splitStateBlock(text) {
  if (!text || typeof text !== "string") return { body: "", stateText: null };

  let m = text.match(STATE_CLOSED);
  if (m) {
    const stateText = (m[1] || "").trim();
    return { body: text.replace(m[0], ""), stateText: stateText || null };
  }

  m = text.match(STATE_OPEN_TAIL);
  if (m) {
    const stateText = (m[1] || "").trim();
    if (/状态追踪/.test(stateText)) return { body: text.slice(0, m.index), stateText };
  }

  STATE_HEAD_RE.lastIndex = 0;
  let last = null;
  let mm;
  while ((mm = STATE_HEAD_RE.exec(text)) !== null) last = mm;
  if (last) {
    const stateText = text.slice(last.index).trim();
    return { body: text.slice(0, last.index), stateText: stateText || null };
  }

  return { body: text, stateText: null };
}

/** 把状态块文本拆成字段与记忆点。 */
export function parseStateFields(text) {
  const fields = new Map();
  const memories = [];
  let inMemories = false;

  for (const raw of String(text || "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (/^\s*\[\s*第\s*\d+\s*轮\s*\]\s*状态追踪/.test(line)) continue; // 头行

    const m = line.match(/^\s*([^：:\-]{2,24})\s*[：:]\s*(.*)$/);
    if (m) {
      const name = m[1].trim();
      const value = m[2].trim();
      if (name === MEMORY_FIELD) {
        inMemories = true;
        if (value) memories.push(value);
        continue;
      }
      if (STATE_FIELD_ORDER.includes(name)) {
        inMemories = false;
        fields.set(name, value);
        continue;
      }
    }
    if (inMemories && /^\s*[-•*]/.test(line)) memories.push(line.trim());
  }

  return { fields, memories };
}

/**
 * 把状态块补成完整 10 项。
 * 缺失、空值或写了「不变/同上」这类占位值的字段，用上一轮同名字段补；都没有则标「（暂无数据）」。
 * @returns {{ text: string, filled: string[], fieldCount: number }}
 */
export function formatStateBlock(stateText, turn, prevText = "") {
  const cur = parseStateFields(stateText || "");
  const prev = parseStateFields(prevText || "");
  const filled = [];
  const lines = [];

  for (const name of STATE_FIELD_ORDER) {
    let value = (cur.fields.get(name) || "").trim();
    if (!value || PLACEHOLDER_VALUES.test(value)) {
      const fallback = (prev.fields.get(name) || "").trim();
      if (fallback && !PLACEHOLDER_VALUES.test(fallback)) {
        value = fallback;
        filled.push(name);
      } else if (!value) {
        value = "（暂无数据）";
      }
    }
    lines.push(`${name}：${value}`);
  }

  let memories = cur.memories.filter(Boolean);
  if (memories.length === 0) {
    const prevMemories = prev.memories.filter(Boolean);
    if (prevMemories.length > 0) {
      memories = prevMemories;
      filled.push(MEMORY_FIELD);
    }
  }
  lines.push(`${MEMORY_FIELD}：`);
  for (const item of memories) lines.push(item.startsWith("-") ? item : `- ${item}`);

  const t = Number(turn);
  const head = Number.isFinite(t) && t > 0 ? `[第${t}轮]状态追踪：` : "状态追踪：";
  return { text: `${head}\n${lines.join("\n")}`, filled, fieldCount: STATE_FIELD_ORDER.length + 1 };
}

/** 兼容旧调用：把状态块补齐并统一轮次编号。 */
export function normalizeStateTurn(stateText, turn) {
  return formatStateBlock(stateText, turn).text;
}

/**
 * 完整解析一次模型输出。
 * @returns {{ body: string, stateText: string|null, filled: string[], hadThinking: boolean, rawLength: number }}
 */
export function parseModelOutput(raw, turn, doStripThinking = true) {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  const withoutThinking = doStripThinking ? stripThinking(text) : text;
  const hadThinking = withoutThinking.length !== text.length;
  const { body, stateText } = splitStateBlock(withoutThinking);
  const formatted = stateText ? formatStateBlock(stateText, turn) : null;
  return {
    body: cleanBody(body),
    stateText: formatted ? formatted.text : null,
    filled: formatted ? formatted.filled : [],
    hadThinking,
    rawLength: text.length,
  };
}
