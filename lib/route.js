/**
 * 请求配置改写：三件事都挂在 `agent/request` 这一个 waterfall 上。
 *
 * 1. **provider 改别名** —— 把 `deepseek` 换成 `deepseek-armor`，请求才会
 *    流经我们的代理 adapter（prefill / many-shot 在那里生效）。
 * 2. **采样** —— `temperature` / `maxTokens`。这是唯一能直接改采样参数的公开口子。
 * 3. **连拒换线** —— 同一 turn 里拒到阈值就换到阶梯下一档。
 *
 * 为什么三件事放一个监听
 * ----------------------
 * `agent/request` 是 waterfall，多个监听会层层叠。分三个监听就要处理
 * 「谁先谁后」「谁覆盖谁」，一个监听按固定顺序改一份 config 更好推。
 *
 * 依据
 * ----
 * `agent/request` 的返回值就是真正要发的 LlmCallConfig（provider / model /
 * reasoningEffort / temperature / maxTokens / stop），dsh-agent 自己的
 * installModelSelection 也用它改选中模型 —— 官方口子，不是破解。
 *
 * 防死循环
 * --------
 * 同一 (turn) 每档最多用一次；总切换次数 <= 阶梯长度。
 */

import { log } from "./log.js";

export function installRoute(ctx, cfg, state) {
  try {
    const ladder = Array.isArray(cfg.routeLadder) ? cfg.routeLadder : [];
    // provider 别名只在 adapter 层真的挂上时才切，否则一切就 NO_ADAPTER。
    const wantAlias = Boolean(cfg.adapterAlias) && state.layers.adapter === "on";
    const wantSampling = cfg.temperature !== null || cfg.maxTokensFloor !== null;
    const wantLadder = ladder.length > 0;

    if (!wantAlias && !wantSampling && !wantLadder) {
      state.layers.route = "off";
      return false;
    }
    if (typeof ctx?.on !== "function") {
      state.layers.route = "no-service";
      return false;
    }

    const off = ctx.on(
      "agent/request",
      async (payload, next) => {
        const resolved = typeof next === "function" ? await next() : payload;
        try {
          if (!resolved || typeof resolved !== "object") return resolved;
          let out = resolved;

          // 1) provider 别名（必须最先，后面的换线可能再覆盖）
          if (wantAlias && out.provider && out.provider !== cfg.adapterAlias) {
            out = { ...out, provider: cfg.adapterAlias };
            state.stats.alias = (state.stats.alias || 0) + 1;
          }

          // 2) 采样
          if (wantSampling) {
            let touched = false;
            const patch = { ...out };
            if (cfg.temperature !== null && patch.temperature !== cfg.temperature) {
              patch.temperature = cfg.temperature;
              touched = true;
            }
            if (
              cfg.maxTokensFloor !== null &&
              (patch.maxTokens === undefined || patch.maxTokens === null || patch.maxTokens < cfg.maxTokensFloor)
            ) {
              patch.maxTokens = cfg.maxTokensFloor;
              touched = true;
            }
            if (touched) out = patch;
          }

          // 3) 连拒换线
          if (wantLadder) {
            const agent = payload?.agent;
            const sid = agent?.id || agent?.session?.id || "";
            const turn = Number(payload?.turn) || 0;
            const key = `${sid}:${turn}`;
            const refusals = state.refusals.get(key) || 0;
            if (refusals >= cfg.routeAfterRefusals) {
              const slot = state.routeSlot.get(key) || 0;
              if (slot < ladder.length) {
                const pick = ladder[slot];
                state.routeSlot.set(key, slot + 1);
                const same = out.provider === pick.provider && out.model === pick.model;
                if (!same) {
                  state.stats.routes += 1;
                  log("换线", `${out.provider}/${out.model}`, "→", `${pick.provider}/${pick.model}`);
                  out = { ...out, provider: pick.provider, model: pick.model };
                }
              }
            }
          }

          return out === resolved ? resolved : out;
        } catch (e) {
          log("route 改写失败，放行原值", String(e?.message || e));
          return resolved;
        }
      },
      { global: true },
    );

    state.layers.route = "on";
    state.routeDisposer = off;
    return true;
  } catch (e) {
    state.layers.route = "failed";
    log("installRoute 失败", String(e?.message || e));
    return false;
  }
}

/** 拒绝计数：由 index 在事件流里调用。 */
export function noteRefusal(state, sessionId, turn) {
  const key = `${sessionId || ""}:${Number(turn) || 0}`;
  state.refusals.set(key, (state.refusals.get(key) || 0) + 1);
  if (state.refusals.size > 400) {
    const first = state.refusals.keys().next().value;
    if (first !== undefined) state.refusals.delete(first);
  }
}
