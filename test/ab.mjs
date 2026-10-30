#!/usr/bin/env node
/**
 * 破甲对照：把 probes.jsonl 里的探针发进 DSH 会话，再回收回复过 classifyReply。
 *
 *   node test/ab.mjs --session <session.v4.jsonl>           只评分（离线）
 *   node test/ab.mjs --latest                               评分最新会话
 *   node test/ab.mjs --emit                                  打印探针清单，手工粘进会话
 *   node test/ab.mjs --emit --cat adult --limit 5            只发某一类
 *
 * 为什么是「离线评分」而不是自动发：
 * DSH 没有从外部注入用户消息的公开入口（只有 agent.followup，需要活在进程里）。
 * 强行起无头会话会把「破甲效果」和「无头模式的差别」混在一起，评分就不可信了。
 * 所以分工是：探针由人发（真实场景），评分由这个脚本做（可复现、可对照）。
 *
 * 探针格式沿用 workspace 的 evals/probes.jsonl：{ id, cat, prompt }，prompt 里带 [PROBE:Pxx]。
 * 会话日志里的 assistant/message 按 [PROBE:Pxx] 配对。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

/**
 * 探针清单从哪来。
 *
 * 仓库自带一份 test/probes.jsonl（40 条，8 类），这是默认来源。
 * 想用自己那份就设 PROBES_FILE=<路径>，或者把文件放到 cwd 的 evals/probes.jsonl。
 */
function findProbes() {
  const cands = [
    process.env.PROBES_FILE,
    path.join(HERE, "probes.jsonl"),
    path.join(REPO, "probes.jsonl"),
    path.resolve("evals/probes.jsonl"),
    path.resolve("probes.jsonl"),
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "";
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decodeMultiFrame(buf) {
  let i = 0;
  const offsets = [];
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    offsets.push(i);
    i += 4;
  }
  if (offsets.length === 0) return buf.toString("utf8");
  const parts = [];
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    if (end <= start) continue;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)));
    } catch {
      /* 半帧 */
    }
  }
  return Buffer.concat(parts).toString("utf8");
}

function readEvents(file) {
  const buf = fs.readFileSync(file);
  const text = file.endsWith(".zstd") ? decodeMultiFrame(buf) : buf.toString("utf8");
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 坏行 */
    }
  }
  return out;
}

function latestSession() {
  const root = path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "sessions");
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/^session\.v\d+\.jsonl(\.zstd)?$/.test(e.name)) {
        try {
          found.push({ file: p, mtime: fs.statSync(p).mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(root, 0);
  if (found.length === 0) return "";
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0].file;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

/** 按 [PROBE:Pxx] 把 prompt 和紧随其后的 assistant 文本配对。 */
function pairProbes(events) {
  const out = new Map();
  let pending = null;
  for (const e of events) {
    if (e?.type === "user/message") {
      const kind = e?.data?.source?.kind;
      if (kind === "purge-flash" || kind === "plugin") continue;
      const text = textOf(e?.data?.content);
      const m = /\[PROBE:(P\d{2})\]/.exec(text);
      if (m) {
        pending = m[1];
        if (!out.has(pending)) out.set(pending, "");
      }
    } else if (e?.type === "assistant/message" && pending) {
      const text = textOf(e?.data?.message?.content);
      if (text.trim()) out.set(pending, `${out.get(pending) || ""}${text}`);
    }
  }
  return out;
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--session" || a === "--cat" || a === "--limit") {
      o[a.slice(2)] = argv[i + 1];
      i += 1;
    } else if (a.startsWith("--")) {
      o[a.slice(2)] = true;
    } else {
      o._.push(a);
    }
  }
  return o;
}

async function classify() {
  return import("../lib/detect.js");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const probesFile = findProbes();
  if (!probesFile) {
    console.error("找不到 probes.jsonl。用 PROBES_FILE=<路径> 指定。");
    return 2;
  }
  const probes = fs
    .readFileSync(probesFile, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  if (args.emit) {
    let rows = probes;
    if (args.cat) rows = rows.filter((p) => p.cat === args.cat);
    if (args.limit) rows = rows.slice(0, Number(args.limit));
    console.log(`# ${rows.length} 条探针（来自 ${probesFile}）\n`);
    console.log("复制下面每一段，逐条发进会话。评分时用 --session 指向那个会话。\n");
    for (const p of rows) console.log(`${p.prompt}\n`);
    return 0;
  }

  let file = args.session;
  if (!file || args.latest) file = latestSession();
  if (!file || !fs.existsSync(file)) {
    console.error(`找不到会话日志：${file || "(空)"}`);
    return 1;
  }

  const { classifyReply } = await classify();
  const events = readEvents(file);
  const got = pairProbes(events);

  const rows = [];
  const byCat = new Map();
  let pass = 0;
  let total = 0;

  for (const p of probes) {
    const reply = got.get(p.id) || "";
    const st = byCat.get(p.cat) || { pass: 0, n: 0 };
    if (!reply) {
      rows.push([p.id, p.cat, "SKIP", "无回复"]);
      byCat.set(p.cat, st);
      continue;
    }
    const v = classifyReply(reply);
    const good = !v.refused;
    st.n += 1;
    total += 1;
    if (good) {
      st.pass += 1;
      pass += 1;
    }
    const why = good
      ? ""
      : `hard=${v.hard ? "Y" : "N"} soft=${v.soft.join("/") || "-"}`;
    rows.push([p.id, p.cat, good ? "PASS" : "FAIL", why]);
    byCat.set(p.cat, st);
  }

  console.log(`会话：${file}\n`);
  console.log("| 探针 | 类别 | 结果 | 命中 |");
  console.log("|---|---|---|---|");
  for (const r of rows) console.log(`| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} |`);
  console.log("\n| 类别 | 通过 / 总数 | 通过率 |");
  console.log("|---|---|---|");
  for (const [cat, st] of [...byCat.entries()].sort()) {
    const rate = st.n > 0 ? `${Math.round((st.pass / st.n) * 100)}%` : "-";
    console.log(`| ${cat} | ${st.pass} / ${st.n} | ${rate} |`);
  }
  const pct = total > 0 ? ((pass / total) * 100).toFixed(1) : "0.0";
  console.log(`\n**总分：${pass}/${total} = ${pct}%**`);
  console.log(`跳过 ${probes.length - total} 条（本次会话里没发过对应探针）`);
  return 0;
}

const code = await main();
process.exit(code);
