export class ContextRouter {
  constructor(deps) {
    this.stateManager = deps.stateManager;
    this.summaryStore = deps.summaryStore;
    this.characterReader = deps.characterReader;
    this.worldInfoResolver = deps.worldInfoResolver;
    this.userPersonaReader = deps.userPersonaReader;
  }

  async buildPlanningContext(userInput, recentTurns, systemEntries, beforeCharEntries, selectiveEntries, stateSummary, presetContext, planningTools) {
    let toolListText = "";
    if (planningTools && planningTools.length > 0) {
      const toolLines = planningTools.map(t => {
        const params = t.function.parameters;
        let paramDesc = "";
        if (params && params.properties) {
          const props = Object.entries(params.properties).map(([k, v]) => `${k}(${v.description || v.type || "any"})`).join(", ");
          paramDesc = `参数: ${props}`;
        } else {
          paramDesc = "无参数";
        }
        return `- ${t.function.name}: ${t.function.description}。${paramDesc}`;
      });
      toolListText = "可用工具：\n" + toolLines.join("\n");
    } else {
      toolListText = "当前没有可用工具，tool_calls 必须为空数组 []。不要自行发明任何工具。";
    }

    return {
      systemEntries: systemEntries || [],
      beforeCharEntries: beforeCharEntries || [],
      selectiveEntries: selectiveEntries || [],
      userPersona: this.userPersonaReader.getPersonaInfo(),
      storySummaries: this.summaryStore.getAllSummaries(),
      recentTurns,
      stateSummary,
      userInput,
      presetContext: presetContext?.planningContext || "",
      toolListText,
    };
  }

  async buildWritingContext(writingGuide, userInput, recentNarratives, systemEntries, selectiveEntries, writingSystemPreset, writingUserPreset, toolResultsText, beforeCharEntries, textRecall = null) {
    return {
      userPersona: this.userPersonaReader.getPersonaInfo(),
      writingGuide,
      recentNarratives,
      systemEntries: systemEntries || [],
      selectiveEntries: selectiveEntries || [],
      writingSystemPreset: writingSystemPreset || "",
      writingUserPreset: writingUserPreset || "",
      userInput,
      toolResultsText: toolResultsText || "",
      beforeCharEntries: beforeCharEntries || [],
      textRecall: textRecall || null,
    };
  }

    buildMergedAnalysisContext(narrativeText, userInput, turnId, stateSummary, stateTracking) {
    // 方案A：userInput 已含 <current_state>（v0.3.5 注入）时，不再重复取 summaryStore 状态追踪，
    // 避免同一份状态在 merged-analysis 输入里出现两次（token 翻倍导致总结变慢）
    // 显式传入 stateTracking 仍优先（调用方明确要求时）
    let effectiveTracking = stateTracking;
    if (!effectiveTracking) {
      const hasInjectedState = typeof userInput === "string" && userInput.includes("<current_state>");
      effectiveTracking = hasInjectedState ? "" : (this.summaryStore.getLatestStateTracking() || "");
    }
    return {
      turnId: turnId || "",
      events: [],
      userInput,
      narrativeText,
      stateSummary: stateSummary || this.stateManager.getSummary(),
      stateTracking: effectiveTracking,
      changedPatches: "",
      postPipelineToolSuffix: "",
    };
  }
}