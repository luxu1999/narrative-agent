# Narrative Agent — 精简版（单次调用）

本版是对原「多 Agent 叙事系统」的重写，目标只有一句话：**用户发送一次 → 只打一次 API → 消息里只显示正文。**

## 行为

```
用户发送
  │
  ├─ GENERATION_STARTED       记下本次生成类型
  ├─ CHAT_COMPLETION_PROMPT_READY
  │     └─ 把这个请求的 prompt 整体替换成：写作指令 + 世界书 + 角色卡 + 用户 persona
  │        + <previous_state> + <recent_turns> + <user_input>
  │        （就这一次请求，插件自己不再发起任何 generateRaw）
  │
  └─ GENERATION_ENDED
        ├─ 剥离思考块   <thinking> / <analysis> / <reasoning> / ```thinking```（含未闭合）
        ├─ 剥离状态块   <state>…</state>（模型没照做时退化为「[第N轮]状态追踪：」尾部切割）
        ├─ 正文写回消息 → 用户只看到正文
        └─ 状态块 → summaryStore + localStorage 快照（用于删消息回滚）
```

## 与原版的差异（为什么这样改）

| 原版 | 精简版 | 原因 |
| --- | --- | --- |
| 中继占位符 + 插件自己 `generateRaw` 跑规划/写作/分析 | 直接替换 prompt，用 ST 这一次请求 | 一轮 3–5 次调用 → 1 次；中继失败即断链的分支被整体删除 |
| 只按 `isPipelineRunning` 挡自己，其它扩展的 `quiet` 调用也被改写 | 只接管 `normal / continue / regenerate / swipe / impersonate` | 旧版会改写其它扩展与内部调用的 prompt，这是「挡住 API」的主因 |
| 超时/取消只放弃等待，底层请求仍在跑；随后 fallback 再发一轮 | 无超时、无重试、无 fallback | 僵尸请求 + 重发叠加会把同一个 key 打到限流 |
| 消息里写 `<context>` + `<summary>` 一起输出 | 只写正文 | 你的要求：不要思考、不要分析 |
| 多条目摘要数组 + 事件状态机 + 多处写回 | 每聊天一条状态追踪 + 按轮次快照 | 原版的「状态追踪重复 / 隔轮消失」都来自多来源写回 |
| 工具系统 / MVU / 并行 / 骰子 / 原文召回 | 全部移除 | 它们每一项都要额外一次调用 |

## 文件

新增：

- `prompt.js` — 组装这一次调用的 messages（含 n+m 历史窗口）
- `parse.js` — 剥离思考块 / 状态块，切出正文
- `summary.js` — `SummaryStore`（每聊天一条状态）+ `CheckpointStore`（localStorage 快照）
- `worldinfo.js` — 世界书条目预取与同步筛选（prompt 必须在事件回调里同步拼好）

重写：

- `index.js` — 入口、engine 装配、聊天生命周期、设置面板
- `bridge.js` — 拦截与收尾
- `settings.js` — 配置与每聊天状态持久化
- `constants.js` — 默认配置 + 唯一一套 Prompt 模板 + 状态块规格
- `settings.html` — 精简面板
- `manifest.json` — 版本 0.4.0-slim

保留原样（仍在被引用）：`utils.js`、`readers.js`、`style.css`。

**请删除的旧文件**：`orchestrator.js`、`agent-planning.js`、`agent-writing.js`、`agent-analysis.js`、`context-router.js`、`tools.js`、`dice.js`、`mvu.js`、`parser.js`、`llm.js`、`state.js`、`store.js`、`worldbook.js`、`TUTORIAL.html`。

本版没有任何代码引用它们；它们引用的部分旧常量（如 `PLANNING_SYSTEM_SUFFIX`、`CANONICAL_CONTEXT_ORDER`、`MAX_EXPLODING_DEPTH`）也已随精简一并移除，所以**留着它们没有意义，一旦被误加载还会报错**。存放关系：`worldbook.js` → 被 `worldinfo.js` 取代；`state.js` → 被 `summary.js` 取代；`TUTORIAL.html` → 讲的是工具/MVU 那套已移除的机制。

## 使用

1. 把本目录放进 `SillyTavern/data/<user>/extensions/third-party/narrative-agent/`（或直接覆盖旧目录）。
2. 刷新酒馆 → 扩展设置里勾选「启用叙事引擎」。
3. 正常发送即可。控制台会打印每次调用的轮次、system/user 字符数、世界书命中条目数、正文长度、是否剥离了思考块。

## 需要知道的取舍

- **不再有工具调用、骰子、MVU、原文召回、并行**——它们与「一次调用」不可兼得。
- **状态块依赖模型配合**：模型没输出 `<state>` 时本轮状态不更新（会打警告），正文不受影响。
- **删消息回滚**按 localStorage 快照退到对应轮次；快照只在 localStorage 满时丢弃最早的几条。
- **其它扩展的生成请求不再被改写**（只放行不接管），所以那些扩展的 API 调用不会被本插件阻挡。
- 若某轮模型只返回了思考、没有正文，消息会写入一条明确提示而不是空白。

## 回滚

本目录不是 git 仓库，改动无法自动回退。需要原版时从 GitHub 重新拉取覆盖即可：

```
git clone https://github.com/luxu1999/narrative-agent.git
```
