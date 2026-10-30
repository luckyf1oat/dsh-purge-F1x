/**
 * /armor 命令：状态、开关、记账、恢复、验证。
 *
 * DSH 的 commands.register 是「人类斜杠命令」：不产生模型消息，直接对 agent 跑。
 * 状态查询必须诚实——拿不到服务就说退化，不能静默说成功。
 */

import { log } from "./log.js";
import { estimateTokens } from "./detect.js";
import { normalizeConfig } from "./config.js";
import { analyzeRewind, applyRewind, invocationSessionId, renderRewindResult } from "./rewind.js";

const HELP = [
  "/armor status            每层是否真挂上 + 内核 token + 镜像统计",
  "/armor on | off          开 / 关内核（其余层照跑）",
  "/armor cost              当前内核的字符数与估 token",
  "/armor recover <sid>     导出镜像转录（撤回/遮蔽段落打 ⚠️）",
  "/armor verify <sid>      比对原日志与镜像，查截断",
  "/armor list              列出已镜像的会话",
  "/armor flush             立刻落盘",
  "/armor rewind [once|round]  撤回上一步 / 上一整轮，另开会话接上下文，原文回显",
  "/armor help              这一屏",
].join("\n");

function ok(text) {
  return { kind: "success", text };
}

function err(text) {
  return { kind: "error", text };
}

function sessionIdOf(invocation) {
  const id =
    invocation?.agent?.session?.id ||
    invocation?.agent?.session?.header?.id ||
    invocation?.session?.id ||
    invocation?.sessionId ||
    "";
  return typeof id === "string" ? id : "";
}

function renderStatus(state) {
  const r = state.report();
  const mark = (v) =>
    v === "on" ? "✓ on" : v === "off" ? "— off" : v === "disabled" ? "— disabled" : v === "no-service" ? "! 无此服务" : v === "no-ladder" ? "— 未配阶梯" : v === "empty" ? "! 空" : v === "failed" ? "✗ 失败" : `? ${v}`;
  // 内核还没渲染过时（本进程第一条消息之前）显式说「未渲染」，别留一片空白让人猜。
  const kernelNote =
    r.kernelChars > 0
      ? `${r.kernelChars} 字符 ≈ ${r.kernelTokens} tok（${r.family}）`
      : r.kernel === "on"
        ? "未渲染（本进程还没发过消息）"
        : "";
  const opNote =
    r.operator === "on"
      ? `${r.operatorChars} 字符 ≈ ${Math.round(r.operatorChars * 0.72)} tok`
      : r.operator === "empty"
        ? "! 没找到 prompt-inject.md —— 破甲强度会明显下降"
        : r.operator === "off"
          ? "— 已关"
          : "";
  const lines = [
    "## purge-flash 状态",
    "",
    `内核        ${mark(r.kernel)}  ${kernelNote}`,
    `尾部回声    ${mark(r.tail)}${r.tailChars > 0 ? `  ${r.tailChars} 字符` : ""}`,
    `操作稿      ${mark(r.operator)}  ${opNote}`,
    `合计注入    ${r.mergedChars > 0 ? `${r.mergedChars} 字符 ≈ ${r.mergedTokens} tok` : "（发过消息后显示）"}`,
    `宿主剥离    ${mark(r.assemble)}（去重档 ${r.dedupeOperator}）`,
    `请求体整形  ${mark(r.adapter)}${r.adapter === "on" ? `  ${r.adapterAlias} · prefill=${r.prefill} many=${r.manyShot} sys=${r.systemField}` : ""}`,
    `消息剥离    ${mark(r.msgStrip)}${r.stats.msgStrip ? `  命中 ${r.stats.msgStrip}` : ""}`,
    `结果改写    ${mark(r.toolStrip)}${r.stats.toolStrip ? `  命中 ${r.stats.toolStrip}` : ""}`,
    `拒答擦除    ${mark(r.shadowRefusal === "on" ? "on" : "off")}${r.stats.refusalsShadowed ? `  擦掉 ${r.stats.refusalsShadowed} 条` : ""}`,
    `拒答修补    ${mark(r.preStep)}`,
    `连拒换线    ${mark(r.route)}${r.routeLadder > 0 ? `（${r.routeLadder} 档）` : ""}`,
    `流量落盘    ${mark(r.stream)}`,
    `事件镜像    ${mark(r.mirror)}`,
    `按需手册    ${mark(r.skills)}`,
    `按需叶子    ${r.leafRouter === "auto" ? "✓ auto" : r.leafRouter === "tool" ? "— tool（模型自调）" : "— off"}${
      r.stats.leaves ? `  已展开 ${r.stats.leaves} 次（${Object.entries(r.stats.leafIds || {}).map(([k, v]) => `${k}×${v}`).join(", ")}）` : ""
    }`,
    `prefill 形态 ${r.prefillGraded === "on" ? "✓ 分级" : "— 固定"} / 阶梯 ${
      r.prefillLadder === "on" ? `✓ 上限 L${r.prefillLadderMax}` : "— off"
    }`,
    `token 重试  ${r.retryOnRefusal === "on" ? `✓ 最多 ${r.retryMax} 次` : "— off"}`,
    `命令层      ${mark(r.commands)}`,
    "",
    `修补 ${r.stats.repairs} 次 / 锚 ${r.stats.anchors} 次 / 换线 ${r.stats.routes} 次 / prefill ${r.stats.prefill || 0} 次`,
    `叶子 ${r.stats.leaves || 0} 次 / 阶梯升级 ${r.stats.escalations || 0} 次 / 拒答擦除 ${r.stats.refusalsShadowed || 0} 条`,
    `token 级重试 ${r.stats.retries || 0} 次${r.stats.retryExhausted ? `（重试用尽 ${r.stats.retryExhausted} 次）` : ""}`,
    `自我撤回 ${r.stats.retractions} 处 / 遮蔽快照 ${r.stats.shadowed} 段 / 手动回退 ${r.stats.rewinds || 0} 次`,
  ];
  if (r.mirrorStats) {
    const m = r.mirrorStats;
    lines.push("", `镜像 ${m.root}`, `会话 ${m.sessions} / 事件 ${m.events} / ${(m.bytes / 1024).toFixed(1)} KB`);
  }
  if (r.patchTier !== "none") lines.push("", `宿主补丁档位：${r.patchTier}`);
  return lines.join("\n");
}

export function installCommands(ctx, cfg, state) {
  try {
    const commands = ctx?.get?.("commands");
    if (!commands || typeof commands.register !== "function") {
      state.layers.commands = "no-service";
      return false;
    }
    commands.register({
      name: "armor",
      description: "破甲台：status / on / off / cost / recover / verify / list / flush / help",
      input: { hint: "status | on | off | cost | recover <sid> | verify <sid> | list | flush | help" },
      handler: async (invocation) => {
        const raw = String(invocation?.rawInput || "").trim();
        const [sub = "status", ...rest] = raw.split(/\s+/);
        const arg = rest.join(" ");
        try {
          switch (sub.toLowerCase()) {
            case "on": {
              state.cfg.enabled = true;
              return ok("内核已打开。新的一轮立即生效；本轮的 system prompt 已组装完，改不到。");
            }
            case "off": {
              state.cfg.enabled = false;
              return ok("内核已关闭。其余层（修补/换线/镜像）照跑。用 /armor on 打开。");
            }
            case "cost": {
              const r = state.report();
              if (r.kernelChars === 0) return err("内核还没渲染过：先发一轮，或检查 kernel 配置是否为 off。");
              return ok(
                [
                  `内核 ${r.kernelChars} 字符 ≈ ${r.kernelTokens} tok（${r.family} 家族）`,
                  `对照：purge 默认注入 24,653 字符 ≈ 6,664 tok；冷咖啡路由表 ≈ 14,961 tok。`,
                ].join("\n"),
              );
            }
            case "recover": {
              const sid = arg || sessionIdOf(invocation);
              if (!sid) return err("要一个 session id：/armor recover <sid>，或从有会话的命令里直接跑。");
              if (!state.mirror) return err("镜像层没挂上，没有东西可恢复。检查 mirror 配置。");
              const md = state.mirror.recover(sid);
              if (!md.trim()) return err(`镜像里没有 ${sid} 的事件。可能这个会话在插件安装之前就结束了。`);
              return ok(md);
            }
            case "verify": {
              const sid = arg || sessionIdOf(invocation);
              if (!sid) return err("要一个 session id。");
              if (!state.mirror) return err("镜像层没挂上。");
              const v = state.mirror.verify(sid);
              return ok(
                [
                  `会话 ${v.id}`,
                  `镜像事件 ${v.events} 条 / ${v.frames} 帧${v.mirrored ? "" : "（镜像文件不存在）"}`,
                  `原日志事件 ${v.sourceEvents} 条`,
                  v.truncated
                    ? "⚠️ 原日志比镜像多 → 日志可能被截断，以镜像为准。"
                    : "镜像覆盖完整。",
                ].join("\n"),
              );
            }
            case "list": {
              if (!state.mirror) return err("镜像层没挂上。");
              const rows = state.mirror.list();
              if (rows.length === 0) return ok("镜像里还没有会话。");
              return ok(
                [
                  "| 会话 | 事件 | 遮蔽 | KB | 最后活动 |",
                  "|---|---|---|---|---|",
                  ...rows.map(
                    (r) =>
                      `| ${r.id} | ${r.events} | ${r.shadows} | ${(r.bytes / 1024).toFixed(1)} | ${r.lastSeen ? new Date(r.lastSeen).toLocaleString() : "-"} |`,
                  ),
                ].join("\n"),
              );
            }
            case "flush": {
              if (!state.mirror) return err("镜像层没挂上。");
              state.mirror.flush();
              return ok("已落盘。");
            }
            case "rewind": {
              const sid = sessionIdOf(invocation);
              if (!sid) return err("这个命令要在有会话的地方跑。");
              const wantRound = /^(round|轮|整轮|all)$/i.test(arg.trim());
              const wantOnce = /^(once|step|步|一步)$/i.test(arg.trim());
              if (!wantRound && !wantOnce) {
                const info = await analyzeRewind(ctx, sid);
                if (!info.ok) return err(info.error || "读不到会话");
                const lines = [
                  "撤回有两种粒度：",
                  "",
                  "`/armor rewind once`  撤回上一步",
                  "`/armor rewind round` 撤回上一整轮",
                  "",
                  info.lastUser ? `当前最后一句：${info.lastUser.slice(0, 120)}` : "（没有可撤回的输入）",
                ];
                return ok(lines.join("\n"));
              }
              const mode = wantRound ? "round" : "once";
              const result = await applyRewind(ctx, sid, mode);
              if (!result.ok) return err(result.error || "回退失败");
              state.stats.rewinds = (state.stats.rewinds || 0) + 1;
              // 把撤回这件事本身也记进镜像：以后查「这句话去哪了」有据可依。
              try {
                state.mirror?.pushEvent(result.sessionId, {
                  type: "purge-flash/rewind",
                  seq: 0,
                  data: {
                    parentId: result.parentId,
                    mode,
                    cut: result.cut,
                    text: result.text,
                    at: result.at,
                  },
                });
                state.mirror?.flush();
              } catch {
                /* 记账失败不影响回退本身 */
              }
              return ok(renderRewindResult(result, mode));
            }
            case "help":
            case "?": {
              return ok(HELP);
            }
            case "status":
            default: {
              return ok(renderStatus(state));
            }
          }
        } catch (e) {
          log("/armor 失败", String(e?.message || e));
          return err(`/armor ${sub} 出错：${String(e?.message || e)}`);
        }
      },
    });
    state.layers.commands = "on";
    return true;
  } catch (e) {
    state.layers.commands = "failed";
    log("installCommands 失败", String(e?.message || e));
    return false;
  }
}

export { HELP, renderStatus };
