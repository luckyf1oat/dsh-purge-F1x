#!/usr/bin/env node
/**
 * 撤回自测：不需要 DSH。
 *
 *   node test/rewind.mjs
 *
 * 测三件事：
 *   1. planRewind 的切点算得对（once / round / 首步 / 空会话）
 *   2. 插件自己注入的消息不会被当成「人说的那一句」
 *   3. applyRewind 在假 sessionController 上真的 fork、归档、记住草稿
 */

import assert from "node:assert/strict";

import {
  planRewind,
  lastHumanUserText,
  applyRewind,
  analyzeRewind,
  renderRewindResult,
  getDraft,
  takeDraft,
} from "../lib/rewind.js";

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n       ${String(e?.message || e).split("\n")[0]}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n       ${String(e?.message || e).split("\n")[0]}`);
  }
}

const mk = (type, seq, data) => ({ type, seq, data });
const user = (seq, text, id = `u${seq}`) =>
  mk("user/message", seq, { id, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] });
const asst = (seq, text) =>
  mk("assistant/message", seq, { message: { role: "assistant", content: [{ type: "text", text }] } });

/** 两轮完整会话 */
function twoTurns() {
  return [
    mk("turn/start", 0, { turn: 0 }),
    user(1, "第一句"),
    mk("step/start", 2, { turn: 0, step: 1 }),
    asst(3, "答一"),
    mk("step/end", 4, { turn: 0, step: 1 }),
    mk("turn/end", 5, { turn: 0, reason: { kind: "completed" } }),
    mk("turn/start", 6, { turn: 1 }),
    user(7, "第二句"),
    mk("step/start", 8, { turn: 1, step: 1 }),
    asst(9, "答二"),
    mk("step/end", 10, { turn: 1, step: 1 }),
    mk("turn/end", 11, { turn: 1, reason: { kind: "completed" } }),
  ];
}

console.log("1. 切点计算");

check("once 切到上一轮末尾", () => {
  const p = planRewind(twoTurns(), "once");
  assert.equal(p.ok, true);
  assert.equal(p.mode, "fork");
  assert.equal(p.atSeq, 5, JSON.stringify(p));
  assert.equal(p.text, "第二句");
});
check("round 切点与 once 相同（本轮只有一步）", () => {
  const p = planRewind(twoTurns(), "round");
  assert.equal(p.atSeq, 5);
  assert.equal(p.text, "第二句");
});
check("多步轮：once 只撤最后一步", () => {
  const ev = [
    mk("turn/start", 0, { turn: 0 }),
    user(1, "干活"),
    mk("step/start", 2, { turn: 0, step: 1 }),
    asst(3, "第一步"),
    mk("step/end", 4, { turn: 0, step: 1 }),
    mk("step/start", 5, { turn: 0, step: 2 }),
    asst(6, "第二步"),
    mk("step/end", 7, { turn: 0, step: 2 }),
  ];
  const once = planRewind(ev, "once");
  assert.equal(once.atSeq, 4, JSON.stringify(once));
  const round = planRewind(ev, "round");
  assert.equal(round.atSeq, null, JSON.stringify(round));
  assert.equal(round.mode, "blank");
  assert.equal(round.text, "干活");
});
check("首步被撤 = 撤整轮", () => {
  const ev = [
    mk("turn/start", 0, { turn: 0 }),
    user(1, "只一步"),
    mk("step/start", 2, { turn: 0, step: 1 }),
    asst(3, "答"),
    mk("step/end", 4, { turn: 0, step: 1 }),
  ];
  const p = planRewind(ev, "once");
  assert.equal(p.unit, "step");
  assert.equal(p.text, "只一步");
});
check("空会话：报没有可回退", () => {
  const p = planRewind([], "once");
  assert.equal(p.ok, false);
  assert.ok(p.error.includes("没有可回退"));
});

console.log("\n2. 插件消息不算人的话");

check("已开始输出：不算", () => {
  const ev = [
    user(1, "真话"),
    mk("user/message", 2, {
      id: "pf-1",
      role: "user",
      source: { kind: "purge-flash", form: "notice", summary: "prefill anchor" },
      content: [{ type: "text", text: "已开始输出：" }],
    }),
  ];
  assert.equal(lastHumanUserText(ev), "真话");
});
check("修补消息不算", () => {
  const ev = [
    user(1, "原话"),
    mk("user/message", 2, {
      id: "pf-2",
      role: "user",
      source: { kind: "purge-flash" },
      content: [{ type: "text", text: "上一条不继承。下面直接给：原话" }],
    }),
  ];
  assert.equal(lastHumanUserText(ev), "原话");
});
check("source.kind=plugin 不算", () => {
  const ev = [
    user(1, "人话"),
    mk("user/message", 2, {
      id: "p1",
      role: "user",
      source: { kind: "plugin" },
      content: [{ type: "text", text: "插件话" }],
    }),
  ];
  assert.equal(lastHumanUserText(ev), "人话");
});
check("rewind- 标记不算", () => {
  const ev = [
    user(1, "人话"),
    mk("user/message", 2, { id: "rewind-9", role: "user", source: { kind: "user" }, content: [] }),
  ];
  assert.equal(lastHumanUserText(ev), "人话");
});

console.log("\n3. applyRewind 真跑（假 sessionController）");

function makeFakeCtx(events, header = {}) {
  const calls = { fork: [], create: [], archive: [] };
  const liveSession = { id: "s1", header, snapshotEvents: () => events };
  const ctx = {
    get(name) {
      if (name === "sessions") return { get: (id) => (id === "s1" ? liveSession : undefined) };
      if (name === "sessionController") {
        return {
          fork: async (req) => {
            calls.fork.push(req);
            return { sessionId: `child-of-${req.sessionId}-at-${req.atSeq}` };
          },
          create: async (req) => {
            calls.create.push(req);
            return { sessionId: "fresh-session" };
          },
        };
      }
      if (name === "workspaceRegistry") {
        return {
          archiveSession: async (id, opts) => {
            calls.archive.push({ id, opts });
            return true;
          },
        };
      }
      return undefined;
    },
  };
  return { ctx, calls };
}

await checkAsync("fork 到正确切点，且不再归档旧会话", async () => {
  const { ctx, calls } = makeFakeCtx(twoTurns(), { cwd: "D:/work" });
  const r = await applyRewind(ctx, "s1", "once");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.sessionId, "child-of-s1-at-5");
  assert.equal(r.parentId, "s1");
  assert.equal(r.text, "第二句");
  // 归档被停用：archiveSession 会往 workspace.json 写 global.archivedSessionIds，
  // 是持久副作用 —— purge 一卸载，侧栏默认 archivedFilter="default" 就把这些会话过滤掉。
  // 回退本身（fork + 草稿回填）不依赖归档，所以这里断言「没有调用」。
  assert.equal(r.archived, false);
  assert.deepEqual(calls.fork, [{ sessionId: "s1", atSeq: 5 }]);
  assert.equal(calls.archive.length, 0, "不应再归档源会话");
});
await checkAsync("草稿记在新会话 id 上，可取一次", async () => {
  const { ctx } = makeFakeCtx(twoTurns(), {});
  const r = await applyRewind(ctx, "s1", "round");
  assert.equal(r.ok, true);
  const draft = getDraft(r.sessionId);
  assert.ok(draft, "没记住草稿");
  assert.equal(draft.text, "第二句");
  const taken = takeDraft(r.sessionId);
  assert.equal(taken.text, "第二句");
  assert.equal(getDraft(r.sessionId), null, "取过之后应该没了");
});
await checkAsync("没有 sessionController 时明确报错", async () => {
  const ctx = { get: () => undefined };
  const r = await applyRewind(ctx, "s1", "once");
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("回退接口"), r.error);
});
await checkAsync("analyzeRewind 报主会话与最后一句", async () => {
  const { ctx } = makeFakeCtx(twoTurns(), {});
  const info = await analyzeRewind(ctx, "s1");
  assert.equal(info.ok, true);
  assert.equal(info.kind, "main");
  assert.equal(info.lastUser, "第二句");
});
await checkAsync("子代理会话被识别成 subagent", async () => {
  const { ctx } = makeFakeCtx(twoTurns(), { origin: "subagent" });
  const info = await analyzeRewind(ctx, "s1");
  assert.equal(info.kind, "subagent");
});

console.log("\n4. 结果文案");
check("含可复制的原文代码块", () => {
  const text = renderRewindResult(
    { ok: true, sessionId: "abc", parentId: "s1", text: "帮我写个东西", archived: true },
    "once",
  );
  assert.ok(text.includes("已撤回上一步"), text);
  assert.ok(text.includes("```text"), text);
  assert.ok(text.includes("帮我写个东西"), text);
  assert.ok(text.includes("abc"), text);
});
check("失败时返回错误串", () => {
  assert.equal(renderRewindResult({ ok: false, error: "没有可回退的上一句" }, "once"), "没有可回退的上一句");
});

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
