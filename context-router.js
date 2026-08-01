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
    // 方案A'：userInput 已含 <current_state>（v0.3.5 注入）时，
    // ① 从 userInput 提取 current_state 真实内容作为 stateTracking（merged-analysis 需要真实状态做演化基准）
    // ② merged-analysis 的 userInput 剥离 <current_state> 段（避免同一份状态出现两次，token 翻倍）
    // 写作引擎仍使用完整 userInput（功能1 不受影响）；显式传入 stateTracking 仍优先
    let effectiveTracking = stateTracking;
    let effectiveUserInput = userInput;
    if (!effectiveTracking && typeof userInput === "string" && userInput.includes("<current_state>")) {
      const csRe = /<current_state>\n([\s\S]*?)\n<\/current_state>/;
      const m = userInput.match(csRe);
      if (m && m[1] && m[1].trim()) {
        effectiveTracking = m[1].trim();
      } else {
        effectiveTracking = this.summaryStore.getLatestStateTracking() || "";
      }
      effectiveUserInput = userInput
        .replace(/<current_state>[\s\S]*?<\/current_state>/g, "")
        .replace(/\n*【当前世界状态[^】]*】/g, "")
        .trim();
    } else if (!effectiveTracking) {
      effectiveTracking = this.summaryStore.getLatestStateTracking() || "";
    }
    return {
      turnId: turnId || "",
      events: [],
      userInput: effectiveUserInput,
      narrativeText,
      stateSummary: stateSummary || this.stateManager.getSummary(),
      stateTracking: effectiveTracking,
      changedPatches: "",
      postPipelineToolSuffix: "",
    };
  }
  }
}