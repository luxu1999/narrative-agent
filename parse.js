// 输出解析：从模型返回文本里剥离「思考块」与「状态块」，只留叙事正文。
// 设计原则：任何一个环节失败都不抛错、不吞内容——解析不出来就把原文当正文，
// 由调用方决定怎么提示，绝不让用户看到空消息。

const THINK_TAGS = "thinking|analysis|reasoning|thought|scratchpad|think";

// 成对出现的思考块（带闭合标签）
const CLOSED_THINKING = new RegExp(
  `<\\s*(?:${THINK_TAGS})\\s*>[\\s\\S]*?<\\s*\\/\\s*(?:${THINK_TAGS})\\s*>`,
  "gi"
);

// ```thinking ... ``` 之类的围栏思考块
const FENCED_THINKING = /```[ \t]*(?:thinking|analysis|reasoning|thought)[ \t]*\r?\n[\s\S]*?```/gi;

// 未闭合的思考块（模型被截断）：思考一定在正文之前，所以从开标签起整段丢弃
const OPEN_THINKING = new RegExp(`<\\s*(?:${THINK_TAGS})\\s*>[\\s\\S]*$`, "i");

// 状态块（正常闭合 / 被截断未闭合）
const STATE_CLOSED = /<\s*state\s*>([\s\S]*?)<\s*\/\s*state\s*>/i;
const STATE_OPEN_TAIL = /<\s*state\s*>([\s\S]*)$/i;
const STATE_HEAD_RE = /\[\s*第\s*(\d+)\s*轮\s*\]\s*状态追踪\s*[：:]/g;

// 模型可能沿用的包裹标签：只删标签、保留内容
const WRAPPER_TAGS = /<\/?\s*(?:context|narrative|story|正文|output)\s*>/gi;

/** 剥离思考块。返回清理后的文本。 */
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

/**
 * 从（已剥离思考的）文本里切出状态块。
 * 优先认 <state>…</state>；模型没照做时退化为认最后一个「[第N轮]状态追踪：」，
 * 两者都没有则视为没有状态块（本轮不更新状态，不影响正文）。
 * @returns {{ body: string, stateText: string|null }}
 */
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
    // 截断的状态块里仍要能看到状态追踪头，否则按正文处理
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

/** 把状态块开头的轮次编号统一成当前轮次，并保证「状态追踪：」表头存在。 */
export function normalizeStateTurn(stateText, turn) {
  if (!stateText || typeof stateText !== "string") return "";
  const t = Number(turn);
  const body = stateText.trim();
  const hasTurn = /\[\s*第\s*\d+\s*轮\s*\]/.test(body);
  const withHeader = /状态追踪\s*[：:]/.test(body) ? body : "状态追踪：\n" + body;
  if (!Number.isFinite(t) || t <= 0) return withHeader;
  if (hasTurn) return withHeader.replace(/\[\s*第\s*\d+\s*轮\s*\]/, `[第${t}轮]`);
  return `[第${t}轮]${withHeader.replace(/^\s*状态追踪/, "状态追踪")}`;
}

/**
 * 完整解析一次模型输出。
 * @param raw 模型原始返回文本
 * @param turn 本轮轮次（用于归一化状态块编号）
 * @param doStripThinking 是否剥离思考块（默认 true）
 * @returns {{ body, stateText, hadThinking, rawLength }}
 */
export function parseModelOutput(raw, turn, doStripThinking = true) {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  const withoutThinking = doStripThinking ? stripThinking(text) : text;
  const hadThinking = withoutThinking.length !== text.length;
  const { body, stateText } = splitStateBlock(withoutThinking);
  return {
    body: cleanBody(body),
    stateText: stateText ? normalizeStateTurn(stateText, turn) : null,
    hadThinking,
    rawLength: text.length,
  };
}
