/**
 * 流层：在模型输出的水管上开一个三通，一边给你看，一边落盘。
 *
 * 为什么要在 llm/stream 而不是等 assistant/message
 * -----------------------------------------------
 * assistant/message 是「已结算」的结果。模型自己中途收回、宿主中断、
 * 或者上层做 replace 遮蔽，都发生在结算之后或之外。流块是唯一的原始物证：
 * 它按 token 到达顺序落盘，谁之后怎么改都改不到它。
 *
 * 只对 loop 自己造的请求做（有 sessionId 的那些），免得把标题生成、
 * 压缩摘要这类旁路请求也录进来。
 */

import { log } from "./log.js";

const SKIP_FINISH_KINDS = new Set(["error", "aborted"]);

export function installStream(ctx, cfg, mirror, state) {
  try {
    if (!cfg.rawStream || !mirror) {
      state.layers.stream = "off";
      return false;
    }
    if (typeof ctx?.on !== "function") {
      state.layers.stream = "no-service";
      return false;
    }

    const off = ctx.on(
      "llm/stream",
      (options, next) => {
        let downstream;
        try {
          downstream = typeof next === "function" ? next() : options;
        } catch (e) {
          log("stream 下游调用失败", String(e?.message || e));
          throw e;
        }
        try {
          const sid = options?.sessionId;
          if (typeof sid !== "string" || sid.length === 0) return downstream;
          if (!downstream || typeof downstream[Symbol.asyncIterator] !== "function") return downstream;
          const turn = options?.turn ?? 0;
          const step = options?.step ?? 0;
          return mirror.teeStream(sid, turn, step, downstream);
        } catch (e) {
          log("stream tee 失败，放行原始流", String(e?.message || e));
          return downstream;
        }
      },
      { global: true },
    );

    state.layers.stream = "on";
    state.streamDisposer = off;
    return true;
  } catch (e) {
    state.layers.stream = "failed";
    log("installStream 失败", String(e?.message || e));
    return false;
  }
}

/** 从 chunk 序列里抽可见文本（自测用）。 */
export function textFromChunks(chunks) {
  const parts = [];
  for (const c of Array.isArray(chunks) ? chunks : []) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "text-delta" && typeof c.text === "string") parts.push(c.text);
    else if (c.type === "block-end" && c.block?.type === "text" && typeof c.block.text === "string") parts.push(c.block.text);
  }
  return parts.join("");
}

export { SKIP_FINISH_KINDS };
