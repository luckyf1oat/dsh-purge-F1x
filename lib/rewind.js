/**
 * 撤回：把最后一轮/最后一步撤掉，另开一个接得上上下文的会话。
 *
 * 为什么不用 purge 那套客户端
 * --------------------------
 * purge 的 `/rewind` 是宿主 fork + 510 KB 的 client.js 把撤回的那句话塞回输入框。
 * 那份客户端只为这一件事就要 500 KB，而且要跟着宿主前端一起升级。
 * 这里改成：命令结果里直接给出撤回的原文（可复制），同时落进镜像。
 * 少一个前端，功能不掉。
 *
 * 机制（照 DSH 官方接口，不 hack）
 * ------------------------------
 * 1. sessionController.fork({ sessionId, atSeq }) —— 从某个事件序号切开，新会话接上之前的上下文
 * 2. workspaceRegistry.archiveSession —— 把旧会话从侧栏藏掉
 * 3. 撤回的那句话写进 draft 记录 + 镜像，命令返回原文
 *
 * 为什么 fork 而不是原地删
 * ------------------------
 * DSH 的会话日志是只追加的事件溯源，没有"删消息"这个操作。原地删 = 破坏
 * 可重建性。fork 是官方给的口子，新会话继承到 atSeq 为止的全部事件。
 */

import fs from "node:fs";
import path from "node:path";
import { log } from "./log.js";

const DRAFT_TTL_MS = 10 * 60 * 1000;
const pendingDrafts = new Map();
let lastPending = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ignoreSettled(v) {
  Promise.resolve(v).catch(() => {});
}

function errorText(err) {
  if (!err) return "回退失败";
  if (typeof err === "string") return err;
  return err.message || err.code || String(err);
}

function asEventList(events) {
  if (Array.isArray(events)) return events;
  if (events && typeof events[Symbol.iterator] === "function") {
    try {
      return [...events];
    } catch {
      return [];
    }
  }
  return [];
}

function service(ctx, name) {
  if (!ctx || typeof ctx.get !== "function") return undefined;
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

function textOfContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (block.type === "text" || typeof block.text === "string") parts.push(String(block.text ?? ""));
  }
  return parts.join("").trim();
}

function userTextFromEvent(event) {
  const data = event?.data;
  return textOfContent(data?.content ?? data?.message?.content);
}

/** 插件自己注入的消息不算「人说的那一句」。 */
function isPluginDraft(text) {
  const v = String(text || "").trim();
  if (!v) return false;
  return /^\[MNEMON\]/i.test(v)
    || /MNEMON RUNTIME MEMORY SNAPSHOT/i.test(v)
    || /^MNEMON VIEW TOOLS/im.test(v)
    || v === "已开始输出："
    || /^上一条不继承/.test(v);
}

function isRewindMarkerEvent(event) {
  if (!event || event.type !== "user/message") return false;
  const id = event.data?.id;
  return typeof id === "string" && id.startsWith("rewind-");
}

function isRoundPromptEvent(event) {
  if (!event || event.type !== "user/message" || isRewindMarkerEvent(event)) return false;
  const kind = event?.data?.source?.kind;
  if (kind === "plugin" || kind === "purge-flash") return false;
  const text = userTextFromEvent(event);
  if (!text || isPluginDraft(text)) return false;
  if (!kind || kind === "user") return true;
  if (kind === "goal") return Number.isFinite(Number(event.data?.source?.round)) && Number(event.data.source.round) >= 0;
  return false;
}

function isSubagentHeader(header) {
  if (!header) return false;
  return header.origin === "subagent" || (header.delegationDepth ?? 0) > 0;
}

function lastEventOfType(events, type) {
  const list = asEventList(events);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.type === type) return list[i];
  }
  return null;
}

function lastOpenTurn(events) {
  const list = asEventList(events);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const type = list[i]?.type;
    if (type === "turn/start") return list[i];
    if (type === "turn/end") return null;
  }
  return null;
}

function seqBefore(events, cutSeq) {
  const floor = Number(cutSeq);
  let prev = null;
  for (const row of asEventList(events)) {
    const seq = Number(row?.seq);
    if (!Number.isFinite(seq)) continue;
    if (Number.isFinite(floor) && seq >= floor) break;
    prev = seq;
  }
  return prev;
}

/**
 * 撤回时把「人说的那一句」取回来。
 *
 * DSH 的事件顺序：turn/start → user/message → step/start → assistant…
 * 所以那句话永远在 **turn/start 之后、第一个 step/start 之前**。
 *
 * 两个参数各管一段：
 *   cutSeq      = 要切掉的那段事件的起点（turn/start 或某个 step/start）
 *   turnStartSeq = 本轮 turn/start 的 seq
 *
 * 规则：
 *   1. 先在 [turnStartSeq, +∞) 里找第一条人类消息——本轮那句话就在这里。
 *   2. 找不到（本轮没有人类消息，比如是 goal 自动轮）再往前跨，取上一句。
 */
function userTextFromRange(events, fromSeq, turnStartSeq) {
  const list = asEventList(events);
  const turnFloor = Number(turnStartSeq);

  if (Number.isFinite(turnFloor)) {
    for (const event of list) {
      const seq = Number(event?.seq);
      if (!Number.isFinite(seq) || seq < turnFloor) continue;
      if (isRoundPromptEvent(event)) return userTextFromEvent(event);
    }
  }

  // 退路：本轮没有人类输入，取切点之前最近一句。
  const floor = Number(fromSeq);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i];
    const seq = Number(event?.seq);
    if (Number.isFinite(seq) && Number.isFinite(floor) && seq >= floor) continue;
    if (isRoundPromptEvent(event)) return userTextFromEvent(event);
  }

  return "";
}

function isFirstStepOfTurn(events, start) {
  if (!start) return true;
  const turn = start.data?.turn;
  const startSeq = Number(start.seq);
  return !asEventList(events).some((event) => (
    event?.type === "step/start"
    && event !== start
    && Number(event.seq) < startSeq
    && (turn == null || event.data?.turn === turn)
  ));
}

function turnStartFor(events, turn, beforeSeq) {
  const limit = Number(beforeSeq);
  let found = null;
  for (const event of asEventList(events)) {
    const seq = Number(event?.seq);
    if (Number.isFinite(limit) && Number.isFinite(seq) && seq > limit) break;
    if (event?.type === "turn/start" && (turn == null || event.data?.turn === turn)) found = event;
  }
  return found;
}

/* ------------------------------------------------------------------ 计划 */

/** once = 撤最后一步；round = 撤最后一整轮。纯函数，便于自测。 */
export function planRewind(events, mode = "once") {
  return mode === "round" ? planRewindTurn(events) : planRewindStep(events);
}

function planRewindStep(events) {
  const start = lastEventOfType(events, "step/start");
  if (!start) return planRewindTurn(events);
  const turn = start.data?.turn;
  const step = start.data?.step;
  let cutSeq = Number(start.seq);
  let turnStartSeq;
  if (isFirstStepOfTurn(events, start)) {
    const turnStart = turnStartFor(events, turn, start.seq);
    if (turnStart && Number.isFinite(Number(turnStart.seq))) {
      cutSeq = Number(turnStart.seq);
      turnStartSeq = cutSeq;
    }
  }
  if (turnStartSeq === undefined) {
    const ts = turnStartFor(events, turn, start.seq);
    if (ts && Number.isFinite(Number(ts.seq))) turnStartSeq = Number(ts.seq);
  }
  const text = userTextFromRange(events, cutSeq, turnStartSeq);
  const atSeq = seqBefore(events, cutSeq);
  if (atSeq == null) {
    if (!text) return { ok: false, error: "没有可回退的上一句" };
    return { ok: true, mode: "blank", atSeq: null, text, unit: "step", turn, step, fromSeq: cutSeq };
  }
  return { ok: true, mode: "fork", atSeq, text, unit: "step", turn, step, fromSeq: cutSeq };
}

function planRewindTurn(events) {
  const list = asEventList(events);
  const open = lastOpenTurn(list);
  let turnStart = open;
  if (!turnStart) {
    const ended = lastEventOfType(list, "turn/end");
    if (ended) turnStart = turnStartFor(list, ended.data?.turn, ended.seq) || ended;
  }
  if (!turnStart) {
    const lastUser = [...list].reverse().find((event) => isRoundPromptEvent(event));
    if (!lastUser) return { ok: false, error: "没有可回退的上一句" };
    const cutSeq = Number(lastUser.seq);
    const text = userTextFromEvent(lastUser);
    const atSeq = seqBefore(list, cutSeq);
    if (atSeq == null) return { ok: true, mode: "blank", atSeq: null, text, unit: "turn", fromSeq: cutSeq };
    return { ok: true, mode: "fork", atSeq, text, unit: "turn", fromSeq: cutSeq };
  }
  const cutSeq = Number(turnStart.seq);
  const text = userTextFromRange(list, cutSeq, cutSeq);
  const atSeq = seqBefore(list, cutSeq);
  if (!text && atSeq == null) return { ok: false, error: "没有可回退的上一句" };
  if (atSeq == null) return { ok: true, mode: "blank", atSeq: null, text, unit: "turn", fromSeq: cutSeq };
  return { ok: true, mode: "fork", atSeq, text, unit: "turn", fromSeq: cutSeq };
}

/* ------------------------------------------------------------- 草稿记录 */

function rememberDraft(sessionId, text, parentId) {
  const rec = { sessionId, parentId, text: text || "", at: Date.now() };
  pendingDrafts.set(sessionId, rec);
  lastPending = rec;
  const now = Date.now();
  for (const [id, row] of pendingDrafts) {
    if (now - row.at > DRAFT_TTL_MS) pendingDrafts.delete(id);
  }
  return rec;
}

export function getDraft(sessionId) {
  if (!sessionId) return null;
  const rec = pendingDrafts.get(sessionId);
  if (!rec) return null;
  if (Date.now() - rec.at > DRAFT_TTL_MS) {
    pendingDrafts.delete(sessionId);
    return null;
  }
  return rec;
}

export function takeDraft(sessionId) {
  const rec = getDraft(sessionId);
  if (rec) pendingDrafts.delete(sessionId);
  return rec;
}

export function getPending() {
  if (!lastPending) return null;
  if (Date.now() - lastPending.at > DRAFT_TTL_MS) {
    lastPending = null;
    return null;
  }
  return lastPending;
}

export function lastHumanUserText(events) {
  const list = asEventList(events);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (isRoundPromptEvent(list[i])) return userTextFromEvent(list[i]);
  }
  return "";
}

/* ------------------------------------------------------------- 读会话 */

export async function readSessionLog(ctx, sessionId) {
  const store = service(ctx, "sessions");
  const live = store?.get?.(sessionId);
  if (live?.snapshotEvents) {
    return { events: asEventList(live.snapshotEvents()), header: live.header, cwd: live.header?.cwd };
  }
  const controller = service(ctx, "sessionController");
  if (typeof controller?.inspect === "function") {
    const inspected = await controller.inspect(sessionId);
    return {
      events: asEventList(inspected?.events),
      header: inspected?.meta || inspected?.header,
      cwd: inspected?.meta?.cwd || inspected?.header?.cwd,
    };
  }
  const query = service(ctx, "sessionQuery");
  if (typeof query?.observeSession === "function") {
    const observed = await query.observeSession(sessionId, { projectionMode: "none" });
    try {
      return { events: asEventList(observed?.events), header: observed?.header, cwd: observed?.header?.cwd };
    } finally {
      try {
        observed?.[Symbol.dispose]?.();
      } catch {
        /* ignore */
      }
    }
  }
  throw new Error("找不到当前会话");
}

async function waitTurnClosed(ctx, sessionId, timeoutMs = 8000) {
  const started = Date.now();
  let last = await readSessionLog(ctx, sessionId);
  while (lastOpenTurn(last.events)) {
    if (Date.now() - started >= timeoutMs) throw new Error("回合还在进行，请先点停止再回退");
    await sleep(80);
    last = await readSessionLog(ctx, sessionId);
  }
  return last;
}

function getAgent(ctx, sessionId) {
  const agents = service(ctx, "agents");
  try {
    return agents?.get?.(sessionId) || agents?.agent?.(sessionId) || undefined;
  } catch {
    return undefined;
  }
}

function resetRequestSeries(ctx, sessionId) {
  const agent = getAgent(ctx, sessionId);
  if (!agent) return;
  try {
    agent.requestHeaderLogged = false;
  } catch {
    /* ignore */
  }
  try {
    agent.requestSurfaceGeneration = -1;
  } catch {
    /* ignore */
  }
  try {
    agent.frozenMessages?.clear?.();
  } catch {
    /* ignore */
  }
}

async function hideRewoundSource(ctx, sessionId) {
  // [purge-guard] rewind no longer hides the source session
  // 原来这里调 workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
  // 写进 workspace.json 的 global.archivedSessionIds，dsh-purge 版还 detachSession 摘槽。
  // 副作用持久化：purge 一关，侧栏默认 archivedFilter="default" 就把这些会话全过滤掉。
  // 回退本身（fork + 草稿回填）不依赖这一步，所以整体停用。
  return false;
}

async function createBlank(ctx, controller, sourceId, cwd) {
  if (cwd) return controller.create({ cwd });
  return controller.create({});
}

/** 官方 fork 要求 events[atSeq].seq === atSeq（从 0 起连续）。 */
function officialForkBoundary(events, atSeq) {
  const list = asEventList(events);
  let n = Number(atSeq);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  while (n >= 0) {
    if (list[n]?.seq === n) return n;
    n -= 1;
  }
  return null;
}

const rewindLocks = new Map();

async function doRewindOneSession(ctx, controller, sessionId, options = {}) {
  if (!controller || typeof controller.fork !== "function" || typeof controller.create !== "function") {
    return { ok: false, error: "当前 DSH 没有会话回退接口" };
  }
  let log = await readSessionLog(ctx, sessionId);
  if (lastOpenTurn(log.events)) {
    try {
      ignoreSettled(controller.cancel?.({ sessionId }));
    } catch {
      /* ignore */
    }
    log = await waitTurnClosed(ctx, sessionId);
  }
  const plan = planRewind(log.events, options.mode === "round" ? "round" : "once");
  if (!plan.ok) return plan;

  let created;
  if (plan.mode === "fork") {
    const atSeq = officialForkBoundary(log.events, plan.atSeq);
    if (atSeq == null) return { ok: false, error: "没有可回退的上一句" };
    created = await controller.fork({ sessionId, atSeq });
  } else {
    created = await createBlank(ctx, controller, sessionId, log.cwd);
  }
  const childId = created?.sessionId || (typeof created === "string" ? created : "");
  if (!childId) return { ok: false, error: "回退会话创建失败" };

  resetRequestSeries(ctx, childId);
  let archived = false;
  try {
    archived = await hideRewoundSource(ctx, sessionId);
  } catch {
    /* 旧会话没藏住也不挡新会话 */
  }

  const rec = rememberDraft(childId, plan.text, sessionId);
  return {
    ok: true,
    sessionId: childId,
    parentId: sessionId,
    archived,
    text: rec.text,
    cut: plan.unit || plan.mode,
    planMode: plan.mode,
    at: rec.at,
  };
}

async function rewindOneSession(ctx, controller, sessionId, options = {}) {
  const key = String(sessionId || "");
  if (!key) return doRewindOneSession(ctx, controller, sessionId, options);
  const prev = rewindLocks.get(key) || Promise.resolve();
  const next = prev.then(
    async () => {
      try {
        return await doRewindOneSession(ctx, controller, sessionId, options);
      } finally {
        if (rewindLocks.get(key) === next) rewindLocks.delete(key);
      }
    },
    async () => {
      try {
        return await doRewindOneSession(ctx, controller, sessionId, options);
      } finally {
        if (rewindLocks.get(key) === next) rewindLocks.delete(key);
      }
    },
  );
  rewindLocks.set(key, next);
  return next;
}

export function invocationSessionId(invocation) {
  return invocation?.agent?.session?.id
    || invocation?.agent?.sessionId
    || invocation?.agent?.session?.header?.id;
}

export async function analyzeRewind(ctx, sessionId) {
  if (!sessionId) return { ok: false, error: "没有当前会话" };
  try {
    const log = await readSessionLog(ctx, sessionId);
    return {
      ok: true,
      kind: isSubagentHeader(log.header) ? "subagent" : "main",
      sessionId,
      lastUser: lastHumanUserText(log.events),
    };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

export async function applyRewind(ctx, sessionId, mode) {
  if (!sessionId) return { ok: false, error: "没有当前会话" };
  const controller = service(ctx, "sessionController");
  const action = mode === "round" ? "round" : "once";
  try {
    const result = await rewindOneSession(ctx, controller, sessionId, { mode: action });
    if (!result.ok) return result;
    return { ...result, sourceId: sessionId, mode: action };
  } catch (err) {
    log("rewind 失败", errorText(err));
    return { ok: false, error: errorText(err) };
  }
}

/** 撤回结果 → 给人看的一段话（含可复制的原文）。 */
export function renderRewindResult(result, mode) {
  if (!result?.ok) return result?.error || "回退失败";
  const blank = result.cut === "blank" || result.mode === "blank";
  const lines = [mode === "round" ? "已撤回上一整轮。" : "已撤回上一步。"];
  if (blank) {
    lines.push(
      "",
      "⚠️ 撤到的是**第一轮**，之前没有上下文可接，所以新开了一个空会话。",
      "旧会话已归档（原文仍在磁盘，可用 /armor recover 取）。",
    );
  } else {
    lines.push(
      "",
      `新会话已接上之前的上下文：\`${result.sessionId}\``,
      result.archived ? "旧会话已从侧栏归档（原文仍在磁盘，可用 /armor recover 取）。" : "旧会话仍在侧栏。",
    );
  }
  if (result.text) {
    lines.push(
      "",
      "**撤回的那句话**（复制后在新会话里重发，会重新注入）：",
      "",
      "```text",
      result.text,
      "```",
    );
  } else {
    lines.push("", "（这一轮没有可撤回的输入文本）");
  }
  return lines.join("\n");
}

export { DRAFT_TTL_MS };
