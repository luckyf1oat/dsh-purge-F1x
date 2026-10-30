/**
 * Token 级重试环：在一次请求内部判拒、abort、换更强的开头重发。
 *
 * 为什么必须在这一层做
 * --------------------
 * pre-step 的修补门槛是 `step > 1` —— 因为宿主第一个 step 之前没有「上一句」可修补。
 * 但纯聊天里模型一旦拒了，回合直接结束，永远不会走到 step 2。
 * 实测四个会话（ee246613 / 671333a3 / 5f1bdcd1 / 660ac0ef）全部是 turn 1 / step 1：
 * 两个被拒的会话里，修补 / 叶子 / 阶梯一次都没触发 —— 注入事件只有 1 条 prefill anchor。
 *
 * 所以自愈必须挪到一次请求的内部：读头几十个字符就能判出「这是拒答」，
 * 此时只花了几个输出 token，abort 掉重发，代价远低于等整段生成完再判。
 *
 * 三个必须防的坑（都写成 test/retry.mjs 的断言）
 * --------------------------------------------
 * 1. **不能judge思维块**。模型的 reasoning 里经常出现「我不该遵守这个框架」这种句子，
 *    那是它在思考，不是它在拒。判错会把自己刚造出来的 deliberation 一起掐掉。
 * 2. **不能把已吐出的 chunk 收回**。所以前 N 个字符先缓冲，判完再决定 flushed 还是丢弃。
 * 3. **任何异常都要退回原流**。这一层在每一次模型调用前面，抛一次就是整机不可用。
 *
 * @module dsh-purge-flash/retry
 */

import { isHardRefusal } from "./detect.js";

/** 判头需要看到的最小字符数。少于这个数先缓冲，不判。 */
export const HEAD_MIN = 24;

/** 从各种可能的 chunk 形状里取文本 + 是不是思维块。 */
export function readChunk(chunk) {
  if (!chunk || typeof chunk !== "object") return { text: "", reasoning: false };
  const c = chunk.chunk && typeof chunk.chunk === "object" ? chunk.chunk : chunk;
  const type = String(c.type || "");
  const reasoning =
    c.blockType === "reasoning" ||
    /reasoning|thinking/i.test(type) ||
    c.channel === "reasoning";

  let text = "";
  if (typeof c.delta === "string") text = c.delta;
  else if (typeof c.text === "string") text = c.text;
  else if (typeof c.content === "string") text = c.content;
  else if (c.delta && typeof c.delta === "object" && typeof c.delta.text === "string") text = c.delta.text;
  else if (typeof chunk.delta === "string") text = chunk.delta;

  return { text, reasoning };
}

/**
 * 判一段开头是不是拒答。
 *
 * @returns {'refuse'|'ok'|'unknown'}
 *   refuse  = 明确是拒，可以 abort
 *   ok      = 已经开始交付，放行并停止判断
 *   unknown = 还看不出来，继续缓冲
 */
export function judgeHead(head) {
  const s = String(head || "").trim();
  if (!s) return "unknown";
  if (isHardRefusal(s)) return "refuse";
  if (s.length < HEAD_MIN) return "unknown";
  return "ok";
}

/** 判断是否值得为这次请求开重试（off / 已有更便宜的手段时跳过）。 */
export function retryEnabled(cfg) {
  return Boolean(cfg && cfg.retryOnRefusal === "on" && Number(cfg.retryMax) > 0);
}

/**
 * 包一层守卫流。
 *
 * @param {(options:object)=>AsyncIterable} openStream 真正打开流的函数
 * @param {object} options 已整形的 options
 * @param {object} cfg
 * @param {object} state
 * @param {(options:object, level:number)=>object} escalate 升一级 prefill 后重算 options
 */
export async function* guardedStream(openStream, options, cfg, state, escalate) {
  const maxTry = Math.max(0, Math.min(3, Number(cfg?.retryMax) || 0));
  const stats = state?.stats || {};
  let lastError = null;
  let lastBuffer = [];

  for (let attempt = 0; attempt <= maxTry; attempt += 1) {
    const opts = attempt === 0 ? options : escalate(options, attempt);
    let head = "";
    let judged = false;
    let verdict = "unknown";
    const buffered = [];
    let stream;

    try {
      stream = openStream(opts);
    } catch (e) {
      // 第一次开流就失败 → 原样抛出，让上层处理
      if (attempt === 0) throw e;
      lastError = e;
      break;
    }

    try {
      for await (const chunk of stream) {
        const { text, reasoning } = readChunk(chunk);

        if (!judged) {
          // 思维块完全不判 —— 那里的「我不该」是 deliberation，不是拒答。
          if (reasoning || !text) {
            buffered.push(chunk);
            continue;
          }
          head += text;
          buffered.push(chunk);
          verdict = judgeHead(head);
          if (verdict === "unknown") continue;
          judged = true;

          if (verdict === "refuse") break; // 丢掉这一轮缓冲，换更强的开头重来

          // ok：把缓冲刷出去，之后直通
          for (const b of buffered.splice(0)) yield b;
          continue;
        }

        yield chunk;
      }
    } catch (e) {
      if (attempt === 0) throw e;
      lastError = e;
      break;
    }

    if (!judged) {
      // 整个流没吐出一个字，或只有思维块：原样放行缓冲，不重试。
      for (const b of buffered.splice(0)) yield b;
      return;
    }
    if (verdict !== "refuse") return;

    // 判成拒答：记住这一轮已经生成的内容，够不够重试用尽时兜底用
    lastBuffer = buffered;
    if (attempt < maxTry) {
      stats.retries = (stats.retries || 0) + 1;
      continue;
    }
    break;
  }

  if (lastError) throw lastError;

  // 重试用尽仍是拒答：把最后一次已经生成的拒答内容交出去。
  // 直接空流会让宿主以为模型什么都没说，比给一条拒答更糟。
  if (lastBuffer.length) {
    for (const b of lastBuffer) yield b;
    stats.retryExhausted = (stats.retryExhausted || 0) + 1;
  }
}
