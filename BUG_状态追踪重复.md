# Bug 报告：AI 回复中出现两条 `[第N轮]状态追踪`（旧轮 + 新轮）

| 项目 | 内容 |
| --- | --- |
| 插件 | Narrative Agent（narrative-agent） |
| 版本 | v0.3.19 |
| 严重程度 | 中（功能可见性缺陷，状态块重复输出，影响观感与上下文） |
| 状态 | 已定位根因，未修复 |
| 模块 | `orchestrator.js`（`_stripStateTrackingFromText`） |
| 报告日期 | 2026-08-01 |

---

## 1. 现象

开启插件后，AI 的**每一条回复**都会输出两条 `[第N轮]状态追踪` 块：

- `[第N-1轮]状态追踪`（上一轮的状态，多余）
- `[第N轮]状态追踪`（本轮新生成的状态，正常）

两者内容基本重复，只是轮次编号不同。

---

## 2. 复现步骤

1. 安装并启用 Narrative Agent 插件，开始一段新的角色扮演对话。
2. 连续进行 2 轮以上对话（让 `[第N-1轮]` 状态块存在）。
3. 查看任意一条 AI 回复的最终内容。
4. 观察到回复中包含两条 `[第N轮]状态追踪` 块。

---

## 3. 影响范围

- 所有 Pipeline 路径均受影响：
  - 完整流水线（有 planning 工具或开启原文召回）：`orchestrator.js:552`
  - 合并写作模式（无 planning 工具）：`orchestrator.js:987`
  - fallback 流水线（API 失败降级）：`orchestrator.js:874`
- 三条路径都会对正文调用 `_stripStateTrackingFromText` 清理，但清理逻辑存在缺陷（见下文），导致旧状态块残留。

---

## 4. 根因分析

### 4.1 最终输出结构

每条回复的最终内容由 `orchestrator.js` 组装（约 547-559 行）：

```js
const parts = [];
parts.push(`<context>\n${this._stripStateTrackingFromText(narrativeText)}\n</context>`); // 正文，应已剥离状态块
if (summaryText) {
  parts.push(`<summary>\n${summaryText}\n</summary>`); // 合并分析生成的新状态块（正确，仅一条）
}
```

- `[第N轮]状态追踪`：来自 `<summary>`，是合并分析 Agent 本轮新生成的，**正常**。
- `[第N-1轮]状态追踪`：是写作 Agent 将注入的旧状态复述进了正文，`_stripStateTrackingFromText` 本应将其硬删除，但**只删了一半**，残留部分进入了 `<context>`。

### 4.2 直接原因：字段正则匹配不上 `在场角色+BUFF：`

`_stripStateTrackingFromText`（`orchestrator.js:1329`）内部用如下正则识别"状态块内的字段行"并跳过（`orchestrator.js:1374`）：

```js
/^(时间|区域|地点|在场角色|不在场角色|处女膜状态|做爱次数|当前好感度|身体外貌|回溯魔法|当前状态)[\uff1a:]/.test(l)
```

而提示词（`constants.js` 的 `MERGED_ANALYSIS_SYSTEM`）定义的字段名是 **`在场角色+BUFF：xxx`**。

`在场角色` 后面紧跟的是 `+BUFF`，不是 `：` 或 `:`，因此该正则**匹配失败**，代码走入了"意外行 → 结束状态块，保留该行"分支（`orchestrator.js:1377-1380`），状态块被提前判定结束。

### 4.3 触发链路

写作 Agent 复述旧状态时，剥离逻辑逐行处理，结果如下：

```
[第9轮]状态追踪：      ← 命中开头正则，被删除
时间：xxx             ← 命中字段正则，被删除
区域：xxx             ← 命中字段正则，被删除
在场角色+BUFF：xxx     ← 匹配失败！状态块在此被判定结束，该行被保留
不在场角色：xxx        ← 之后的每一行都不再处于"状态块"内 → 全部作为正文保留
处女膜状态：xxx
做爱次数：xxx
当前好感度：xxx
身体外貌：xxx
重要记忆点：- 琴：xxx
```

于是 `<context>` 中残留了旧状态块自 `在场角色+BUFF` 起的全部字段，与 `<summary>` 中的新状态块并存，形成"两条状态追踪"。

### 4.4 为什么写作 Agent 会复述旧状态

- 用户发送消息时，`bridge.js` 从最新 AI 消息中提取上一轮 `[第N-1轮]状态追踪`，注入到用户消息的 `<current_state>` 段（`orchestrator.js:250-258`），写作 Agent 可以直接看到该文本。
- 提示词虽然要求"严禁在正文中复述、改写或输出它；状态块由系统自动追加"，但 LLM 并不总能遵守。
- 代码注释也明确承认这一点："写作引擎可能复述注入的旧状态，代码层硬清理，不依赖 AI 自觉"（`orchestrator.js:1327`）。剥离函数是唯一兜底，而它存在缺陷，因此失效。

---

## 5. 次要放大因素

1. **自由格式兜底同样失效**（`orchestrator.js:1382-1386`）：
   `/^(地点|在场角色|当前状态|好感度|处女膜状态|做爱次数|回溯魔法)[\uff1a:]/` 中 `在场角色[：:]` 同样匹配不到 `在场角色+BUFF：`。若写作 Agent 以无 `[第N轮]` 头的自由格式复述状态，整块都无法被识别和剥离。
2. **字段名写法不一致**：剥离正则使用 `回溯魔法`，而提示词/文档使用 `回朔魔法`，含该字段的状态块同样无法被跳过（次要，因为 `在场角色+BUFF` 会先触发提前退出）。

---

## 6. 为什么 `<summary>` 只有一条（去重逻辑正常）

`parser.js` 的 `parseMergedOutput` 中：

- `stripTrailingTurnLines`：截断状态追踪条目末尾误附的 `[第N轮]` 行；
- `dedupeStateTracking`：丢弃非标准格式状态块与重复的旧轮次条目，只保留最后一条标准格式 `[第N轮]状态追踪`。

因此 `<summary>` 始终只含一条新状态块。多出来的那条来自 `<context>` 泄漏，去重函数管不到它。

---

## 7. 验证方法

1. 在 SillyTavern 中对任意一条 AI 回复点击编辑，查看原始 `mes` 内容。
2. 检查 `<context>` 内是否残留从 `在场角色+BUFF：` 开始的半截状态块。
3. 若残留存在，即可 100% 确认本根因。

---

## 8. 修复建议（仅供参考，未实施）

1. **核心修复**：修正 `_stripStateTrackingFromText` 的字段正则，允许 `在场角色+BUFF` 后缀，例如把 `在场角色` 改为 `在场角色(?:\+BUFF)?`；同步修复自由格式兜底正则（`orchestrator.js:1386`）。
2. **顺带修正**：统一 `回溯魔法` / `回朔魔法` 的写法，避免字段无法识别。
3. **可选加固**：写作 Agent 输出后，若检测到以 `[第\d+轮]状态追踪` 开头的行，整段硬删除（当前为逐行状态机，遇到边缘格式容易提前退出）。

---

## 9. 相关代码位置

| 文件 | 行号 | 说明 |
| --- | --- | --- |
| `orchestrator.js` | 1329 | `_stripStateTrackingFromText` 函数定义 |
| `orchestrator.js` | 1374 | 字段跳过正则（无法匹配 `在场角色+BUFF：`，根因所在） |
| `orchestrator.js` | 1382-1386 | 自由格式状态块兜底正则（同样无法匹配 `在场角色+BUFF：`） |
| `orchestrator.js` | 552 / 874 / 987 | 三条流水线路径的 `<context>` 组装与剥离调用 |
| `orchestrator.js` | 250-258 | `<current_state>` 注入逻辑 |
| `bridge.js` | 约 90-140 | `_extractLatestStateTrackingFromChat`：提取上一轮状态追踪 |
| `constants.js` | `MERGED_ANALYSIS_SYSTEM` | 状态追踪字段定义（`在场角色+BUFF：`） |
| `parser.js` | `parseMergedOutput` 内 | `stripTrailingTurnLines` / `dedupeStateTracking` 去重逻辑 |
