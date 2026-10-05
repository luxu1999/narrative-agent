// 拦截层（状态后端版）：既不替换 prompt，也不改写消息。
//
// 职责收敛为两件事：
//   1) 生成前：只记录本轮轮次；
//   2) 生成后：只读地解析消息里的状态块 → 补齐缺项 → 存档 → 写成 ST 聊天变量，
//      由预设条目用 {{getvar::na_state}} 在下一轮自行注入。
//
// 为什么不替换 prompt / 不改写消息：
//   原预设（创世回廊）的破甲栈寄生在 ST 的两条管线上——prompt 组装管线（首条 system、
//   末条 user 的光标锚点、assistant 预填位置）与正则清洗管线（渲染时剥离外壳、组装时净化历史）。
//   一旦本插件整段替换 prompt 或重建 msg.mes，这两条管线就被绕过，破甲直接失效。
//   因此这里采用「只读」：prompt 与消息文本一律归 ST 与预设所有。
//
// 只接管用户主动发起的生成（normal/continue/regenerate/swipe/impersonate），
// 其它扩展的 quiet 调用一律放行；无重试、无降级、无超时。

import { getSTContext } from "./utils.js";
import { parseModelOutput, formatStateBlock } from "./parse.js";
import { applyInjection, clearInjection } from "./inject.js";

const GEN_NORMAL = "normal";
const GEN_CONTINUE = "continue";
const GEN_REGENERATE = "regenerate";
const GEN_SWIPE = "swipe";
const GEN_IMPERSONATE = "impersonate";
const USER_GENERATION_TYPES = new Set([GEN_NORMAL, GEN_CONTINUE, GEN_REGENERATE, GEN_SWIPE, GEN_IMPERSONATE]);
const CONTINUATION_TYPES = new Set([GEN_CONTINUE, GEN_SWIPE, GEN_REGENERATE]);

export class NarrativeBridge {
  constructor(engine) {
    this.engine = engine;
    this.enabled = true;
    this._genType = null;
    this._plan = null;
    this._installed = false;
    this._quietActive = 0; // 正在进行的「非用户生成」（其它扩展的 quiet 调用）数量
    this._boundStarted = this._onGenerationStarted.bind(this);
    this._boundPromptReady = this._onPromptReady.bind(this);
    this._boundEnded = this._onGenerationEnded.bind(this);
  }

  install() {
    const ctx = getSTContext();
    if (!ctx?.eventSource) {
      console.error("[NarrativeAgent] ST eventSource 不可用，拦截层未安装");
      return false;
    }
    // 幂等：重复安装会导致同一请求被改写两次（第二次把插件自己的 <user_input> 又包一层），
    // 请求体畸形/被 abort，表现为「断联」。
    if (this._installed) {
      console.warn("[NarrativeAgent] 拦截层已安装，跳过重复安装");
      return true;
    }
    const t = ctx.eventTypes;
    ctx.eventSource.on(t.GENERATION_STARTED, this._boundStarted);
    ctx.eventSource.on(t.CHAT_COMPLETION_PROMPT_READY, this._boundPromptReady);
    ctx.eventSource.on(t.GENERATION_ENDED, this._boundEnded);
    this._installed = true;
    console.log("[NarrativeAgent] 拦截层已安装（只读状态后端）");
    return true;
  }

  uninstall() {
    const ctx = getSTContext();
    if (!ctx?.eventSource) return;
    const t = ctx.eventTypes;
    ctx.eventSource.removeListener(t.GENERATION_STARTED, this._boundStarted);
    ctx.eventSource.removeListener(t.CHAT_COMPLETION_PROMPT_READY, this._boundPromptReady);
    ctx.eventSource.removeListener(t.GENERATION_ENDED, this._boundEnded);
    this._installed = false;
    this._plan = null;
    this._quietActive = 0;
    // 关闭时把注入一并撤掉，避免残留内容继续进入 prompt
    try {
      clearInjection();
    } catch {
      /* ignore */
    }
    console.log("[NarrativeAgent] 拦截层已卸载");
  }

  /** 设置面板开关用：启用时确保已安装，关闭时卸载，避免「勾上了但不生效」。 */
  setEnabled(enabled) {
    this.enabled = enabled === true;
    if (this.enabled) this.install();
    else this.uninstall();
  }

  _onGenerationStarted(type) {
    const t = typeof type === "string" && type ? type : GEN_NORMAL;
    this._genType = t;
    if (USER_GENERATION_TYPES.has(t)) {
      // 新一轮用户生成：上一轮若因异常没走到收尾，这里丢掉残留计划，避免串轮
      this._plan = null;
      // 自动注入必须赶在 prompt 组装之前：GENERATION_STARTED 早于组装，
      // 而 CHAT_COMPLETION_PROMPT_READY 时 prompt 已经拼好了，再设就晚了。
      // 这里顺带把轮次号刷新成本轮。
      try {
        applyInjection(this.engine, this.engine?.config, this.engine?.nextTurn?.() || 1);
      } catch (e) {
        console.warn("[NarrativeAgent] 自动注入失败:", e?.message);
      }
    } else {
      // 其它扩展发起的生成：标记一下，结束时不要误当成我们的收尾
      this._quietActive++;
      // 别人的 prompt 不注入我们的内容，避免造成干扰
      try {
        clearInjection();
      } catch {
        /* ignore */
      }
    }
  }

  _onPromptReady(data) {
    if (!this.enabled) return;
    // ST 会用同一事件做 token 预算的 dry run；改写它没有意义，还可能污染 _plan
    if (data?.dryRun === true) return;
    if (!USER_GENERATION_TYPES.has(this._genType)) {
      // 不是用户主动发起的生成（例如其它扩展的 quiet 调用）→ 原样放行，不改写它的 prompt
      if (this._genType == null && !this._warnedNoType) {
        this._warnedNoType = true;
        console.warn(
          "[NarrativeAgent] 收到 prompt 就绪事件但没有 GENERATION_STARTED，本次不接管。若每轮都不生效，请反馈 ST 版本。"
        );
      }
      return;
    }
    // 同一次生成里重复触发（例如生成期间的 dry run 或重复安装的监听器）→ 只改写一次
    if (this._plan) {
      console.warn("[NarrativeAgent] 本次生成已改写 prompt，跳过重复改写");
      return;
    }
    const ctx = getSTContext();
    const chat = Array.isArray(data?.chat) ? data.chat : null;
    if (!chat || chat.length === 0) return;

    const last = chat[chat.length - 1];
    const lastIsUser = !!last && (last.is_user === true || last.role === "user");
    const isContinuation = CONTINUATION_TYPES.has(this._genType);
    if (!lastIsUser && !isContinuation) return;

    // 只记轮次，不碰 prompt：
    // prompt 由 ST + 预设原样组装，本插件只在生成结束后读消息、写变量。
    const turn = this.engine.nextTurn();
    this._plan = { turn };
    console.log(`[NarrativeAgent] 第${turn}轮：只读模式已就绪（不改写 prompt、不改写消息）`);
  }

  async _onGenerationEnded() {
    // 其它扩展的生成结束了，不是我们的这一轮 → 只销账，不动消息。
    // 但如果最后一条已经是 AI 消息，说明结束的是我们这一轮（quiet 调用不会往 chat 里写消息），
    // 这时不能再当成 quiet 销账，否则正文里的 <state> 块会残留。
    if (this._quietActive > 0) {
      const c = getSTContext()?.chat;
      const last = Array.isArray(c) && c.length > 0 ? c[c.length - 1] : null;
      const lastIsAi = !!last && last.is_user !== true && last.role !== "user";
      if (!lastIsAi) {
        this._quietActive--;
        return;
      }
    }
    const plan = this._plan;
    this._plan = null;
    this._genType = null;
    if (!plan) return;

    const ctx = getSTContext();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : null;
    if (!chat || chat.length === 0) return;

    const index = chat.length - 1;
    const msg = chat[index];
    if (!msg || msg.is_user === true || msg.role === "user") {
      console.warn("[NarrativeAgent] 收尾时最后一条不是 AI 消息，跳过处理（不改动消息）");
      return;
    }

    // 保留原始文本，一个字都不写回去。
    const raw = String(msg.mes ?? msg.content ?? "");
    // 先剥掉「代码补全」类破甲外壳（只作用于解析副本），否则状态块会被 Python 外壳挡住。
    const unwrapped = unwrapBypassShell(raw);
    const doStrip = this.engine.config?.stripThinking !== false;
    const { body, stateText, filled, hadThinking } = parseModelOutput(unwrapped, plan.turn, doStrip);

    // 状态追踪兜底：模型没给状态块就沿用上一轮；缺项用上一轮同名项补齐。
    // 补齐结果只进存档与变量（供下一轮注入），不写回消息。
    const prevState = this.engine.prevState();
    let finalState = stateText;
    if (!finalState && prevState) {
      finalState = formatStateBlock(prevState, plan.turn, prevState).text;
      console.warn(`[NarrativeAgent] 第${plan.turn}轮未解析出状态块，沿用上一轮状态`);
    }
    if (finalState && filled && filled.length > 0) {
      console.warn(`[NarrativeAgent] 第${plan.turn}轮状态块缺项，已用上一轮补齐：${filled.join("、")}`);
    }

    if (finalState) {
      this.engine.applyState(finalState, plan.turn);
    } else {
      console.warn(`[NarrativeAgent] 第${plan.turn}轮没有任何状态可记录（首轮且模型未输出状态块）`);
    }

    if (!body && raw.trim()) {
      console.warn("[NarrativeAgent] 解析后正文为空，原始返回如下（仅日志）:\n" + raw.slice(0, 2000));
    }

    this.engine.afterTurn(plan.turn);

    // 关键：不写 msg.mes、不 updateMessageBlock、不手动 emit 事件。
    // 消息文本与 prompt 一律归 ST 与预设所有（正则清洗 / 破甲栈都在那边）。
    try {
      if (typeof ctx.saveChat === "function") await ctx.saveChat();
    } catch (e) {
      console.warn("[NarrativeAgent] 保存聊天失败:", e?.message);
    }

    console.log(
      `[NarrativeAgent] 第${plan.turn}轮完成：正文 ${body.length} 字符` +
        `${hadThinking ? "（解析时已剥离思考块）" : ""}` +
        `${finalState ? "，状态已存档并写入 {{getvar::na_state}}" : "，无状态可存档"}`
    );
  }
}

/**
 * 剥掉「代码补全」类破甲外壳，仅用于解析（消息本身不动）。
 *
 * 目标是让状态块能被 parseModelOutput 找到。原预设的外壳形如：
 *   import sys
 *   content = """<｜begin｜>……正文……<｜over｜>"""
 *   sys.stdout.write(content)
 * 它由预设的正则在「渲染」和「组装 prompt」时剥离；而存储的消息文本里外壳仍在，
 * 所以本插件要在解析前自行剥一遍。
 *
 * 采用「逐段删外壳」而不是「截取标记之间的内容」：这样即使模型把内容写到标记之外，
 * 那部分也会被保留下来，不会整段丢失。
 */
function unwrapBypassShell(text) {
  let out = String(text ?? "");
  out = out.replace(/^[ \t]*import[ \t]+sys[ \t]*\r?\n/i, "");
  out = out.replace(/[ \t]*content[ \t]*=[ \t]*"""\s*<[|｜]\s*begin\s*[|｜]>\s*\r?\n?/i, "");
  out = out.replace(/\r?\n?\s*<[|｜]\s*over\s*[|｜]>\s*"{3,4}/i, "");
  out = out.replace(/^[ \t]*sys\.stdout\.write\([ \t]*content[ \t]*\)[ \t]*$/gim, "");
  return out;
}
