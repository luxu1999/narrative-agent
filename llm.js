import { getSTContext } from "./utils.js";

let llmCallCount = 0;
let globalCancelCheck = null;

// 默认单次 LLM 调用超时（180s）：覆盖正常慢速生成，同时避免请求挂死时无限等待
// 可被 options.timeoutMs 覆盖
 export const DEFAULT_LLM_TIMEOUT_MS = 180000;

// 注册全局取消检测函数（由 orchestrator 传入，指向停止按钮置位的 _shouldCancel）
export function setCancelCheck(fn) {
  globalCancelCheck = typeof fn === "function" ? fn : null;
}

export async function callLLM(messages, options) {
  llmCallCount++;
  const label = (options && options.label) || `call_${llmCallCount}`;
  const maxRetries = (options && options.retries) || 1;
  const timeoutMs = (options && options.timeoutMs) || DEFAULT_LLM_TIMEOUT_MS;
  // 可选的生成 token 上限：>0 时透传 generateRaw 的 responseLength，临时覆盖 ST 的 Response Length 设置
  // （不传则沿用 ST 当前配置；若 ST 的 Response Length 设得过小，正文会被截断写不满字数）
  const responseLength = (options && typeof options.responseLength === "number" && options.responseLength > 0)
    ? options.responseLength
    : null;

  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) console.log(`[LLMClient] ${label} \u91cd\u8bd5 ${attempt}/${maxRetries}`);
      const ctx = getSTContext();
      if (!ctx) throw new Error("SillyTavern context not available");
      const promptSize = Array.isArray(messages)
        ? messages.reduce((sum, m) => sum + (m && m.content ? String(m.content).length : 0), 0)
        : 0;
      console.log(`[LLMClient] ${label} \u8c03\u7528, messages \u6570\u91cf: ${messages.length}, \u63d0\u793a\u8bcd\u5b57\u7b26\u6570: ${promptSize}${promptSize > 120000 ? " ⚠️ \u5f88\u5927\uff0c\u53ef\u80fd\u89e6\u53d1\u4e0a\u4e0b\u6587\u4e0a\u9650" : ""}`);
      // generateRaw 在 ST 本版本不接受 signal，无法真正中止请求；
      // 用「超时 + 取消轮询」包装：超时抛错（不重试），停止按钮轮询立即中断等待
      const result = await withTimeoutWithCancel(() => ctx.generateRaw({ prompt: messages, responseLength }), timeoutMs, () => globalCancelCheck && globalCancelCheck());
      const text = extractText(result);
      if (!text || (typeof text === "string" && text.trim().length === 0)) {
        throw new Error("[LLMClient] generateRaw \u8fd4\u56de\u7a7a\u5185\u5bb9\uff0c\u8bf7\u6c42\u53ef\u80fd\u88ab\u53d6\u6d88\u6216API\u9519\u8bef");
      }
      console.log(`[LLMClient] ${label} \u8fd4\u56de, \u957f\u5ea6:`, text.length);
      return text;
    } catch (err) {
      lastErr = err;
      if (isAbortError(err)) throw new Error("Pipeline cancelled");
      if (err && err.timeout) {
        // 超时不重试，避免单次失败时长翻倍（挂起场景重试只会再等一个超时）
        console.error(`[LLMClient] ${label} \u8d85\u65f6(${timeoutMs}ms)\uff0c\u4e0d\u91cd\u8bd5\uff0c\u8fdb\u5165\u964d\u7ea7\u6d41\u7a0b`);
        break;
      }
      if (!isRetryable(err)) break;
    }
  }
  console.error(`[LLMClient] ${label} \u5931\u8d25:`, lastErr);
  throw lastErr || new Error(`[LLMClient] ${label} failed`);
}

// 超时 + 取消轮询的等待包装：
// - timeoutMs 到期 → reject（.timeout=true）
// - cancelCheck() 返回 true（用户点了停止）→ reject("Pipeline cancelled")，200ms 内响应
// - 底层 generateRaw 无法真正中止，被放弃的 Promise 由 Promise.race 接管，不会产生 unhandled rejection
export function withTimeoutWithCancel(fn, timeoutMs, cancelCheck) {
  let timer = null;
  let interval = null;
  const cancelPromise = new Promise((_, reject) => {
    interval = setInterval(() => {
      if (cancelCheck && cancelCheck()) {
        reject(new Error("Pipeline cancelled"));
      }
    }, 200);
  });
  return Promise.race([
    Promise.resolve().then(fn),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`LLM \u8c03\u7528\u8d85\u65f6(${timeoutMs}ms)`);
        e.timeout = true;
        reject(e);
      }, timeoutMs);
    }),
    cancelPromise,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
    if (interval) clearInterval(interval);
  });
}

export function extractText(result) {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    if (result.choices?.[0]?.message?.content) return result.choices[0].message.content;
    if (result.message?.content) return result.message.content;
  }
  return String(result || "");
}

export function isAbortError(err) {
  const msg = (err && err.message) || "";
  return msg.includes("Pipeline cancelled") || msg.includes("abort") || msg.includes("Abort") || msg.includes("Cancelled by stop");
}

export function isRetryable(err) {
  const msg = (err && err.message) || "";
  if (msg.includes("fetch") || msg.includes("network") || msg.includes("ECONN")) return true;
  if (msg.includes("timeout") || msg.includes("ETIMEDOUT")) return true;
  if (msg.includes("429") || msg.includes("rate")) return true;
  if (/\b5\d{2}\b/.test(msg)) return true;
  return false;
}