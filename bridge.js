// 拦截层：把 ST 这一次生成请求的 prompt 换成我们自己的 messages（全程只这一次 API 调用），
// 生成结束后把返回值剥成「纯正文」写回消息，并把状态块交给 engine 存档。
//
// 与旧版的关键区别：
// 1) 不再用中继占位符 + 自己 generateRaw，因此一轮只打一次 API，不会产生僵尸请求；
// 2) 只接管用户主动发起的生成（normal/continue/regenerate/swipe/impersonate），
//    其它扩展的 quiet 调用一律放行——旧版会连别人的请求一起改写，这就是「挡住 API」的来源；
// 3) 无重试、无降级、无超时，失败就是失败，不叠加请求。

import { getSTContext, getLatestUserInput } from "./utils.js";
import { buildMessages } from "./prompt.js";
import { parseModelOutput, formatStateBlock } from "./parse.js";
import { EMPTY_OUTPUT_NOTICE } from "./constants.js";

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
    console.log("[NarrativeAgent] 拦截层已安装（单次调用模式）");
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
    } else {
      // 其它扩展发起的生成：标记一下，结束时不要误当成我们的收尾
      this._quietActive++;
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

    const lastText = String(last?.mes ?? last?.content ?? "").trim();
    const userInput = lastIsUser ? lastText : String(getLatestUserInput(ctx?.chat || chat) || "").trim();
    const turn = this.engine.nextTurn();

    const worldEntries = this.engine.collectWorldEntries(userInput);
    const { messages, systemChars, userChars, trimmed } = buildMessages({
      config: this.engine.config,
      turn,
      worldEntries,
      presetRules: this.engine.presetRules(),
      characterInfo: this.engine.characterInfo(),
      personaText: this.engine.personaText(),
      prevState: this.engine.prevState(),
      history: this.engine.history(),
      userInput,
    });

    chat.splice(0, chat.length, ...messages);

    this._plan = { turn, userInput };
    console.log(
      `[NarrativeAgent] 第${turn}轮：单次调用已就绪（system ${systemChars} 字符 / user ${userChars} 字符 / 世界书 ${worldEntries.length} 条）`
        + (trimmed.length ? `｜已裁剪：${trimmed.join("，")}` : "")
    );
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

    const raw = String(msg.mes ?? msg.content ?? "");
    const stripThinking = this.engine.config?.stripThinking !== false;
    const { body, stateText, filled, hadThinking } = parseModelOutput(raw, plan.turn, stripThinking);

    if (!body && raw.trim()) {
      console.warn("[NarrativeAgent] 解析后正文为空，原始返回如下（仅日志）:\n" + raw.slice(0, 2000));
    }

    // 状态追踪兜底：模型没给状态块就沿用上一轮，保证每段末尾都能看到完整状态
    const prevState = this.engine.prevState();
    let finalState = stateText;
    if (!finalState && prevState) {
      finalState = formatStateBlock(prevState, plan.turn, prevState).text;
      console.warn(`[NarrativeAgent] 第${plan.turn}轮未解析出状态块，沿用上一轮状态`);
    }
    if (finalState && filled && filled.length > 0) {
      console.warn(`[NarrativeAgent] 第${plan.turn}轮状态块缺项，已用上一轮补齐：${filled.join("、")}`);
    }

    const bodyText = body || EMPTY_OUTPUT_NOTICE;
    const showState = this.engine.config?.showStateInMessage !== false;
    msg.mes = finalState && showState ? `${bodyText}\n\n${finalState}` : bodyText;
    try {
      if (typeof ctx.updateMessageBlock === "function") ctx.updateMessageBlock(index, msg);
    } catch (e) {
      console.warn("[NarrativeAgent] 刷新消息显示失败:", e?.message);
    }

    if (finalState) {
      this.engine.applyState(finalState, plan.turn);
    } else {
      console.warn(`[NarrativeAgent] 第${plan.turn}轮没有任何状态可记录（首轮且模型未输出状态块）`);
    }

    this.engine.afterTurn(plan.turn);

    try {
      if (typeof ctx.saveChat === "function") await ctx.saveChat();
    } catch (e) {
      console.warn("[NarrativeAgent] 保存聊天失败:", e?.message);
    }

    // 注意：这里不要再手动 emit MESSAGE_UPDATED / CHARACTER_MESSAGE_RENDERED。
    // ST 的 generateRawData 本身也会 emit CHAT_COMPLETION_PROMPT_READY（dryRun:false），
    // 而每次 Generate() 都会覆盖 ST 的全局 abortController（script.js:4243）。
    // 手动 emit 很容易诱发其它扩展（如 expressions）在生成收尾阶段再发一次请求，
    // 把主请求的 abortController 顶掉 → 直接表现为「API 断联」。

    console.log(
      `[NarrativeAgent] 第${plan.turn}轮完成：正文 ${body.length} 字符` +
        `${hadThinking ? "（已剥离思考块）" : ""}` +
        `${finalState ? `，状态追踪${showState ? "已附在消息末尾" : "已存档（未展示）"}` : "，无状态追踪"}`
    );
  }
}
