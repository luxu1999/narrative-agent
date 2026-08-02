# Bug 报告：Pipeline 长时间卡顿（创作故事/总结整理）与偶发"多Agent叙事系统出错"

| 项目 | 内容 |
| --- | --- |
| 插件 | Narrative Agent（narrative-agent） |
| 版本 | v0.3.19 |
| 严重程度 | 高（生成流程可能长时间挂起或整体失败，影响正常使用） |
| 状态 | 已定位根因，未修复 |
| 模块 | `llm.js`（无超时/中止）、`orchestrator.js`（fallback 重跑 + 上下文无预算） |
| 报告日期 | 2026-08-02 |

---

## 1. 现象

- 插件启用后，生成回复时在 **"正在创作故事..."**（写作阶段）和 **"正在总结整理..."**（合并分析阶段）会卡**很久很久**，进度不前进、界面看起来像死掉。
- 长时间等待后，**有时**会直接输出错误文本：
  > `[多Agent叙事系统出错：正常流水线和fallback流水线均执行失败，请检查控制台日志和API连接。]`
- 卡住期间点"停止"按钮通常无效，只能刷新页面。

---

## 2. 复现步骤

1. 启用插件，使用**条目较多的世界书**或较长的对话历史。
2. 发送一条消息触发生成。
3. 观察进度条停在"正在创作故事..."或"正在总结整理..."较长时间。
4. 若 API 端持续报错（上下文超长/限流/网络异常），等待后出现"多Agent叙事系统出错"提示。

---

## 3. 影响范围

- 所有 Pipeline 路径（完整流水线、合并写作模式、fallback）都会经历写作 + 合并分析两次大调用，均可能卡顿。
- 卡顿时发送按钮被禁用、显示停止按钮（`bridge.js` `_onGenerationEnded`），用户无法继续操作，只能刷新。

---

## 4. 根因分析

### 4.1 卡顿根因一：LLM 调用没有任何超时/中止机制

所有 LLM 调用统一走 `llm.js` 的 `callLLM`（`llm.js:17`）：

```js
const result = await ctx.generateRaw({ prompt: messages });
```

- 全项目**不存在** `AbortController`、Promise 超时包装或 `generateRaw` 超时参数（已全局检索确认，仅有错误文案里的 "timeout" 字符串判断）。
- SillyTavern 的 `generateRaw` 本身支持第二个参数 `signal`（用于停止按钮的中止），但此处**没有传**。
- 后果：当 API 请求挂起（网络中断但连接未断开、API 服务端无响应、代理卡住）时，`generateRaw` 的 Promise **永不 settle**，pipeline 永远停留在当前阶段（"正在创作故事..." 或 "正在总结整理..."）。

### 4.2 卡顿根因二：停止按钮无法中断进行中的请求

- 停止按钮只是把 `orchestrator._shouldCancel` 置为 `true`（`bridge.js`）。
- `_shouldCancel` 仅在阶段之间的 `_cancelCheck()` 生效（`orchestrator.js` 各 Phase 之间），**无法中断正在执行的 `generateRaw`**。
- 因此一旦卡在 LLM 调用内部，点停止没有反应，只能刷新页面。

### 4.3 卡顿根因三：每轮多次顺序大调用 + 重试翻倍

一次用户输入实际触发 4~6 次顺序 LLM 调用：

```
中继占位符调用（快）
→ 规划 Agent（1 次）
→ 工具调用（0~5 次，若有 planning 工具）
→ 写作 Agent（1 次，输出长正文，耗时占比最大）
→ 合并分析 Agent（1 次，输入为全量上下文）
```

每次调用都注入全量世界书常量条目（`constant=true` 全部无条件注入）。在慢 API 或大世界书下，单次调用可达几十秒到数分钟，**单轮总耗时 = 各次调用之和**，用户感知为"卡很久很久"。

另外 `llm.js:8-11` 默认 `maxRetries = 1`：对网络错误 / 429 / 5xx / 超时类错误会**再调用一次**，单次失败时长直接翻倍。

### 4.4 报错根因：fallback 原样重跑两个昂贵调用，持续性错误必然再次失败

`pipeline()` 的 catch（`orchestrator.js:311-314`）：

```js
if (isApiFailure(error)) {
  this._reportProgress("API请求失败，尝试降级处理...");
}
const result = await this._fallbackPipeline(userInput, turnId);
```

`_fallbackPipeline`（`orchestrator.js:828`）会把 **`runWritingAgent` + `runMergedAnalysisAgent` 用同样的超大 prompt 原样再跑一遍**。

- 若主流程失败原因是**持续性**错误——最常见的是**上下文超长**（世界书 + 历史窗口 + 状态摘要超过模型上限）、429 限流、网络断开——fallback 会以同样条件再次失败。
- fallback 再次失败时（`orchestrator.js:891/895`）输出错误文案 `[多Agent叙事系统出错：正常流水线和fallback流水线均执行失败...]`。
- 同时总耗时约为正常流程的 **2 倍**（先卡主流程，再卡 fallback），加剧"卡很久"的观感。

### 4.5 上下文超长是"多Agent出错"的最常见诱因

- 每个 Agent 的 prompt 都包含：全量 `worldinfo1`（系统条目）+ `worldinfo2`（before_char 常驻）+ `worldinfo3`（关键词/after_char 条目）+ 最近 N 轮历史 + 状态摘要 + 用户输入。
- 世界书条目越多、对话越长，越容易触发模型上下文上限错误。
- 插件**不监控各 Agent prompt 的 token 数**（README 已知限制第 8 条），没有提前裁剪或警告，只能等 API 报错后走 fallback、再报错。

---

## 5. 次要观察（非本 bug 直接原因）

1. **合并分析失败会被静默吞掉**：`runMergedAnalysisAgent` 抛错时 catch 返回 `{ events: [], summary_entries: [] }`，本轮状态/摘要缺失但流程继续，用户无感知（不报"多Agent出错"，但状态会错位）。
2. **代码工具无沙箱**：`new Function("params", "state", code)` 在浏览器主线程执行（README 已知限制第 3 条）。若自定义工具死循环（如 `while(true)`），pipeline 会永久卡在工具阶段，停止按钮同样无效。
3. **MVU 调用无超时**：`_getStateSummary` / `prefetchState` 调用 `Mvu.getMvuData(...)` 同样无超时包装（有 try/catch 但无超时），若 MVU 扩展异常挂起也会拖慢/卡住流程。

---

## 6. 验证方法

1. 打开浏览器控制台（F12），复现卡顿时观察日志：
   - `[LLMClient] writing 调用, messages 数量: N` → 卡在写作调用，等待 `writing 返回`。
   - 若出现 `Pipeline error:` 后跟 `[NA] ...` 错误，再跟 `Using fallback pipeline`，则是走了 fallback 重跑。
2. 检查 API 错误信息：上下文超长（`context length` / `maximum context`）、429、网络错误是"多Agent出错"的常见触发。
3. 卡住时点"停止"并观察：日志中不会立即出现 `Pipeline cancelled`，证明进行中的请求无法被中断。

---

## 7. 修复建议（仅供参考，未实施）

1. **给 LLM 调用加超时与中止**（核心）：
   - `callLLM` 对 `generateRaw` 增加超时包装（如 `Promise.race` 30~60s）或传入 `AbortSignal`，并与 SillyTavern 停止按钮打通，让"停止"能真正中断请求。
2. **fallback 降级策略**：
   - 不要原样重跑两个大调用；失败时改为单次合并输出（如 `runMergedWritingAgent`），或仅重试写作、跳过合并分析。
3. **上下文预算控制**：
   - 估算各 Agent prompt 的 token 数，超限前自动裁剪世界书/历史窗口，或给出明确警告（README 已知限制第 8 条）。
4. **代码工具看门狗**：
   - 对 `new Function` 工具执行加超时中断，防止死循环永久卡死。

---

## 8. 相关代码位置

| 文件 | 行号 | 说明 |
| --- | --- | --- |
| `llm.js` | 17 | `generateRaw` 调用（无超时、无 signal） |
| `llm.js` | 8-11 | 默认 `maxRetries=1` 重试逻辑 |
| `orchestrator.js` | 311-314 | 主流程失败 → 进入 fallback |
| `orchestrator.js` | 828 | `_fallbackPipeline`：原样重跑写作 + 合并分析 |
| `orchestrator.js` | 891 / 895 | "多Agent叙事系统出错"错误文案 |
| `orchestrator.js` | 462 / 483 | 完整流水线"正在创作故事..." / "正在总结整理..." |
| `orchestrator.js` | 915 / 957 | 合并写作模式的两个阶段进度提示 |
| `orchestrator.js` | 500-535 | 合并分析失败被静默吞掉 |
| `bridge.js` | 205-260 | 停止按钮仅置 `_shouldCancel`，无法中断请求 |
| `utils.js` | 215-225 | `isApiFailure` 错误分类 |
