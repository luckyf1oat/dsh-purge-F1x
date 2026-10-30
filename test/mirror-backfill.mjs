#!/usr/bin/env node
/**
 * 镜像补录自测：不需要 DSH、不需要真实会话目录。
 *
 *   node test/mirror-backfill.mjs
 *
 * 锁住 1.4.0 的真实事故：backfill 把「一批事件」当成「一条事件」推进 pending，
 * commit 于是把整批 JSON.stringify 成一行，而记账只 +1。结果是每次补录都把
 * 整段历史重写一遍 —— 生产上一台机器五天写了 2.5 GB，单会话 1.9 MB 的日志
 * 变成 296 MB（157 倍），而且 verify 解不动、报 0 条。
 *
 * 测四件事：
 *   1. 补录写进去的是 N 行（一条一个事件），不是 1 行数组
 *   2. 记账按条数累加，补第二次就收敛（added === 0）
 *   3. 会话日志没变过就不重读（mtime 缓存）
 *   4. 实时 pushEvent 传数组也照样摊平成单事件
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { createMirror, decodeMultiFrame } from "../lib/mirror.js";

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

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purge-flash-mirror-"));
  fs.mkdirSync(path.join(dir, "sessions", "--D-test--", "session-abc"), { recursive: true });
  return dir;
}

function writeSource(home, events) {
  const file = path.join(home, "sessions", "--D-test--", "session-abc", "session.v4.jsonl.zstd");
  const parts = events.map((e) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(e)}\n`)));
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
}

function makeEvent(seq) {
  return {
    type: "assistant/message",
    seq,
    data: { message: { role: "assistant", content: [{ type: "text", text: `第 ${seq} 条 ${"x".repeat(80)}` }] } },
  };
}

/** 镜像文件里所有帧解出来后的行（每行应该是一条事件）。 */
function mirrorLines(home) {
  const file = path.join(home, "purge-flash-raw", "session-abc", "events.jsonl.zstd");
  if (!fs.existsSync(file)) return { lines: [], frames: 0, bytes: 0 };
  const buf = fs.readFileSync(file);
  const offsets = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    offsets.push(i);
    i += 4;
  }
  const chunks = [];
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(start, end)).toString("utf8"));
    } catch {
      /* 半帧 */
    }
  }
  const lines = chunks.join("").split("\n").filter(Boolean);
  return { lines, frames: offsets.length, bytes: buf.length };
}

const cfg = { mirrorDir: "purge-flash-raw", shadowSnapshot: false, rawStream: false };

console.log("1. 补录写的是单事件，不是一整批");

const home = tmpHome();
const events = [makeEvent(0), makeEvent(1), makeEvent(2), makeEvent(3), makeEvent(4)];
writeSource(home, events);
const mirror = createMirror(cfg, home);

const added1 = mirror.backfill(true);
check("第一次补录 added = 事件数", () => assert.equal(added1, 5));

const first = mirrorLines(home);
check("帧内是 5 行（一条一行）", () => assert.equal(first.lines.length, 5));
check("没有一行是数组", () => {
  for (const line of first.lines) {
    const v = JSON.parse(line);
    assert.ok(!Array.isArray(v), `出现了数组行：${line.slice(0, 40)}`);
    assert.equal(typeof v, "object");
  }
});
check("解出的事件 seq 齐全", () => {
  const seqs = first.lines.map((l) => JSON.parse(l).seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, [0, 1, 2, 3, 4]);
});
check("无重复行", () => {
  const seqs = first.lines.map((l) => JSON.parse(l).seq);
  assert.equal(new Set(seqs).size, seqs.length);
});

console.log("\n2. 记账按条数累加、补录收敛");

check("index.events 记的是 5，不是 1", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(home, "purge-flash-raw", "index.json"), "utf8"));
  assert.equal(raw["session-abc"].events, 5);
});
const added2 = mirror.backfill(true);
check("没新事件时第二次补录 added = 0", () => assert.equal(added2, 0));
const second = mirrorLines(home);
check("第二次补录没往文件里再写字节", () => assert.equal(second.bytes, first.bytes));

console.log("\n3. 增量只写新增的那几条");

writeSource(home, [...events, makeEvent(5), makeEvent(6)]);
const added3 = mirror.backfill(true);
check("增量补录 added = 2", () => assert.equal(added3, 2));
const third = mirrorLines(home);
check("文件里现在 7 行、无重复", () => {
  assert.equal(third.lines.length, 7);
  const seqs = third.lines.map((l) => JSON.parse(l).seq);
  assert.equal(new Set(seqs).size, 7);
});

console.log("\n4. 实时通道传数组也要摊平");

const home2 = tmpHome();
const mirror2 = createMirror(cfg, home2);
mirror2.pushEvent("session-abc", [makeEvent(10), makeEvent(11), makeEvent(12)]);
mirror2.flush();
const pushed = mirrorLines(home2);
check("pushEvent 收到数组 → 3 行单事件", () => {
  assert.equal(pushed.lines.length, 3);
  for (const line of pushed.lines) assert.ok(!Array.isArray(JSON.parse(line)));
});

console.log("\n5. dispose 之前的内容不丢");

const home3 = tmpHome();
const mirror3 = createMirror(cfg, home3);
mirror3.pushEvent("session-abc", makeEvent(20));
mirror3.dispose();
const disposed = mirrorLines(home3);
check("dispose 把 pending 写掉了", () => assert.equal(disposed.lines.length, 1));

check("decodeMultiFrame 仍能整体解", () => {
  const text = decodeMultiFrame(fs.readFileSync(path.join(home, "purge-flash-raw", "session-abc", "events.jsonl.zstd")));
  assert.equal(text.split("\n").filter(Boolean).length, 7);
});

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
