// 世界书条目：读取一次、缓存成原始条目数组，之后同步筛选与关键词匹配。
// 为什么要缓存：prompt 必须在 CHAT_COMPLETION_PROMPT_READY 回调里「同步」拼好，
// 而 ST 的世界书读取是异步的，所以条目统一在轮次结束后/初始化时预取。

import { getSTContext, _isToolEntryContent } from "./utils.js";

const FORMAT_PREFIX = /^\s*\[(?:TOOL|UI|initvar|mvu_update)/i;

function toArray(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string" && v.trim());
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const rawPosition = entry?.extensions?.position ?? entry?.position;
  const position = Number(rawPosition);
  return {
    comment: String(entry.comment ?? ""),
    content: String(entry.content ?? "").trim(),
    order: Number(entry.order) || 0,
    constant: entry.constant === true,
    position: Number.isFinite(position) ? position : undefined,
    keys: toArray(entry.key ?? entry.keys).map((k) => k.toLowerCase()),
    secondary: toArray(entry.keysecondary ?? entry.secondary_keys).map((k) => k.toLowerCase()),
    disabled: entry.disable === true || entry.enabled === false,
  };
}

export class WorldInfoSource {
  constructor(source = "auto") {
    this.source = source;
    this._entries = [];
    this._loaded = false;
    this._lastError = null;
  }

  /** 读取并缓存条目（异步）。失败不抛错，保留上次缓存。 */
  async refresh() {
    try {
      const raw = await this._load();
      this._entries = raw.map(normalizeEntry).filter(Boolean);
      this._loaded = true;
      this._lastError = null;
      return true;
    } catch (e) {
      this._lastError = e?.message || String(e);
      console.warn("[NarrativeAgent] 世界书读取失败（沿用上次缓存）:", this._lastError);
      return false;
    }
  }

  invalidate() {
    this._loaded = false;
    this._entries = [];
  }

  get status() {
    return { loaded: this._loaded, count: this._entries.length, error: this._lastError };
  }

  async _load() {
    const ctx = getSTContext();
    if (!ctx) return [];
    const card = ctx.characters?.[ctx.characterId];
    const fromCard = () => {
      const book = card?.data?.character_book || card?.character_book;
      const entries = book?.entries;
      if (!entries) return null;
      if (Array.isArray(entries)) return entries;
      if (typeof entries === "object") return Object.values(entries);
      return null;
    };
    const fromWorld = async () => {
      const name = card?.data?.extensions?.world || card?.extensions?.world || ctx.chatMetadata?.world_info;
      if (!name || typeof ctx.loadWorldInfo !== "function") return null;
      const book = await ctx.loadWorldInfo(name);
      if (!book) return null;
      if (Array.isArray(book)) return book;
      if (book.entries && typeof book.entries === "object") return Object.values(book.entries);
      if (typeof book === "object") return Object.values(book);
      return null;
    };

    let entries = null;
    if (this.source === "card") entries = fromCard();
    else if (this.source === "world") entries = await fromWorld();
    else {
      entries = fromCard();
      if (!entries || entries.length === 0) entries = await fromWorld();
    }
    return Array.isArray(entries) ? entries : [];
  }

  /** 可用条目：启用、有内容、且不是格式化/工具条目。 */
  _usable() {
    return this._entries
      .filter((e) => !e.disabled && e.content)
      .filter((e) => !FORMAT_PREFIX.test(e.comment))
      .filter((e) => !_isToolEntryContent(e.content))
      .sort((a, b) => a.order - b.order);
  }

  /** 常驻条目正文（同步）。 */
  constantEntries() {
    return this._usable()
      .filter((e) => e.constant === true)
      .map((e) => e.content);
  }

  /** 关键词命中的条目正文（同步）。主/副关键词取并集，命中任一即注入。 */
  keywordEntries(matchText) {
    const text = String(matchText || "").toLowerCase();
    if (!text) return [];
    return this._usable()
      .filter((e) => e.constant !== true && (e.keys.length > 0 || e.secondary.length > 0))
      .filter((e) => [...e.keys, ...e.secondary].some((k) => text.includes(k)))
      .map((e) => e.content);
  }
}
