import { getSTContext, extractPresetContext, getLatestUserInput, isApiFailure } from "./utils.js";
import { PLACEHOLDER } from "./constants.js";

export class SillyTavernBridge {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
    this.enabled = true;
    this.wasIntercepted = false;
    this.isPipelineRunning = false;
    this._aborted = false;
    this._generationType = null;
    this._savedUserInput = null;
    this._generationCompleted = true;
    this._pipelineCompleteCbs = [];
    this._stopEventHandler = null;
    this._boundOnPromptReady = this._onPromptReady.bind(this);
    this._boundOnGenerationEnded = this._onGenerationEnded.bind(this);
    this._boundOnGenerationStarted = this._onGenerationStarted.bind(this);
    this._boundOnMessageDeleted = this._onMessageDeleted.bind(this);
  }

  onPipelineComplete(cb) { this._pipelineCompleteCbs.push(cb); }

  install() {
    const ctx = getSTContext();
    if (!ctx) { console.error("[NarrativeAgent] ST context not available"); return; }
    ctx.eventSource.on(ctx.eventTypes.CHAT_COMPLETION_PROMPT_READY, this._boundOnPromptReady);
    ctx.eventSource.on(ctx.eventTypes.GENERATION_ENDED, this._boundOnGenerationEnded);
    ctx.eventSource.on(ctx.eventTypes.GENERATION_STARTED, this._boundOnGenerationStarted);
    ctx.eventSource.on(ctx.eventTypes.MESSAGE_DELETED, this._boundOnMessageDeleted);
    console.log("[NarrativeAgent] Bridge installed, enabled:", this.enabled);
  }

  uninstall() {
    const ctx = getSTContext();
    if (!ctx) return;
    ctx.eventSource.removeListener(ctx.eventTypes.CHAT_COMPLETION_PROMPT_READY, this._boundOnPromptReady);
    ctx.eventSource.removeListener(ctx.eventTypes.GENERATION_ENDED, this._boundOnGenerationEnded);
    ctx.eventSource.removeListener(ctx.eventTypes.GENERATION_STARTED, this._boundOnGenerationStarted);
    ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_DELETED, this._boundOnMessageDeleted);
  }

  _onGenerationStarted(type) {
    this._generationType = type;
    this._generationCompleted = false;
    console.log("[NarrativeAgent] GENERATION_STARTED, type:", type);
  }

  _onMessageDeleted(newChatLength) {
    if (!this.enabled || this.isPipelineRunning) return;

    if (newChatLength <= 1) {
      console.log("[NarrativeAgent] MESSAGE_DELETED, chat near-empty, full reset. newChatLength:", newChatLength);
      this.orchestrator.rollbackToTurn(0);
      return;
    }

    // 删除消息后回滚到最新完整轮次的 checkpoint：
    // 状态追踪/摘要条目存于 summaryStore + checkpoint，回滚后随消息一并回到被删前的轮次，
    // 避免出现「#103 的状态错位到 #102」的情况（与 WST 独立快照模型的本质区别）
    try {
      const ctx = getSTContext();
      const rawChat = ctx?.chat || [];
      const { turns } = this.orchestrator._extractTurnHistoryFromChat(rawChat);
      let maxTurn = 0;
      for (const t of turns) {
        if (t.turnNum != null && t.turnNum > maxTurn) maxTurn = t.turnNum;
      }
      // 仅当最新完整轮次确实减少时才回滚（删的是尾部消息）；
      // 删除历史中间消息不影响最新轮次，只失效缓存即可
      if (maxTurn < this.orchestrator.turnCounter) {
        console.log("[NarrativeAgent] MESSAGE_DELETED, newChatLength:", newChatLength,
          "最新完整轮次:", maxTurn, "< turnCounter:", this.orchestrator.turnCounter, "→ 回滚到该轮次 checkpoint");
        this.orchestrator.rollbackToTurn(maxTurn);
      } else {
        console.log("[NarrativeAgent] MESSAGE_DELETED, newChatLength:", newChatLength,
          "最新完整轮次:", maxTurn, "未减少，仅失效预取缓存");
        this.orchestrator.invalidatePrefetch();
      }
    } catch (e) {
      console.warn("[NarrativeAgent] MESSAGE_DELETED 回滚失败，仅失效预取缓存:", e.message);
      this.orchestrator.invalidatePrefetch();
    }
  }

  _onPromptReady(data) {
    if (!this.enabled || this.isPipelineRunning) return;
    this._aborted = false;
    console.log("[NarrativeAgent] 拦截 CHAT_COMPLETION_PROMPT_READY, 原始消息数:", data.chat?.length);

    if (data.chat && data.chat.length > 0) {
      const sample = data.chat[0];
      console.log("[NA:bridge] data.chat[0] keys:", Object.keys(sample), "hasMes:", "mes" in sample, "hasContent:", "content" in sample, "hasIs_user:", "is_user" in sample, "hasRole:", "role" in sample);
      console.log("[NA:bridge] data.chat[0] role:", sample.role, "is_user:", sample.is_user, "mes首80字:", sample.mes?.substring(0, 80), "content首80字:", sample.content?.substring(0, 80));
    }

    this.orchestrator.worldInfoResolver.buildFormattingSet().catch(e => console.warn("[NA] buildFormattingSet in _onPromptReady failed:", e.message));

    const ctx = getSTContext();
    const rawChat = ctx?.chat || [];
    console.log("[NA:bridge] ctx.chat (前端展示消息) 长度:", rawChat.length);
    if (rawChat.length > 0) {
      const rawSample = rawChat[0];
      console.log("[NA:bridge] ctx.chat[0] keys:", Object.keys(rawSample), "is_user:", rawSample.is_user, "mes长度:", rawSample.mes?.length);
    }

    this._savedUserInput = getLatestUserInput(rawChat);
    console.log("[NarrativeAgent] 已保存用户输入:", this._savedUserInput?.substring(0, 80), "长度:", this._savedUserInput?.length);

    const { turns } = this.orchestrator._extractTurnHistoryFromChat(rawChat);
    this.orchestrator.applyChatExtractedContext(turns);
    console.log("[NarrativeAgent] 从chat提取轮次:", turns.length);

    if (this.orchestrator.config.presetMode === "split") {
      const presetCtx = extractPresetContext();
      this.orchestrator.setPresetContext(presetCtx);
      console.log("[NarrativeAgent] 预设上下文已提取, planningContext长度:", presetCtx.planningContext.length, "writingSystemContext长度:", presetCtx.writingSystemContext.length, "writingUserContext长度:", presetCtx.writingUserContext.length);
    } else {
      this.orchestrator.setPresetContext(null);
    }

    data.chat.splice(0, data.chat.length);
    data.chat.push({ role: "system", content: "You are a relay. You must output exactly the following text and nothing else: " + PLACEHOLDER });
    data.chat.push({ role: "user", content: "Relay the designated text now." });
    this.wasIntercepted = true;
  }

  async _onGenerationEnded() {
    this._generationCompleted = true;

    if (!this.enabled || this.isPipelineRunning || !this.wasIntercepted || this._aborted) return;
    this.wasIntercepted = false;

    const ctx = getSTContext();
    if (!ctx) return;

    const lastMsg = ctx.chat[ctx.chat.length - 1];
    if (!lastMsg || lastMsg.is_user || !(lastMsg.mes || "").includes(PLACEHOLDER)) {
      console.warn("[NarrativeAgent] 中继未正常完成（可能被用户取消或API错误），跳过Pipeline");
      return;
    }

    this.isPipelineRunning = true;

    // 切换 UI 到"生成中"状态：显示停止按钮，禁用发送路径
    $('#send_but').prop('disabled', true).css('pointer-events', 'none');
    $('#option_regenerate, #option_continue, #mes_continue, #mes_impersonate')
      .prop('disabled', true).css('pointer-events', 'none');
    $('#mes_stop').css('display', 'flex');
    document.body.dataset.generating = 'true';
    this._stopEventHandler = () => { this.orchestrator._shouldCancel = true; };
    ctx.eventSource.on(ctx.eventTypes.GENERATION_STOPPED, this._stopEventHandler);

    const chat = ctx.chat;
    const isRegeneration = this._generationType === "swipe" || this._generationType === "regenerate";
    this._generationType = null;

    try {
      let userInput = getLatestUserInput(chat);
      if (!userInput && this._savedUserInput) {
        userInput = this._savedUserInput;
        console.log("[NarrativeAgent] 使用保存的用户输入:", userInput?.substring(0, 80));
      }
      this._savedUserInput = null;
      console.log("[NarrativeAgent] Pipeline start, userInput preview:", userInput?.substring(0, 60), "isRegeneration:", isRegeneration);

      const lastMsgIndex = chat.length - 1;
      this.orchestrator.onProgress((status) => {
        const msg = chat[lastMsgIndex];
        if (msg && !msg.is_user) {
          msg.mes = status;
          try { ctx.updateMessageBlock(lastMsgIndex, msg); } catch (e) { /* ignore */ }
        }
      });

      const result = await this.orchestrator.pipeline(userInput, isRegeneration, chat);

      if (lastMsg && !lastMsg.is_user) {
        lastMsg.mes = result.finalOutput || result.narrative;
        lastMsg.extra = lastMsg.extra || {};
        lastMsg.extra.state_panel = null;
        lastMsg.extra.writing_guide = result.writingGuide;
        lastMsg.extra.events = result.events;
        ctx.updateMessageBlock(chat.length - 1, lastMsg);
      }

      if (typeof ctx.saveChat === "function") await ctx.saveChat();
      console.log("[NarrativeAgent] Pipeline 执行完成, 输出长度:", result.finalOutput.length);

      await this.orchestrator.prefetchState();

      ctx.eventSource.emit(ctx.eventTypes.MESSAGE_EDITED, chat.length - 1);
      ctx.eventSource.emit(ctx.eventTypes.MESSAGE_UPDATED, chat.length - 1);
      ctx.eventSource.emit(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, chat.length - 1);

      for (const cb of this._pipelineCompleteCbs) {
        try { await cb(result); } catch (err) { console.error("[NarrativeAgent] Callback error:", err); }
      }
    } catch (err) {
      console.error("[NarrativeAgent] Pipeline 执行失败:", err);
      if (lastMsg) {
        if (isApiFailure(err)) {
          lastMsg.mes = "API请求失败或被打断，工作流终止！";
        } else {
          lastMsg.mes = "工作流执行异常，请检查控制台日志。";
        }
        ctx.updateMessageBlock(chat.length - 1, lastMsg);
      }
      try { ctx.eventSource.emit(ctx.eventTypes.MESSAGE_EDITED, chat.length - 1); } catch {}
      try { ctx.eventSource.emit(ctx.eventTypes.MESSAGE_UPDATED, chat.length - 1); } catch {}
    } finally {
      // 恢复 UI 到正常状态
      ctx.eventSource.removeListener(ctx.eventTypes.GENERATION_STOPPED, this._stopEventHandler);
      this._stopEventHandler = null;
      $('#send_but').prop('disabled', false).css('pointer-events', '');
      $('#option_regenerate, #option_continue, #mes_continue, #mes_impersonate')
        .prop('disabled', false).css('pointer-events', '');
      $('#mes_stop').css('display', 'none');
      delete document.body.dataset.generating;
      this.isPipelineRunning = false;
    }
  }
}