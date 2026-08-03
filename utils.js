export function truncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text || "";
  return text.substring(0, maxLen) + "...";
}

export function stripStatePanel(text) {
  if (!text) return text;
  return text.replace(/<state_panel>[\s\S]*?<\/state_panel>/g, "").trim();
}

export function stripMvuTags(text) {
  if (!text) return text;
  let result = text;
  result = result.replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/g, "").trim();
  const contentMatch = result.match(/<content>([\s\S]*?)<\/content>/);
  if (contentMatch) result = contentMatch[1].trim();
  return result;
}

export function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// 从文本中提取明确的字数要求，返回 { min, max } 或 null：
// 优先级（命中高层级即返回）：
//   1. 区间形式：「1200~1500字」「800-1000字」「500至800字」「300到500字」 → { min, max }
//   2. 前导语义词：「不超过/最多500字」 → { min: 0, max: n }（上限）；「至少500字」 → { min: n, max: 0 }（下限）
//   3. 后缀修饰：「300字以内/以下/内」 → { min: 0, max: n }；「300字左右/上下」或裸「300字」 → { min: n, max: n }（约 n 字）
// 同一层级取最后一个匹配（用户最后说的算）
// 用于：本轮用户输入 / 预设提示词中的字数要求 → 覆盖面板默认值
export function extractCharRange(text) {
  if (!text || typeof text !== "string") return null;

  // 1) 区间形式
  const rangeMatches = [];
  const reRange = /(\d{1,4})\s*(?:~|～|-|至|到)\s*(\d{1,4})\s*[字个]/g;
  let m;
  while ((m = reRange.exec(text)) !== null) {
    let a = parseInt(m[1], 10);
    let b = parseInt(m[2], 10);
    if (a > b) { const t = a; a = b; b = t; }
    if (a >= 1 && b <= 9999) rangeMatches.push({ min: a, max: b });
  }
  if (rangeMatches.length > 0) return rangeMatches[rangeMatches.length - 1];

  // 2) 前导语义词：不超过/最多 → 上限；至少 → 下限
  const leadMatches = [];
  const reLead = /(不超过|最多)(?:[^。；;\n]{0,10}?)(\d{1,4})\s*[字个]|至少(?:[^。；;\n]{0,10}?)(\d{1,4})\s*[字个]/g;
  while ((m = reLead.exec(text)) !== null) {
    if (m[1]) {
      const n = parseInt(m[2], 10);
      if (n >= 1 && n <= 9999) leadMatches.push({ min: 0, max: n });
    } else if (m[3]) {
      const n = parseInt(m[3], 10);
      if (n >= 1 && n <= 9999) leadMatches.push({ min: n, max: 0 });
    }
  }
  if (leadMatches.length > 0) return leadMatches[leadMatches.length - 1];

  // 3) 后缀修饰 / 裸数字
  const singleMatches = [];
  const reSingle = /(?:字数|回复|回答|输出|正文)?[^。；;\n]{0,10}?(\d{1,4})\s*[字个](以内|以下|左右|上下|内)?/g;
  while ((m = reSingle.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (n < 1 || n > 9999) continue;
    const mod = m[2];
    if (mod === "以内" || mod === "以下" || mod === "内") {
      singleMatches.push({ min: 0, max: n });
    } else {
      singleMatches.push({ min: n, max: n }); // 左右/上下/裸数字 → 目标值
    }
  }
  return singleMatches.length > 0 ? singleMatches[singleMatches.length - 1] : null;
}

export function getSTContext() {
  try { return window.SillyTavern?.getContext() ?? null; } catch { return null; }
}

export function extractPresetContext() {
  const ctx = getSTContext();
  const systemEntries = [];
  const userEntries = [];

  try {
    const settings = ctx?.chatCompletionSettings;
    const prompts = settings?.prompts;
    if (Array.isArray(prompts) && prompts.length > 0) {
      const enabledMap = _buildPromptEnabledMap(settings?.prompt_order);
      console.log("[NA:preset] prompt_order enabledMap size:", enabledMap.size);

      const CUSTOMIZABLE_IDS = new Set(["nsfw", "jailbreak"]);

      for (const prompt of prompts) {
        const identifier = prompt?.identifier;
        if (!identifier) continue;
        if (!prompt?.role) continue;
        if (!prompt?.content?.trim()) continue;

        if (CUSTOMIZABLE_IDS.has(identifier)) {
          // 用户可自定义的条目：nsfw, jailbreak
        } else if (prompt.system_prompt === true || prompt.marker === true) {
          console.log(`[NA:preset] 跳过 ST 内置条目: identifier="${identifier}"`);
          continue;
        }

        const enabled = enabledMap.has(identifier) ? enabledMap.get(identifier) : true;
        if (!enabled) {
          console.log(`[NA:preset] 跳过已禁用: identifier="${identifier}" role="${prompt.role}"`);
          continue;
        }

        console.log(`[NA:preset] 使用: identifier="${identifier}" role="${prompt.role}" content长度=${prompt.content.length}`);
        if (prompt.role === "system") {
          systemEntries.push(prompt.content.trim());
        } else {
          userEntries.push(prompt.content.trim());
        }
      }
    }
  } catch (e) {
    console.warn("[NA:preset] 读取 chatCompletionSettings.prompts 失败:", e.message);
  }

  const systemText = systemEntries.join("\n\n");
  const result = {
    planningContext: systemText,
    writingSystemContext: systemText,
    writingUserContext: userEntries.join("\n\n"),
  };
  console.log("[NA:preset] 提取完成: systemEntries=", systemEntries.length, "userEntries=", userEntries.length);
  return result;
}

function _buildPromptEnabledMap(promptOrder) {
  const map = new Map();
  if (!Array.isArray(promptOrder) || promptOrder.length === 0) return map;

  const entry = promptOrder[0];
  const order = entry?.order;
  if (!Array.isArray(order)) return map;

  for (const item of order) {
    if (item?.identifier) {
      map.set(item.identifier, item.enabled !== false);
    }
  }
  return map;
}

export function _stripFormattingContent(text, formattingSet) {
  if (!text || typeof text !== "string") return text;
  if (!formattingSet || formattingSet.size === 0) return text;
  let result = text;
  for (const fmt of formattingSet) {
    if (!fmt || fmt.length === 0) continue;
    let idx;
    while ((idx = result.indexOf(fmt)) !== -1) {
      result = result.slice(0, idx) + result.slice(idx + fmt.length);
    }
  }
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

export function _isEntryExcluded(content, formattingSet) {
  if (_isToolEntryContent(content)) return true;
  if (formattingSet && formattingSet.has(content)) return true;
  return false;
}

export function _isToolEntryContent(content) {
  if (!content || typeof content !== "string") return false;
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const validTypes = ["llm", "code"];
    return validTypes.includes(parsed.type)
      && parsed.function
      && typeof parsed.function === "object"
      && typeof parsed.function.name === "string";
  } catch {
    return false;
  }
}

export function parseTextToVariables(text) {
  if (!text || typeof text !== "string") return null;
  const lines = text.split("\n");
  const stack = [{ indent: -1, key: null, obj: {} }];
  const root = stack[0].obj;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    const colonIdx = content.indexOf(":");

    if (colonIdx === -1) continue;

    const key = content.substring(0, colonIdx).trim();
    const value = content.substring(colonIdx + 1).trim();

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];

    if (value === "") {
      const newObj = {};
      if (Array.isArray(parent.obj)) {
        parent.obj.push(newObj);
      } else {
        parent.obj[key] = newObj;
      }
      stack.push({ indent, key, obj: newObj });
    } else {
      let parsed;
      if (value === "true" || value === "false") {
        parsed = value === "true";
      } else if (/^-?\d+$/.test(value)) {
        parsed = parseInt(value, 10);
      } else if (/^-?\d+\.\d+$/.test(value)) {
        parsed = parseFloat(value);
      } else {
        parsed = value;
      }
      if (Array.isArray(parent.obj)) {
        parent.obj.push(parsed);
      } else {
        parent.obj[key] = parsed;
      }
    }
  }

  return Object.keys(root).length > 0 ? root : null;
}

export function getConversationId() {
  try { const ctx = getSTContext(); return ctx?.chatId || ctx?.characterId || "default"; } catch { return "default"; }
}

export function getLatestUserInput(chat) {
  if (!chat || !Array.isArray(chat) || chat.length === 0) return "";
  for (let i = chat.length - 1; i >= 0; i--) {
    const msg = chat[i];
    if (!msg) continue;
    const isUser = msg.is_user === true || msg.role === "user";
    const text = msg.mes || msg.content;
    if (isUser && text) return text;
  }
  return "";
}

export function isApiFailure(err) {
  if (!err) return false;
  const msg = (err && err.message) || "";
  if (msg.includes("Pipeline cancelled")) return true;
  if (msg.includes("网络") || msg.includes("网络错误")) return true;
  if (msg.includes("fetch") || msg.includes("network") || msg.includes("ECONN")) return true;
  if (msg.includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("超时")) return true;
  if (msg.includes("429") || msg.includes("rate")) return true;
  if (/\b5\d{2}\b/.test(msg)) return true;
  if (msg.includes("generateRaw") && msg.includes("空内容")) return true;
  if (msg.includes("context not available")) return true;
  if (msg.includes("请求可能被取消") || msg.includes("API错误")) return true;
  return false;
}

// 通用超时包装：超过 timeoutMs 未 settle 则 reject（错误带 .timeout=true 标记，供调用方区分）
// 用于 MVU 等无法取消但可能挂起的调用，防止无限等待
 export function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error((label ? label + " " : "") + "操作超时(" + timeoutMs + "ms)");
        e.timeout = true;
        reject(e);
      }, timeoutMs);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}