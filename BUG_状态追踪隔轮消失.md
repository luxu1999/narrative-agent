# Bug 报告：状态追踪"出现一次 → 下一轮消失 → 再下一轮又出现"（交替性丢失）

| 项目 | 内容 |
| --- | --- |
| 插件 | Narrative Agent（narrative-agent） |
| 版本 | v0.3.30（现象在 v0.3.30 系列修复后仍存在） |
| 严重程度 | 高（核心状态追踪功能不稳定，状态断链直接影响剧情连续性） |
| 状态 | 已定位根因，未修复 |
| 模块 | `agent-analysis.js`（合并分析截断/超时）、`llm.js`（超时不重试）、`parser.js`（截断 JSON 解析失败）、`bridge.js`（F主回溯导致轮次停滞） |
| 报告日期 | 2026-08-04 |

---

## 1. 现象

- 状态追踪呈现稳定的交替模式：本轮回复**有** `[第N轮]状态追踪`，下一轮回复**没有**，再下一轮又出现。
- "出现"的轮次里，状态块的轮次编号**可能不前进**（停留在旧编号），表现为"状态好像没更新"。
- 失败轮次生成耗时明显变长（合并分析可能多次等待直到超时）。

---

## 2. 复现步骤

1. 启用插件，使用**带思考（reasoning）的模型**，并保证状态追踪字段较多、记忆点较多。
2. 连续对话 4~6 轮。
3. 观察：追踪块 出现 → 消失 → 出现 → 消失……（交替）。
4. 打开控制台，在消失轮次可见 `Merged Analysis 失败，跳过事件提取与摘要压缩` 或 `LLM 调用超时(240000ms)` 日志。

---

## 3. 根因分析

### 3.1 直接触发：合并分析输出被截断或超时

合并分析调用（`agent-analysis.js:56`）：

```js
await callLLM(messages, { label: "merged-analysis", responseLength: 8000, timeoutMs: 240000 })
```

- `responseLength: 8000` 是**输出 token 总上限，包含模型的 thinking/reasoning token**（提交 `a926035` 的说明已确认这一点）。
- 模型"带思考"且本轮需要**参考完整上一状态做演化**时，思考 + JSON 输出很容易超过 8000 token → **输出被截断**。
- 慢速模型长输出也可能超过 `240000ms` → **调用超时**。

这正是你自己在提交记录里观察到的规律：
> "第一条=初始化状态输出短成功；第二条=参考完整状态演化，输出+思考更长。4000 token 在模型带 thinking（reasoning 计入额度）时不够 → JSON 截断解析失败 → summary 空；180s 超时对慢速长输出也不够"

### 3.2 截断的 JSON → `parseMergedOutput` 解析失败 → summary 空

`parser.js:52` 用 `text.match(/\{[\s\S]*\}/)` 提取 JSON：

- 输出被截断且**没有闭合 `}`** 时，正则匹配不到 → `parseMergedOutput` 直接返回空 `{ events: [], summary_entries: [] }`。
- 有闭合 `}` 但数组内容被切断时，`JSON.parse` 失败 → 同样返回空。
- 结果：本轮 `merged.summary_entries` 为空 → Phase 5 组装时 `<summary>` 块**整体缺失**。

### 3.3 超时抛错会绕过兜底重试

`runMergedAnalysisAgent` 的兜底重试（`agent-analysis.js:59-65`）只在 **"解析结果为空"** 时触发：

```js
if (parsed.summary_entries.length === 0) { /* 强制重试一次 */ }
```

而 `callLLM` 对**超时**的处理是直接 `throw`（`llm.js:48` 超时分支 `break` 后 `throw lastErr`）：

- 超时 → `callLLM` 抛异常 → `runMergedAnalysisAgent` 直接 reject → **重试逻辑被跳过**。
- 该异常被 `orchestrator.js:532-533` 的 catch 吞掉，`merged = { events: [], summary_entries: [] }` → 本轮丢失状态追踪，且白白等待了最长 240 秒。

### 3.4 交替的来源：失败轮 → 下一轮 F主回溯旧状态（断链-续接循环）

`bridge.js:52` 的 F主提取（v0.3.30 增强）会**回溯最近 10 条 AI 消息**：

- 成功轮 N：回复含 `<summary>[第N轮]状态追踪</summary>`，状态完整、较长。
- 失败轮 N+1：状态追踪参考上一轮完整状态 → 输出/思考超预算 → 截断/超时 → **回复无 `<summary>`**。
- 恢复轮 N+2：F主扫描最新消息（N+1 无追踪）→ 回溯到更早的 N 轮成功消息 → 注入旧状态 → 合并分析"重新续上" → 追踪**又出现**。

于是形成稳定的"出现 → 消失 → 出现 → 消失"循环。而且：

- 回溯注入的是**旧轮次的状态**（如 `[第N轮]`），合并分析虽被告知输出 `[第N+2轮]`，但模型常复制 `<state_tracking>` 输入里的轮次编号 → "出现"轮的状态块编号**停滞在旧轮**，看起来像状态没更新。
- 每次失败轮都会消耗 240s 级等待（主调用 + 可能的重试），与"卡很久"现象叠加。

### 3.5 为什么"更新后第一条有、第二条起消失"

第一条的 `<state_tracking>` 为"（无，首次初始化状态）"→ 输出短 → 成功；第二条起参考完整状态演化 → 输出长 → 触顶。这与 git 提交 `a926035` 里记录的规律一致，当前 8000/240s 只是把阈值提高，**没有根治**，失败轮次依然存在，并因 F主回溯表现为交替。

---

## 4. 次要放大因素

1. **F主提取带回 `</summary>` 尾巴**：`_extractLatestStateTrackingFromChat` 的正则捕获到消息末尾，注入的状态块末尾常带一行 `</summary>`，被写入 summaryStore 和 `<state_tracking>`，污染参考格式（非致命，但增加输出负担）。
2. **重试只补"空"，不补"错"**：合并分析主调用无论因截断还是超时失败，重试策略都没有覆盖超时异常路径。
3. **"重要记忆点必须完整复制"加重输出负担**：提示词要求每轮完整输出全部记忆，使输出长度与记忆量线性增长，越往后越容易触顶。

---

## 5. 验证方法

1. 在消失轮次查看控制台日志：
   - `[LLMClient] merged-analysis 调用` → 若随后出现 `LLM 调用超时(240000ms)`，是**超时**路径。
   - 若出现 `merged-analysis 未输出状态追踪条目，重试一次` 且重试后仍空，是**截断/解析失败**路径。
   - 若出现 `Merged Analysis 失败，跳过事件提取与摘要压缩:`，确认该轮 `<summary>` 被跳过。
2. 观察出现轮次的 `F主：从<summary>提取状态追踪 (第X轮, N chars)`：X 是否停滞在旧编号（说明回溯续接）。

---

## 6. 修复建议（仅供参考，未实施）

1. **超时也走兜底重试**：把 `runMergedAnalysisAgent` 的两个 `callLLM` 包进 try/catch，超时/异常时也执行强制重试（或降级为"严格复制上一状态"的简化输出）。
2. **截断容忍解析**：`parseMergedOutput` 在正则匹配不到闭合 `}` 时，尝试补全闭合括号再 `JSON.parse`；或改为流式/正则提取 `summary_entries` 中的 `[第N轮]状态追踪` 段，不依赖完整 JSON。
3. **给 thinking 模型留余量**：`responseLength` 上调（如 12000+），或对支持 reasoning_effort 的模型限制思考强度；并监控各 Agent 输出 token 实际用量。
4. **轮次推进防护**：F主回溯多条消息时优先取**轮次编号最大**的状态块，避免旧轮次状态覆盖新轮次；对注入的 `<state_tracking>` 头做轮次归一（写回时已有，注入前也做）。
5. **减轻输出负担**：记忆点的"完整复制"已由代码侧 `_mergeStateTrackingMemories` 兜底，提示词可改为"记忆由系统保留，仅输出新增变化"，缩短输出长度。

---

## 7. 相关代码位置

| 文件 | 行号 | 说明 |
| --- | --- | --- |
| `agent-analysis.js` | 56 | 合并分析主调用：`responseLength: 8000, timeoutMs: 240000` |
| `agent-analysis.js` | 59-65 | 兜底重试（仅覆盖"解析为空"，不覆盖超时异常） |
| `llm.js` | 8 / 19 | `DEFAULT_LLM_TIMEOUT_MS = 180000` 与超时配置 |
| `llm.js` | 48 | 超时分支：`break` 后 `throw`，绕过上层重试 |
| `parser.js` | 52 | `jsonMatch = text.match(/\{[\s\S]*\}/)`：截断 JSON 解析失败 |
| `orchestrator.js` | 532-533 | 合并分析异常被吞掉 → `summary_entries: []` |
| `bridge.js` | 52-93 | F主回溯最近 10 条消息，失败后从旧消息续接 |
| `orchestrator.js` | 265-283 | 注入状态写回 summaryStore（仅归一化首行轮次） |
