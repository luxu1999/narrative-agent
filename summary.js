// 状态存储：每个聊天只维护「一条」状态追踪（最近一轮），外加按轮次的轻量快照，
// 用于删消息时把状态退回对应轮次。刻意不做事件状态机、不做数组追加——
// 原版的状态错位/重复问题全部来自多条目 + 多来源写回，这里从结构上消除。

const LS_PREFIX = "na:cp:";

export class SummaryStore {
  constructor(chatId = "default") {
    this.chatId = chatId;
    this.tracking = "";
    this.turn = 0;
  }

  getTracking() {
    return this.tracking || "";
  }

  getTurn() {
    return Number(this.turn) || 0;
  }

  setTracking(text, turn) {
    if (typeof text !== "string" || !text.trim()) return;
    this.tracking = text.trim();
    const t = Number(turn);
    if (Number.isFinite(t) && t > 0) this.turn = t;
  }

  reset() {
    this.tracking = "";
    this.turn = 0;
  }

  toDict() {
    return { tracking: this.tracking, turn: this.turn };
  }

  static fromDict(dict, chatId = "default") {
    const store = new SummaryStore(chatId);
    if (dict && typeof dict === "object") {
      if (typeof dict.tracking === "string") store.tracking = dict.tracking;
      const t = Number(dict.turn);
      if (Number.isFinite(t) && t > 0) store.turn = t;
    }
    return store;
  }
}

/** localStorage 快照：key = na:cp:<chatId>:<turn>，value = 状态追踪文本。 */
export class CheckpointStore {
  constructor(chatId = "default") {
    this.chatId = chatId;
  }

  _storage() {
    try {
      return typeof localStorage !== "undefined" ? localStorage : null;
    } catch {
      return null;
    }
  }

  _key(turn) {
    return `${LS_PREFIX}${this.chatId}:${String(turn).padStart(4, "0")}`;
  }

  save(turn, tracking) {
    const ls = this._storage();
    const t = Number(turn);
    if (!ls || !Number.isFinite(t) || t <= 0 || typeof tracking !== "string" || !tracking.trim()) return;
    try {
      ls.setItem(this._key(t), tracking.trim());
    } catch {
      // 配额溢出：丢掉该聊天最早的快照再试一次，仍失败就放弃（不影响主流程）
      try {
        const keys = this.listKeys();
        if (keys.length > 1) {
          ls.removeItem(keys[0]);
          ls.setItem(this._key(t), tracking.trim());
        }
      } catch {
        console.warn("[NarrativeAgent] 状态快照写入失败（localStorage 不可用或已满）");
      }
    }
  }

  /** 该聊天的所有快照 key，按轮次升序。 */
  listKeys() {
    const ls = this._storage();
    if (!ls) return [];
    const prefix = `${LS_PREFIX}${this.chatId}:`;
    const keys = [];
    try {
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k && k.startsWith(prefix)) keys.push(k);
      }
    } catch {
      return [];
    }
    return keys.sort();
  }

  /** 取 <= turn 的最新快照。 */
  latestAtOrBefore(turn) {
    const ls = this._storage();
    const t = Number(turn);
    if (!ls || !Number.isFinite(t)) return null;
    const keys = this.listKeys();
    for (let i = keys.length - 1; i >= 0; i--) {
      const suffix = keys[i].slice(`${LS_PREFIX}${this.chatId}:`.length);
      const n = parseInt(suffix, 10);
      if (Number.isFinite(n) && n <= t) {
        const value = ls.getItem(keys[i]);
        if (value && value.trim()) return { turn: n, tracking: value.trim() };
      }
    }
    return null;
  }

  /** 删除 >= turn 的所有快照（删消息后调用）。 */
  removeFrom(turn) {
    const ls = this._storage();
    const t = Number(turn);
    if (!ls || !Number.isFinite(t)) return;
    for (const key of this.listKeys()) {
      const n = parseInt(key.slice(`${LS_PREFIX}${this.chatId}:`.length), 10);
      if (Number.isFinite(n) && n >= t) {
        try {
          ls.removeItem(key);
        } catch {
          /* ignore */
        }
      }
    }
  }

  clear() {
    const ls = this._storage();
    if (!ls) return;
    for (const key of this.listKeys()) {
      try {
        ls.removeItem(key);
      } catch {
        /* ignore */
      }
    }
  }

  static cleanup(chatId) {
    new CheckpointStore(chatId).clear();
  }
}
