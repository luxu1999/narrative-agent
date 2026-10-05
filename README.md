# Narrative Agent — 状态后端版（只读）

本版把插件从「接管者」降级为**只读状态后端**：**不改写 prompt、不改写消息**，只负责把每轮的状态追踪解析、补齐、存档，并写入聊天变量 `na_state`，由预设条目 `{{getvar::na_state}}` 在下一轮注入。

这样预设自己的生成管线才能完整保留——包括寄生在「prompt 组装」与「正则清洗」两条管线上的**破甲栈**。

> **v0.5.0 更新**：删除 prompt 整段替换与 `msg.mes` 重建；状态改走聊天变量 `na_state`；解析前自动剥破甲外壳。详见 [CHANGELOG.md](./CHANGELOG.md)。

## 预设侧需要配合的一条条目

```
<previous_state>
{{getvar::na_state}}
</previous_state>
```

位置要求：**靠后，且必须在光标锚点 `<｜cursor｜>` 之前**（否则会顶掉 prompt 末位，破坏补全框架）。

## 行为（v0.4.x 历史说明，本版已不再适用）

```
用户发送
  │
  ├─ GENERATION_STARTED        记下本次生成类型
  ├─ CHAT_COMPLETION_PROMPT_READY
  │     └─ 把这个请求的 prompt 整体替换成：最小写作指令 + **预设写作规则** + 状态块规格
  │        + 世界书 + 角色卡 + 用户 persona + <previous_state> + <recent_turns> + <user_input>
  │        （替换后按 maxPromptChars 裁剪：关键词世界书 → 最老历史）
  │        （就这一次请求，插件自己不再发起任何 generateRaw）
  │
  └─ GENERATION_ENDED
        ├─ 剥离思考块   <thinking> / <analysis> / <reasoning> / ```thinking```（含被截断的未闭合情形）
        ├─ 切出状态块   <state>…</state>（模型没照做时退化为「[第N轮]状态追踪：」尾部切割）
        ├─ 把状态补成完整 10 项（缺项用上一轮同名字段补；整块缺失则沿用上一轮）
        ├─ 消息 = 正文 + 空行 + 完整状态追踪（可在设置里只存不显示）
        └─ 同一份状态 → summaryStore + localStorage 快照（供下一轮注入与删消息回滚）
```

## 与预设的分工

本插件**只负责状态追踪**。文风 / 人称 / 抢话 / 剧情推进 / 用词（句式黑名单）/ 篇幅字数一律由 SillyTavern 预设提供。

`preset.js` 会在每次生成前遍历预设里**启用**的条目，逐条 `substituteParams`（这样 `{{setglobalvar}}` 先执行、`{{getglobalvar}}` 才有值），把写作规则抽出来放进 `<preset_rules>`；同时丢弃输出协议类条目（DREAM_PLOT / schema / MVU / 八股超杀 / 梦境选项 / DX 包裹 / 世界书压缩宏），避免与「正文 + 状态块」格式打架。

「写作模式」这类人话与协议混排的条目，只取其中的 `<writing_setting>…</writing_setting>` 块。

因此：**想改文风/字数，改预设；想改状态字段，改本扩展。**

## 断联是怎么修掉的（都已在代码层处理）

1. **替换 prompt 后不再有 ST 的 token 预算**：新增 `maxPromptChars`（默认 40000 字符），超出按「关键词世界书 → 最老历史 → user 段兜底」顺序裁剪。这是「超长请求被 API 拒绝」的直接对策。
2. **收尾阶段不再手动 emit 事件**：`MESSAGE_UPDATED` / `CHARACTER_MESSAGE_RENDERED` 被手动 emit 会让其它扩展（如 expressions）在收尾时再发一次请求；而 ST 的 `Generate()` 每次都会覆盖全局 `abortController`（`script.js:4243`），把主请求顶掉就是断联。
3. **拦截层幂等 + 不碰 dry run**：重复 `install()` 会导致同一请求被改写两次；`dryRun` 的 prompt 也不再改写。
4. **同一次生成只改写一次**：`_plan` 已存在时跳过重复改写。
5. **其它扩展的 quiet 生成不再干扰收尾**：用 `_quietActive` 计数区分，避免被别人的 `GENERATION_ENDED` 提前触发收尾。
6. 删掉了永远不生效的死配置（原 `responseTokens`：ST 的该事件载荷只有 `{ chat, dryRun }`，没有 `max_tokens`）。

## 状态追踪的完整性怎么保证

三道防线，任何一道生效都不会出现残缺的状态块：

1. **Prompt 硬约束**：输出格式里给出 10 项字段模板，并写明「一项都不能少、不许写『不变/同上/略』、无变化就照抄 `<previous_state>`」；同时把上一轮的完整状态作为 `<previous_state>` 注入，模型照抄即可。
2. **字段级兜底**（`parse.js` → `formatStateBlock`）：解析后逐项核对，缺失、空值或写了占位词的字段用上一轮同名项补齐，并在控制台列出补了哪些项。
3. **整块兜底**（`bridge.js`）：模型整块状态都没输出时，直接沿用上一轮状态并重新标记轮次，保证消息末尾始终有状态。

固定 10 项：`时间` / `区域` / `在场角色+BUFF` / `不在场角色` / `处女膜状态` / `做爱次数` / `角色好感度` / `当前态度` / `身体外貌` / `重要记忆点`。

## 与原版的差异（为什么这样改）

| 原版 | 精简版 | 原因 |
| --- | --- | --- |
| 中继占位符 + 插件自己 `generateRaw` 跑规划/写作/分析 | 直接替换 prompt，用 ST 这一次请求 | 一轮 3–5 次调用 → 1 次；中继失败即断链的分支被整体删除 |
| 只按 `isPipelineRunning` 挡自己，其它扩展的 `quiet` 调用也被改写 | 只接管 `normal / continue / regenerate / swipe / impersonate` | 旧版会改写其它扩展与内部调用的 prompt，这是「挡住 API」的主因 |
| 超时/取消只放弃等待，底层请求仍在跑；随后 fallback 再发一轮 | 无超时、无重试、无 fallback | 僵尸请求 + 重发叠加会把同一个 key 打到限流 |
| 消息里 `<context>` 包正文 + `<summary>` 混排，状态块可能缺字段 | 消息 = 正文 + 完整状态追踪；思考块剥离 | 状态要可见，但不要思考过程、不要半截状态 |
| 多条目摘要数组 + 事件状态机 + 多处写回 | 每聊天一条状态追踪 + 按轮次快照 | 原版的「状态追踪重复 / 隔轮消失」都来自多来源写回 |
| 工具系统 / MVU / 并行 / 骰子 / 原文召回 | 全部移除 | 它们每一项都要额外一次调用 |

## 文件

新增：

- `preset.js` — 从 ST 预设里提取写作规则（文风 / 人称 / 抢话 / 推进 / 用词 / 字数），并过滤输出协议类条目
- `prompt.js` — 组装这一次调用的 messages（含 n+m 历史窗口）
- `parse.js` — 剥离思考块、切出状态块、把状态块补成完整 10 项
- `summary.js` — `SummaryStore`（每聊天一条状态）+ `CheckpointStore`（localStorage 快照）
- `worldinfo.js` — 世界书条目预取与同步筛选（prompt 必须在事件回调里同步拼好）

重写：

- `index.js` — 入口、engine 装配、聊天生命周期、设置面板
- `bridge.js` — 拦截、收尾、状态兜底与消息组装
- `settings.js` — 配置与每聊天状态持久化
- `constants.js` — 默认配置 + 唯一一套 Prompt 模板 + 状态块规格
- `settings.html` — 精简面板
- `manifest.json` — 版本 0.4.0-slim

保留原样（仍在被引用）：`utils.js`、`readers.js`、`style.css`。

**请删除的旧文件**：`orchestrator.js`、`agent-planning.js`、`agent-writing.js`、`agent-analysis.js`、`context-router.js`、`tools.js`、`dice.js`、`mvu.js`、`parser.js`、`llm.js`、`state.js`、`store.js`、`worldbook.js`、`TUTORIAL.html`。

本版没有任何代码引用它们；它们引用的部分旧常量（如 `PLANNING_SYSTEM_SUFFIX`、`CANONICAL_CONTEXT_ORDER`、`MAX_EXPLODING_DEPTH`）也已随精简一并移除，所以**留着它们没有意义，一旦被误加载还会报错**。对应关系：`worldbook.js` → 被 `worldinfo.js` 取代；`state.js` → 被 `summary.js` 取代；`TUTORIAL.html` → 讲的是工具/MVU 那套已移除的机制。

## 使用

1. 把本目录放进 `SillyTavern/data/<user>/extensions/third-party/narrative-agent/`（或直接覆盖旧目录）。
2. 刷新酒馆 → 扩展设置里勾选「启用叙事引擎」；「在消息末尾展示完整状态追踪」默认开启。
3. 正常发送即可。控制台会打印每轮的 system/user 字符数、世界书命中条目数、正文长度、是否剥离了思考块、状态块是否补过项。

## 设置项

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 启用叙事引擎 | 开 | 关闭后卸载拦截层并回退到 ST 原生生成（无需刷新页面） |
| 最小轮数 n / 生长缓冲 m | 3 / 3 | 历史窗口在 n ~ n+m 之间生长，稳定前缀以提高缓存命中 |
| 注入预设的写作规则 | 开 | 把预设里启用的写作规则带进 prompt；关闭则只按插件内置最小规则写作 |
| Prompt 字符上限 | 40000 | 超出按「世界书 → 最老历史」自动裁剪，防超长请求被 API 拒绝 |
| 世界书来源 / 注入常驻 / 注入关键词 | auto / 开 / 开 | 格式化条目（`[TOOL:*]` 等）一律不注入 |
| 剥离思考块 | 开 | 关闭则原样保留模型的思考标签 |
| 在消息末尾展示完整状态追踪 | 开 | 关闭后状态只在后台存档，不出现在消息里 |

## 需要知道的取舍

- **不再有工具调用、骰子、MVU、原文召回、并行**——它们与「一次调用」不可兼得。
- **状态块依赖模型配合**：模型漏字段会被自动补齐；整块没给就沿用上一轮状态，因此「状态不变」时内容与上轮相同（这是设计，不是故障）。
- **删消息回滚**按 localStorage 快照退到对应轮次；快照只在 localStorage 满时丢弃最早的几条。
- **其它扩展的生成请求不再被改写**（只放行不接管），所以那些扩展的 API 调用不会被本插件阻挡。
- 若某轮模型只返回了思考、没有正文，消息会写入一条明确提示（并在控制台打出原始返回以便排查）。

## 回滚

需要原版多 Agent 实现时，直接从 GitHub 历史取回：

```
git clone https://github.com/luxu1999/narrative-agent.git
git checkout 48572de   # v0.3.32，精简前的最后版本
```
