// 入口：装配 engine（配置 / 状态 / 世界书 / 读取器）、安装拦截层、注册聊天生命周期事件、渲染设置面板。
// 全程没有多 Agent、没有工具执行、没有降级重试——一次用户发送 = 一次 API 调用。

import { NarrativeBridge } from "./bridge.js";
import { WorldInfoSource } from "./worldinfo.js";
import { CharacterReader, UserPersonaReader } from "./readers.js";
import { SummaryStore, CheckpointStore } from "./summary.js";
import {
  loadConfig,
  saveConfig,
  loadChatState,
  saveChatState,
  deleteChatState,
  purgeLegacyGlobals,
} from "./settings.js";
import { getSTContext, getConversationId, truncate } from "./utils.js";
import { selectHistory } from "./prompt.js";

let config = null;
let engine = null;
let bridge = null;
let settingsHtml = null;

/** 从 ctx.chat 提取轮次（用户一条 + 其后的 AI 正文算一轮）。 */
function extractTurns(chat) {
  const turns = [];
  let current = null;
  for (const m of chat || []) {
    const text = String(m?.mes ?? m?.content ?? "").trim();
    if (!text) continue;
    const isUser = m?.is_user === true || m?.role === "user";
    if (isUser) {
      current = { user: text, assistant: "" };
      turns.push(current);
    } else if (current) {
      current.assistant = current.assistant ? `${current.assistant}\n${text}` : text;
    }
  }
  turns.forEach((t, i) => {
    t.turnNum = i + 1;
  });
  return turns;
}

function chatTurns() {
  return extractTurns(getSTContext()?.chat || []);
}

function completedTurns() {
  return chatTurns().filter((t) => t.assistant).length;
}

function createEngine(chatId) {
  const state = loadChatState(chatId);
  const summary = SummaryStore.fromDict(state, chatId);
  const checkpoints = new CheckpointStore(chatId);
  const world = new WorldInfoSource(config.worldbookSource);
  const persona = new UserPersonaReader();
  const character = new CharacterReader();

  const eng = {
    config,
    chatId,
    summary,
    checkpoints,
    world,
    persona,
    character,

    nextTurn() {
      return Math.max(completedTurns(), summary.getTurn()) + 1;
    },

    prevState() {
      return summary.getTracking();
    },

    history() {
      return selectHistory(chatTurns(), config.historyWindow, config.historyGrowth);
    },

    characterInfo() {
      const info = character.getCoreInfo();
      const parts = [];
      if (info?.name) parts.push(`【名称】${info.name}`);
      if (info?.personality) parts.push(`【性格】\n${truncate(info.personality, 1500)}`);
      if (info?.description) parts.push(`【设定】\n${truncate(info.description, 4000)}`);
      return parts.join("\n\n");
    },

    personaText() {
      try {
        return persona.getPersonaInfo() || "";
      } catch {
        return "";
      }
    },

    collectWorldEntries(userInput) {
      const parts = [];
      try {
        if (config.injectConstantEntries) parts.push(...world.constantEntries());
        if (config.injectKeywordEntries) {
          const matchText = [summary.getTracking(), eng.history().map((t) => `${t.user}\n${t.assistant}`).join("\n"), userInput]
            .filter(Boolean)
            .join("\n");
          parts.push(...world.keywordEntries(matchText));
        }
      } catch (e) {
        console.warn("[NarrativeAgent] 世界书条目收集失败:", e?.message);
      }
      // 世界书可能非常长：超上限直接截断，宁可少注入也不让请求被 API 拒绝
      const MAX_WORLD_CHARS = 30000;
      const picked = [];
      let total = 0;
      for (const p of parts) {
        if (total + p.length > MAX_WORLD_CHARS) {
          console.warn(`[NarrativeAgent] 世界书注入已达上限 ${MAX_WORLD_CHARS} 字符，剩余条目被截断`);
          break;
        }
        picked.push(p);
        total += p.length;
      }
      return picked;
    },

    applyState(stateText, turn) {
      summary.setTracking(stateText, turn);
      checkpoints.save(turn, stateText);
      saveChatState(chatId, summary.toDict());
    },

    afterTurn() {
      saveChatState(chatId, summary.toDict());
      world.refresh().catch(() => {});
      refreshDisplay();
    },

    persist() {
      saveChatState(chatId, summary.toDict());
    },

    rollbackTo(turn) {
      const snap = checkpoints.latestAtOrBefore(turn);
      if (snap) summary.setTracking(snap.tracking, snap.turn);
      else summary.reset();
      checkpoints.removeFrom(turn + 1);
      saveChatState(chatId, summary.toDict());
      refreshDisplay();
    },
  };

  return eng;
}

function installLifecycleHandlers() {
  const ctx = getSTContext();
  if (!ctx?.eventSource) return;
  const t = ctx.eventTypes;

  ctx.eventSource.on(t.CHAT_CHANGED, () => {
    const newChatId = getConversationId();
    // 切换聊天时丢弃未收尾的计划：正在进行的生成结束后不得改动新聊天的消息
    if (bridge) bridge._plan = null;
    if (!engine || newChatId === engine.chatId) return;
    engine.persist();
    engine = createEngine(newChatId);
    bridge.engine = engine;
    engine.world.refresh().catch(() => {});
    console.log("[NarrativeAgent] 已切换到聊天:", newChatId);
    refreshDisplay();
  });

  ctx.eventSource.on(t.CHAT_DELETED, (chatFileName) => {
    deleteChatState(chatFileName);
    CheckpointStore.cleanup(chatFileName);
    console.log("[NarrativeAgent] 已清理聊天数据:", chatFileName);
  });

  ctx.eventSource.on(t.MESSAGE_DELETED, () => {
    if (!engine) return;
    const done = completedTurns();
    if (done >= engine.summary.getTurn()) return; // 没往回退
    console.log(`[NarrativeAgent] 消息被删除 → 状态回滚到第${done}轮`);
    engine.rollbackTo(done);
  });
}

function refreshDisplay() {
  const $display = settingsHtml ? settingsHtml.find("#na_state_display") : $("#na_state_display");
  if (!$display?.length || !engine) return;
  const tracking = engine.summary.getTracking();
  const turn = engine.summary.getTurn();
  const world = engine.world.status;
  const lines = [
    `轮次：已完成 ${completedTurns()} 轮｜状态记录：第 ${turn} 轮`,
    `世界书：${world.loaded ? `${world.count} 条${world.error ? `（上次读取失败：${world.error}）` : ""}` : "未加载"}`,
    "",
    tracking ? truncate(tracking, 1200) : "（暂无状态追踪）",
  ];
  $display.text(lines.join("\n"));
}

async function registerSettingsPane() {
  const ctx = getSTContext();
  if (!ctx?.renderExtensionTemplateAsync) {
    console.warn("[NarrativeAgent] 无法渲染设置面板");
    return;
  }
  const html = await ctx.renderExtensionTemplateAsync("third-party/narrative-agent", "settings");
  const $html = $(html);
  settingsHtml = $html;

  const bindCheckbox = (selector, get, set) => {
    $html.find(selector).prop("checked", get());
    $html.find(selector).on("change", function () {
      set($(this).prop("checked"));
      commit();
    });
  };
  const bindNumber = (selector, get, set, min = 0, max = 99999) => {
    $html.find(selector).val(get());
    $html.find(selector).on("change", function () {
      const v = Math.max(min, Math.min(max, parseInt($(this).val(), 10) || 0));
      $(this).val(v);
      set(v);
      commit();
    });
  };

  const commit = () => {
    saveConfig(config);
    if (engine) engine.config = config;
    refreshDisplay();
  };

  bindCheckbox("#na_enabled", () => config.enabled === true, (v) => {
    config.enabled = v;
    if (bridge) bridge.enabled = v;
  });
  bindNumber("#na_history_window", () => config.historyWindow, (v) => { config.historyWindow = Math.max(1, v); }, 1, 50);
  bindNumber("#na_history_growth", () => config.historyGrowth, (v) => { config.historyGrowth = v; }, 0, 50);
  bindNumber("#na_min_reply_chars", () => config.minReplyChars, (v) => { config.minReplyChars = v; }, 0, 9999);
  bindNumber("#na_max_reply_chars", () => config.maxReplyChars, (v) => { config.maxReplyChars = v; }, 0, 9999);
  bindCheckbox("#na_inject_constant", () => config.injectConstantEntries !== false, (v) => { config.injectConstantEntries = v; });
  bindCheckbox("#na_inject_keyword", () => config.injectKeywordEntries !== false, (v) => { config.injectKeywordEntries = v; });
  bindCheckbox("#na_dialogue_driven", () => config.dialogueDriven !== false, (v) => { config.dialogueDriven = v; });
  bindCheckbox("#na_strip_thinking", () => config.stripThinking !== false, (v) => { config.stripThinking = v; });
  bindCheckbox("#na_show_state", () => config.showStateInMessage !== false, (v) => { config.showStateInMessage = v; });

  $html.find("#na_worldbook_source").val(config.worldbookSource || "auto");
  $html.find("#na_worldbook_source").on("change", function () {
    config.worldbookSource = $(this).val();
    if (engine) {
      engine.world.source = config.worldbookSource;
      engine.world.invalidate();
      engine.world.refresh().then(refreshDisplay).catch(() => {});
    }
    commit();
  });

  $html.find("#na_reset_state").on("click", () => {
    if (!engine) return;
    engine.summary.reset();
    engine.checkpoints.clear();
    saveChatState(engine.chatId, engine.summary.toDict());
    refreshDisplay();
    if (typeof toastr !== "undefined") toastr.info("状态追踪已重置");
  });

  $html.find("#na_refresh_state").on("click", refreshDisplay);

  $html.find("#na_reload_worldbook").on("click", () => {
    if (!engine) return;
    engine.world.invalidate();
    engine.world.refresh().then(() => {
      refreshDisplay();
      if (typeof toastr !== "undefined") toastr.info("世界书缓存已刷新");
    });
  });

  $("#extensions_settings").append($html);
  refreshDisplay();
}

async function init() {
  config = loadConfig();
  purgeLegacyGlobals();

  const chatId = getConversationId();
  engine = createEngine(chatId);
  bridge = new NarrativeBridge(engine);
  bridge.enabled = config.enabled === true;

  // 预取世界书：prompt 必须在事件回调里同步拼好，所以条目要提前缓存
  await engine.world.refresh();

  if (config.enabled) {
    bridge.install();
  }
  installLifecycleHandlers();
  await registerSettingsPane();

  console.log(
    `[NarrativeAgent] 初始化完成（单次调用模式）｜启用=${config.enabled}｜世界书 ${engine.world.status.count} 条｜聊天=${chatId}`
  );
}

function bootstrap() {
  init().catch((e) => console.error("[NarrativeAgent] 初始化失败:", e));
}

if (typeof $ !== "undefined") {
  $(bootstrap);
} else {
  const timer = setInterval(() => {
    if (typeof $ !== "undefined") {
      clearInterval(timer);
      $(bootstrap);
    }
  }, 100);
}
