// 显示层注入：把「状态追踪」画进消息里（纯 DOM，不改消息文本）。
//
// 为什么不改写 msg.mes：
//   预设的破甲栈寄生在「prompt 组装」与「正则清洗」两条管线上。一旦改写消息文本，
//   这两条管线就被绕过（v0.5.0 之前的老做法正是如此，破甲直接失效）。
//   显示层注入只动 DOM，msg.mes 一个字不改，预设的正则该跑的照跑。
//
// 代价（必须清楚）：显示的内容**不进 prompt**，所以它只解决「看得见」，
//   不构成模型记忆。模型记忆由规格注入 / na_state 那条线负责。
//
// 锚点降级链：① 摘要折叠块之后 → ② 消息末尾 → ③ 不插。
//   这样「有摘要的预设更好看，没摘要的预设也照常工作」，与预设解耦。

import { getSTContext } from "./utils.js";

const VIEW_CLASS = "na-state-view";

/** 该 chat 下标属于第几轮（用户一条 + 其后的 AI 算一轮）。 */
function turnOfIndex(chat, index) {
  let turn = 0;
  for (let i = 0; i <= index && i < chat.length; i++) {
    const m = chat[i];
    if (m?.is_user === true || m?.role === "user") turn++;
  }
  return turn;
}

/** 取该轮的状态：优先按轮快照，其次（若正是当前轮）用内存里的。 */
function stateForTurn(engine, turn) {
  try {
    const snap = engine?.checkpoints?.latestAtOrBefore?.(turn);
    if (snap?.tracking) return { text: snap.tracking, from: snap.turn };
  } catch {
    /* ignore */
  }
  const curTurn = engine?.summary?.getTurn?.() || 0;
  const curText = engine?.summary?.getTracking?.() || "";
  if (curText && curTurn === turn) return { text: curText, from: curTurn };
  return null;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildViewHtml(text, turn) {
  return (
    '<details style="margin:0.6em 0;padding:0.5em 0.75em;border-left:3px solid rgba(140,170,255,.55);border-radius:6px;background:rgba(140,170,255,.07);">' +
    `<summary style="cursor:pointer;font-weight:600;opacity:.85;">状态追踪 · 第${turn}轮</summary>` +
    `<pre style="white-space:pre-wrap;margin:.5em 0 0 0;font-size:.92em;line-height:1.5;opacity:.9;">${esc(text)}</pre>` +
    '</details>'
  );
}

function removeView($text) {
  try {
    $text.children(`div.${VIEW_CLASS}`).remove();
  } catch {
    /* ignore */
  }
}

/**
 * 为一条消息补充「状态追踪」显示块。幂等：已存在就只更新内容，不重复插入。
 * @returns {boolean} 是否插入了内容
 */
export function renderStateIntoMessage(index, engine, config) {
  const ctx = getSTContext();
  const chat = ctx?.chat;
  if (!Array.isArray(chat) || index < 0 || index >= chat.length) return false;

  const $mes = $("#chat").children(".mes").eq(index);
  const $text = $mes.find(".mes_text").first();
  if (!$mes.length || !$text.length) return false;

  if (config?.showStateInMessage === false) {
    removeView($text);
    return false;
  }

  const msg = chat[index];
  if (!msg || msg.is_user === true || msg.role === "user") {
    removeView($text);
    return false;
  }

  const turn = turnOfIndex(chat, index);
  if (!turn) return false;

  const state = stateForTurn(engine, turn);
  if (!state) {
    removeView($text);
    return false;
  }

  let $view = $text.children(`div.${VIEW_CLASS}`);
  if (!$view.length) {
    $view = $(`<div class="${VIEW_CLASS}"></div>`);
    // 锚点①：摘要折叠块之后（用 find 而不是 children，防它被包在 <p> 里）
    const $anchor = $text
      .find("details")
      .filter(function () {
        return /摘要/.test($(this).children("summary").first().text());
      })
      .last();
    if ($anchor.length) $anchor.after($view);
    else $text.append($view); // 锚点②：消息末尾
  }
  $view.attr("data-na-turn", String(turn)).html(buildViewHtml(state.text, turn));
  return true;
}

/** 聊天切换 / 全量重绘时调用。 */
export function renderAllStateViews(engine, config) {
  const ctx = getSTContext();
  const chat = ctx?.chat;
  if (!Array.isArray(chat)) return;
  for (let i = 0; i < chat.length; i++) {
    renderStateIntoMessage(i, engine, config);
  }
}

/** 关闭开关时清掉所有已注入的块。 */
export function clearAllStateViews() {
  try {
    $(`div.${VIEW_CLASS}`).remove();
  } catch {
    /* ignore */
  }
}
